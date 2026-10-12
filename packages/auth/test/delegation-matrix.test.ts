import {
  ACTION_IDS,
  type ActionId,
  actionDefinition,
  type BindingScope,
  type ClientKind,
  type GrantRestrictions,
  isScope,
  isScopeGrantableTo,
  MCP_INELIGIBLE_SCOPES,
  type OAuthResource,
  type Permission,
  RESOURCES_BY_CLIENT_KIND,
  readPermissionOfKind,
  SCOPE_IDS,
  type Scope,
  scopeDefinition,
} from '@exponetdb/contracts'
import { type Queryable, Row } from '@exponetdb/control-store'
import { type IdentityId, newId } from '@exponetdb/kernel'
import type { PolicyDecision } from '@exponetdb/policy'
import { describe, expect, it } from 'vitest'
import {
  Authorizer,
  ControlPlaneSubjectResolver,
  type DelegatedCredential,
  type Principal,
  restrictionDenial,
  type SubjectChain,
  type SubjectRef,
  withPolicy,
} from '../src/index.ts'

/**
 * The G3B delegation matrix (order §128–129): action × caller (a person
 * through the CLI or an MCP client, a service account) × credential (access
 * token, API key) × credential audience × request resource × delegated
 * scopes × grant restrictions × subject × role binding. Every combination is
 * decided by the engine and compared with an oracle written from oauth.md §5
 * and authorization.md §1 and §4, not from the engine; every allow is checked
 * again against each single condition. The identity always holds the action's
 * permission somewhere: the question is only what the delegation takes away.
 */
const P1 = newId('prd', 1)
const J1 = newId('prj', 3)
const E_NONPROD = newId('env', 5)
const E_PROD = newId('env', 6)
const P2 = newId('prd', 2)
const J2 = newId('prj', 4)
const E_OTHER = newId('env', 7)
const T_NONPROD = newId('tgt', 8)
const T_PROD = newId('tgt', 9)
const T_UNTIERED = newId('tgt', 10)
const T_OTHER = newId('tgt', 11)

const GRAPH: Record<string, SubjectChain> = {
  [T_NONPROD]: {
    productId: P1,
    projectId: J1,
    environmentId: E_NONPROD,
    targetId: T_NONPROD,
    tier: 'nonprod',
  },
  [T_PROD]: { productId: P1, projectId: J1, environmentId: E_PROD, targetId: T_PROD, tier: 'prod' },
  [T_UNTIERED]: { productId: P1, projectId: J1, environmentId: E_NONPROD, targetId: T_UNTIERED },
  [T_OTHER]: {
    productId: P2,
    projectId: J2,
    environmentId: E_OTHER,
    targetId: T_OTHER,
    tier: 'nonprod',
  },
}

const authorizer = new Authorizer(new ControlPlaneSubjectResolver(async (id) => GRAPH[id]))
const IDENTITY: IdentityId = newId('idn', 77)

function grantsStore(
  grants: readonly { permission: Permission; scope: BindingScope }[],
): Queryable {
  return {
    async query(queryClass) {
      if (queryClass !== 'auth.grants.load') {
        throw new Error(`unexpected query ${queryClass}`)
      }
      const rows = grants.map(
        (g, i) =>
          new Row({
            binding_id: newId('rlb', 2000 + i),
            role_id: 'custom',
            scope_kind: g.scope.kind,
            scope_id:
              g.scope.kind === 'global'
                ? null
                : g.scope.kind === 'target'
                  ? g.scope.targetId
                  : g.scope.kind === 'environment'
                    ? g.scope.environmentId
                    : g.scope.kind === 'project'
                      ? g.scope.projectId
                      : g.scope.productId,
            permission: g.permission,
          }),
      )
      return { rows, rowCount: rows.length }
    },
  }
}

const BINDINGS = {
  global: { kind: 'global' },
  targetNonprod: { kind: 'target', targetId: T_NONPROD },
} as const satisfies Record<string, BindingScope>
type BindingName = keyof typeof BINDINGS

const CALLERS = [
  { identity: 'human', client: 'cli' },
  { identity: 'human', client: 'mcp' },
  { identity: 'service', client: 'ci' },
] as const satisfies readonly { identity: 'human' | 'service'; client: ClientKind }[]
type Caller = (typeof CALLERS)[number]

const BASELINE: readonly Scope[] = ['targets.read', 'schema.read', 'diagnostics.read']

const SCOPE_SETS = {
  none: () => [],
  baseline: () => BASELINE,
  nonprod: (client: ClientKind) =>
    SCOPE_IDS.filter((s) => isScopeGrantableTo(s, client) && !s.endsWith(':prod')),
  grantable: (client: ClientKind) => SCOPE_IDS.filter((s) => isScopeGrantableTo(s, client)),
  // A corrupt delegation that lists the whole catalog, ineligible and human-only scopes included.
  catalog: () => SCOPE_IDS,
} as const satisfies Record<string, (client: ClientKind) => readonly Scope[]>
type ScopeSetName = keyof typeof SCOPE_SETS

const RESTRICTIONS = {
  unrestricted: { tiers: ['prod', 'nonprod'], targets: { kind: 'all' } },
  nonprodOnly: { tiers: ['nonprod'], targets: { kind: 'all' } },
  prodOnly: { tiers: ['prod'], targets: { kind: 'all' } },
  listNonprod: { tiers: ['prod', 'nonprod'], targets: { kind: 'list', targetIds: [T_NONPROD] } },
  listOther: { tiers: ['nonprod'], targets: { kind: 'list', targetIds: [T_OTHER] } },
  listNonprodProdTier: { tiers: ['prod'], targets: { kind: 'list', targetIds: [T_NONPROD] } },
} as const satisfies Record<string, GrantRestrictions>
type RestrictionName = keyof typeof RESTRICTIONS

const SUBJECTS = {
  nonprod: T_NONPROD,
  prod: T_PROD,
  untiered: T_UNTIERED,
  other: T_OTHER,
} as const
type SubjectName = keyof typeof SUBJECTS

const ACTIONS: readonly ActionId[] = [
  'target.get',
  'query.run',
  'migration.plan',
  'migration.apply',
  'drift.accept',
  'operation.force_release',
  'identity.list',
]

interface Input {
  readonly action: ActionId
  readonly caller: Caller
  readonly credential: 'access_token' | 'api_key'
  readonly audience: OAuthResource
  readonly arrivedAt: OAuthResource | undefined
  readonly scopes: ScopeSetName
  readonly restrictions: RestrictionName
  readonly subject: SubjectName
  readonly binding: BindingName
}

function credentialOf(input: Input): DelegatedCredential {
  return input.credential === 'api_key'
    ? { type: 'api_key', keyId: newId('key', 1) }
    : {
        type: 'access_token',
        grantId: newId('grt', 1),
        clientId: newId('cli', 1),
        grantKind: input.caller.identity === 'service' ? 'machine' : 'delegated',
      }
}

function principalOf(input: Input): Principal {
  return {
    kind: 'delegated',
    identityId: IDENTITY,
    identityKind: input.caller.identity,
    label: `${input.caller.identity} #1`,
    client: input.caller.client,
    delegation: {
      credential: credentialOf(input),
      resource: input.audience,
      scopes: new Set(SCOPE_SETS[input.scopes](input.caller.client)),
      restrictions: RESTRICTIONS[input.restrictions],
    },
  }
}

type Outcome =
  | { readonly decision: 'allow' }
  | { readonly decision: 'deny'; readonly code: string; readonly requiredScope?: Scope }

const DENIED: Outcome = { decision: 'deny', code: 'PERMISSION_DENIED' }

function coversBinding(binding: BindingScope, chain: SubjectChain): boolean {
  return (
    binding.kind === 'global' || (binding.kind === 'target' && binding.targetId === chain.targetId)
  )
}

/** The oracle: oauth.md §5 (a scope is a ceiling), authorization.md §1 and §4. */
function expected(input: Input): Outcome {
  const def = actionDefinition(input.action)
  const { identity, client } = input.caller
  const human = identity === 'human'
  const held = SCOPE_SETS[input.scopes](client)
  const restrictions: GrantRestrictions = RESTRICTIONS[input.restrictions]
  if (!def.clientKinds.includes(client)) return DENIED
  // An API key belongs to a service account and is valid for the REST API only.
  if (input.credential === 'api_key' && identity !== 'service') return DENIED
  if (def.humanOnly && !(human && client === 'cli')) return DENIED
  // The credential is valid for exactly one resource, which its client kind may obtain.
  if (
    input.arrivedAt !== input.audience ||
    !RESOURCES_BY_CLIENT_KIND[client].includes(input.audience) ||
    (input.credential === 'api_key' && input.audience !== 'api')
  ) {
    return DENIED
  }
  if (def.scope.kind === 'fixed') {
    const scope = def.scope.scope
    if (!isScope(scope) || !isScopeGrantableTo(scope, client)) return DENIED
    if (scopeDefinition(scope).humanOnly && !human) return DENIED
    if (!held.includes(scope))
      return { decision: 'deny', code: 'INSUFFICIENT_SCOPE', requiredScope: scope }
  }
  const chain = GRAPH[SUBJECTS[input.subject]]
  if (chain === undefined) return { decision: 'deny', code: 'NOT_FOUND' }
  // A restricted delegation sees only its targets (error-model.md §4, owner decision R2):
  // outside its list or tier, a target answers like an unknown one, before anything else.
  if (
    restrictions.targets.kind === 'list' &&
    !restrictions.targets.targetIds.some((id) => id === chain.targetId)
  ) {
    return { decision: 'deny', code: 'TARGET_NOT_FOUND' }
  }
  const tierAllowed =
    chain.tier === undefined
      ? restrictions.tiers.includes('prod') && restrictions.tiers.includes('nonprod')
      : restrictions.tiers.includes(chain.tier)
  if (!tierAllowed) return { decision: 'deny', code: 'TARGET_NOT_FOUND' }
  if (def.tierSemantics !== 'none' && chain.tier === undefined) return DENIED
  let tiered: Scope | undefined
  if (def.scope.kind === 'tiered') {
    const name = chain.tier === undefined ? undefined : `${def.scope.permission}:${chain.tier}`
    if (name === undefined || !isScope(name) || !isScopeGrantableTo(name, client)) return DENIED
    tiered = name
  }
  if (!coversBinding(BINDINGS[input.binding], chain)) return DENIED
  if (tiered !== undefined && !held.includes(tiered)) {
    return { decision: 'deny', code: 'INSUFFICIENT_SCOPE', requiredScope: tiered }
  }
  // A bearer credential never proves presence.
  if (def.reauthentication) return { decision: 'deny', code: 'REAUTH_REQUIRED' }
  return { decision: 'allow' }
}

const ALLOW_POLICY = async (): Promise<PolicyDecision> => ({
  decision: 'allow',
  requirements: [],
  rules: [],
  overriddenRules: [],
  policyVersion: `sha256:pv1:${'b'.repeat(64)}`,
  evaluatedAt: '2026-10-06T00:00:00.000Z',
})

async function decide(input: Input) {
  const def = actionDefinition(input.action)
  if (def.permission.kind !== 'fixed') {
    throw new Error('matrix actions have fixed permissions')
  }
  const who = principalOf(input)
  const store = grantsStore([
    { permission: def.permission.permission, scope: BINDINGS[input.binding] },
  ])
  const authorization = await authorizer.authorize(
    store,
    {
      action: input.action,
      principal: who,
      ...(input.arrivedAt === undefined ? {} : { resource: input.arrivedAt }),
    },
    { kind: 'target', targetId: SUBJECTS[input.subject] },
  )
  return withPolicy(who, authorization, ALLOW_POLICY)
}

describe('delegation matrix (G3B §128–129)', () => {
  it('decides every combination exactly as the documented formula, with no accidental allow', async () => {
    let total = 0
    let allowed = 0
    const named = new Set<string>()
    for (const action of ACTIONS) {
      for (const caller of CALLERS) {
        for (const credential of ['access_token', 'api_key'] as const) {
          for (const audience of ['api', 'mcp'] as const) {
            for (const arrivedAt of ['api', 'mcp', undefined] as const) {
              for (const scopes of Object.keys(SCOPE_SETS) as ScopeSetName[]) {
                for (const restrictions of Object.keys(RESTRICTIONS) as RestrictionName[]) {
                  for (const subject of Object.keys(SUBJECTS) as SubjectName[]) {
                    for (const binding of Object.keys(BINDINGS) as BindingName[]) {
                      const input: Input = {
                        action,
                        caller,
                        credential,
                        audience,
                        arrivedAt,
                        scopes,
                        restrictions,
                        subject,
                        binding,
                      }
                      const result = await decide(input)
                      const want = expected(input)
                      total += 1
                      const got =
                        result.decision === 'deny'
                          ? {
                              decision: 'deny',
                              code: result.error.code,
                              requiredScope: result.error.details?.['requiredScope'],
                            }
                          : { decision: result.decision }
                      const wanted =
                        want.decision === 'deny'
                          ? { decision: 'deny', code: want.code, requiredScope: want.requiredScope }
                          : want
                      if (JSON.stringify(got) !== JSON.stringify(wanted)) {
                        throw new Error(
                          `mismatch ${JSON.stringify(input)}: got ${JSON.stringify(got)}, want ${JSON.stringify(wanted)}`,
                        )
                      }
                      if (want.decision === 'deny') {
                        named.add(want.code)
                        continue
                      }
                      allowed += 1
                      // Independent safety checks for every allow.
                      const def = actionDefinition(action)
                      const chain = GRAPH[SUBJECTS[subject]]
                      const r: GrantRestrictions = RESTRICTIONS[restrictions]
                      const held = SCOPE_SETS[scopes](caller.client)
                      expect(arrivedAt).toBe(audience)
                      expect(RESOURCES_BY_CLIENT_KIND[caller.client]).toContain(audience)
                      expect(def.reauthentication).toBe(false)
                      if (def.humanOnly)
                        expect(caller).toEqual({ identity: 'human', client: 'cli' })
                      if (credential === 'api_key') expect(caller.identity).toBe('service')
                      const scope =
                        def.scope.kind === 'fixed'
                          ? def.scope.scope
                          : def.scope.kind === 'tiered'
                            ? `${def.scope.permission}:${chain?.tier}`
                            : ''
                      expect(isScope(scope) && held.includes(scope)).toBe(true)
                      expect(isScope(scope) && isScopeGrantableTo(scope, caller.client)).toBe(true)
                      if (caller.client === 'mcp')
                        expect(MCP_INELIGIBLE_SCOPES).not.toContain(scope)
                      if (r.targets.kind === 'list')
                        expect(r.targets.targetIds).toContain(chain?.targetId)
                      if (chain?.tier !== undefined) expect(r.tiers).toContain(chain.tier)
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(total).toBe(ACTIONS.length * CALLERS.length * 2 * 2 * 3 * 5 * 6 * 4 * 2)
    expect(allowed).toBeGreaterThan(0)
    // Every refusal of the delegation surfaced at least once.
    for (const code of [
      'PERMISSION_DENIED',
      'INSUFFICIENT_SCOPE',
      'TARGET_NOT_FOUND',
      'REAUTH_REQUIRED',
    ]) {
      expect(named, code).toContain(code)
    }
  }, 60_000)
})

function delegated(
  caller: Caller,
  scopes: readonly Scope[],
  restrictions: GrantRestrictions = RESTRICTIONS.unrestricted,
  // Each client kind's own resource: an MCP client holds /mcp only (G3B final hardening).
  audience: OAuthResource = caller.client === 'mcp' ? 'mcp' : 'api',
): Principal {
  return {
    kind: 'delegated',
    identityId: IDENTITY,
    identityKind: caller.identity,
    label: `${caller.identity} #1`,
    client: caller.client,
    delegation: {
      credential: {
        type: 'access_token',
        grantId: newId('grt', 2),
        clientId: newId('cli', 2),
        grantKind: caller.identity === 'service' ? 'machine' : 'delegated',
      },
      resource: audience,
      scopes: new Set(scopes),
      restrictions,
    },
  }
}

const CLI = CALLERS[0]
const MCP = CALLERS[1]
const CI = CALLERS[2]

describe('scopes are a ceiling, never a permission (oauth.md §5)', () => {
  it('a delegation listing the whole catalog allows nothing without a role binding', async () => {
    const none = grantsStore([])
    for (const action of ACTION_IDS) {
      const def = actionDefinition(action)
      if (def.permission.kind === 'public' || def.permission.kind === 'protocol') continue
      for (const caller of CALLERS) {
        const who = delegated(caller, SCOPE_IDS)
        const admission = await authorizer.admit(none, {
          action,
          principal: who,
          resource: 'api',
          ...(def.permission.kind === 'of_plan_kind' ? { planKind: 'migration.apply' } : {}),
        })
        expect(admission.allowed, `${action} for ${caller.client}`).toBe(false)
      }
    }
  })

  it('a missing scope is named only when the identity could use it', async () => {
    const holds = grantsStore([{ permission: 'targets.read', scope: { kind: 'global' } }])
    const lacks = grantsStore([])
    const who = delegated(MCP, [])
    const request = { action: 'target.get', principal: who, resource: 'mcp' } as const
    const named = await authorizer.admit(holds, request)
    expect(named).toMatchObject({ allowed: false, reason: 'delegated_scope' })
    expect(named.allowed ? undefined : named.error.code).toBe('INSUFFICIENT_SCOPE')
    expect(named.allowed ? undefined : named.error.details).toEqual({
      requiredScope: 'targets.read',
    })
    const hidden = await authorizer.admit(lacks, request)
    expect(hidden).toMatchObject({ allowed: false, reason: 'no_permission' })
    expect(hidden.allowed ? undefined : hidden.error.details).toBeUndefined()
  })

  it('MCP-ineligible scopes are refused at authorization even when a delegation lists them', async () => {
    expect(MCP_INELIGIBLE_SCOPES.length).toBeGreaterThan(5)
    let checked = 0
    for (const action of ACTION_IDS) {
      const def = actionDefinition(action)
      if (def.permission.kind !== 'fixed' || def.scope.kind !== 'fixed') continue
      const scope = def.scope.scope
      if (!isScope(scope) || !MCP_INELIGIBLE_SCOPES.includes(scope)) continue
      checked += 1
      const owner = grantsStore([
        { permission: def.permission.permission, scope: { kind: 'global' } },
      ])
      for (const resource of ['api', 'mcp'] as const) {
        const result = await authorizer.authorize(
          owner,
          {
            action,
            principal: delegated(MCP, SCOPE_IDS, RESTRICTIONS.unrestricted, resource),
            resource,
          },
          { kind: 'installation' },
        )
        expect(result.allowed, `${action} at ${resource}`).toBe(false)
      }
    }
    expect(checked).toBeGreaterThan(10)
  })

  it('a service account never uses a human-only scope, whatever its delegation lists', async () => {
    for (const action of ACTION_IDS) {
      const def = actionDefinition(action)
      if (def.permission.kind !== 'fixed' || def.scope.kind !== 'fixed') continue
      const scope = def.scope.scope
      if (!isScope(scope) || !scopeDefinition(scope).humanOnly) continue
      const owner = grantsStore([
        { permission: def.permission.permission, scope: { kind: 'global' } },
      ])
      const admission = await authorizer.admit(owner, {
        action,
        principal: delegated(CI, SCOPE_IDS),
        resource: 'api',
      })
      expect(admission.allowed, action).toBe(false)
    }
  })
})

describe('credentials and resources', () => {
  const owner = grantsStore([{ permission: 'targets.read', scope: { kind: 'global' } }])
  const subject: SubjectRef = { kind: 'target', targetId: T_NONPROD }

  it('a token for one resource is refused at the other, and a request without a resource is refused', async () => {
    const forApi = delegated(CLI, BASELINE, RESTRICTIONS.unrestricted, 'api')
    const forMcp = delegated(MCP, BASELINE, RESTRICTIONS.unrestricted, 'mcp')
    for (const [who, resource] of [
      [forApi, 'api'],
      [forMcp, 'mcp'],
    ] as const) {
      expect(
        await authorizer.authorize(
          owner,
          { action: 'target.get', principal: who, resource },
          subject,
        ),
      ).toMatchObject({ allowed: true })
    }
    for (const [who, resource] of [
      [forApi, 'mcp'],
      [forMcp, 'api'],
      [forApi, undefined],
      [forMcp, undefined],
    ] as const) {
      expect(
        await authorizer.authorize(
          owner,
          { action: 'target.get', principal: who, ...(resource === undefined ? {} : { resource }) },
          subject,
        ),
      ).toMatchObject({ allowed: false, reason: 'resource' })
    }
  })

  it('an MCP client never holds a token for /api, even when a malformed delegation says so (G3B final hardening)', async () => {
    expect(RESOURCES_BY_CLIENT_KIND.mcp).toEqual(['mcp'])
    const malformed = delegated(MCP, BASELINE, RESTRICTIONS.unrestricted, 'api')
    expect(
      await authorizer.authorize(
        owner,
        { action: 'target.get', principal: malformed, resource: 'api' },
        subject,
      ),
    ).toMatchObject({ allowed: false, reason: 'resource' })
  })

  it('the CLI and service accounts never hold a token for /mcp, and the Web App never holds a token', async () => {
    for (const [caller, audience] of [
      [CLI, 'mcp'],
      [CI, 'mcp'],
    ] as const) {
      const who = delegated(caller, BASELINE, RESTRICTIONS.unrestricted, audience)
      expect(
        await authorizer.authorize(
          owner,
          { action: 'target.get', principal: who, resource: audience },
          subject,
        ),
      ).toMatchObject({ allowed: false, reason: 'resource' })
    }
    const web: Principal = {
      kind: 'delegated',
      identityId: IDENTITY,
      identityKind: 'human',
      label: 'human #1',
      client: 'web',
      delegation: {
        credential: {
          type: 'access_token',
          grantId: newId('grt', 3),
          clientId: newId('cli', 3),
          grantKind: 'delegated',
        },
        resource: 'api',
        scopes: new Set(BASELINE),
        restrictions: RESTRICTIONS.unrestricted,
      },
    }
    expect(
      await authorizer.authorize(
        owner,
        { action: 'target.get', principal: web, resource: 'api' },
        subject,
      ),
    ).toMatchObject({ allowed: false })
  })

  it('an API key is a service account credential for the REST API only', async () => {
    const key = (
      identityKind: 'human' | 'service',
      client: ClientKind,
      resource: OAuthResource,
    ): Principal => ({
      kind: 'delegated',
      identityId: IDENTITY,
      identityKind,
      label: `${identityKind} #1`,
      client,
      delegation: {
        credential: { type: 'api_key', keyId: newId('key', 2) },
        resource,
        scopes: new Set(BASELINE),
        restrictions: RESTRICTIONS.unrestricted,
      },
    })
    expect(
      await authorizer.authorize(
        owner,
        { action: 'target.get', principal: key('service', 'ci', 'api'), resource: 'api' },
        subject,
      ),
    ).toMatchObject({ allowed: true })
    for (const [kind, client, resource] of [
      ['service', 'ci', 'mcp'],
      ['human', 'cli', 'api'],
      ['human', 'mcp', 'api'],
      ['service', 'mcp', 'api'],
    ] as const) {
      expect(
        await authorizer.authorize(
          owner,
          { action: 'target.get', principal: key(kind, client, resource), resource },
          subject,
        ),
        `${kind}/${client}/${resource}`,
      ).toMatchObject({ allowed: false })
    }
  })

  it("a machine grant is a service account credential and a delegated grant a person's", async () => {
    const mismatched = (
      identityKind: 'human' | 'service',
      client: ClientKind,
      grantKind: 'delegated' | 'machine',
    ): Principal => ({
      kind: 'delegated',
      identityId: IDENTITY,
      identityKind,
      label: `${identityKind} #1`,
      client,
      delegation: {
        credential: {
          type: 'access_token',
          grantId: newId('grt', 4),
          clientId: newId('cli', 4),
          grantKind,
        },
        resource: 'api',
        scopes: new Set(BASELINE),
        restrictions: RESTRICTIONS.unrestricted,
      },
    })
    for (const [kind, client, grantKind] of [
      ['service', 'ci', 'delegated'],
      ['human', 'cli', 'machine'],
      ['human', 'ci', 'delegated'],
      ['service', 'cli', 'machine'],
    ] as const) {
      expect(
        await authorizer.admit(owner, {
          action: 'target.get',
          principal: mismatched(kind, client, grantKind),
          resource: 'api',
        }),
        `${kind}/${client}/${grantKind}`,
      ).toMatchObject({ allowed: false, reason: 'client_kind' })
    }
  })

  it('a delegated principal never reaches own-session actions and never satisfies re-authentication', async () => {
    const everything = grantsStore([{ permission: 'access.manage', scope: { kind: 'global' } }])
    for (const action of [
      'me.get',
      'auth.session.list',
      'oauth.grant.list_own',
      'oauth.consent',
    ] as const) {
      expect(
        await authorizer.admit(everything, {
          action,
          principal: delegated(CLI, SCOPE_IDS),
          resource: 'api',
        }),
        action,
      ).toMatchObject({ allowed: false })
    }
    const result = await authorizer.authorize(
      everything,
      {
        action: 'access.role_binding.create',
        principal: delegated(CLI, SCOPE_IDS),
        resource: 'api',
      },
      { kind: 'installation' },
    )
    expect(result).toMatchObject({ allowed: false, reason: 'reauth' })
    // A reauth requirement of policy stays a requirement for a delegated principal.
    const who = delegated(
      MCP,
      SCOPE_IDS.filter((s) => isScopeGrantableTo(s, 'mcp')),
    )
    const store = grantsStore([{ permission: 'migrations.apply', scope: { kind: 'global' } }])
    const authorization = await authorizer.authorize(
      store,
      { action: 'migration.apply', principal: who, resource: 'mcp' },
      { kind: 'target', targetId: T_PROD },
    )
    const decision = await withPolicy(who, authorization, async () => ({
      ...(await ALLOW_POLICY()),
      decision: 'require',
      requirements: [{ kind: 'reauth', withinSeconds: 300 }],
    }))
    expect(decision).toMatchObject({ decision: 'require', requirements: [{ kind: 'reauth' }] })
  })

  it('OAuth protocol endpoints are admitted without a principal; their own proof decides', async () => {
    for (const action of [
      'oauth.token',
      'oauth.revoke',
      'oauth.register',
      'oauth.device_authorization',
    ] as const) {
      expect(
        await authorizer.admit(grantsStore([]), {
          action,
          principal: { kind: 'anonymous', client: 'mcp' },
        }),
      ).toMatchObject({ allowed: true, permission: 'public' })
    }
  })
})

describe('grant restrictions (oauth.md §5, synthetic subject chains)', () => {
  const unrestrictedRead = { effect: 'read', subject: 'target' } as const
  const write = { effect: 'consequential', subject: 'access' } as const
  const installationRead = { effect: 'read', subject: 'installation' } as const

  it('a nonprod grant never reaches production, through a target, a plan or a container', () => {
    const r = RESTRICTIONS.nonprodOnly
    expect(restrictionDenial(r, unrestrictedRead, GRAPH[T_PROD] ?? {})).toBe('tier')
    expect(restrictionDenial(r, unrestrictedRead, GRAPH[T_NONPROD] ?? {})).toBeUndefined()
    expect(restrictionDenial(r, unrestrictedRead, { tier: 'prod' })).toBe('tier')
    expect(restrictionDenial(r, unrestrictedRead, { tier: 'nonprod' })).toBeUndefined()
    expect(restrictionDenial(r, unrestrictedRead, { productId: P1 })).toBe('restricted_scope')
    expect(restrictionDenial(r, unrestrictedRead, { productId: P1, projectId: J1 })).toBe(
      'restricted_scope',
    )
    expect(
      restrictionDenial(r, unrestrictedRead, {
        productId: P1,
        projectId: J1,
        environmentId: E_PROD,
      }),
    ).toBe('restricted_scope')
  })

  it('an unknown tier passes only a grant for both tiers', () => {
    const untiered = GRAPH[T_UNTIERED] ?? {}
    expect(restrictionDenial(RESTRICTIONS.unrestricted, unrestrictedRead, untiered)).toBeUndefined()
    expect(restrictionDenial(RESTRICTIONS.nonprodOnly, unrestrictedRead, untiered)).toBe('tier')
    expect(restrictionDenial(RESTRICTIONS.prodOnly, unrestrictedRead, untiered)).toBe('tier')
  })

  it('a target list admits only its targets, and never a plan without a target', () => {
    const r = RESTRICTIONS.listNonprod
    expect(restrictionDenial(r, unrestrictedRead, GRAPH[T_NONPROD] ?? {})).toBeUndefined()
    expect(restrictionDenial(r, unrestrictedRead, GRAPH[T_OTHER] ?? {})).toBe('target')
    expect(restrictionDenial(r, unrestrictedRead, GRAPH[T_PROD] ?? {})).toBe('target')
    expect(restrictionDenial(r, unrestrictedRead, { tier: 'nonprod' })).toBe('target')
  })

  it('a restricted grant manages nothing installation-wide; it may read the installation', () => {
    for (const name of ['nonprodOnly', 'prodOnly', 'listNonprod', 'listOther'] as const) {
      const r = RESTRICTIONS[name]
      expect(restrictionDenial(r, write, {}), name).toBe('restricted_scope')
      expect(restrictionDenial(r, { effect: 'read', subject: 'access' }, {}), name).toBe(
        'restricted_scope',
      )
      expect(restrictionDenial(r, installationRead, {}), name).toBeUndefined()
    }
    expect(restrictionDenial(RESTRICTIONS.unrestricted, write, {})).toBeUndefined()
  })

  it('the engine refuses an installation-wide action to a restricted CLI grant', async () => {
    const reader = grantsStore([{ permission: 'access.read', scope: { kind: 'global' } }])
    const restricted = delegated(CLI, ['access.read'], RESTRICTIONS.nonprodOnly)
    expect(
      await authorizer.authorize(
        reader,
        { action: 'identity.list', principal: restricted, resource: 'api' },
        { kind: 'installation' },
      ),
    ).toMatchObject({ allowed: false, reason: 'restriction' })
    expect(
      await authorizer.authorize(
        reader,
        { action: 'identity.list', principal: delegated(CLI, ['access.read']), resource: 'api' },
        { kind: 'installation' },
      ),
    ).toMatchObject({ allowed: true })
  })
})

describe('a critical plan is applied by a person only, whatever its kind (G6 finding A2)', () => {
  // `migration.rollback` and `postgres.roles.apply` are not human-only; their
  // class is decided by the plan (`by_plan`), which can make it critical.
  const holds = grantsStore([
    { permission: 'migrations.apply', scope: { kind: 'global' } },
    { permission: 'nodes.operate', scope: { kind: 'global' } },
  ])
  const subject = { kind: 'target', targetId: T_NONPROD } as const
  const apply = (who: Principal, planKind: string, planClass?: 'high' | 'critical') =>
    authorizer.authorize(
      holds,
      {
        action: 'plan.apply',
        principal: who,
        resource: 'api',
        planKind,
        ...(planClass === undefined ? {} : { planClass }),
      },
      subject,
    )

  it('refuses a service account and an MCP client on a nonprod critical plan', async () => {
    for (const caller of [CI, MCP]) {
      const who = delegated(caller, SCOPE_SETS.grantable(caller.client))
      const high = await apply(who, 'migration.rollback', 'high')
      // MCP clients cannot hold migrations.apply:nonprod for apply anyway; the
      // service account can: a high plan is its to apply.
      if (caller === CI) {
        expect(high.allowed, 'a high rollback plan by a service account').toBe(true)
      }
      const critical = await apply(who, 'migration.rollback', 'critical')
      expect(critical.allowed, `${caller.client} on a critical plan`).toBe(false)
      // Refused before the scope: a service client is no person's session client.
      expect(critical.allowed ? undefined : critical.error.code).toBe('PERMISSION_DENIED')
    }
  })

  it('lets a person through the first-party CLI apply it (the policy decides the rest)', async () => {
    const who = delegated(CLI, SCOPE_SETS.grantable('cli'))
    expect((await apply(who, 'migration.rollback', 'critical')).allowed).toBe(true)
  })

  it('takes the class the plan stored: without it the kind decides as before', async () => {
    const who = delegated(CI, SCOPE_SETS.grantable('ci'))
    expect((await apply(who, 'migration.rollback')).allowed).toBe(true)
    expect(actionDefinition('migration.rollback').humanOnly).toBe(false)
  })
})

describe('plans and operations are read by the read permission of their kind (OD-26 (c))', () => {
  const webSession: Principal = {
    kind: 'human',
    identityId: IDENTITY,
    client: 'web',
    session: {
      sessionId: newId('ses', 9),
      identityId: IDENTITY,
      labelNumber: 1,
      label: 'human #1',
      assurance: 'full',
      recoveryRequired: false,
      reauthAt: null,
      reauthAgeSeconds: null,
      reauthMethod: null,
      reauthEventId: null,
      authzRevision: 1,
      createdAt: '2026-10-12T00:00:00.000000Z',
      lastSeenAt: '2026-10-12T00:00:00.000000Z',
      idleExpiresAt: '2026-10-12T00:30:00.000000Z',
      absoluteExpiresAt: '2026-10-12T12:00:00.000000Z',
      deviceLabel: 'Firefox on Linux',
      csrfHash: `sha256:${'0'.repeat(64)}`,
    },
  }
  const onNonprod = { kind: 'target', targetId: T_NONPROD } as const
  const onOther = { kind: 'target', targetId: T_OTHER } as const
  const read = (
    store: Queryable,
    who: Principal,
    action: 'plan.get' | 'operation.get' | 'operation.list',
    planKind: string,
    subject: SubjectRef = onNonprod,
  ) =>
    authorizer.authorize(
      store,
      {
        action,
        principal: who,
        ...(who.kind === 'delegated' ? { resource: 'api' as const } : {}),
        planKind,
      },
      subject,
    )

  it('maps each kind to its domain read permission', () => {
    expect(readPermissionOfKind('migration.apply')).toBe('migrations.read')
    expect(readPermissionOfKind('ledger.reconcile')).toBe('migrations.read')
    expect(readPermissionOfKind('postgres.config.apply')).toBe('nodes.read')
    expect(readPermissionOfKind('node.enroll')).toBe('nodes.read')
    expect(readPermissionOfKind('access.role_binding.create')).toBe('access.read')
    expect(readPermissionOfKind('backup.run')).toBe('backups.read')
    expect(readPermissionOfKind('target.register')).toBe('targets.read')
    expect(readPermissionOfKind('registry.product.create')).toBe('targets.read')
    expect(readPermissionOfKind('registry.cluster.register')).toBe('nodes.read')
    expect(readPermissionOfKind('registry.server.create')).toBe('nodes.read')
    for (const kind of ACTION_IDS) {
      expect([
        'targets.read',
        'migrations.read',
        'nodes.read',
        'access.read',
        'backups.read',
        'diagnostics.read',
        'schema.read',
      ]).toContain(readPermissionOfKind(kind))
    }
  })

  it('reads with the domain permission at a covering scope and nowhere else', async () => {
    const store = grantsStore([{ permission: 'migrations.read', scope: BINDINGS.targetNonprod }])
    for (const action of ['plan.get', 'operation.get', 'operation.list'] as const) {
      expect((await read(store, webSession, action, 'migration.apply')).allowed, action).toBe(true)
      expect((await read(store, webSession, action, 'migration.apply', onOther)).allowed).toBe(
        false,
      )
      // Another domain's kind on the same target: not readable with migrations.read.
      expect((await read(store, webSession, action, 'postgres.config.apply')).allowed).toBe(false)
      expect((await read(store, webSession, action, 'target.register')).allowed).toBe(false)
    }
  })

  it('lets an approver read through a Web App session only, and only where it may approve', async () => {
    const store = grantsStore([{ permission: 'plans.approve', scope: BINDINGS.targetNonprod }])
    expect((await read(store, webSession, 'plan.get', 'migration.apply')).allowed).toBe(true)
    expect((await read(store, webSession, 'plan.get', 'migration.apply', onOther)).allowed).toBe(
      false,
    )
    for (const caller of [CLI, MCP, CI]) {
      const who = delegated(caller, SCOPE_SETS.catalog())
      expect((await read(store, who, 'plan.get', 'migration.apply')).allowed, caller.client).toBe(
        false,
      )
    }
  })

  it('tries the approver rule at the subject when the domain grant does not cover it', async () => {
    const store = grantsStore([
      { permission: 'migrations.read', scope: { kind: 'target', targetId: T_OTHER } },
      { permission: 'plans.approve', scope: BINDINGS.targetNonprod },
    ])
    expect((await read(store, webSession, 'operation.get', 'migration.apply')).allowed).toBe(true)
    expect(
      (await read(store, webSession, 'operation.get', 'migration.apply', onOther)).allowed,
    ).toBe(true)
    expect(
      (
        await read(store, webSession, 'operation.get', 'migration.apply', {
          kind: 'target',
          targetId: T_PROD,
        })
      ).allowed,
    ).toBe(false)
  })

  it('needs the delegated scope of the domain read permission', async () => {
    const store = grantsStore([{ permission: 'migrations.read', scope: BINDINGS.global }])
    const without = delegated(CLI, BASELINE)
    const withScope = delegated(CLI, [...BASELINE, 'migrations.read'])
    expect((await read(store, without, 'operation.list', 'migration.apply')).allowed).toBe(false)
    expect((await read(store, withScope, 'operation.list', 'migration.apply')).allowed).toBe(true)
    // A restricted delegation does not see a target outside its list.
    const restricted = delegated(CLI, [...BASELINE, 'migrations.read'], RESTRICTIONS.listOther)
    const outside = await read(store, restricted, 'operation.get', 'migration.apply')
    expect(outside.allowed ? undefined : outside.error.code).toBe('TARGET_NOT_FOUND')
  })

  it('refuses a caller without a kind or with an unknown kind', async () => {
    const store = grantsStore([{ permission: 'targets.read', scope: BINDINGS.global }])
    expect((await read(store, webSession, 'plan.get', 'no.such_kind')).allowed).toBe(false)
  })
})

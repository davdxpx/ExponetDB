import {
  ACTION_IDS,
  type ActionId,
  actionDefinition,
  type BindingScope,
  CLIENT_KINDS,
  type ClientKind,
  isScope,
  type Permission,
  scopeDefinition,
} from '@exponetdb/contracts'
import { type Queryable, Row } from '@exponetdb/control-store'
import { type IdentityId, newId } from '@exponetdb/kernel'
import type { PolicyDecision, Requirement } from '@exponetdb/policy'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  type AuthorizationDecision,
  Authorizer,
  ControlPlaneSubjectResolver,
  type Principal,
  type SessionContext,
  type SubjectChain,
  type SubjectRef,
  withPolicy,
} from '../src/index.ts'

/**
 * The G3A authorization matrix (order §57): permission × binding scope ×
 * tier × client kind × identity kind × policy × re-authentication, over a
 * synthetic subject graph (Wave 4 brings the registry). Every combination
 * is decided by the engine and compared with an independent oracle written
 * from authorization.md §1 and §5; the safety assertion is that nothing is
 * allowed that any single condition forbids.
 */
const P1 = newId('prd', 1)
const P2 = newId('prd', 2)
const J1 = newId('prj', 3)
const J2 = newId('prj', 4)
const E_NONPROD = newId('env', 5)
const E_PROD = newId('env', 6)
const E_OTHER = newId('env', 7)
const T_NONPROD = newId('tgt', 8)
const T_PROD = newId('tgt', 9)
const T_UNTIERED = newId('tgt', 10)
const T_OTHER = newId('tgt', 11)
const T_MISSING = newId('tgt', 12)

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

const resolver = new ControlPlaneSubjectResolver(async (id) => GRAPH[id])
const authorizer = new Authorizer(resolver)

const BINDINGS: Record<string, BindingScope> = {
  global: { kind: 'global' },
  productMatch: { kind: 'product', productId: P1 },
  productMismatch: { kind: 'product', productId: P2 },
  projectMatch: { kind: 'project', projectId: J1 },
  projectMismatch: { kind: 'project', projectId: J2 },
  environmentNonprod: { kind: 'environment', environmentId: E_NONPROD },
  environmentProd: { kind: 'environment', environmentId: E_PROD },
  targetNonprod: { kind: 'target', targetId: T_NONPROD },
  targetProd: { kind: 'target', targetId: T_PROD },
}

/** A Control Store stand-in that answers only the grants query, from the given bindings. */
function grantsStore(
  grants: readonly { permission: Permission; scope: BindingScope }[],
): Queryable {
  return {
    async query(queryClass) {
      if (queryClass !== 'auth.grants.load') {
        throw new Error(`unexpected query ${queryClass}`)
      }
      const rows = grants.map((g, i) => {
        const scopeId =
          g.scope.kind === 'global'
            ? null
            : g.scope.kind === 'product'
              ? g.scope.productId
              : g.scope.kind === 'project'
                ? g.scope.projectId
                : g.scope.kind === 'environment'
                  ? g.scope.environmentId
                  : g.scope.targetId
        return new Row({
          binding_id: newId('rlb', 1000 + i),
          role_id: 'custom',
          scope_kind: g.scope.kind,
          scope_id: scopeId,
          permission: g.permission,
        })
      })
      return { rows, rowCount: rows.length }
    },
  }
}

const IDENTITY: IdentityId = newId('idn', 99)

function session(reauth: 'fresh' | 'stale' | 'absent'): SessionContext {
  return {
    sessionId: newId('ses', 1),
    identityId: IDENTITY,
    labelNumber: 1,
    label: 'human #1',
    assurance: 'full',
    recoveryRequired: false,
    reauthAt: reauth === 'absent' ? null : '2026-10-05T00:00:00.000000Z',
    reauthAgeSeconds: reauth === 'fresh' ? 30 : reauth === 'stale' ? 3600 : null,
    reauthMethod: reauth === 'absent' ? null : 'passkey',
    reauthEventId: reauth === 'absent' ? null : newId('rau', 1),
    authzRevision: 1,
    createdAt: '2026-10-05T00:00:00.000000Z',
    lastSeenAt: '2026-10-05T00:00:00.000000Z',
    idleExpiresAt: '2026-10-05T00:30:00.000000Z',
    absoluteExpiresAt: '2026-10-05T12:00:00.000000Z',
    deviceLabel: 'Chrome on Linux',
    csrfHash: `sha256:${'0'.repeat(64)}`,
  }
}

function principal(
  kind: 'human' | 'service',
  client: ClientKind,
  reauth: 'fresh' | 'stale' | 'absent',
): Principal {
  return kind === 'human'
    ? { kind: 'human', identityId: IDENTITY, client, session: session(reauth) }
    : { kind: 'service', identityId: IDENTITY, client }
}

type PolicyCase = 'allow' | 'require_satisfied' | 'require_missing' | 'deny' | 'error'
const APPROVAL: Requirement = { kind: 'approval', count: 1, permission: 'plans.approve' }

function policy(kind: PolicyCase): () => Promise<PolicyDecision> {
  const base: PolicyDecision = {
    decision: 'allow',
    requirements: [],
    rules: [],
    overriddenRules: [],
    policyVersion: `sha256:pv1:${'a'.repeat(64)}`,
    evaluatedAt: '2026-10-05T00:00:00.000Z',
  }
  switch (kind) {
    case 'allow':
      return async () => base
    case 'require_satisfied':
      return async () => ({
        ...base,
        decision: 'require',
        requirements: [{ kind: 'reauth', withinSeconds: 300 }],
      })
    case 'require_missing':
      return async () => ({ ...base, decision: 'require', requirements: [APPROVAL] })
    case 'deny':
      return async () => ({
        ...base,
        decision: 'deny',
        rules: [
          {
            id: 'test.deny',
            version: 1,
            result: 'fail',
            severity: 'deny',
            message: 'no',
            facts: {},
            overridableByBreakGlass: false,
            requirements: [],
          },
        ],
      })
    case 'error':
      return async () => {
        throw new Error('policy store down')
      }
  }
}

const SUBJECTS: Record<string, SubjectRef> = {
  nonprod: { kind: 'target', targetId: T_NONPROD },
  prod: { kind: 'target', targetId: T_PROD },
  untiered: { kind: 'target', targetId: T_UNTIERED },
  missing: { kind: 'target', targetId: T_MISSING },
}

function covers(scope: BindingScope, chain: SubjectChain | undefined): boolean {
  if (chain === undefined) {
    return false
  }
  return (
    scope.kind === 'global' ||
    (scope.kind === 'product' && chain.productId === scope.productId) ||
    (scope.kind === 'project' && chain.projectId === scope.projectId) ||
    (scope.kind === 'environment' && chain.environmentId === scope.environmentId) ||
    (scope.kind === 'target' && chain.targetId === scope.targetId)
  )
}

/** The oracle, written from the documentation, not from the engine. */
function expected(input: {
  action: ActionId
  holds: boolean
  binding: BindingScope
  subject: string
  client: ClientKind
  identity: 'human' | 'service'
  policy: PolicyCase
  reauth: 'fresh' | 'stale' | 'absent'
}): 'allow' | 'require' | 'deny' {
  const def = actionDefinition(input.action)
  if (def.permission.kind !== 'fixed') {
    throw new Error('matrix actions have fixed permissions')
  }
  const target = SUBJECTS[input.subject]
  const chain = target?.kind === 'target' ? GRAPH[target.targetId] : undefined
  const human = input.identity === 'human'
  if (!def.clientKinds.includes(input.client)) return 'deny'
  if (def.humanOnly && !(human && (input.client === 'web' || input.client === 'cli'))) return 'deny'
  if (def.scope.kind === 'fixed') {
    const scope = isScope(def.scope.scope) ? scopeDefinition(def.scope.scope) : undefined
    if (
      scope === undefined ||
      !scope.clientKinds.includes(input.client) ||
      (scope.humanOnly && !human)
    ) {
      return 'deny'
    }
  }
  if (!input.holds) return 'deny'
  if (chain === undefined) return 'deny'
  if (def.tierSemantics !== 'none' && chain.tier === undefined) return 'deny'
  if (def.scope.kind === 'tiered') {
    if (chain.tier === undefined) return 'deny'
    const name = `${def.scope.permission}:${chain.tier}`
    if (!isScope(name) || !scopeDefinition(name).clientKinds.includes(input.client)) return 'deny'
  }
  if (!covers(input.binding, chain)) return 'deny'
  const fresh = human && input.reauth === 'fresh'
  if (def.reauthentication && !fresh) return 'deny'
  switch (input.policy) {
    case 'deny':
    case 'error':
      return 'deny'
    case 'require_satisfied':
      return fresh ? 'allow' : 'require'
    case 'require_missing':
      return 'require'
    case 'allow':
      return 'allow'
  }
}

const MATRIX_ACTIONS: readonly ActionId[] = [
  'target.get',
  'query.run',
  'migration.apply',
  'operation.force_release',
  'drift.accept',
]

async function decide(input: Parameters<typeof expected>[0]): Promise<AuthorizationDecision> {
  const def = actionDefinition(input.action)
  if (def.permission.kind !== 'fixed') {
    throw new Error('fixed permission expected')
  }
  const store = grantsStore(
    input.holds ? [{ permission: def.permission.permission, scope: input.binding }] : [],
  )
  const who = principal(input.identity, input.client, input.reauth)
  const subject = SUBJECTS[input.subject]
  if (subject === undefined) {
    throw new Error('subject')
  }
  const authorization = await authorizer.authorize(
    store,
    { action: input.action, principal: who },
    subject,
  )
  return withPolicy(who, authorization, policy(input.policy))
}

describe('authorization matrix (G3A §57)', () => {
  // Exhaustive: every action × grant × binding × subject × client kind ×
  // identity kind × policy outcome × re-authentication state. Under a loaded
  // CI runner this CPU-bound walk takes seconds, so it gets the same budget as
  // the Argon2id tests instead of the 5-second default.
  it('decides every combination exactly as the documented formula, with no accidental allow', async () => {
    let allowed = 0
    let total = 0
    for (const action of MATRIX_ACTIONS) {
      for (const holds of [true, false]) {
        for (const binding of Object.values(BINDINGS)) {
          for (const subject of Object.keys(SUBJECTS)) {
            for (const client of CLIENT_KINDS) {
              for (const identity of ['human', 'service'] as const) {
                for (const policyCase of [
                  'allow',
                  'require_satisfied',
                  'require_missing',
                  'deny',
                  'error',
                ] as const) {
                  for (const reauth of ['fresh', 'stale', 'absent'] as const) {
                    const input = {
                      action,
                      holds,
                      binding,
                      subject,
                      client,
                      identity,
                      policy: policyCase,
                      reauth,
                    }
                    const result = await decide(input)
                    const want = expected(input)
                    total += 1
                    if (result.decision !== want) {
                      throw new Error(
                        `mismatch ${JSON.stringify(input)}: got ${result.decision}, want ${want}`,
                      )
                    }
                    if (result.decision === 'allow') {
                      allowed += 1
                      // Independent safety checks for every allow.
                      const def = actionDefinition(action)
                      const target = SUBJECTS[subject]
                      const chain = target?.kind === 'target' ? GRAPH[target.targetId] : undefined
                      expect(holds).toBe(true)
                      expect(covers(binding, chain)).toBe(true)
                      expect(def.clientKinds).toContain(client)
                      expect(policyCase === 'allow' || policyCase === 'require_satisfied').toBe(
                        true,
                      )
                      if (def.humanOnly) expect(identity).toBe('human')
                      if (def.reauthentication) expect(reauth).toBe('fresh')
                      if (def.tierSemantics !== 'none') expect(chain?.tier).toBeDefined()
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(total).toBe(MATRIX_ACTIONS.length * 2 * 9 * 4 * 4 * 2 * 5 * 3)
    expect(allowed).toBeGreaterThan(0)
  }, 30_000)

  it('a nonprod environment binding never reaches a prod target, and a prod binding never a nonprod one', async () => {
    for (const [binding, subject, want] of [
      ['environmentNonprod', 'prod', 'deny'],
      ['environmentProd', 'nonprod', 'deny'],
      ['targetNonprod', 'prod', 'deny'],
      ['environmentNonprod', 'nonprod', 'allow'],
    ] as const) {
      const result = await decide({
        action: 'migration.apply',
        holds: true,
        binding: BINDINGS[binding] ?? { kind: 'global' },
        subject,
        client: 'web',
        identity: 'human',
        policy: 'allow',
        reauth: 'fresh',
      })
      expect(result.decision, `${binding} → ${subject}`).toBe(want)
    }
  })

  it('an unresolvable subject denies; it is never treated as global', async () => {
    const result = await decide({
      action: 'target.get',
      holds: true,
      binding: { kind: 'global' },
      subject: 'missing',
      client: 'web',
      identity: 'human',
      policy: 'allow',
      reauth: 'fresh',
    })
    expect(result).toMatchObject({ decision: 'deny', reason: 'subject_unresolved' })
    const noRegistry = new Authorizer(new ControlPlaneSubjectResolver())
    const store = grantsStore([{ permission: 'targets.read', scope: { kind: 'global' } }])
    expect(
      await noRegistry.authorize(
        store,
        { action: 'target.get', principal: principal('human', 'web', 'fresh') },
        { kind: 'target', targetId: T_NONPROD },
      ),
    ).toMatchObject({ allowed: false, reason: 'subject_unresolved' })
  })

  it('decisions do not depend on the order of bindings (property)', async () => {
    const scopes = Object.values(BINDINGS)
    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray(scopes, { minLength: 0, maxLength: scopes.length }),
        fc.constantFrom(...Object.keys(SUBJECTS)),
        async (bindings, subject) => {
          const grants = bindings.map((scope) => ({ permission: 'data.read' as const, scope }))
          const who = principal('human', 'web', 'fresh')
          const ref = SUBJECTS[subject] ?? { kind: 'installation' }
          const forward = await authorizer.authorize(
            grantsStore(grants),
            { action: 'query.run', principal: who },
            ref,
          )
          const backward = await authorizer.authorize(
            grantsStore([...grants].reverse()),
            { action: 'query.run', principal: who },
            ref,
          )
          expect(forward.allowed).toBe(backward.allowed)
        },
      ),
      { numRuns: 200 },
    )
  })
})

describe('human-only actions (G3A §59)', () => {
  it('are never authorized for mcp, ci or a service account, whatever they hold', async () => {
    const humanOnly = ACTION_IDS.filter((id) => {
      const def = actionDefinition(id)
      return def.humanOnly && def.permission.kind === 'fixed'
    })
    expect(humanOnly.length).toBeGreaterThan(10)
    for (const action of humanOnly) {
      const def = actionDefinition(action)
      if (def.permission.kind !== 'fixed') continue
      const store = grantsStore([
        { permission: def.permission.permission, scope: { kind: 'global' } },
      ])
      const callers: Principal[] = [
        principal('human', 'mcp', 'fresh'),
        principal('human', 'ci', 'fresh'),
        principal('service', 'web', 'fresh'),
        principal('service', 'cli', 'fresh'),
        principal('service', 'mcp', 'fresh'),
        principal('service', 'ci', 'fresh'),
      ]
      for (const who of callers) {
        const admission = await authorizer.admit(store, { action, principal: who })
        expect(admission.allowed, `${action} for ${who.kind}/${who.client}`).toBe(false)
      }
    }
  })

  it('an owner without a fresh re-authentication cannot run a re-authentication action (no owner bypass)', async () => {
    const def = actionDefinition('access.role_binding.create')
    expect(def.reauthentication).toBe(true)
    const owner = grantsStore([{ permission: 'access.manage', scope: { kind: 'global' } }])
    for (const reauth of ['stale', 'absent'] as const) {
      const result = await authorizer.authorize(
        owner,
        { action: 'access.role_binding.create', principal: principal('human', 'web', reauth) },
        { kind: 'installation' },
      )
      expect(result).toMatchObject({ allowed: false, reason: 'reauth' })
    }
  })

  it('a recovery session may only set up factors', async () => {
    const recovery: Principal = {
      kind: 'human',
      identityId: IDENTITY,
      client: 'web',
      session: { ...session('fresh'), assurance: 'recovery', reauthMethod: 'recovery_code' },
    }
    const all = grantsStore([{ permission: 'access.read', scope: { kind: 'global' } }])
    expect(
      await authorizer.admit(all, { action: 'identity.list', principal: recovery }),
    ).toMatchObject({
      allowed: false,
      reason: 'recovery_session',
    })
    expect(
      await authorizer.authorize(
        all,
        { action: 'auth.passkey.add', principal: recovery },
        { kind: 'self', identityId: IDENTITY },
      ),
    ).toMatchObject({ allowed: true })
  })

  it('a self action never acts on another identity, and the session scope is no wildcard', async () => {
    const who = principal('human', 'web', 'fresh')
    const empty = grantsStore([])
    expect(
      await authorizer.authorize(
        empty,
        { action: 'auth.session.list', principal: who },
        { kind: 'self', identityId: newId('idn', 5) },
      ),
    ).toMatchObject({ allowed: false, reason: 'not_self' })
    // Holding only session-equivalent access (no permission) allows nothing permission-bound.
    expect(
      await authorizer.admit(empty, { action: 'identity.list', principal: who }),
    ).toMatchObject({
      allowed: false,
      reason: 'no_permission',
    })
    expect(
      await authorizer.admit(empty, {
        action: 'auth.session.list',
        principal: principal('human', 'cli', 'fresh'),
      }),
    ).toMatchObject({
      allowed: false,
    })
  })

  it('an unknown action denies', async () => {
    expect(
      await authorizer.admit(grantsStore([]), {
        action: 'access.everything',
        principal: principal('human', 'web', 'fresh'),
      }),
    ).toMatchObject({ allowed: false, reason: 'unknown_action' })
  })
})

import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ACTION_IDS,
  ACTIONS,
  type ActionId,
  AuditChainSchema,
  AVATAR_MAX_BYTES,
  AvatarRefSchema,
  buildOpenApi,
  contractJsonSchema,
  DriftAcceptRequestSchema,
  GRANT_USE_CLASS_VALUES,
  GrantViewSchema,
  InstallationHealthSchema,
  isScramSha256Verifier,
  isWriteScope,
  MCP_TOOL_LIST,
  MeSchema,
  MigrationStreamSchema,
  NodeCertificatesSchema,
  NodeJobSchema,
  OperationReadSchema,
  OperationSchema,
  PlanReadSchema,
  PlanViewSchema,
  ProfileDisplayNameSchema,
  ProfileUpdateRequestSchema,
  ProfileViewSchema,
  ROUTE_LIST,
  RoleVerifierSubmissionSchema,
  SavedQueryCreateRequestSchema,
  SavedQueryUpdateRequestSchema,
  TargetHealthHistorySchema,
} from '../src/index.ts'

const PRJ = 'prj_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z'

/** A SCRAM-SHA-256 verifier as libpq and PostgreSQL compute it (RFC 5802, 4096 iterations). */
function scramVerifierFor(password: string): string {
  const salt = randomBytes(16)
  const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256')
  const storedKey = createHash('sha256')
    .update(createHmac('sha256', salted).update('Client Key').digest())
    .digest()
  const serverKey = createHmac('sha256', salted).update('Server Key').digest()
  const b64 = (b: Buffer) => b.toString('base64')
  return `SCRAM-SHA-256$4096:${b64(salt)}$${b64(storedKey)}:${b64(serverKey)}`
}

/**
 * The Wave 8 server batch S1 (order §9): eight additive read endpoints. The
 * contract side: the actions reuse existing permissions and are no MCP
 * tools, the routes are where the resources document says, the new response
 * fields are optional and stay out of the MCP announcements, and no response
 * names a bucket, a file location, a build, a signature or an envelope.
 */
const WAVE8: readonly [ActionId, string][] = [
  ['target.health.history.get', 'diagnostics.read'],
  ['node.job.list', 'nodes.read'],
  ['node.certificate.list', 'nodes.read'],
  ['audit.chain.get', 'audit.read'],
  ['fleet.get', 'targets.read'],
  ['finding.list', 'diagnostics.read'],
  ['sql.classify', 'migrations.read'],
]

/** Break-glass list and review (order §9): owner and admin through `policy.manage`, human sessions only. */
const BREAK_GLASS: readonly ActionId[] = ['breakglass.list', 'breakglass.review']
/** Order §9 endpoint 3: drift acceptance, a planned operation for a person only. */
const DRIFT_ACCEPT: readonly ActionId[] = ['drift.accept', 'drift.accept.plan']
/**
 * Endpoints 6 and 7 (query history and saved queries): reads decided on
 * `data.read` at the subject's tier, and the saved query changes as a
 * person's own records in the Web App (self-service, scope `api`), so no
 * `data.read` scope becomes a write scope.
 */
const WAVE8_QUERY_READS: readonly ActionId[] = [
  'query.history.list',
  'saved_query.list',
  'saved_query.get',
]
const WAVE8_QUERY_CHANGES: readonly ActionId[] = [
  'saved_query.create',
  'saved_query.update',
  'saved_query.delete',
]

/** OD-22 (extended 2026-10-13, owner decision S4): the declared tier of a cluster, a registry plan and its kind. */
const WAVE8_REGISTRY: readonly ActionId[] = [
  'registry.cluster.declare_tier',
  'registry.cluster.declare_tier.plan',
]

/** The audit export (owner decision 2026-10-13): see audit-export.test.ts. */
const AUDIT_EXPORT: readonly ActionId[] = ['audit.export']

/** The raw statement view (owner decision S2): `diagnostics.read_sensitive`, a person in the Web App. */
const RAW_STATEMENT: readonly ActionId[] = ['statement.raw.get']

/** Role verifiers (owner decision S3): a write-only submission that plans a node operation. */
const ROLE_VERIFIERS: readonly ActionId[] = [
  'postgres.roles.verifier.plan',
  'postgres.roles.verifier.set',
]

/** The own profile (owner decision S10): self-service changes and the picture read. */
const PROFILE_CHANGES: readonly ActionId[] = [
  'me.avatar.delete',
  'me.avatar.set',
  'me.profile.update',
]
const PROFILE_READS: readonly ActionId[] = ['identity.avatar.get']

function propertyNames(schema: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(schema)) {
    for (const s of schema) propertyNames(s, out)
    return out
  }
  if (typeof schema !== 'object' || schema === null) return out
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'properties' && typeof v === 'object' && v !== null) {
      for (const name of Object.keys(v)) out.add(name)
    }
    propertyNames(v, out)
  }
  return out
}

const names = (schema: Parameters<typeof contractJsonSchema>[0]) =>
  propertyNames(contractJsonSchema(schema, { io: 'output' }))

describe('Wave 8 actions', () => {
  it('are reads of an existing permission, REST only, and no MCP tool binds them', () => {
    for (const [id, permission] of WAVE8) {
      const a = ACTIONS[id]
      expect(a.wave, id).toBe('8')
      expect(a.effect, id).toBe('read')
      expect(a.permission, id).toEqual({ kind: 'fixed', permission })
      expect(a.scope, id).toEqual({ kind: 'fixed', scope: permission })
      expect(a.clientKinds, id).not.toContain('mcp')
      expect(
        MCP_TOOL_LIST.some((t) => t.action === id),
        id,
      ).toBe(false)
    }
    // The only actions of wave 8 are these: a new one is a decision to review.
    expect(ACTION_IDS.filter((id) => ACTIONS[id].wave === '8').sort()).toEqual(
      [
        ...WAVE8.map(([id]) => id),
        ...AUDIT_EXPORT,
        ...BREAK_GLASS,
        ...DRIFT_ACCEPT,
        ...PROFILE_CHANGES,
        ...PROFILE_READS,
        ...RAW_STATEMENT,
        ...ROLE_VERIFIERS,
        ...WAVE8_QUERY_READS,
        ...WAVE8_QUERY_CHANGES,
        ...WAVE8_REGISTRY,
      ].sort(),
    )
  })

  it('decide the query history and saved query reads on data.read at the tier, REST only, no MCP tool', () => {
    for (const id of WAVE8_QUERY_READS) {
      const a = ACTIONS[id]
      expect(a.effect, id).toBe('read')
      expect(a.permission, id).toEqual({ kind: 'fixed', permission: 'data.read' })
      expect(a.scope, id).toEqual({ kind: 'tiered', permission: 'data.read' })
      expect(a.tierSemantics, id).toBe('subject')
      expect(a.clientKinds, id).toEqual(['web', 'cli', 'ci'])
      expect(
        MCP_TOOL_LIST.some((t) => t.action === id),
        id,
      ).toBe(false)
    }
  })

  it('make saved query changes own records of a person in the Web App; data.read stays a read scope', () => {
    for (const id of WAVE8_QUERY_CHANGES) {
      const a = ACTIONS[id]
      expect(a.effect, id).toBe('control_record')
      expect(a.permission, id).toEqual({ kind: 'self' })
      expect(a.scope, id).toEqual({ kind: 'fixed', scope: 'api' })
      expect(a.clientKinds, id).toEqual(['web'])
      expect(a.humanOnly, id).toBe(true)
      expect(MCP_TOOL_LIST.some((t) => t.action === id)).toBe(false)
    }
    expect(isWriteScope('data.read:prod')).toBe(false)
    expect(isWriteScope('data.read:nonprod')).toBe(false)
  })

  it('route the history under the target and the saved queries at their own collection', () => {
    const route = (operationId: string) => ROUTE_LIST.find((r) => r.operationId === operationId)
    expect(
      [
        'listQueryHistory',
        'listSavedQueries',
        'createSavedQuery',
        'getSavedQuery',
        'updateSavedQuery',
        'deleteSavedQuery',
      ].map((id) => [id, route(id)?.method, route(id)?.path, route(id)?.action]),
    ).toEqual([
      ['listQueryHistory', 'get', '/targets/{target}/queries/history', 'query.history.list'],
      ['listSavedQueries', 'get', '/saved-queries', 'saved_query.list'],
      ['createSavedQuery', 'post', '/saved-queries', 'saved_query.create'],
      ['getSavedQuery', 'get', '/saved-queries/{savedQueryId}', 'saved_query.get'],
      ['updateSavedQuery', 'put', '/saved-queries/{savedQueryId}', 'saved_query.update'],
      ['deleteSavedQuery', 'delete', '/saved-queries/{savedQueryId}', 'saved_query.delete'],
    ])
    expect(route('updateSavedQuery')?.errors).toContain('CONFLICT')
  })

  it('bound a saved query: a one-line name of at most 120 characters, a text of at most 65,536', () => {
    const ok = { name: 'Orders today', sql: 'select 1', scope: { kind: 'project', projectId: PRJ } }
    expect(SavedQueryCreateRequestSchema.safeParse(ok).success).toBe(true)
    expect(SavedQueryCreateRequestSchema.parse(ok).visibility).toBe('personal')
    for (const name of [
      '',
      'x'.repeat(121),
      'a\nb',
      'tab\there',
      `bidi${String.fromCharCode(0x202e)}`,
    ]) {
      expect(SavedQueryCreateRequestSchema.safeParse({ ...ok, name }).success, name).toBe(false)
    }
    expect(SavedQueryCreateRequestSchema.safeParse({ ...ok, sql: '' }).success).toBe(false)
    expect(
      SavedQueryCreateRequestSchema.safeParse({ ...ok, sql: 'x'.repeat(65_537) }).success,
    ).toBe(false)
    expect(
      SavedQueryCreateRequestSchema.safeParse({ ...ok, sql: 'x'.repeat(65_536) }).success,
    ).toBe(true)
    // Strict: an owner, a revision or a time cannot be sent.
    expect(
      SavedQueryCreateRequestSchema.safeParse({ ...ok, ownerIdentityId: 'idn_x' }).success,
    ).toBe(false)
    expect(
      SavedQueryUpdateRequestSchema.safeParse({ name: 'n', sql: 's', visibility: 'project' })
        .success,
    ).toBe(false)
  })

  it('have routes: GET, the documented paths, the static node path before the node id', () => {
    const route = (operationId: string) => ROUTE_LIST.find((r) => r.operationId === operationId)
    expect(
      [
        'getInstallationHealth',
        'getTargetHealthHistory',
        'getAuditChain',
        'listNodeJobs',
        'listNodeCertificates',
        'getMigrationStream',
      ].map((id) => [id, route(id)?.method, route(id)?.path]),
    ).toEqual([
      ['getInstallationHealth', 'get', '/installation/health'],
      ['getTargetHealthHistory', 'get', '/targets/{target}/health/history'],
      ['getAuditChain', 'get', '/audit-events/chain'],
      ['listNodeJobs', 'get', '/nodes/{nodeId}/jobs'],
      ['listNodeCertificates', 'get', '/nodes/certificates'],
      ['getMigrationStream', 'get', '/projects/{projectId}/migrations'],
    ])
    expect(route('getTargetHealthHistory')?.action).toBe('target.health.history.get')
    expect(route('getMigrationStream')?.action).toBe('migration.stream.get')
    // Hono answers with the first route that matches: `certificates` must come before `{nodeId}`.
    const order = ROUTE_LIST.map((r) => r.operationId)
    expect(order.indexOf('listNodeCertificates')).toBeLessThan(order.indexOf('getNode'))
  })
})

describe('the own profile (owner decision S10)', () => {
  it('changes as own records of a person in the Web App, without re-authentication, no MCP tool', () => {
    for (const id of PROFILE_CHANGES) {
      const a = ACTIONS[id]
      expect(a.effect, id).toBe('control_record')
      expect(a.permission, id).toEqual({ kind: 'self' })
      expect(a.scope, id).toEqual({ kind: 'fixed', scope: 'api' })
      expect(a.clientKinds, id).toEqual(['web'])
      expect([a.humanOnly, a.reauthentication], id).toEqual([true, false])
      expect(MCP_TOOL_LIST.some((t) => t.action === id)).toBe(false)
    }
    const read = ACTIONS['identity.avatar.get']
    expect(read.effect).toBe('read')
    expect(read.permission).toEqual({ kind: 'fixed', permission: 'access.read' })
    expect(read.clientKinds).toEqual(['web', 'cli'])
    expect(MCP_TOOL_LIST.some((t) => t.action === 'identity.avatar.get')).toBe(false)
  })

  it('routes the profile under /me and the picture under the identity, raw bytes both ways', () => {
    const route = (operationId: string) => ROUTE_LIST.find((r) => r.operationId === operationId)
    expect(
      ['updateMyProfile', 'setMyAvatar', 'deleteMyAvatar', 'getIdentityAvatar'].map((id) => [
        id,
        route(id)?.method,
        route(id)?.path,
        route(id)?.action,
      ]),
    ).toEqual([
      ['updateMyProfile', 'put', '/me/profile', 'me.profile.update'],
      ['setMyAvatar', 'put', '/me/avatar', 'me.avatar.set'],
      ['deleteMyAvatar', 'delete', '/me/avatar', 'me.avatar.delete'],
      ['getIdentityAvatar', 'get', '/identities/{identityId}/avatar', 'identity.avatar.get'],
    ])
    expect(route('updateMyProfile')?.errors).toContain('CONFLICT')
    const upload = route('setMyAvatar')
    expect(upload?.body).toBeUndefined()
    expect(upload?.rawBody?.mediaTypes).toEqual(['image/png', 'image/jpeg', 'image/webp'])
    expect(upload?.maxBodyBytes).toBe(AVATAR_MAX_BYTES)
    expect(AVATAR_MAX_BYTES).toBe(256 * 1024)
    expect(route('getIdentityAvatar')?.rawResponse?.mediaTypes).toEqual([
      'image/png',
      'image/jpeg',
      'image/webp',
    ])
    // No SVG, no GIF, no other type anywhere.
    const doc = JSON.stringify(buildOpenApi())
    expect(doc).not.toContain('image/svg')
    expect(doc).not.toContain('image/gif')
  })

  it('bounds the display name: one line of 1 to 64 characters, no control or formatting character', () => {
    for (const ok of ['Ada', 'Grace Hopper', 'x'.repeat(64), 'Zoë Ångström', '山田 太郎']) {
      expect(ProfileDisplayNameSchema.safeParse(ok).success, ok).toBe(true)
    }
    for (const bad of [
      '',
      'x'.repeat(65),
      'a\nb',
      'tab\there',
      ' leading',
      'trailing ',
      '   ',
      `bidi${String.fromCharCode(0x202e)}`,
      `isolate${String.fromCharCode(0x2066)}`,
      `zero${String.fromCharCode(0x200b)}width`,
      `bom${String.fromCharCode(0xfeff)}`,
      `c1${String.fromCharCode(0x85)}`,
    ]) {
      expect(ProfileDisplayNameSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
    expect(ProfileUpdateRequestSchema.safeParse({ displayName: null, revision: 0 }).success).toBe(
      true,
    )
    // Strict: a picture, an identity or a time cannot be sent with the name.
    expect(
      ProfileUpdateRequestSchema.safeParse({ displayName: 'Ada', revision: 1, avatar: null })
        .success,
    ).toBe(false)
    expect(ProfileUpdateRequestSchema.safeParse({ displayName: 'Ada' }).success).toBe(false)
  })

  it('names a picture by a same-origin path keyed by its hash, and adds the profile to /me optionally', () => {
    const sha = `sha256:${'a'.repeat(64)}`
    const ok = {
      url: `/api/v1/identities/idn_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z/avatar?v=${sha}`,
      sha256: sha,
      width: 64,
      height: 64,
    }
    expect(AvatarRefSchema.safeParse(ok).success).toBe(true)
    for (const url of [
      `https://cdn.example.com/a.png?v=${sha}`,
      `//example.com/api/v1/identities/idn_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z/avatar?v=${sha}`,
      `/api/v1/identities/idn_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z/avatar`,
      `javascript:alert(1)`,
    ]) {
      expect(AvatarRefSchema.safeParse({ ...ok, url }).success, url).toBe(false)
    }
    expect(AvatarRefSchema.safeParse({ ...ok, width: 1025 }).success).toBe(false)
    expect(names(ProfileViewSchema)).toEqual(
      new Set([
        'identityId',
        'displayName',
        'avatar',
        'url',
        'sha256',
        'width',
        'height',
        'revision',
        'updatedAt',
      ]),
    )
    const root = contractJsonSchema(MeSchema, { io: 'output' })
    const defs = (root['$defs'] ?? {}) as Record<string, { required?: string[] }>
    const ref = typeof root['$ref'] === 'string' ? root['$ref'].replace('#/$defs/', '') : ''
    const required = defs[ref]?.required ?? (root['required'] as string[] | undefined) ?? []
    for (const field of ['displayName', 'avatar', 'profileRevision']) {
      expect(required).not.toContain(field)
    }
  })
})

describe('Wave 8 drift acceptance (order §9 endpoint 3)', () => {
  it('plans drift.accept with schema.manage, for a person only, never through MCP', () => {
    const plan = ACTIONS['drift.accept.plan']
    expect(plan.effect).toBe('control_record')
    expect(plan.permission).toEqual({ kind: 'fixed', permission: 'schema.manage' })
    expect(plan.scope).toEqual({ kind: 'fixed', scope: 'schema.manage' })
    expect(plan.humanOnly).toBe(true)
    expect([...plan.clientKinds].sort()).toEqual(['cli', 'web'])
    const kind = ACTIONS['drift.accept']
    expect(kind.effect).toBe('consequential')
    expect(kind.operationKind).toBe(true)
    expect(kind.humanOnly).toBe(true)
    expect(kind.class).toEqual({ kind: 'by_tier', nonprod: 'standard', prod: 'high' })
    expect(kind.tierSemantics).toBe('subject')
    expect(kind.exclusivity).toEqual(['target.schema'])
    expect(kind.verification).toBe('required')
    for (const id of DRIFT_ACCEPT) {
      expect(ACTIONS[id].clientKinds, id).not.toContain('mcp')
      expect(
        MCP_TOOL_LIST.some((t) => t.action === id),
        id,
      ).toBe(false)
    }
  })

  it('is POST /findings/{finding}/accept, answers a plan and lists 422 and the plan errors', () => {
    const route = ROUTE_LIST.find((r) => r.operationId === 'planDriftAcceptance')
    expect([route?.method, route?.path, route?.action, route?.response.status]).toEqual([
      'post',
      '/findings/{finding}/accept',
      'drift.accept.plan',
      201,
    ])
    expect(route?.response.schema).toBe(PlanViewSchema)
    expect(route?.errors).toEqual(
      expect.arrayContaining(['VALIDATION_FAILED', 'REGISTRY_CONFLICT', 'NOT_FOUND']),
    )
    const body = DriftAcceptRequestSchema
    expect(body.safeParse({}).success).toBe(true)
    expect(body.safeParse({ reason: 'Hotfix adopted after review' }).success).toBe(true)
    expect(body.safeParse({ reason: 'short' }).success).toBe(false)
    expect(body.safeParse({ reason: 'x'.repeat(1001) }).success).toBe(false)
    expect(
      body.safeParse({ reason: 'Hotfix adopted after review', fingerprint: 'x' }).success,
    ).toBe(false)
  })
})

describe('role verifiers (owner decision S3)', () => {
  const VERIFIER = scramVerifierFor('marker password for the contract test')

  it('are human only, Web App or human sessions, re-authenticated, tiered on nodes.operate', () => {
    const plan = ACTIONS['postgres.roles.verifier.plan']
    expect([plan.clientKinds, plan.humanOnly, plan.reauthentication]).toEqual([['web'], true, true])
    expect(plan.scope).toEqual({ kind: 'tiered', permission: 'nodes.operate' })
    const set = ACTIONS['postgres.roles.verifier.set']
    expect([set.operationKind, set.humanOnly, set.reauthentication, set.class]).toEqual([
      true,
      true,
      true,
      { kind: 'fixed', class: 'high' },
    ])
    expect(set.clientKinds).not.toContain('mcp')
    expect(set.scope).toEqual({ kind: 'tiered', permission: 'nodes.operate' })
    expect(set.exclusivity).toEqual(['cluster.config'])
    expect(MCP_TOOL_LIST.some((t) => t.action.startsWith('postgres.roles.verifier'))).toBe(false)
    const route = ROUTE_LIST.find((r) => r.operationId === 'submitRoleVerifier')
    expect([route?.method, route?.path, route?.action]).toEqual([
      'post',
      '/clusters/{clusterId}/role-verifiers',
      'postgres.roles.verifier.plan',
    ])
  })

  it('accepts a SCRAM-SHA-256 verifier as PostgreSQL stores it, and nothing else', () => {
    expect(isScramSha256Verifier(VERIFIER)).toBe(true)
    const [, iterations, rest] = /^SCRAM-SHA-256\$(\d+):(.*)$/.exec(VERIFIER) ?? []
    for (const bad of [
      'marker password for the contract test',
      `md5${'0'.repeat(32)}`,
      VERIFIER.replace(`$${iterations}:`, '$4095:'),
      VERIFIER.replace(`$${iterations}:`, '$04096:'),
      VERIFIER.replace(`$${iterations}:`, '$12345678:'),
      `SCRAM-SHA-256$4096:${Buffer.alloc(8).toString('base64')}$${rest?.split('$')[1]}`,
      `${VERIFIER}x`,
      VERIFIER.replace('SCRAM-SHA-256', 'SCRAM-SHA-1'),
      VERIFIER.slice(0, -2),
    ]) {
      expect(isScramSha256Verifier(bad), bad).toBe(false)
    }
  })

  it('refuses a password, a predefined or own role, and never echoes the submitted value', () => {
    const ok = RoleVerifierSubmissionSchema.safeParse({ role: 'acme_app', verifier: VERIFIER })
    expect(ok.success).toBe(true)
    const marker = ['marker', 'never', 'echoed', '0123456789'].join('-')
    for (const body of [
      { role: 'acme_app', verifier: marker },
      { role: 'acme_app', password: marker },
      { role: 'acme_app', verifier: VERIFIER, password: marker },
      { role: 'pg_monitor', verifier: VERIFIER },
      { role: 'exponetdb_reader', verifier: VERIFIER },
    ]) {
      const r = RoleVerifierSubmissionSchema.safeParse(body)
      expect(r.success, JSON.stringify(Object.keys(body))).toBe(false)
      const text = JSON.stringify(r.error?.issues.map((i) => [i.path, i.code, i.message]))
      expect(text).not.toContain(marker)
      expect(text).not.toContain(VERIFIER)
    }
  })
})

describe('Wave 8 response fields', () => {
  it('add operationId and retryable to the REST reads only, as optional fields', () => {
    const planProps = names(PlanReadSchema)
    const viewProps = names(PlanViewSchema)
    expect([...planProps].filter((n) => !viewProps.has(n))).toEqual(['operationId'])
    const opProps = names(OperationReadSchema)
    const baseProps = names(OperationSchema)
    expect([...opProps].filter((n) => !baseProps.has(n))).toEqual(['retryable'])
    const required = (schema: Parameters<typeof contractJsonSchema>[0]) => {
      const root = contractJsonSchema(schema, { io: 'output' })
      const def = (root['$defs'] ?? {}) as Record<string, { required?: string[] }>
      const ref = typeof root['$ref'] === 'string' ? root['$ref'].replace('#/$defs/', '') : ''
      return (def[ref]?.required ?? (root['required'] as string[] | undefined) ?? []) as string[]
    }
    expect(required(PlanReadSchema)).not.toContain('operationId')
    expect(required(OperationReadSchema)).not.toContain('retryable')
    // The MCP tools announce the base views: neither field is in any tool.
    for (const tool of MCP_TOOL_LIST) {
      const all = new Set([
        ...names(tool.output),
        ...propertyNames(contractJsonSchema(tool.input, { io: 'input' })),
      ])
      expect(all.has('retryable'), tool.name).toBe(false)
      expect(all.has('operationId') && tool.output === PlanViewSchema, tool.name).toBe(false)
    }
  })

  it('add lastUsedAt and lastUseClass to the grant view, optional, with the classes the store keeps', () => {
    const doc = buildOpenApi() as {
      components: { schemas: Record<string, { properties: object; required: string[] }> }
    }
    const grant = doc.components.schemas['Grant']
    expect(Object.keys(grant?.properties ?? {})).toEqual(
      expect.arrayContaining(['lastUsedAt', 'lastUseClass']),
    )
    expect(grant?.required).not.toContain('lastUsedAt')
    expect(grant?.required).not.toContain('lastUseClass')
    expect(GrantViewSchema.shape.lastUsedAt.isOptional()).toBe(true)
    expect([...GRANT_USE_CLASS_VALUES]).toEqual(['read', 'plan', 'apply', 'data', 'rest'])
  })

  it('never show a bucket, a file location, a build, an envelope or a signature', () => {
    const forbidden =
      /^(bucket|location|endpoint|sink|commit|buildCommit|buildVersion|host|hostname|envelope|completion|signature|args|argsHash|privateKey|secret|password)$/i
    const checks: [string, Parameters<typeof contractJsonSchema>[0], RegExp][] = [
      ['audit chain', AuditChainSchema, forbidden],
      ['installation health', InstallationHealthSchema, forbidden],
      ['node job', NodeJobSchema, forbidden],
      ['node certificates', NodeCertificatesSchema, forbidden],
      ['target health history', TargetHealthHistorySchema, forbidden],
      ['migration stream', MigrationStreamSchema, forbidden],
    ]
    for (const [label, schema, pattern] of checks) {
      const offenders = [...names(schema)].filter((n) => pattern.test(n))
      // `resultVerified` is a verdict, `entriesOutsideStream` a count, `exports` a state: none is a value.
      expect(offenders, label).toEqual([])
    }
  })

  it('accepts the shapes the use cases build', () => {
    expect(
      InstallationHealthSchema.safeParse({
        state: 'degraded',
        components: [
          {
            component: 'workers',
            state: 'degraded',
            source: 'inferred',
            observedAt: '2026-10-13T10:00:00.000Z',
            reasons: ['no_live_worker'],
            values: { liveWorkers: 0 },
          },
        ],
        unobserved: [{ component: 'gateway', reason: 'not_applicable' }],
        observedAt: '2026-10-13T10:00:00.000Z',
      }).success,
    ).toBe(true)
    expect(
      AuditChainSchema.shape.verification.safeParse({
        status: 'not_verified',
        reason: 'too_many_events',
        anchorCheckpointSeq: 3,
        eventsSinceAnchor: 20_000,
        limit: 10_000,
      }).success,
    ).toBe(true)
    // A verification that claims success must say through which sequence and when.
    expect(AuditChainSchema.shape.verification.safeParse({ status: 'verified' }).success).toBe(
      false,
    )
  })
})

describe('the OpenAPI document', () => {
  it('equals the generated file (serve builds it with the function the generator uses)', () => {
    const file = fileURLToPath(new URL('../generated/openapi.json', import.meta.url))
    expect(JSON.parse(JSON.stringify(buildOpenApi()))).toEqual(
      JSON.parse(readFileSync(file, 'utf8')),
    )
  })

  it('lists every route of the contract with its wave', () => {
    const doc = buildOpenApi() as {
      paths: Record<string, Record<string, { operationId: string; 'x-exponetdb-wave': string }>>
    }
    const listed = Object.values(doc.paths).flatMap((p) =>
      Object.values(p).map((o) => o.operationId),
    )
    expect(listed.sort()).toEqual(ROUTE_LIST.map((r) => r.operationId).sort())
    expect(doc.paths['/audit-events/chain']?.['get']?.['x-exponetdb-wave']).toBe('8')
  })
})

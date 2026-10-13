import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ACTION_IDS,
  ACTIONS,
  type ActionId,
  AuditChainSchema,
  buildOpenApi,
  contractJsonSchema,
  GRANT_USE_CLASS_VALUES,
  GrantViewSchema,
  InstallationHealthSchema,
  MCP_TOOL_LIST,
  MigrationStreamSchema,
  NodeCertificatesSchema,
  NodeJobSchema,
  OperationReadSchema,
  OperationSchema,
  PlanReadSchema,
  PlanViewSchema,
  ROUTE_LIST,
  TargetHealthHistorySchema,
} from '../src/index.ts'

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
]

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
      WAVE8.map(([id]) => id).sort(),
    )
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

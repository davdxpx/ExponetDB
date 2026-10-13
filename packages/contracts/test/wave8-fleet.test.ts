import { describe, expect, it } from 'vitest'
import {
  ACTIONS,
  buildOpenApi,
  FindingListQuerySchema,
  FleetFindingSchema,
  FleetSchema,
  MCP_TOOL_LIST,
  ROUTE_LIST,
} from '../src/index.ts'

/**
 * The fleet overview and the findings across targets (Wave 8, order §9,
 * endpoints 1 and 2): reads of existing permissions, REST only, no MCP tool;
 * every count says where it comes from and whether it is a lower bound; a
 * part the caller may not see is marked unavailable, never zero.
 */
const route = (operationId: string) => ROUTE_LIST.find((r) => r.operationId === operationId)

const NOW = '2026-10-13T19:00:00.000Z'
const meta = { source: 'live', observedAt: NOW, lowerBound: false, lowerBoundReason: null }

const fleet = {
  targets: {
    total: 3,
    decommissioned: 0,
    byTier: { prod: 1, nonprod: 2 },
    byHealth: { healthy: 1, degraded: 0, unhealthy: 0, unreachable: 0, unknown: 2, suspended: 0 },
    bySource: { sampled: 1, cached: 1, inferred: 1 },
    oldestSampleAt: NOW,
    ...meta,
  },
  findings: {
    available: true,
    open: 2,
    bySeverity: { info: 1, warning: 1, critical: 0 },
    ...meta,
  },
  operations: {
    available: true,
    running: 1,
    needs_attention: 0,
    awaiting_approval: 0,
    ...meta,
  },
  asOf: NOW,
}

describe('fleet.get and finding.list', () => {
  it('are reads of an existing permission, REST only, and no MCP tool binds them', () => {
    expect(ACTIONS['fleet.get']).toMatchObject({
      effect: 'read',
      wave: '8',
      permission: { kind: 'fixed', permission: 'targets.read' },
    })
    expect(ACTIONS['finding.list']).toMatchObject({
      effect: 'read',
      wave: '8',
      permission: { kind: 'fixed', permission: 'diagnostics.read' },
    })
    for (const id of ['fleet.get', 'finding.list'] as const) {
      expect(ACTIONS[id].clientKinds).not.toContain('mcp')
      expect(MCP_TOOL_LIST.some((t) => t.action === id)).toBe(false)
    }
  })

  it('have the documented routes', () => {
    expect([route('getFleet')?.method, route('getFleet')?.path]).toEqual(['get', '/fleet'])
    expect([route('listFindings')?.method, route('listFindings')?.path]).toEqual([
      'get',
      '/findings',
    ])
    expect(route('getFleet')?.action).toBe('fleet.get')
    expect(route('listFindings')?.action).toBe('finding.list')
    const doc = buildOpenApi() as { paths: Record<string, Record<string, { operationId: string }>> }
    expect(doc.paths['/fleet']?.['get']?.operationId).toBe('getFleet')
    expect(doc.paths['/findings']?.['get']?.operationId).toBe('listFindings')
  })
})

describe('the fleet overview', () => {
  it('accepts counts that carry source, time and the lower-bound flag', () => {
    expect(FleetSchema.safeParse(fleet).success).toBe(true)
    expect(
      FleetSchema.safeParse({
        ...fleet,
        operations: { ...fleet.operations, lowerBound: true, lowerBoundReason: 'scan_limit' },
      }).success,
    ).toBe(true)
  })

  it('has no count without source, time and lower-bound flag', () => {
    for (const drop of ['source', 'observedAt', 'lowerBound', 'lowerBoundReason'] as const) {
      const { [drop]: _gone, ...rest } = fleet.targets
      expect(FleetSchema.safeParse({ ...fleet, targets: rest }).success, drop).toBe(false)
    }
  })

  it('marks a part the caller may not see as unavailable with a reason, and has no zero for it', () => {
    const hidden = { available: false, reason: 'permission_denied' }
    expect(FleetSchema.safeParse({ ...fleet, findings: hidden }).success).toBe(true)
    expect(FleetSchema.safeParse({ ...fleet, operations: hidden }).success).toBe(true)
    // An unavailable part has no counts, and an available one has all of them.
    expect(FleetSchema.safeParse({ ...fleet, findings: { available: false } }).success).toBe(false)
    expect(
      FleetSchema.safeParse({ ...fleet, findings: { ...fleet.findings, open: undefined } }).success,
    ).toBe(false)
  })

  it('counts every health state, with unknown as a state of its own', () => {
    const { unknown: _u, ...noUnknown } = fleet.targets.byHealth
    expect(
      FleetSchema.safeParse({ ...fleet, targets: { ...fleet.targets, byHealth: noUnknown } })
        .success,
    ).toBe(false)
  })
})

describe('the findings across targets', () => {
  const finding = {
    id: 'fnd_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z',
    kind: 'drift',
    code: 'object_added',
    severity: 'warning',
    subject: { targetId: 'tgt_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z', clusterId: null, nodeId: null },
    summary: 'A table was added.',
    state: 'open',
    occurrences: 1,
    object: null,
    securityRelevant: false,
    resolution: null,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    resolvedAt: null,
    targetId: 'tgt_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z',
    targetPath: 'acme/platform/staging',
  }

  it('is the per-target finding plus the target id and path', () => {
    expect(FleetFindingSchema.safeParse(finding).success).toBe(true)
    const { targetPath: _p, ...noPath } = finding
    expect(FleetFindingSchema.safeParse(noPath).success).toBe(false)
    const { targetId: _i, ...noId } = finding
    expect(FleetFindingSchema.safeParse(noId).success).toBe(false)
  })

  it('takes closed filter values, a page of at most 200, and nothing else', () => {
    const query = route('listFindings')?.query
    expect(query).toBeDefined()
    const ok = (q: object) => query?.safeParse(q).success
    expect(ok({})).toBe(true)
    expect(ok({ severity: 'critical', state: 'all', kind: 'health', limit: 200 })).toBe(true)
    expect(ok({ target: 'acme/platform/staging' })).toBe(true)
    expect(ok({ severity: 'fatal' })).toBe(false)
    expect(ok({ state: 'closed' })).toBe(false)
    expect(ok({ kind: 'advisor' })).toBe(false)
    expect(ok({ limit: 201 })).toBe(false)
    expect(ok({ limit: 0 })).toBe(false)
    expect(ok({ includeResolved: true })).toBe(false)
    expect(FindingListQuerySchema.safeParse({ severity: 'info' }).success).toBe(true)
  })

  it('does not name a credential, a host or a file in any response field', () => {
    const doc = JSON.stringify(
      (buildOpenApi() as { components: { schemas: Record<string, unknown> } }).components.schemas[
        'Fleet'
      ],
    )
    for (const word of ['password', 'secret', 'host', 'path', 'file', 'address']) {
      expect(doc.toLowerCase(), word).not.toContain(`"${word}"`)
    }
  })
})

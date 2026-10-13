import type { Readable } from '@exponetdb/ui-patterns'
import { describe, expect, it } from 'vitest'
import { type GateInput, gateFor, permissionsRequired } from '../../src/features/target/gate.ts'
import type { Target, TargetHealth } from '../../src/features/target/queries.ts'

const NOW = new Date().toISOString()

function target(over: Partial<Target> = {}): Target {
  return {
    id: 'tgt_1',
    path: 'shop/platform/staging',
    productId: 'prd_1',
    projectId: 'prj_1',
    environmentId: 'env_1',
    tier: 'nonprod',
    state: 'active',
    generation: 1,
    health: null,
    environment: { slug: 'staging', tier: 'nonprod' },
    placement: null,
    ledger: null,
    openFindingCount: 0,
    ...over,
  }
}

function sample(over: Partial<TargetHealth> = {}): TargetHealth {
  return {
    targetId: 'tgt_1',
    lifecycle: 'active',
    state: 'healthy',
    source: 'sampled',
    observedAt: NOW,
    conditions: [],
    unknownBecause: null,
    probes: [],
    node: null,
    backups: null,
    ...over,
  }
}

const ready = (value: TargetHealth): Readable<TargetHealth> => ({
  state: 'ready',
  value,
  source: 'sampled',
  observedAt: NOW,
})

function gate(over: Partial<GateInput>) {
  return gateFor({
    requires: [],
    target: target(),
    health: undefined,
    permissions: undefined,
    ...over,
  })
}

describe('gateFor: the order of the states', () => {
  it('opens a page with no requirement on an active target', () => {
    expect(gate({})).toEqual({ kind: 'open' })
  })

  it('puts decommissioned before everything', () => {
    expect(
      gate({
        target: target({ state: 'decommissioned' }),
        requires: ['wave9', 'od21', 'permission:audit.read', 'target.reachable'],
        health: ready(sample({ state: 'unreachable' })),
      }).kind,
    ).toBe('decommissioned')
  })

  it('puts suspended before Wave 9, OD-21, permissions and health', () => {
    expect(
      gate({
        target: target({ state: 'suspended' }),
        requires: ['wave9', 'od21', 'target.reachable'],
        health: ready(sample({ state: 'unreachable' })),
      }).kind,
    ).toBe('suspended')
  })

  it('puts Wave 9 before OD-21, permissions and health', () => {
    expect(gate({ requires: ['od21', 'wave9', 'permission:audit.read'] }).kind).toBe('wave9')
  })

  it('puts OD-21 before permissions and health', () => {
    expect(
      gate({
        requires: ['permission:audit.read', 'target.reachable', 'od21'],
        permissions: [],
        health: ready(sample({ state: 'unreachable' })),
      }).kind,
    ).toBe('od21')
  })

  it('puts a missing permission before health', () => {
    expect(
      gate({
        requires: ['target.reachable', 'permission:audit.read'],
        permissions: ['targets.read'],
        health: ready(sample({ state: 'unreachable' })),
      }),
    ).toEqual({ kind: 'not_permitted', permission: 'audit.read' })
  })

  it('names the first permission that is missing, and passes when all are held', () => {
    const requires = ['permission:access.read', 'permission:audit.read'] as const
    expect(gate({ requires, permissions: ['access.read'] })).toEqual({
      kind: 'not_permitted',
      permission: 'audit.read',
    })
    expect(gate({ requires, permissions: ['access.read', 'audit.read'] }).kind).toBe('open')
  })

  it('treats permissions that are not known as not held', () => {
    expect(gate({ requires: ['permission:audit.read'], permissions: undefined }).kind).toBe(
      'not_permitted',
    )
  })

  it('lists the permissions a requirement list names', () => {
    expect(permissionsRequired(['wave9', 'permission:access.read', 'node.online'])).toEqual([
      'access.read',
    ])
  })
})

describe('gateFor: target.reachable', () => {
  const requires = ['target.reachable'] as const

  it.each(['healthy', 'degraded', 'unhealthy'] as const)(
    'opens the page when health is %s',
    (state) => {
      expect(gate({ requires, health: ready(sample({ state })) })).toEqual({ kind: 'open' })
    },
  )

  it('says unreachable when health says so, with the sample', () => {
    const health = sample({ state: 'unreachable', source: 'sampled' })
    expect(gate({ requires, health: ready(health) })).toEqual({ kind: 'unreachable', health })
  })

  it('says suspended when health says the target is suspended (identity check)', () => {
    expect(gate({ requires, health: ready(sample({ state: 'suspended' })) }).kind).toBe('suspended')
  })

  it('cannot tell when health is unknown, and keeps the reason and the source', () => {
    expect(
      gate({
        requires,
        health: ready(sample({ state: 'unknown', unknownBecause: 'never_sampled' })),
      }),
    ).toEqual({
      kind: 'target_cannot_tell',
      cause: { kind: 'unknown', source: 'sampled', observedAt: NOW, reason: 'never_sampled' },
    })
  })

  it('cannot tell when the health read failed (never healthy, never open)', () => {
    const error = { code: 'INTERNAL', message: 'It broke.' }
    expect(gate({ requires, health: { state: 'failed', error } })).toEqual({
      kind: 'target_cannot_tell',
      cause: { kind: 'failed', error },
    })
  })

  it('cannot tell when the page has no health read at all', () => {
    expect(gate({ requires })).toEqual({
      kind: 'target_cannot_tell',
      cause: { kind: 'missing' },
    })
  })

  it('waits while the health read is loading', () => {
    expect(gate({ requires, health: { state: 'loading' } }).kind).toBe('health_loading')
  })

  it('opens under a stale banner when an old sample is all there is and it does not say unreachable', () => {
    const value = sample({ state: 'healthy' })
    const result = gate({
      requires,
      health: {
        state: 'stale',
        value,
        source: 'cached',
        observedAt: NOW,
        error: { code: 'NETWORK', message: 'The server could not be reached.' },
      },
    })
    expect(result).toEqual({
      kind: 'open',
      staleHealth: {
        source: 'cached',
        observedAt: NOW,
        error: { code: 'NETWORK', message: 'The server could not be reached.' },
      },
    })
  })

  it('still says unreachable from a stale sample', () => {
    const value = sample({ state: 'unreachable' })
    expect(
      gate({ requires, health: { state: 'stale', value, source: 'cached', observedAt: NOW } }).kind,
    ).toBe('unreachable')
  })
})

describe('gateFor: node.online', () => {
  const requires = ['node.online'] as const
  const node = (state: NonNullable<TargetHealth['node']>['state']) => ({
    nodeId: 'nod_1',
    state,
    source: 'agent_reported',
    observedAt: NOW,
  })

  it.each(['active', 'degraded'] as const)('opens the page when the node is %s', (state) => {
    expect(gate({ requires, health: ready(sample({ node: node(state) })) })).toEqual({
      kind: 'open',
    })
  })

  it.each([
    'offline',
    'revoked',
    'pending_enrollment',
    'decommissioned',
    'binding_failed',
  ] as const)('says the node is not online when it is %s', (state) => {
    const result = gate({ requires, health: ready(sample({ node: node(state) })) })
    expect(result).toEqual({ kind: 'node_offline', node: node(state) })
  })

  it('cannot tell when the node state is unknown', () => {
    expect(gate({ requires, health: ready(sample({ node: node('unknown') })) })).toEqual({
      kind: 'node_cannot_tell',
      cause: { kind: 'unknown', source: 'agent_reported', observedAt: NOW, reason: null },
    })
  })

  it('says there is no node for a cluster ExponetDB does not run an agent on', () => {
    expect(gate({ requires, health: ready(sample({ node: null })) }).kind).toBe('no_node')
  })

  it('cannot tell when the health read failed or is missing', () => {
    expect(
      gate({ requires, health: { state: 'failed', error: { code: 'X', message: 'm' } } }).kind,
    ).toBe('node_cannot_tell')
    expect(gate({ requires }).kind).toBe('node_cannot_tell')
  })

  it('checks the target before the node when a page needs both', () => {
    expect(
      gate({
        requires: ['target.reachable', 'node.online'],
        health: ready(sample({ state: 'unreachable', node: node('offline') })),
      }).kind,
    ).toBe('unreachable')
    expect(
      gate({
        requires: ['target.reachable', 'node.online'],
        health: ready(sample({ state: 'healthy', node: node('offline') })),
      }).kind,
    ).toBe('node_offline')
  })
})

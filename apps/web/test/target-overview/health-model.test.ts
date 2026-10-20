import type { ProbeResult, TargetHealth } from '@exponetdb/sdk/operations'
import { describe, expect, it } from 'vitest'
import {
  conditionDetails,
  conditionGroup,
  gapCauseKey,
  historyBreakdown,
  historyPoints,
  incidentGroups,
  SERIES_KEYS,
  worstOf,
} from '../../src/features/target-overview/health-model.ts'
import {
  cellOf,
  matrixBundles,
  matrixColumns,
  streamState,
} from '../../src/features/target-overview/migrations-model.ts'
import { historyFixture, streamFixture } from './support.tsx'

const NOW = '2026-10-13T10:00:00.000Z'

function probe(over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    probe: 'simple',
    outcome: 'ok',
    durationMs: 3,
    errorClass: null,
    observedAt: NOW,
    tls: 'verified',
    endpoint: { id: null, kind: 'private', label: 'main', verified: true },
    ...over,
  }
}

function health(over: Partial<TargetHealth> = {}): TargetHealth {
  return {
    targetId: 'tgt_00000000000000000000000001',
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

const verdicts = (h: TargetHealth) =>
  Object.fromEntries(incidentGroups(h).map((g) => [g.id, g.verdict]))

describe('incidentGroups: the three questions in incident order', () => {
  it('lists path, answers and stuck, in that order', () => {
    expect(incidentGroups(health()).map((g) => g.id)).toEqual(['path', 'answers', 'stuck'])
  })

  it('reads a group with no probe as not observed, never as fine', () => {
    expect(verdicts(health({ probes: [probe()] }))).toEqual({
      path: 'ok',
      answers: 'not_observed',
      stuck: 'not_observed',
    })
  })

  it('reads a failed or timed out probe as a problem in its own group only', () => {
    const h = health({
      state: 'unreachable',
      probes: [probe({ outcome: 'timeout' }), probe({ probe: 'extended' })],
    })
    expect(verdicts(h)).toMatchObject({ path: 'problem', answers: 'ok' })
  })

  it('never reads a passing probe as ok while the sample as a whole is unknown', () => {
    const h = health({ state: 'unknown', probes: [probe(), probe({ probe: 'extended' })] })
    expect(Object.values(verdicts(h))).not.toContain('ok')
    expect(verdicts(h)['path']).toBe('overall_unknown')
  })

  it('files each condition under its question, and an unknown condition under the last', () => {
    expect(conditionGroup('probe_simple_failed')).toBe('path')
    expect(conditionGroup('node_offline')).toBe('path')
    expect(conditionGroup('identity_mismatch')).toBe('answers')
    expect(conditionGroup('stalled_sessions')).toBe('stuck')
    expect(conditionGroup('a_condition_of_a_later_release')).toBe('stuck')
  })

  it('does not count an informational condition as a problem', () => {
    const h = health({
      probes: [probe({ probe: 'activity' })],
      conditions: [
        { condition: 'pending_restart', severity: 'info', count: null, observedAt: NOW },
      ],
    })
    expect(verdicts(h)['stuck']).toBe('ok')
  })

  it('sorts conditions critical first', () => {
    const h = health({
      conditions: [
        { condition: 'long_running', severity: 'warning', count: 1, observedAt: NOW },
        { condition: 'lock_waits', severity: 'critical', count: 2, observedAt: NOW },
      ],
    })
    const stuck = incidentGroups(h).find((g) => g.id === 'stuck')
    expect(stuck?.conditions.map((c) => c.severity)).toEqual(['critical', 'warning'])
  })
})

describe('historyPoints: a gap is a break, never an interpolation', () => {
  const words = () => 'cause words'

  it('makes a point per bucket with the count of every state', () => {
    const points = historyPoints(historyFixture({ gaps: [] }), words)
    const real = points.filter((p) => p.values['healthy'] !== null)
    expect(real).toHaveLength(3)
    expect(real[1]?.values).toMatchObject({ healthy: 15, degraded: 5, unreachable: 0 })
  })

  it('puts a null point (every series null) where buckets are missing, with the covering gap as cause', () => {
    const points = historyPoints(historyFixture(), words)
    const holes = points.filter((p) => SERIES_KEYS.every((key) => p.values[key] === null))
    expect(holes).toHaveLength(1)
    expect(holes[0]?.time).toBe('2026-10-13T10:10:00.000Z')
    expect(holes[0]?.gaps?.['healthy']).toBe('cause words')
    // The points stay in time order.
    const times = points.map((p) => Date.parse(p.time))
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })

  it('leaves the cause out of a hole that no gap covers (the cause is not reported)', () => {
    const points = historyPoints(historyFixture({ gaps: [], gapsTruncated: true }), words)
    const hole = points.find((p) => p.values['healthy'] === null)
    expect(hole).toBeDefined()
    expect(hole?.gaps).toBeUndefined()
  })

  it('marks a long stretch without samples after the last bucket', () => {
    const history = historyFixture({
      gaps: [],
      to: '2026-10-13T12:00:00.000Z',
    })
    const points = historyPoints(history, words)
    expect(points.filter((p) => p.values['healthy'] === null).length).toBeGreaterThanOrEqual(2)
  })

  it('draws nothing for a range with no bucket', () => {
    expect(historyPoints(historyFixture({ buckets: [], gaps: [] }), words)).toEqual([])
  })
})

describe('the rest of the history model', () => {
  it('takes the worst state over the buckets, and null without a bucket', () => {
    expect(worstOf(historyFixture())).toBe('degraded')
    expect(worstOf(historyFixture({ buckets: [] }))).toBeNull()
  })

  it('sums the samples of every state in one bar', () => {
    const [bar] = historyBreakdown(historyFixture(), 'All')
    expect(bar?.values).toMatchObject({ healthy: 55, degraded: 5, unknown: 0 })
  })

  it('has words for the three causes and a fallback', () => {
    expect(gapCauseKey('control_plane_down')).toBe('overview.history.cause.control_plane_down')
    expect(gapCauseKey('sampler_lagging')).toBe('overview.history.cause.sampler_lagging')
    expect(gapCauseKey('anything else')).toBe('overview.history.cause.other')
  })
})

describe('the migration matrix', () => {
  it('orders the columns by evidence rank and marks the page target', () => {
    const columns = matrixColumns(streamFixture(), 'shop/platform/staging')
    expect(columns.map((c) => c.slug)).toEqual(['development', 'staging', 'production'])
    expect(columns.filter((c) => c.current).map((c) => c.slug)).toEqual(['staging'])
    expect(columns.find((c) => c.slug === 'production')?.mirrorObservedAt).toBeNull()
  })

  it('reads a missing cell as unknown, never as not applied', () => {
    const stream = streamFixture()
    const bundle = stream.bundles[0]
    expect(bundle).toBeDefined()
    if (bundle === undefined) return
    expect(streamState(cellOf(bundle, 'no-such-environment'))).toEqual({
      state: 'unknown',
      checksumDiffers: false,
    })
  })

  it('names a state it does not know "other" and flags a differing checksum', () => {
    const stream = streamFixture()
    const bundle = stream.bundles[1]
    if (bundle === undefined) return
    expect(streamState(cellOf(bundle, 'development')).checksumDiffers).toBe(true)
    expect(
      streamState({
        environment: 'x',
        state: 'a_state_of_a_later_release',
        checksum: null,
        checksumMatches: null,
        appliedAt: null,
        verification: null,
        observedAt: null,
      }).state,
    ).toBe('other')
  })

  it('shows the newest bundles', () => {
    expect(matrixBundles(streamFixture()).map((b) => b.name)).toEqual([
      'create_orders',
      'add_orders_index',
    ])
  })
})

describe('conditionDetails', () => {
  const base = {
    condition: 'connections_high',
    severity: 'warning',
    count: 212,
    observedAt: NOW,
  } as const

  it('reads the slots, the oldest age and the transaction age from the values the server sent', () => {
    expect(
      conditionDetails({ ...base, values: { clientBackends: 212, usableSlots: 400 } }),
    ).toEqual([{ kind: 'slots', used: 212, usable: 400 }])
    expect(
      conditionDetails({
        ...base,
        condition: 'idle_in_transaction',
        values: { oldestSeconds: 720 },
      }),
    ).toEqual([{ kind: 'oldest', seconds: 720 }])
    expect(
      conditionDetails({ ...base, condition: 'xid_age_high', values: { xidAge: 512_000_000 } }),
    ).toEqual([{ kind: 'xidAge', age: 512_000_000 }])
  })

  it('shows nothing for a condition without values, and nothing it cannot read as a number', () => {
    expect(conditionDetails(base)).toEqual([])
    expect(conditionDetails({ ...base, values: { clientBackends: 212 } })).toEqual([])
    expect(
      conditionDetails({
        ...base,
        values: { clientBackends: null, usableSlots: true, oldestSeconds: -1, xidAge: Number.NaN },
      }),
    ).toEqual([])
  })

  it('keeps a zero, which is a value the server sent', () => {
    expect(
      conditionDetails({ ...base, condition: 'long_running', values: { oldestSeconds: 0 } }),
    ).toEqual([{ kind: 'oldest', seconds: 0 }])
  })
})

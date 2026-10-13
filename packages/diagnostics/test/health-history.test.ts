import { describe, expect, it } from 'vitest'
import {
  type AliveInterval,
  causesOfGap,
  chooseBucketSeconds,
  GAP_THRESHOLD_SECONDS,
  HEALTH_STATES,
  HISTORY_MAX_BUCKETS,
  HISTORY_MAX_RANGE_MS,
  type StateCounts,
  worstState,
} from '../src/index.ts'

/**
 * The pure parts of the health history (order §9): the bucket ladder, the
 * order of states, and how a gap is split into stretches with one cause each.
 */
const MIN = 60_000
const counts = (over: Partial<StateCounts>): StateCounts => ({
  healthy: 0,
  degraded: 0,
  unhealthy: 0,
  unreachable: 0,
  unknown: 0,
  suspended: 0,
  ...over,
})

describe('buckets', () => {
  it('stay within the bound for any range, aligned or not', () => {
    for (const hours of [0.01, 0.5, 1, 6, 24, 24 * 7, 24 * 14, 24 * 60]) {
      const range = hours * 3600
      const size = chooseBucketSeconds(range)
      // At most ceil(range / size) + 1 buckets: the range need not start on a boundary.
      expect(Math.ceil(range / size) + 1, `${hours} h`).toBeLessThanOrEqual(HISTORY_MAX_BUCKETS)
    }
    expect(chooseBucketSeconds(HISTORY_MAX_RANGE_MS / 1000)).toBe(14_400)
  })

  it('chooses the smallest size that fits, so a short range is not blurred', () => {
    expect(chooseBucketSeconds(10 * 60)).toBe(15)
    expect(chooseBucketSeconds(24 * 3600)).toBe(300)
  })
})

describe('the worst state of a bucket', () => {
  it('ranks unreachable, unhealthy, degraded, suspended, unknown, healthy', () => {
    const order = [
      'unreachable',
      'unhealthy',
      'degraded',
      'suspended',
      'unknown',
      'healthy',
    ] as const
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const worse = order[i] as (typeof order)[number]
        const better = order[j] as (typeof order)[number]
        expect(worstState(counts({ [worse]: 1, [better]: 20 })), `${worse} over ${better}`).toBe(
          worse,
        )
      }
    }
    expect([...HEALTH_STATES].sort()).toEqual([...order].sort())
  })

  it('never reads unknown as healthy', () => {
    expect(worstState(counts({ healthy: 100, unknown: 1 }))).toBe('unknown')
    expect(worstState(counts({ healthy: 3 }))).toBe('healthy')
  })
})

describe('the cause of a gap', () => {
  const horizon = 0
  const gap = { from: 10 * MIN, to: 40 * MIN }
  const alive = (from: number, to: number): AliveInterval => ({ from, to })

  it('is sampler_lagging while a worker was alive', () => {
    expect(causesOfGap(gap, [alive(0, 60 * MIN)], [alive(0, 60 * MIN)], horizon)).toEqual([
      { ...gap, cause: 'sampler_lagging', reason: null },
    ])
  })

  it('is control_plane_down when no worker was alive, and says whether serve was', () => {
    expect(causesOfGap(gap, [], [alive(0, 60 * MIN)], horizon)).toEqual([
      { ...gap, cause: 'control_plane_down', reason: 'no_live_worker' },
    ])
    expect(causesOfGap(gap, [], [], horizon)).toEqual([
      { ...gap, cause: 'control_plane_down', reason: 'no_live_process' },
    ])
  })

  it('splits a gap where a worker came up in the middle', () => {
    const result = causesOfGap(gap, [alive(25 * MIN, 60 * MIN)], [], horizon)
    expect(result).toEqual([
      { from: 10 * MIN, to: 25 * MIN, cause: 'control_plane_down', reason: 'no_live_process' },
      { from: 25 * MIN, to: 40 * MIN, cause: 'sampler_lagging', reason: null },
    ])
  })

  it('does not split an outage for a worker that came up seconds before its first sample', () => {
    const upAt = 40 * MIN - (GAP_THRESHOLD_SECONDS * 1000) / 2
    expect(causesOfGap(gap, [alive(upAt, 60 * MIN)], [], horizon)).toEqual([
      { ...gap, cause: 'control_plane_down', reason: 'no_live_process' },
    ])
  })

  it('is unknown where the heartbeats that could say were pruned, unless a worker is known to have been alive', () => {
    expect(causesOfGap(gap, [], [], 100 * MIN)).toEqual([
      { ...gap, cause: 'unknown', reason: 'heartbeats_pruned' },
    ])
    // A worker row that survives is positive evidence, whatever the horizon.
    expect(causesOfGap(gap, [alive(0, 60 * MIN)], [], 100 * MIN)).toEqual([
      { ...gap, cause: 'sampler_lagging', reason: null },
    ])
    // Across the horizon: unknown before it, control_plane_down after it.
    expect(causesOfGap(gap, [], [], 25 * MIN)).toEqual([
      { from: 10 * MIN, to: 25 * MIN, cause: 'unknown', reason: 'heartbeats_pruned' },
      { from: 25 * MIN, to: 40 * MIN, cause: 'control_plane_down', reason: 'no_live_process' },
    ])
  })
})

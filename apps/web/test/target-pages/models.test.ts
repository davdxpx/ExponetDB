import { describe, expect, it } from 'vitest'
import { isReasonRequired } from '../../src/features/drift/accept-drift.tsx'
import { bySeverity, lastSeenOf, triage } from '../../src/features/drift/drift-model.ts'
import {
  environmentNotes,
  isDecisionState,
  mapReadable,
  needsDecision,
  reportSearch,
  streamMissing,
  timelineDataOf,
} from '../../src/features/migrations/model.ts'
import { ApiError } from '../../src/lib/api/errors.ts'
import { must, nth, stream, ulid } from './support.tsx'

describe('timelineDataOf', () => {
  it('maps the stream and leaves a missing cell missing, never "not applied"', () => {
    const data = timelineDataOf(stream() as never)
    expect(data.environments.map((e) => e.id)).toEqual(['development', 'staging', 'production'])
    expect(data.environments[2]).toMatchObject({ tier: 'prod', evidenceFrom: 'staging' })
    const second = data.bundles[1]
    expect(second?.cells.map((c) => c.environmentId)).toEqual(['development', 'staging'])
    expect(second?.cells.find((c) => c.environmentId === 'production')).toBeUndefined()
    expect(data.bundles[0]?.cells.map((c) => c.state)).toEqual([
      'verified',
      'applied',
      'not_applied',
    ])
    expect(data.totalBundleCount).toBeUndefined()
  })

  it('turns an unknown state into unknown and divergent into drifted', () => {
    const s = stream()
    const bundles = [
      {
        ...nth(s.bundles, 0),
        states: [
          { ...nth(nth(s.bundles, 0).states, 0), state: 'divergent' },
          { ...nth(nth(s.bundles, 0).states, 1), state: 'something_new' },
        ],
      },
    ]
    const data = timelineDataOf({ ...s, bundles } as never)
    expect(data.bundles[0]?.cells.map((c) => c.state)).toEqual(['drifted', 'unknown'])
  })

  it('reports a truncated stream with its total', () => {
    const truncated = { ...stream(), truncated: true, bundleCount: 1500 }
    expect(timelineDataOf(truncated as never).totalBundleCount).toBe(1500)
    expect(streamMissing(truncated as never)).toHaveLength(1)
    expect(streamMissing(stream() as never)).toBeUndefined()
  })
})

describe('environmentNotes', () => {
  it('names environments without a target, without a mirror and with a divergent mirror', () => {
    const s = stream()
    const environments = [
      { ...nth(s.environments, 0), target: null },
      { ...nth(s.environments, 1), mirror: null },
      {
        ...nth(s.environments, 2),
        mirror: {
          ...must(nth(s.environments, 2).mirror),
          divergent: true,
          divergence: { missing: [ulid(1)], checksumDiffers: [ulid(2)], unrecorded: [] },
        },
      },
    ]
    expect(environmentNotes({ ...s, environments } as never).map((n) => [n.slug, n.kind])).toEqual([
      ['development', 'no_target'],
      ['staging', 'no_mirror'],
      ['production', 'divergent'],
    ])
  })
})

describe('mapReadable', () => {
  it('maps a value and passes a loading or failed read through unchanged', () => {
    expect(mapReadable({ state: 'loading' }, (n: number) => n + 1)).toEqual({ state: 'loading' })
    const failed = { state: 'failed', error: { code: 'X', message: 'm' } } as const
    expect(mapReadable(failed, (n: number) => n + 1)).toBe(failed)
    expect(
      mapReadable(
        { state: 'partial', value: 1, source: 'live', observedAt: 't', missing: ['a'] },
        (n) => n + 1,
      ),
    ).toMatchObject({ state: 'partial', value: 2, missing: ['a'] })
  })
})

describe('the legacy import helpers', () => {
  it('asks for a decision only on an undecided review item', () => {
    const item = (state: string, decision: unknown = null) =>
      ({ itemId: '1', legacyId: 'x', name: 'x', state, contentDigest: null, decision }) as never
    expect(needsDecision(item('recorded_missing'))).toBe(true)
    expect(needsDecision(item('ambiguous'))).toBe(true)
    expect(needsDecision(item('recorded_present'))).toBe(false)
    expect(
      needsDecision(item('recorded_missing', { state: 'superseded', note: 'n', decidedAt: 't' })),
    ).toBe(false)
  })

  it('knows the decision states and not ambiguous', () => {
    expect(isDecisionState('not_applicable')).toBe(true)
    expect(isDecisionState('ambiguous')).toBe(false)
    expect(isDecisionState('<script>')).toBe(false)
  })

  it('accepts only an import report id in the address', () => {
    expect(reportSearch({ report: `imr_${ulid(1)}` })).toEqual({ report: `imr_${ulid(1)}` })
    expect(reportSearch({ report: 'imr_../../x' })).toEqual({ report: undefined })
    expect(reportSearch({ report: ['imr_1'] })).toEqual({ report: undefined })
    expect(reportSearch({})).toEqual({ report: undefined })
  })
})

describe('the drift helpers', () => {
  it('triages into the three buckets and keeps an unknown bucket apart', () => {
    const f = (bucket: string) => ({ bucket }) as never
    const result = triage([f('matched'), f('drifted'), f('unmanaged'), f('new_bucket')])
    expect([
      result.drifted.length,
      result.unmanaged.length,
      result.matched.length,
      result.other.length,
    ]).toEqual([1, 1, 1, 1])
  })

  it('sorts the most severe first and an unknown severity last', () => {
    expect(
      bySeverity([{ severity: 'info' }, { severity: 'mystery' }, { severity: 'critical' }]).map(
        (x) => x.severity,
      ),
    ).toEqual(['critical', 'info', 'mystery'])
  })

  it('finds the latest time a finding was seen', () => {
    expect(
      lastSeenOf([
        { lastSeenAt: '2026-10-01T00:00:00Z' },
        { lastSeenAt: 'not a date' },
        { lastSeenAt: '2026-10-03T00:00:00Z' },
      ]),
    ).toBe('2026-10-03T00:00:00Z')
    expect(lastSeenOf([])).toBeUndefined()
  })

  it('recognizes the server refusal that asks for a reason, and only that one', () => {
    const refusal = new ApiError('VALIDATION_FAILED', 422, 'm', undefined, {
      errors: [{ path: '/reason', code: 'reason_required' }],
    })
    expect(isReasonRequired(refusal)).toBe(true)
    expect(
      isReasonRequired(
        new ApiError('VALIDATION_FAILED', 422, 'm', undefined, {
          errors: [{ path: '/reason', code: 'too_short' }],
        }),
      ),
    ).toBe(false)
    expect(isReasonRequired(new ApiError('REGISTRY_CONFLICT', 409, 'm'))).toBe(false)
    expect(isReasonRequired(new Error('reason_required'))).toBe(false)
  })
})

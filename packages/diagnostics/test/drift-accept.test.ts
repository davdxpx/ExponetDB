import { describe, expect, it } from 'vitest'
import {
  type AcceptanceExpectation,
  type AcceptanceObservation,
  acceptanceBindings,
  acceptClass,
  reasonRequired,
} from '../src/index.ts'

/**
 * The planner and binding logic of `drift.accept` (Wave 8, order §9): what
 * makes a drift acceptance plan stale, when a reason is required, and the
 * class by tier. The live paths are proven against PostgreSQL in
 * `apps/server/test/http-drift-accept.int.test.ts`.
 */
const FP = `fp1:17:${'a'.repeat(64)}`
const OTHER = `fp1:17:${'b'.repeat(64)}`
const F1 = 'fnd_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z'
const F2 = 'fnd_01JB2Z6G8M4Q7R9T1V3W5X7Y9Y'

const expected: AcceptanceExpectation = {
  generation: 3,
  baselineId: 'smp_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z',
  fingerprint: FP,
  covered: [F1, F2],
}

const unchanged: AcceptanceObservation = {
  target: { state: 'active', generation: 3 },
  baselineId: 'smp_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z',
  open: [F1, F2],
  sameScope: true,
  snapshot: { complete: true, fingerprint: FP },
}

describe('drift acceptance bindings', () => {
  it('hold when nothing changed, also without a live snapshot (the apply transaction)', () => {
    expect(acceptanceBindings(expected, unchanged)).toEqual([])
    const { snapshot: _, ...withoutSnapshot } = unchanged
    expect(acceptanceBindings(expected, withoutSnapshot)).toEqual([])
  })

  it('stay valid when a covered finding was resolved meanwhile', () => {
    expect(acceptanceBindings(expected, { ...unchanged, open: [F2] })).toEqual([])
    expect(acceptanceBindings(expected, { ...unchanged, open: [] })).toEqual([])
  })

  it('are stale when the schema fingerprint changed or the snapshot is incomplete', () => {
    expect(
      acceptanceBindings(expected, {
        ...unchanged,
        snapshot: { complete: true, fingerprint: OTHER },
      }),
    ).toEqual([{ binding: 'schemaFingerprint', expected: FP, actual: OTHER }])
    expect(
      acceptanceBindings(expected, {
        ...unchanged,
        snapshot: { complete: false, fingerprint: FP },
      }),
    ).toEqual([{ binding: 'schemaFingerprint', actual: 'incomplete' }])
  })

  it('are stale when a drift finding the person did not see is open', () => {
    expect(
      acceptanceBindings(expected, {
        ...unchanged,
        open: [F1, F2, 'fnd_01JB2Z6G8M4Q7R9T1V3W5X7Y9X'],
      }),
    ).toEqual([{ binding: 'findings', actual: '1 new' }])
  })

  it('are stale when the baseline or the managed scope changed', () => {
    expect(acceptanceBindings(expected, { ...unchanged, baselineId: null })).toEqual([
      { binding: 'baseline', expected: expected.baselineId, actual: null },
    ])
    expect(acceptanceBindings(expected, { ...unchanged, sameScope: false })).toEqual([
      { binding: 'scope', actual: 'changed' },
    ])
  })

  it('are stale on another generation, a target not active or gone, before anything else', () => {
    expect(
      acceptanceBindings(expected, { ...unchanged, target: { state: 'active', generation: 4 } }),
    ).toEqual([{ binding: 'generation', expected: 3, actual: 4 }])
    expect(
      acceptanceBindings(expected, {
        ...unchanged,
        target: { state: 'suspended', generation: 3 },
        snapshot: { complete: true, fingerprint: OTHER },
      }),
    ).toEqual([{ binding: 'target', actual: 'suspended' }])
    expect(acceptanceBindings(expected, { ...unchanged, target: undefined })).toEqual([
      { binding: 'target', actual: 'missing' },
    ])
  })

  it('report every changed binding at once', () => {
    expect(
      acceptanceBindings(expected, {
        ...unchanged,
        baselineId: 'smp_01JB2Z6G8M4Q7R9T1V3W5X7Y9Y',
        open: [F1, F2, 'fnd_01JB2Z6G8M4Q7R9T1V3W5X7Y9X'],
        snapshot: { complete: true, fingerprint: OTHER },
      }).map((b) => b.binding),
    ).toEqual(['baseline', 'findings', 'schemaFingerprint'])
  })
})

describe('drift acceptance planning rules', () => {
  it('requires a reason when a covered finding is critical or security-relevant', () => {
    expect(reasonRequired([])).toBe(false)
    expect(reasonRequired([{ severity: 'warning', details: { securityRelevant: false } }])).toBe(
      false,
    )
    expect(
      reasonRequired([
        { severity: 'warning', details: {} },
        { severity: 'critical', details: { securityRelevant: false } },
      ]),
    ).toBe(true)
    expect(reasonRequired([{ severity: 'warning', details: { securityRelevant: true } }])).toBe(
      true,
    )
  })

  it('plans standard on nonprod and high on prod (the action is by tier)', () => {
    expect(acceptClass('nonprod')).toBe('standard')
    expect(acceptClass('prod')).toBe('high')
  })
})

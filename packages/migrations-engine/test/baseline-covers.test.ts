import { describe, expect, it } from 'vitest'
import { combinedLayer, isCoveredRow } from '../src/baseline-covers.ts'
import type { Layer } from '../src/verification.ts'

const layer = (status: Layer['status'], checks: number, failed = 0, name?: string): Layer => ({
  status,
  checks,
  failed,
  firstFailure: name === undefined ? null : { name, detail: 'why' },
})

describe('a baseline that covers bundles (ADR-0040)', () => {
  it('counts only a legacy_import row under a bundle id as a covered bundle', () => {
    expect(
      isCoveredRow({ origin: 'legacy_import', migrationId: '01M6KDVFE7SGZKSKHJ2Z7D1H10' }),
    ).toBe(true)
    expect(isCoveredRow({ origin: 'legacy_import', migrationId: 'legacy:0001_items' })).toBe(false)
    expect(isCoveredRow({ origin: 'exponetdb', migrationId: '01M6KDVFE7SGZKSKHJ2Z7D1H10' })).toBe(
      false,
    )
    expect(isCoveredRow({ origin: 'baseline', migrationId: 'baseline:acme' })).toBe(false)
  })

  it("combines the covered bundles' runtime layers: worst status, sums, the first bad one named", () => {
    expect(combinedLayer([])).toMatchObject({ status: 'skipped', checks: 0, firstFailure: null })
    expect(
      combinedLayer([
        { id: 'A', layer: layer('passed', 2) },
        { id: 'B', layer: layer('skipped', 0) },
      ]),
    ).toEqual({ status: 'passed', checks: 2, failed: 0, firstFailure: null })
    expect(
      combinedLayer([
        { id: 'A', layer: layer('passed', 2) },
        { id: 'B', layer: layer('failed', 3, 1, 'grant held') },
      ]),
    ).toEqual({
      status: 'failed',
      checks: 5,
      failed: 1,
      firstFailure: { name: 'B: grant held', detail: 'why' },
    })
    expect(
      combinedLayer([
        { id: 'A', layer: layer('failed', 1, 1, 'x') },
        { id: 'B', layer: layer('error', 0, 0, 'verifier connection') },
      ]),
    ).toMatchObject({ status: 'error', firstFailure: { name: 'B: verifier connection' } })
  })
})

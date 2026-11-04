import { describe, expect, it } from 'vitest'
import { combinedLayer, isCoveredRow } from '../src/baseline-covers.ts'
import { coveredVerification } from '../src/reads.ts'
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
      failures: [
        {
          file: 'B',
          statement: null,
          kind: 'covered_verify',
          object: 'grant held',
          failed: ['failed'],
          excused: false,
        },
      ],
      failuresTotal: 1,
    })
    expect(
      combinedLayer([
        { id: 'A', layer: layer('failed', 1, 1, 'x') },
        { id: 'B', layer: layer('error', 0, 0, 'verifier connection') },
      ]),
    ).toMatchObject({
      status: 'error',
      firstFailure: { name: 'B: verifier connection' },
      failures: [
        { file: 'A', failed: ['failed'] },
        { file: 'B', failed: ['error'] },
      ],
      failuresTotal: 2,
    })
  })
})

describe('a covered bundle in migration status (ADR-0040)', () => {
  const run = (runtime: unknown, status: 'passed' | 'failed' = 'failed') =>
    ({
      verificationId: 'vfy_x',
      migrationId: 'baseline:acme',
      operationId: 'op_x',
      verifyDigest: null,
      startedAt: '2026-11-04T00:00:00Z',
      finishedAt: '2026-11-04T00:00:01Z',
      status,
      structural: { status: 'passed', checks: 1, failed: 0, firstFailure: null },
      runtime,
      engine: { status: 'passed', checks: 1, failed: 0, firstFailure: null },
      fingerprint: 'f',
    }) as never

  it('reads its own share of the baseline run: failed when its verify.sql did not hold', () => {
    const runtime = combinedLayer([
      { id: 'A', layer: layer('passed', 1) },
      { id: 'B', layer: layer('failed', 1, 1, 'x') },
    ])
    expect(coveredVerification('A', 'baseline:acme', run(runtime)).status).toBe('passed')
    expect(coveredVerification('B', 'baseline:acme', run(runtime)).status).toBe('failed')
    expect(coveredVerification('B', 'baseline:acme', undefined).status).toBe('pending')
  })
})

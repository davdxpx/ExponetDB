import type { LedgerRecord, VerificationRecord } from '@exponetdb/postgres'
import { describe, expect, it } from 'vitest'
import { acceptBaselineSchema, mirrorDiffers, rowsAfterBaseline } from '../src/baseline-chain.ts'
import { dependenciesVerified } from '../src/planner.ts'
import { importedVerification } from '../src/reads.ts'

/**
 * The schema a baseline's re-verification accepts after migrations applied
 * on top of it (Part A follow-up 4; legacy-import.md §2 step 7), and the
 * baseline as a dependency of every production plan.
 */
const REVIEWED = `fp1:17:${'a'.repeat(64)}`
const FIRST = `fp1:17:${'b'.repeat(64)}`
const SECOND = `fp1:17:${'c'.repeat(64)}`
const M1 = '01M5PZ4X8AFWAS024R4BG22KM3'
const M2 = '01M5PZ4X8AFWAS024R4BG22KM4'
const BASELINE = 'baseline:acme-2026'

function row(migrationId: string, seq: number, over: Partial<LedgerRecord> = {}): LedgerRecord {
  return {
    migrationId,
    origin: 'exponetdb',
    name: migrationId,
    checksum: `sha256:c1:${'0'.repeat(64)}`,
    checksumProvenance: 'exponetdb',
    sourceDigest: null,
    verifyDigest: null,
    rollbackDigest: null,
    manifest: null,
    dependencies: [],
    transactional: true,
    appliedSeq: String(seq),
    appliedAt: '2026-10-24T10:00:00.000Z',
    planId: null,
    operationId: 'op_x',
    fingerprintBefore: null,
    fingerprintAfter: null,
    revertedAt: null,
    revertedByOp: null,
    ...over,
  }
}

function run(
  migrationId: string,
  status: VerificationRecord['status'],
  at: string,
): VerificationRecord {
  return {
    verificationId: `vfy_${at}`,
    migrationId,
    operationId: 'op_x',
    verifyDigest: null,
    startedAt: at,
    finishedAt: at,
    status,
    structural: {},
    runtime: null,
    engine: {},
    fingerprint: REVIEWED,
  }
}

const ledger = [
  row('legacy:0001_items', 1, { origin: 'legacy_import' }),
  row(BASELINE, 2, { origin: 'baseline', fingerprintBefore: REVIEWED, fingerprintAfter: REVIEWED }),
  row(M2, 10, { fingerprintBefore: FIRST, fingerprintAfter: SECOND }),
  row(M1, 9, { fingerprintBefore: REVIEWED, fingerprintAfter: FIRST }),
]
const later = rowsAfterBaseline(ledger, BASELINE)
const verified = [
  run(M1, 'passed', '2026-10-24T10:01:00.000Z'),
  run(M2, 'passed', '2026-10-24T10:02:00.000Z'),
]

describe('the schema a baseline accepts', () => {
  it('takes the rows after the baseline in the order they were applied', () => {
    expect(later.map((r) => r.migrationId)).toEqual([M1, M2])
  })

  it('accepts the reviewed schema, and a chain of verified migrations from it', () => {
    expect(
      acceptBaselineSchema({ reviewed: REVIEWED, live: REVIEWED, later: [], verifications: [] }),
    ).toEqual({ kind: 'reviewed' })
    expect(
      acceptBaselineSchema({ reviewed: REVIEWED, live: SECOND, later, verifications: verified }),
    ).toEqual({ kind: 'chain', migrations: 2, last: M2 })
  })

  it('fails without later migrations, on one not verified, a gap, or a live schema after the chain', () => {
    expect(
      acceptBaselineSchema({ reviewed: REVIEWED, live: FIRST, later: [], verifications: [] }),
    ).toMatchObject({ kind: 'failed', name: 'schema fingerprint' })
    // The latest run counts: verified once, failed since.
    expect(
      acceptBaselineSchema({
        reviewed: REVIEWED,
        live: SECOND,
        later,
        verifications: [...verified, run(M2, 'failed', '2026-10-24T10:03:00.000Z')],
      }),
    ).toEqual({
      kind: 'failed',
      name: `schema after the baseline: ${M2}`,
      detail: 'its latest verification is failed',
    })
    expect(
      acceptBaselineSchema({
        reviewed: REVIEWED,
        live: SECOND,
        later,
        verifications: verified.slice(0, 1),
      }),
    ).toMatchObject({ kind: 'failed', detail: 'never verified' })
    // A gap: the second one did not start where the first one ended.
    const gap = [
      later[0] as LedgerRecord,
      row(M2, 10, { fingerprintBefore: REVIEWED, fingerprintAfter: SECOND }),
    ]
    expect(
      acceptBaselineSchema({
        reviewed: REVIEWED,
        live: SECOND,
        later: gap,
        verifications: verified,
      }),
    ).toMatchObject({ kind: 'failed', name: `schema after the baseline: ${M2}` })
    // A change by hand after the last verified migration.
    expect(
      acceptBaselineSchema({
        reviewed: REVIEWED,
        live: `fp1:17:${'d'.repeat(64)}`,
        later,
        verifications: verified,
      }),
    ).toMatchObject({
      kind: 'failed',
      detail: 'the live schema is not the one the last verified migration left',
    })
    // A reverted migration ends the chain.
    expect(
      acceptBaselineSchema({
        reviewed: REVIEWED,
        live: SECOND,
        later: [{ ...(later[0] as LedgerRecord), revertedAt: '2026-10-24T11:00:00.000Z' }],
        verifications: verified,
      }),
    ).toMatchObject({ kind: 'failed', detail: 'reverted after the baseline' })
  })
})

describe("the target's rows after the baseline against the Control Store's mirror", () => {
  const mirrored = later.map((r) => ({
    migrationId: r.migrationId,
    checksum: r.checksum,
    operationId: r.operationId,
    fingerprintBefore: r.fingerprintBefore,
    fingerprintAfter: r.fingerprintAfter,
    reverted: false,
  }))
  it('agrees when every row is the mirrored one', () => {
    expect(mirrorDiffers(later, mirrored)).toBe(null)
  })
  it('names a row the mirror does not hold, or holds otherwise', () => {
    expect(mirrorDiffers(later, mirrored.slice(0, 1))).toBe(M2)
    expect(
      mirrorDiffers(later, [
        { ...(mirrored[0] as (typeof mirrored)[number]), fingerprintAfter: SECOND },
        mirrored[1] as (typeof mirrored)[number],
      ]),
    ).toBe(M1)
    expect(
      mirrorDiffers(later, [
        mirrored[0] as (typeof mirrored)[number],
        { ...(mirrored[1] as (typeof mirrored)[number]), reverted: true },
      ]),
    ).toBe(M2)
  })
})

describe('the baseline as a dependency of a production plan', () => {
  const order = [{ migrationId: '01M5PZ4X8AFWAS024R4BG22KM5', dependsOn: [M1] }] as never
  it('needs the baseline verified, as every applied dependency', () => {
    expect(dependenciesVerified(order, ledger, verified)).toBe(false)
    expect(
      dependenciesVerified(order, ledger, [
        ...verified,
        run(BASELINE, 'failed', '2026-10-24T09:00:00.000Z'),
      ]),
    ).toBe(false)
    expect(
      dependenciesVerified(order, ledger, [
        ...verified,
        run(BASELINE, 'passed', '2026-10-24T09:00:00.000Z'),
      ]),
    ).toBe(true)
    // A target without a baseline: only the applied dependencies count.
    expect(
      dependenciesVerified(
        order,
        ledger.filter((r) => r.origin === 'exponetdb'),
        verified,
      ),
    ).toBe(true)
  })
})

describe("an imported row's verification, from its baseline's run (follow-up 4 addendum)", () => {
  const failure = (file: string, excused: boolean) => ({
    file,
    statement: 0,
    kind: 'row_security',
    object: `row security of ${file}`,
    failed: ['enabled'],
    excused,
  })
  const baselineRun = (
    status: VerificationRecord['status'],
    structural: Record<string, unknown>,
  ): VerificationRecord => ({
    ...run(BASELINE, status, '2026-10-24T12:00:00.000Z'),
    structural: structural as never,
  })

  it('is pending without a run, and says it comes from the baseline', () => {
    expect(importedVerification('0001_items', BASELINE, undefined, false)).toEqual({
      status: 'pending',
      verifiedAt: null,
      verifyDigest: null,
      via: BASELINE,
    })
  })

  it("is the row's share of the run: passed with its excusals, failed with an open failure", () => {
    const passed = baselineRun('passed', {
      status: 'passed',
      checks: 10,
      failed: 0,
      firstFailure: null,
      excused: 1,
      failures: [failure('0002_rls', true)],
      failuresTotal: 1,
    })
    expect(importedVerification('0002_rls', BASELINE, passed, false)).toMatchObject({
      status: 'passed',
      verifiedAt: '2026-10-24T12:00:00.000Z',
      via: BASELINE,
      excused: 1,
    })
    expect(importedVerification('0001_items', BASELINE, passed, false)).not.toHaveProperty(
      'excused',
    )
    const failed = baselineRun('failed', {
      status: 'failed',
      checks: 10,
      failed: 1,
      firstFailure: { name: 'x', detail: null },
      excused: 1,
      failures: [failure('0004_role', false), failure('0002_rls', true)],
      failuresTotal: 2,
    })
    expect(importedVerification('0004_role', BASELINE, failed, false).status).toBe('failed')
    // Every failure of the run is known: a row with none of them open passed.
    expect(importedVerification('0001_items', BASELINE, failed, false).status).toBe('passed')
  })

  it("takes the run's status when the run did not keep every failure, or could not read the history", () => {
    const cut = baselineRun('failed', {
      status: 'failed',
      checks: 900,
      failed: 400,
      firstFailure: { name: 'x', detail: null },
      failures: [failure('0004_role', false)],
      failuresTotal: 400,
    })
    expect(importedVerification('0001_items', BASELINE, cut, false).status).toBe('failed')
    // A run of the release before kept two counts only.
    const counts = baselineRun('failed', { checked: 13507, held: 13115 })
    expect(importedVerification('0001_items', BASELINE, counts, false).status).toBe('failed')
    const unparsed = baselineRun('failed', { checked: 0, held: 0, unparsed: '0007_x' })
    expect(importedVerification('0001_items', BASELINE, unparsed, false).status).toBe('error')
  })

  it('says so for a superseded file instead of a share', () => {
    const passed = baselineRun('passed', {
      status: 'passed',
      checks: 1,
      failed: 0,
      firstFailure: null,
    })
    expect(importedVerification('0003_old', BASELINE, passed, true)).toEqual({
      status: 'passed',
      verifiedAt: '2026-10-24T12:00:00.000Z',
      verifyDigest: null,
      via: BASELINE,
      superseded: true,
    })
  })
})

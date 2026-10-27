import { describe, expect, it } from 'vitest'
import {
  type BackupFact,
  computeProtection,
  type DrillFact,
  type ProtectionInput,
  type RepositoryFact,
  type WalFact,
} from '../src/protection.ts'

const NOW = Date.parse('2026-10-26T12:00:00Z')
const MIN = 60_000
const DAY = 86_400_000

const repo = (over: Partial<RepositoryFact> = {}): RepositoryFact => ({
  id: 'bkr_01M60000000000000000000001',
  layer: 'l1_physical',
  provider: 'cloudflare_r2',
  state: 'active',
  ownership: 'adopted_observed',
  lockCapability: 'proven',
  cipher: 'aes-256-cbc',
  offlineCopyConfirmed: true,
  engineAdvisory: 'none',
  reconciledAtMs: NOW - 5 * MIN,
  reconciliationOutcome: 'ok',
  ...over,
})

const full = (over: Partial<BackupFact> = {}): BackupFact => ({
  repositoryId: 'bkr_01M60000000000000000000001',
  kind: 'full',
  state: 'succeeded',
  startedAtMs: NOW - DAY - 20 * MIN,
  finishedAtMs: NOW - DAY,
  verification: 'passed',
  divergence: 'none',
  walStart: '000000010000001A0000003B',
  ...over,
})

const wal = (over: Partial<WalFact> = {}): WalFact => ({
  repositoryId: 'bkr_01M60000000000000000000001',
  timeline: 1,
  minSegment: '000000010000001A00000030',
  maxSegment: '000000010000001B00000042',
  maxArchivedAtMs: NOW - 2 * MIN,
  gapEnds: [],
  observedAtMs: NOW - 5 * MIN,
  ...over,
})

const drill = (over: Partial<DrillFact> = {}): DrillFact => ({
  id: 'drl_01M60000000000000000000009',
  mode: 'control_plane',
  outcome: 'passed',
  finishedAtMs: NOW - 3 * DAY,
  measuredRtoSeconds: 1800,
  ...over,
})

const base = (over: Partial<ProtectionInput> = {}): ProtectionInput => ({
  nowMs: NOW,
  repositories: [repo()],
  backups: [full()],
  wal: [wal()],
  archive: { failing: false, lastArchivedAtMs: NOW - 2 * MIN, observedAtMs: NOW - MIN },
  drills: [drill()],
  policy: { rpoObjectiveSeconds: 900, rtoObjectiveSeconds: 4 * 3600, drillCadenceDays: 30 },
  clockSkewSeconds: 1,
  ...over,
})

describe('backup protection (architecture.md §4, ADR-0038 §5)', () => {
  it('measures the RPO from the archive but never calls the WAL range proven (review finding A-4)', () => {
    const p = computeProtection(base())
    expect(p.state).toBe('unproven')
    expect(p.reasons).toEqual(['wal_continuity_unproven'])
    expect(p.rpo.basis).toBe('wal_archive')
    expect(p.rpo.achievableSeconds).toBe(120)
    expect(p.rto.measuredSeconds).toBe(1800)
    expect(p.pitrWindow).toEqual({
      from: new Date(NOW - DAY).toISOString(),
      to: new Date(NOW - 2 * MIN).toISOString(),
    })
  })

  it('is protected only when everything is measured, proven and within the objectives', () => {
    // A verified backup within the objective, no WAL claim, a drill in cadence.
    const p = computeProtection(
      base({
        wal: [],
        backups: [full({ finishedAtMs: NOW - 10 * MIN })],
        policy: { rpoObjectiveSeconds: 3600, rtoObjectiveSeconds: 4 * 3600, drillCadenceDays: 30 },
      }),
    )
    expect(p.state).toBe('protected')
    expect(p.reasons).toEqual([])
    expect(p.rpo.basis).toBe('verified_backup')
  })

  it('treats a truncated listing as stale, never as fresh (review finding A-5)', () => {
    const p = computeProtection(
      base({ repositories: [repo({ reconciliationOutcome: 'partial' })] }),
    )
    expect(p.state).not.toBe('protected')
    expect(p.reasons).toContain('catalog_stale')
  })

  it('does not believe an archive time in the future (review finding A-3)', () => {
    const p = computeProtection(base({ wal: [wal({ maxArchivedAtMs: NOW + 60 * MIN })] }))
    expect(p.rpo.basis).not.toBe('wal_archive')
  })

  it('is unknown, never empty or green, without a repository', () => {
    const p = computeProtection(base({ repositories: [], backups: [], wal: [] }))
    expect(p.state).toBe('unknown')
    expect(p.reasons).toContain('no_repository')
    expect(p.rpo.achievableSeconds).toBeNull()
  })

  it('is unknown when the only repository was never read or its read failed', () => {
    for (const r of [
      repo({ reconciledAtMs: null, reconciliationOutcome: null }),
      repo({ reconciliationOutcome: 'failed' }),
      repo({ reconciledAtMs: NOW - 2 * 3600_000 }),
    ]) {
      const p = computeProtection(base({ repositories: [r] }))
      expect(p.state).toBe('unknown')
      expect(p.rpo.basis).toBe('none')
    }
  })

  it('never counts an unproven lock as protection (G9 S item)', () => {
    const p = computeProtection(base({ repositories: [repo({ lockCapability: 'unproven' })] }))
    expect(p.state).toBe('at_risk')
    expect(p.reasons).toContain('lock_not_proven')
  })

  it('does not count a posix repository as off-host', () => {
    const p = computeProtection(base({ repositories: [repo({ provider: 'posix' })] }))
    expect(p.reasons).toContain('not_off_host')
    expect(p.state).toBe('unprotected')
  })

  it('falls back to the newest verified backup when the archive is failing or stale', () => {
    for (const archive of [
      { failing: true, lastArchivedAtMs: NOW - 20 * MIN, observedAtMs: NOW - MIN },
      { failing: false, lastArchivedAtMs: NOW - 2 * MIN, observedAtMs: NOW - 30 * MIN },
      null,
    ]) {
      const p = computeProtection(base({ archive }))
      expect(p.rpo.basis).toBe('verified_backup')
      expect(p.rpo.achievableSeconds).toBe(86_400)
      expect(p.state).toBe('at_risk')
      expect(p.reasons).toContain('rpo_above_objective')
    }
    expect(
      computeProtection(
        base({ archive: { failing: true, lastArchivedAtMs: null, observedAtMs: NOW } }),
      ).reasons,
    ).toContain('wal_archive_failing')
  })

  it('ignores backups that are unverified, failed or no longer listed by the engine', () => {
    for (const b of [
      full({ verification: 'pending' }),
      full({ verification: 'failed' }),
      full({ divergence: 'missing_in_engine' }),
      full({ state: 'failed' }),
    ]) {
      const p = computeProtection(base({ backups: [b], archive: null }))
      expect(p.lastVerifiedBackupAt).toBeNull()
      expect(p.reasons).toContain('no_verified_backup')
    }
  })

  it('has no PITR window across a WAL gap after the base', () => {
    const gap = wal({ gapEnds: ['000000010000001B00000001'] })
    const p = computeProtection(base({ wal: [gap] }))
    expect(p.pitrWindow).toBeNull()
    expect(p.reasons).toContain('wal_gap')
    expect(p.rpo.basis).toBe('verified_backup')
  })

  it('reports an uncertainty above the objective as unknown, never as within it', () => {
    const p = computeProtection(base({ clockSkewSeconds: 3600 }))
    expect(p.reasons).toContain('rpo_unknown')
    expect(p.state).toBe('at_risk')
  })

  it('takes the RTO only from a passed drill run by ExponetDB; an offline drill is an attestation', () => {
    const p = computeProtection(
      base({
        drills: [
          drill({ outcome: 'failed', finishedAtMs: NOW - DAY, measuredRtoSeconds: null }),
          drill({ id: 'drl_01M60000000000000000000008', finishedAtMs: NOW - 10 * DAY }),
          drill({
            id: 'drl_01M60000000000000000000007',
            mode: 'offline_runbook',
            outcome: 'attested',
            finishedAtMs: NOW - MIN,
            measuredRtoSeconds: null,
          }),
        ],
      }),
    )
    expect(p.drill.state).toBe('failed')
    expect(p.rto.drillId).toBe('drl_01M60000000000000000000008')
    expect(p.state).toBe('at_risk')
    const attestedOnly = computeProtection(
      base({
        drills: [
          drill({
            mode: 'offline_runbook',
            outcome: 'attested',
            finishedAtMs: NOW - MIN,
            measuredRtoSeconds: null,
          }),
        ],
      }),
    )
    expect(attestedOnly.drill.state).toBe('never')
    expect(attestedOnly.rto.measuredSeconds).toBeNull()
    expect(attestedOnly.state).toBe('unproven')
  })

  it('is unproven while the last passed drill is older than the cadence', () => {
    const p = computeProtection(base({ drills: [drill({ finishedAtMs: NOW - 40 * DAY })] }))
    expect(p.drill.state).toBe('overdue')
    expect(p.state).toBe('unproven')
  })

  it('names the engine advisory and an unconfirmed offline key copy', () => {
    const p = computeProtection(
      base({
        repositories: [
          repo({ engineAdvisory: 'subkey_check_missing', offlineCopyConfirmed: false }),
        ],
      }),
    )
    expect(p.reasons).toEqual(
      expect.arrayContaining(['engine_advisory', 'offline_key_unconfirmed']),
    )
    expect(p.state).toBe('at_risk')
  })

  it('ignores retired and external repositories', () => {
    const p = computeProtection(
      base({ repositories: [repo({ state: 'retired' }), repo({ ownership: 'external' })] }),
    )
    expect(p.state).toBe('unknown')
    expect(p.reasons).toContain('no_repository')
  })
})

import type { BackupProtection } from '@exponetdb/contracts'

/**
 * The measured protection of a cluster ([architecture.md §4](../../../exponetdb-docs/09-backups-and-restore/architecture.md#4-freshness-rpo-and-rto-as-measured-values),
 * ADR-0038 §5). Pure: the facts come from the catalog mirror, the latest
 * WAL archive observation and the drill records; nothing here reads a
 * clock or a store. Every value that cannot be computed is null with a
 * reason, never a guess (C-30), and the states only get worse with missing
 * input: unknown > unprotected > at_risk > unproven > protected.
 */

/** A catalog older than this is stale for display (the mirror is refreshed every 10 minutes). */
export const CATALOG_STALE_AFTER_MS = 30 * 60_000
/** A WAL archive observation older than this does not prove the archive works now. */
/** How far an observed time may lie in the future (clock skew) before it is not believed. */
export const FUTURE_TOLERANCE_MS = 5 * 60_000
export const ARCHIVE_STALE_AFTER_MS = 10 * 60_000

export interface RepositoryFact {
  readonly id: string
  readonly layer: 'l1_physical' | 'l2_logical' | 'l3_offprovider'
  readonly provider: string
  readonly state: 'registered' | 'observing' | 'active' | 'degraded' | 'retired'
  readonly ownership: 'external' | 'adopted_observed' | 'adopted_runs' | 'owned'
  readonly lockCapability: 'unknown' | 'unsupported' | 'unproven' | 'proven'
  readonly cipher: 'aes-256-cbc' | 'restic' | 'none' | 'unknown'
  readonly offlineCopyConfirmed: boolean
  readonly engineAdvisory: 'none' | 'below_floor' | 'subkey_check_missing' | 'unknown'
  readonly reconciledAtMs: number | null
  readonly reconciliationOutcome: 'ok' | 'partial' | 'failed' | null
}

export interface BackupFact {
  readonly repositoryId: string
  readonly kind: 'full' | 'differential' | 'incremental' | 'logical'
  readonly state: 'running' | 'succeeded' | 'failed'
  readonly startedAtMs: number
  readonly finishedAtMs: number | null
  readonly verification: 'pending' | 'passed' | 'failed'
  readonly divergence: 'none' | 'missing_in_engine'
  /** The first WAL segment the backup needs (24 hex digits), when the engine said. */
  readonly walStart: string | null
}

export interface WalFact {
  readonly repositoryId: string
  readonly timeline: number
  readonly minSegment: string | null
  readonly maxSegment: string | null
  readonly maxArchivedAtMs: number | null
  /** The first segment after each gap (the archive misses the segments before it). */
  readonly gapEnds: readonly string[]
  readonly observedAtMs: number
}

export interface ArchiveFact {
  /** pg_stat_archiver: the last failure is newer than the last success. */
  readonly failing: boolean
  readonly lastArchivedAtMs: number | null
  readonly observedAtMs: number
}

export interface DrillFact {
  readonly id: string
  readonly mode: 'control_plane' | 'offline_runbook'
  readonly outcome: 'pending' | 'passed' | 'failed' | 'aborted' | 'attested'
  readonly finishedAtMs: number | null
  readonly measuredRtoSeconds: number | null
}

export interface PolicyFact {
  readonly rpoObjectiveSeconds: number | null
  readonly rtoObjectiveSeconds: number | null
  readonly drillCadenceDays: number
}

export interface ProtectionInput {
  readonly nowMs: number
  readonly repositories: readonly RepositoryFact[]
  readonly backups: readonly BackupFact[]
  readonly wal: readonly WalFact[]
  readonly archive: ArchiveFact | null
  readonly drills: readonly DrillFact[]
  readonly policy: PolicyFact | null
  /** The node's reported clock skew (absolute), when known. */
  readonly clockSkewSeconds: number | null
}

type Reason = BackupProtection['reasons'][number]

const iso = (ms: number) => new Date(ms).toISOString()
const seconds = (ms: number) => Math.max(0, Math.floor(ms / 1000))

/**
 * A repository whose catalog may be relied on now: reconciled completely and recently. A
 * truncated listing (`partial`) cannot mark what the engine no longer lists, so it is stale
 * (review finding A-5).
 */
function fresh(r: RepositoryFact, nowMs: number): boolean {
  return (
    r.reconciledAtMs !== null &&
    r.reconciliationOutcome === 'ok' &&
    nowMs - r.reconciledAtMs <= CATALOG_STALE_AFTER_MS
  )
}

/** Off the database host: a posix repository is a directory on some host and never counts. */
export function offHost(r: Pick<RepositoryFact, 'provider'>): boolean {
  return r.provider !== 'posix'
}

/**
 * The oldest base backup from which the archive is continuous to its newest
 * segment: every gap ends at or before the backup's first segment. Segment
 * names of one timeline order lexically (fixed-width hex).
 */
function pitrBase(
  bases: readonly BackupFact[],
  wal: readonly WalFact[],
): { readonly base: BackupFact; readonly coverage: WalFact } | undefined {
  for (const base of [...bases].sort((a, b) => a.startedAtMs - b.startedAtMs)) {
    if (base.walStart === null) continue
    const timeline = Number.parseInt(base.walStart.slice(0, 8), 16)
    const coverage = wal.find(
      (w) =>
        w.repositoryId === base.repositoryId &&
        w.timeline === timeline &&
        w.minSegment !== null &&
        w.maxSegment !== null &&
        w.maxArchivedAtMs !== null &&
        w.minSegment <= (base.walStart as string),
    )
    if (coverage === undefined) continue
    if (coverage.gapEnds.every((end) => end <= (base.walStart as string))) {
      return { base, coverage }
    }
  }
  return undefined
}

export function computeProtection(input: ProtectionInput): BackupProtection {
  const { nowMs } = input
  const reasons = new Set<Reason>()
  const live = input.repositories.filter((r) => r.state !== 'retired' && r.ownership !== 'external')
  const readable = live.filter((r) => fresh(r, nowMs))
  const readableIds = new Set(readable.map((r) => r.id))
  const offHostIds = new Set(readable.filter(offHost).map((r) => r.id))
  const cadenceDays = input.policy?.drillCadenceDays ?? null

  if (live.length === 0) reasons.add('no_repository')
  for (const r of live) {
    if (r.reconciledAtMs === null || r.reconciliationOutcome === 'failed') {
      reasons.add('repository_unreadable')
    } else if (!fresh(r, nowMs)) {
      reasons.add('catalog_stale')
    }
    if (offHost(r) && r.lockCapability !== 'proven') reasons.add('lock_not_proven')
    if (r.cipher !== 'none' && !r.offlineCopyConfirmed) reasons.add('offline_key_unconfirmed')
    if (r.engineAdvisory !== 'none') reasons.add('engine_advisory')
  }
  if (readable.length > 0 && offHostIds.size === 0) reasons.add('not_off_host')

  // Backups that count: succeeded, still listed by the engine, in a readable off-host repository.
  const counted = input.backups.filter(
    (b) =>
      b.state === 'succeeded' &&
      b.finishedAtMs !== null &&
      b.divergence === 'none' &&
      offHostIds.has(b.repositoryId),
  )
  const verified = counted.filter((b) => b.verification === 'passed')
  const lastVerified = verified.reduce<BackupFact | undefined>(
    (best, b) =>
      best === undefined || (b.finishedAtMs ?? 0) > (best.finishedAtMs ?? 0) ? b : best,
    undefined,
  )
  if (lastVerified === undefined) reasons.add('no_verified_backup')

  // WAL: the archive must be observed recently and not failing to count as a basis.
  const archiveOk =
    input.archive !== null &&
    !input.archive.failing &&
    nowMs - input.archive.observedAtMs <= ARCHIVE_STALE_AFTER_MS
  if (input.archive?.failing === true) reasons.add('wal_archive_failing')
  const wal = input.wal.filter(
    (w) => readableIds.has(w.repositoryId) && offHostIds.has(w.repositoryId),
  )
  if (wal.some((w) => w.gapEnds.length > 0)) reasons.add('wal_gap')

  const bases = counted.filter((b) => b.kind !== 'logical')
  const pitr = pitrBase(bases, wal)
  const skew = input.clockSkewSeconds ?? null

  let rpo: BackupProtection['rpo']
  const walNewest = wal.reduce<WalFact | undefined>(
    (best, w) =>
      w.maxArchivedAtMs !== null &&
      // A time in the future is not a fresh archive (it would read as an RPO of zero).
      w.maxArchivedAtMs <= nowMs + FUTURE_TOLERANCE_MS &&
      (best === undefined || w.maxArchivedAtMs > (best.maxArchivedAtMs ?? 0))
        ? w
        : best,
    undefined,
  )
  if (archiveOk && walNewest?.maxArchivedAtMs != null && pitr !== undefined) {
    // The engine lists the oldest and newest segment of an archive, not every segment between:
    // a hole inside the range is found only by a verify run or a restore (review finding A-4).
    reasons.add('wal_continuity_unproven')
    const age = nowMs - walNewest.maxArchivedAtMs
    const uncertainty = Math.max(skew ?? 0, seconds(nowMs - walNewest.observedAtMs))
    rpo = {
      achievableSeconds: seconds(age),
      uncertaintySeconds: uncertainty,
      basis: 'wal_archive',
      objectiveSeconds: input.policy?.rpoObjectiveSeconds ?? null,
    }
  } else if (lastVerified?.finishedAtMs != null) {
    const repo = readable.find((r) => r.id === lastVerified.repositoryId)
    const uncertainty = Math.max(
      skew ?? 0,
      repo?.reconciledAtMs == null ? 0 : seconds(nowMs - repo.reconciledAtMs),
    )
    rpo = {
      achievableSeconds: seconds(nowMs - lastVerified.finishedAtMs),
      uncertaintySeconds: uncertainty,
      basis: 'verified_backup',
      objectiveSeconds: input.policy?.rpoObjectiveSeconds ?? null,
    }
  } else {
    rpo = {
      achievableSeconds: null,
      uncertaintySeconds: null,
      basis: 'none',
      objectiveSeconds: input.policy?.rpoObjectiveSeconds ?? null,
    }
  }
  const objective = rpo.objectiveSeconds
  if (rpo.achievableSeconds === null) {
    reasons.add('rpo_unknown')
  } else if (objective !== null) {
    if ((rpo.uncertaintySeconds ?? 0) > objective) {
      // The value cannot be told apart from a breach: unknown, never green.
      reasons.add('rpo_unknown')
    } else if (rpo.achievableSeconds + (rpo.uncertaintySeconds ?? 0) > objective) {
      reasons.add('rpo_above_objective')
    }
  }

  // Drills: only drills run by ExponetDB that passed measure anything; an
  // offline drill is an attestation (C-35) and never proves the RTO.
  const measured = input.drills.filter((d) => d.mode === 'control_plane' && d.finishedAtMs !== null)
  const passed = measured
    .filter((d) => d.outcome === 'passed')
    .sort((a, b) => (b.finishedAtMs ?? 0) - (a.finishedAtMs ?? 0))
  const lastPassed = passed[0]
  const lastFinished = [...measured]
    .filter((d) => d.outcome === 'passed' || d.outcome === 'failed')
    .sort((a, b) => (b.finishedAtMs ?? 0) - (a.finishedAtMs ?? 0))[0]
  let drillState: BackupProtection['drill']['state']
  if (lastFinished !== undefined && lastFinished.outcome === 'failed') {
    drillState = 'failed'
    reasons.add('drill_failed')
  } else if (lastPassed === undefined) {
    drillState = 'never'
    reasons.add('drill_never')
  } else if (
    cadenceDays === null ||
    nowMs - (lastPassed.finishedAtMs ?? 0) > cadenceDays * 86_400_000
  ) {
    drillState = 'overdue'
    reasons.add('drill_overdue')
  } else {
    drillState = 'passed_in_cadence'
  }

  const has = (r: Reason) => reasons.has(r)
  let state: BackupProtection['state']
  if (
    has('no_repository') ||
    readable.length === 0 ||
    (readable.length < live.length && rpo.basis === 'none')
  ) {
    state = 'unknown'
  } else if (rpo.basis === 'none') {
    state = 'unprotected'
  } else if (
    has('wal_archive_failing') ||
    has('wal_gap') ||
    has('rpo_above_objective') ||
    has('rpo_unknown') ||
    has('drill_failed') ||
    has('not_off_host') ||
    has('lock_not_proven') ||
    has('offline_key_unconfirmed') ||
    has('engine_advisory') ||
    has('repository_unreadable') ||
    has('catalog_stale')
  ) {
    state = 'at_risk'
  } else if (drillState !== 'passed_in_cadence' || has('wal_continuity_unproven')) {
    state = 'unproven'
  } else {
    state = 'protected'
  }

  return {
    state,
    reasons: [...reasons].sort(),
    rpo,
    rto: {
      measuredSeconds: lastPassed?.measuredRtoSeconds ?? null,
      drillId: (lastPassed?.id ?? null) as BackupProtection['rto']['drillId'],
      drillAt: lastPassed?.finishedAtMs == null ? null : iso(lastPassed.finishedAtMs),
      objectiveSeconds: input.policy?.rtoObjectiveSeconds ?? null,
    },
    pitrWindow:
      pitr === undefined ||
      pitr.base.finishedAtMs === null ||
      pitr.coverage.maxArchivedAtMs === null
        ? null
        : { from: iso(pitr.base.finishedAtMs), to: iso(pitr.coverage.maxArchivedAtMs) },
    lastVerifiedBackupAt:
      lastVerified?.finishedAtMs == null ? null : iso(lastVerified.finishedAtMs),
    drill: {
      state: drillState,
      lastPassedAt: lastPassed?.finishedAtMs == null ? null : iso(lastPassed.finishedAtMs),
      cadenceDays,
    },
  }
}

/** The health field `backups.state` of a target: the protection state of its cluster. */
export function healthState(p: BackupProtection): BackupProtection['state'] {
  return p.state
}

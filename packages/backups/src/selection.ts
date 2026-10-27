import type { BackupEntryView, CoverageRecord } from './records.ts'
import { segmentLsn } from './records.ts'

/**
 * Which backup and WAL range a restore uses (restore.md §2, ADR-0038 §1,
 * §4). Pure: the planner passes the catalog mirror of one repository, its
 * WAL coverage and, for a random drill, a random source. The result is
 * bound in the plan and checked again at apply. Nothing here guesses: a
 * point in time outside the shown continuous window is refused, and a WAL
 * range whose newest time is unknown is not continuous.
 */

export interface SelectableBackup {
  readonly view: BackupEntryView
  readonly walStart: string | null
  readonly systemIdentifier: string | null
}

export type SourceRequest =
  | { readonly kind: 'latest' }
  | { readonly kind: 'older' }
  | { readonly kind: 'backup'; readonly backupId: string }
  | { readonly kind: 'pitr'; readonly atMs: number }
  | { readonly kind: 'pitr_random' }

export interface ResolvedSource {
  readonly backupId: string
  readonly label: string
  readonly verification: 'pending' | 'passed' | 'failed'
  readonly verificationAt: string | null
  readonly timeline: number | null
  readonly walFrom: string | null
  readonly walTo: string | null
  readonly pointInTime: string | null
  readonly walContinuous: boolean
  readonly postgresMajor: number | null
  readonly systemIdentifier: string | null
  readonly engineVersion: string | null
}

export type Selection =
  | { readonly ok: true; readonly source: ResolvedSource }
  | {
      readonly ok: false
      readonly reason: 'no_backup_selectable' | 'backup_not_found' | 'point_in_time_outside_window'
    }

/** At least this far before the newest archived WAL, so the random point is inside what is surely archived. */
export const PITR_MARGIN_MS = 5 * 60_000

function basesOf(backups: readonly SelectableBackup[]): SelectableBackup[] {
  return backups
    .filter(
      (b) =>
        b.view.state === 'succeeded' &&
        b.view.finishedAt !== null &&
        b.view.divergence === 'none' &&
        b.view.kind !== 'logical',
    )
    .sort((a, b) => Date.parse(b.view.finishedAt ?? '') - Date.parse(a.view.finishedAt ?? ''))
}

function coverageFor(
  b: SelectableBackup,
  coverage: readonly CoverageRecord[],
): CoverageRecord | undefined {
  if (b.walStart === null) return undefined
  const timeline = Number.parseInt(b.walStart.slice(0, 8), 16)
  return coverage.find(
    (c) =>
      c.repositoryId === b.view.repositoryId &&
      c.timeline === timeline &&
      c.minSegment !== null &&
      c.maxSegment !== null &&
      c.minSegment <= (b.walStart as string),
  )
}

/** The WAL from the base's start to the coverage's end is continuous: no gap ends after the base starts. */
function continuousFrom(b: SelectableBackup, c: CoverageRecord | undefined): boolean {
  if (c === undefined || b.walStart === null) return false
  return c.gapEnds.every((end) => end <= (b.walStart as string))
}

function resolved(
  b: SelectableBackup,
  c: CoverageRecord | undefined,
  pointInTimeMs: number | null,
): ResolvedSource {
  const continuous = continuousFrom(b, c)
  return {
    backupId: b.view.id,
    label: b.view.engineLabel,
    verification: b.view.verification.state,
    verificationAt: b.view.verification.verifiedAt,
    timeline: b.view.timeline,
    walFrom: b.walStart === null ? null : segmentLsn(b.walStart),
    walTo: c?.maxSegment == null ? null : segmentLsn(c.maxSegment),
    pointInTime: pointInTimeMs === null ? null : new Date(pointInTimeMs).toISOString(),
    // A point in time needs the archive to reach it; without a recorded time of the newest segment it is not shown.
    walContinuous:
      pointInTimeMs === null
        ? continuous || b.view.lsnStop !== null
        : continuous && c?.maxArchivedAt != null && c.maxArchivedAt.getTime() >= pointInTimeMs,
    postgresMajor: b.view.postgresMajor,
    systemIdentifier: b.systemIdentifier,
    engineVersion: b.view.engineVersion,
  }
}

export function selectSource(
  backups: readonly SelectableBackup[],
  coverage: readonly CoverageRecord[],
  request: SourceRequest,
  random: () => number = Math.random,
): Selection {
  const bases = basesOf(backups)
  const verified = bases.filter((b) => b.view.verification.state === 'passed')
  switch (request.kind) {
    case 'latest': {
      const b = verified[0] ?? bases[0]
      return b === undefined
        ? { ok: false, reason: 'no_backup_selectable' }
        : { ok: true, source: resolved(b, coverageFor(b, coverage), null) }
    }
    case 'older': {
      const b = verified[1]
      return b === undefined
        ? { ok: false, reason: 'no_backup_selectable' }
        : { ok: true, source: resolved(b, coverageFor(b, coverage), null) }
    }
    case 'backup': {
      // Only a base that can be restored: succeeded, still listed by the engine, physical
      // (review finding C-7). An entry missing in the engine is not offered by name either.
      const b = bases.find((x) => x.view.id === request.backupId)
      if (b === undefined) return { ok: false, reason: 'backup_not_found' }
      return { ok: true, source: resolved(b, coverageFor(b, coverage), null) }
    }
    case 'pitr': {
      const b = verified.find((x) => Date.parse(x.view.finishedAt ?? '') <= request.atMs)
      if (b === undefined) return { ok: false, reason: 'point_in_time_outside_window' }
      const c = coverageFor(b, coverage)
      if (c?.maxArchivedAt == null || c.maxArchivedAt.getTime() < request.atMs) {
        return { ok: false, reason: 'point_in_time_outside_window' }
      }
      return { ok: true, source: resolved(b, c, request.atMs) }
    }
    case 'pitr_random': {
      // The oldest verified base from which the archive is continuous to its end.
      const windows = verified
        .map((b) => ({ b, c: coverageFor(b, coverage) }))
        .filter(({ b, c }) => continuousFrom(b, c) && c?.maxArchivedAt != null)
      const oldest = windows[windows.length - 1]
      if (oldest === undefined) return { ok: false, reason: 'no_backup_selectable' }
      const from = Date.parse(oldest.b.view.finishedAt ?? '')
      const to = (oldest.c?.maxArchivedAt?.getTime() ?? from) - PITR_MARGIN_MS
      if (!(to > from)) return { ok: false, reason: 'point_in_time_outside_window' }
      const at = Math.floor(from + random() * (to - from))
      // The newest verified base at or before the drawn instant.
      const base = verified.find((x) => Date.parse(x.view.finishedAt ?? '') <= at) ?? oldest.b
      return { ok: true, source: resolved(base, coverageFor(base, coverage), at) }
    }
  }
}

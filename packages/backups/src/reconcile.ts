import type { Queryable, Tx } from '@exponetdb/control-store'
import { type JsonObject, newId } from '@exponetdb/kernel'

/**
 * Reconciliation of the catalog mirror with the engine's own catalog
 * ([architecture.md §3](../../../exponetdb-docs/09-backups-and-restore/architecture.md#3-catalog), C-32).
 * The input is a node-signed `backup.list@1` result the worker already
 * judged (signature and schema). The engine is the truth: entries it lists
 * are inserted or refreshed; entries it no longer lists are marked
 * `missing_in_engine` (finding `backup_catalog_divergence`), never deleted
 * and never counted as protection. A stanza that names another
 * `system_identifier` than the cluster's pinned one is not ingested at all
 * (finding `backup_identity_mismatch`, critical): a mirror of another
 * cluster's backups would make a restore plan pick the wrong source.
 */

/** pgBackRest releases before this one may hold weak encryption subkeys (2026-10-04 advisory, ADR-0036 §5). */
export const PGBACKREST_FLOOR = '2.59.3'

export interface ListedBackup {
  readonly label: string
  readonly kind: 'full' | 'differential' | 'incremental' | 'logical'
  readonly startedAt: string
  readonly finishedAt: string | null
  readonly lsnStart: string | null
  readonly lsnStop: string | null
  readonly walStart: string | null
  readonly sizeBytes: number | null
  readonly repositorySizeBytes: number | null
  readonly postgresMajor: number | null
  readonly error: boolean
}

export interface ListResult {
  readonly engineVersion: string | null
  readonly stanza: {
    readonly status: 'ok' | 'missing' | 'error'
    readonly message: string
    readonly systemIdentifier: string | null
    readonly cipher: 'aes-256-cbc' | 'none' | 'unknown'
  } | null
  readonly backups: readonly ListedBackup[]
  readonly archive: readonly {
    readonly id: string
    readonly min: string | null
    readonly max: string | null
  }[]
  readonly truncated: boolean
}

export interface ArchiveObservation {
  readonly lastArchivedWal: string | null
  readonly lastArchivedAt: string | null
}

export interface ReconcileInput {
  readonly repositoryId: string
  readonly clusterId: string
  readonly engine: 'pgbackrest' | 'pg_dump' | 'restic'
  readonly clusterSystemIdentifier: string
  readonly jobId: string | null
  readonly result: ListResult
  readonly archive: ArchiveObservation | null
  readonly nowMs: number
}

export interface ReconcileOutcome {
  readonly outcome: 'ok' | 'partial' | 'failed'
  readonly errorCode: string | null
  readonly entries: number
  readonly inserted: number
  readonly missing: number
}

const SEGMENT = /^[0-9A-F]{24}$/
const LSN = /^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10))
  const pb = b.split('.').map((x) => Number.parseInt(x, 10))
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (Number.isNaN(d)) return Number.NaN
    if (d !== 0) return d
  }
  return 0
}

/**
 * The engine advisory of an observed repository. Upgrading the binary does
 * not replace a weak subkey of a stanza created before 2.59.3, and ExponetDB
 * records no subkey check yet: an encrypted pgBackRest stanza therefore
 * stays `subkey_check_missing` until the owner's check is recorded.
 */
export function engineAdvisory(
  engine: string,
  version: string | null,
  cipher: string | null,
): 'none' | 'below_floor' | 'subkey_check_missing' | 'unknown' {
  if (engine !== 'pgbackrest') return version === null ? 'unknown' : 'none'
  if (version === null || !/^[0-9]+\.[0-9]+(\.[0-9]+)?$/.test(version)) return 'unknown'
  const c = compareVersions(version, PGBACKREST_FLOOR)
  if (Number.isNaN(c)) return 'unknown'
  if (c < 0) return 'below_floor'
  if (cipher === 'aes-256-cbc' || cipher === 'unknown' || cipher === null)
    return 'subkey_check_missing'
  return 'none'
}

/** The timeline of a WAL segment name (its first eight hex digits). */
export function segmentTimeline(segment: string | null): number | null {
  if (segment === null || !SEGMENT.test(segment)) return null
  const t = Number.parseInt(segment.slice(0, 8), 16)
  return t >= 1 ? t : null
}

async function finding(
  tx: Tx,
  clusterId: string,
  code: string,
  severity: 'info' | 'warning' | 'critical',
  key: string,
  summary: string,
  details: JsonObject,
  nowMs: number,
): Promise<void> {
  await tx.query(
    'backups.findings.record',
    `INSERT INTO observation.subject_findings
       (finding_id, cluster_id, kind, code, severity, security_relevant, dedup_key, summary, details, state,
        occurrences, first_seen_at, last_seen_at)
     VALUES ($1, $2, 'backup', $3, $4, $5, $6, $7, $8, 'open', 1, now(), now())
     ON CONFLICT (cluster_id, kind, dedup_key) WHERE state = 'open' AND cluster_id IS NOT NULL
     DO UPDATE SET occurrences = observation.subject_findings.occurrences + 1, severity = EXCLUDED.severity,
                   summary = EXCLUDED.summary, details = EXCLUDED.details`,
    [
      newId('fnd', nowMs),
      clusterId,
      code,
      severity,
      code === 'backup_identity_mismatch',
      key,
      summary,
      JSON.stringify(details),
    ],
  )
}

async function resolve(tx: Tx, clusterId: string, code: string, key: string): Promise<void> {
  await tx.query(
    'backups.findings.resolve',
    `UPDATE observation.subject_findings SET state = 'resolved', resolution = 'cleared'
      WHERE cluster_id = $1 AND kind = 'backup' AND code = $2 AND dedup_key = $3 AND state = 'open'`,
    [clusterId, code, key],
  )
}

/** Folds one judged `backup.list@1` result into the mirror, in the caller's (worker) transaction. */
export async function reconcileCatalog(tx: Tx, input: ReconcileInput): Promise<ReconcileOutcome> {
  const { repositoryId, clusterId, result, nowMs } = input
  const reconciliationId = newId('smp', nowMs)
  const key = (code: string) => `${code}:${repositoryId}`
  const record = async (outcome: ReconcileOutcome, observed: JsonObject | null) => {
    await tx.query(
      'backups.reconciliations.insert',
      `INSERT INTO backups.reconciliations (reconciliation_id, repository_id, job_id, outcome, error_code, entries, divergent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        reconciliationId,
        repositoryId,
        input.jobId,
        outcome.outcome,
        outcome.errorCode,
        outcome.entries,
        outcome.missing,
      ],
    )
    const advisory = engineAdvisory(
      input.engine,
      result.engineVersion,
      result.stanza?.cipher ?? null,
    )
    await tx.query(
      'backups.repositories.observed',
      `UPDATE backups.repositories
          SET observed = coalesce($2::jsonb, observed), observed_at = now(), reconciled_at = now(),
              reconciliation_outcome = $3, reconciliation_error = $4,
              observed_engine_version = coalesce($5, observed_engine_version), engine_advisory = $6,
              state = CASE WHEN $3 = 'failed' THEN 'degraded'
                           WHEN $3 = 'ok' THEN 'active' ELSE state END
        WHERE repository_id = $1 AND state <> 'retired'`,
      [
        repositoryId,
        observed === null ? null : JSON.stringify(observed),
        outcome.outcome,
        outcome.errorCode,
        result.engineVersion,
        advisory,
      ],
    )
    if (advisory === 'none') {
      await resolve(tx, clusterId, 'backup_engine_advisory', key('backup_engine_advisory'))
    } else {
      await finding(
        tx,
        clusterId,
        'backup_engine_advisory',
        'warning',
        key('backup_engine_advisory'),
        advisory === 'below_floor'
          ? `The repository's engine is older than pgBackRest ${PGBACKREST_FLOOR}, which fixes weak encryption subkeys.`
          : advisory === 'subkey_check_missing'
            ? 'The encrypted stanza may predate pgBackRest 2.59.3; its subkey check is not recorded (an upgrade does not replace a weak subkey).'
            : 'The engine version of the repository was not observed.',
        { repositoryId, advisory, engineVersion: result.engineVersion },
        nowMs,
      )
    }
    return outcome
  }

  if (input.engine === 'pgbackrest') {
    const stanza = result.stanza
    if (stanza === null || stanza.status !== 'ok') {
      await finding(
        tx,
        clusterId,
        'backup_repository_unreadable',
        'critical',
        key('backup_repository_unreadable'),
        'The engine could not read the repository (stanza missing or in error).',
        { repositoryId, status: stanza?.status ?? 'missing' },
        nowMs,
      )
      return record(
        {
          outcome: 'failed',
          errorCode: 'BACKUP_REPOSITORY_UNAVAILABLE',
          entries: 0,
          inserted: 0,
          missing: 0,
        },
        null,
      )
    }
    if (stanza.systemIdentifier !== input.clusterSystemIdentifier) {
      await finding(
        tx,
        clusterId,
        'backup_identity_mismatch',
        'critical',
        key('backup_identity_mismatch'),
        "The repository's stanza belongs to another PostgreSQL cluster than the registered one; nothing of it is mirrored.",
        { repositoryId },
        nowMs,
      )
      return record(
        {
          outcome: 'failed',
          errorCode: 'RESTORE_TARGET_MISMATCH',
          entries: 0,
          inserted: 0,
          missing: 0,
        },
        null,
      )
    }
  }
  await resolve(tx, clusterId, 'backup_repository_unreadable', key('backup_repository_unreadable'))
  await resolve(tx, clusterId, 'backup_identity_mismatch', key('backup_identity_mismatch'))

  let inserted = 0
  const labels: string[] = []
  for (const b of result.backups) {
    if (!/^[^\p{Cc}]{1,128}$/u.test(b.label)) continue
    labels.push(b.label)
    const timeline = segmentTimeline(b.walStart)
    const { rows } = await tx.query(
      'backups.catalog.upsert',
      `INSERT INTO backups.catalog (backup_id, repository_id, engine_label, kind, state, started_at, finished_at,
         size_bytes, repository_size_bytes, lsn_start, lsn_stop, timeline, pg_major, system_identifier, engine_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (repository_id, engine_label) DO UPDATE
          SET state = EXCLUDED.state, finished_at = EXCLUDED.finished_at, size_bytes = EXCLUDED.size_bytes,
              repository_size_bytes = EXCLUDED.repository_size_bytes, lsn_start = EXCLUDED.lsn_start,
              lsn_stop = EXCLUDED.lsn_stop, timeline = EXCLUDED.timeline, pg_major = EXCLUDED.pg_major,
              system_identifier = EXCLUDED.system_identifier,
              engine_version = coalesce(backups.catalog.engine_version, EXCLUDED.engine_version),
              divergence = 'none', missing_since = NULL, last_seen_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [
        newId('bkp', nowMs),
        repositoryId,
        b.label,
        b.kind,
        b.error ? 'failed' : b.finishedAt === null ? 'running' : 'succeeded',
        b.startedAt,
        b.finishedAt,
        b.sizeBytes,
        b.repositorySizeBytes,
        b.lsnStart !== null && LSN.test(b.lsnStart) ? b.lsnStart : null,
        b.lsnStop !== null && LSN.test(b.lsnStop) ? b.lsnStop : null,
        timeline,
        b.postgresMajor,
        input.engine === 'pgbackrest' ? input.clusterSystemIdentifier : null,
        result.engineVersion,
      ],
    )
    if (rows[0]?.bool('inserted') === true) inserted++
  }
  // The engine is the truth: what it no longer lists is marked, never removed.
  let missing = 0
  if (!result.truncated) {
    const { rows } = await tx.query(
      'backups.catalog.missing',
      `UPDATE backups.catalog SET divergence = 'missing_in_engine', missing_since = coalesce(missing_since, now())
        WHERE repository_id = $1 AND NOT (engine_label = ANY($2::text[]))
       RETURNING backup_id`,
      [repositoryId, labels],
    )
    missing = rows.length
  }
  const { rows: missingRows } = await tx.query(
    'backups.catalog.missing_count',
    `SELECT count(*)::int AS n FROM backups.catalog WHERE repository_id = $1 AND divergence = 'missing_in_engine'`,
    [repositoryId],
  )
  const divergent = missingRows[0]?.int('n') ?? 0
  if (divergent > 0) {
    await finding(
      tx,
      clusterId,
      'backup_catalog_divergence',
      'warning',
      key('backup_catalog_divergence'),
      `${divergent} backups ExponetDB recorded are no longer listed by the engine; they do not count as protection.`,
      { repositoryId, missing: divergent },
      nowMs,
    )
  } else {
    await resolve(tx, clusterId, 'backup_catalog_divergence', key('backup_catalog_divergence'))
  }

  for (const a of result.archive) {
    const timeline = segmentTimeline(a.min) ?? segmentTimeline(a.max)
    if (timeline === null || !/^[0-9]{1,2}-[0-9]{1,5}$/.test(a.id)) continue
    const max = a.max !== null && SEGMENT.test(a.max) ? a.max : null
    // The time of the newest segment is known only when the archiver's last
    // archived segment is that one (or a later one of the same timeline).
    const archived = input.archive
    const maxArchivedAt =
      archived?.lastArchivedAt !== null &&
      archived?.lastArchivedWal !== null &&
      archived !== null &&
      max !== null &&
      SEGMENT.test(archived.lastArchivedWal ?? '') &&
      (archived.lastArchivedWal ?? '') >= max &&
      (archived.lastArchivedWal ?? '').slice(0, 8) === max.slice(0, 8)
        ? archived.lastArchivedAt
        : null
    await tx.query(
      'backups.wal_coverage.upsert',
      `INSERT INTO backups.wal_coverage (repository_id, archive_id, timeline, min_segment, max_segment, max_archived_at, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (repository_id, archive_id, timeline) DO UPDATE
          SET min_segment = EXCLUDED.min_segment, max_segment = EXCLUDED.max_segment,
              max_archived_at = EXCLUDED.max_archived_at, observed_at = now()`,
      [
        repositoryId,
        a.id,
        timeline,
        a.min !== null && SEGMENT.test(a.min) ? a.min : null,
        max,
        maxArchivedAt,
      ],
    )
  }

  const observed: JsonObject = {
    stanza:
      result.stanza === null
        ? null
        : { status: result.stanza.status, cipher: result.stanza.cipher },
    backups: result.backups.slice(0, 500).map((b) => ({ label: b.label, walStart: b.walStart })),
    truncated: result.truncated,
  }
  return record(
    {
      outcome: result.truncated ? 'partial' : 'ok',
      errorCode: null,
      entries: result.backups.length,
      inserted,
      missing,
    },
    observed,
  )
}

/** The latest WAL archive observation of a cluster's node, for the coverage times. */
export async function latestArchive(
  q: Queryable,
  clusterId: string,
): Promise<ArchiveObservation | null> {
  const { rows } = await q.query(
    'backups.reconcile.archive',
    `SELECT o.result FROM nodes.observations o
      WHERE o.cluster_id = $1 AND o.capability = 'wal.archive_status@1'
      ORDER BY o.observed_at DESC LIMIT 1`,
    [clusterId],
  )
  const result = rows[0]?.json('result') as Record<string, unknown> | undefined
  if (result === undefined || result === null) return null
  return {
    lastArchivedWal:
      typeof result['lastArchivedWal'] === 'string' ? result['lastArchivedWal'] : null,
    lastArchivedAt: typeof result['lastArchivedAt'] === 'string' ? result['lastArchivedAt'] : null,
  }
}

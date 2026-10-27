import type {
  BackupEntry,
  BackupPolicyBody,
  BackupRepository,
  Drill,
  EngineRun,
  Restore,
  WalCoverage,
} from '@exponetdb/contracts'
import type { Queryable, Row } from '@exponetdb/control-store'
import type {
  ArchiveFact,
  BackupFact,
  DrillFact,
  PolicyFact,
  ProtectionInput,
  RepositoryFact,
  WalFact,
} from './protection.ts'

/**
 * The backup domain's records in the Control Store (schema `backups`,
 * bundle `backup-catalog`). One set of reads serves the REST views, the
 * protection computation, the planners and the retirement port, so they
 * never disagree. Nothing here is a secret: the records hold none.
 */

export type BackupRepositoryView = BackupRepository
export type BackupEntryView = BackupEntry
export type WalCoverageView = WalCoverage
export type EngineRunView = EngineRun
export type RestoreView = Restore
export type DrillView = Drill

const iso = (d: Date | null) => (d === null ? null : d.toISOString())

export interface RepositoryRecord {
  readonly repositoryId: string
  readonly clusterId: string
  readonly layer: RepositoryFact['layer']
  readonly engine: 'pgbackrest' | 'pg_dump' | 'restic'
  readonly provider: string
  readonly endpointHost: string | null
  readonly region: string | null
  readonly bucket: string | null
  readonly prefix: string
  readonly stanza: string | null
  readonly repoIndex: number | null
  readonly priority: number
  readonly purpose: 'primary' | 'secondary' | 'offsite'
  readonly ownership: RepositoryFact['ownership']
  readonly lockMode: 'none' | 's3_object_lock' | 'r2_bucket_lock' | 'unknown'
  readonly lockCapability: RepositoryFact['lockCapability']
  readonly lockRetentionDays: number | null
  readonly cipher: RepositoryFact['cipher']
  readonly offlineCopyConfirmedAt: Date | null
  readonly pinnedEngineVersion: string | null
  readonly observedEngineVersion: string | null
  readonly engineAdvisory: RepositoryFact['engineAdvisory']
  readonly state: RepositoryFact['state']
  readonly revision: number
  readonly reconciledAt: Date | null
  readonly reconciliationOutcome: 'ok' | 'partial' | 'failed' | null
  readonly reconciliationError: string | null
  readonly createdAt: Date
  readonly retiredAt: Date | null
}

const REPOSITORY_COLUMNS = `repository_id, cluster_id, layer, engine, provider, endpoint_host, region, bucket, prefix,
  stanza, repo_index, priority, purpose, ownership, lock_mode, lock_capability, lock_retention_days, cipher,
  offline_copy_confirmed_at, pinned_engine_version, observed_engine_version, engine_advisory, state, revision,
  reconciled_at, reconciliation_outcome, reconciliation_error, created_at, retired_at`

function repositoryOf(row: Row): RepositoryRecord {
  return {
    repositoryId: row.text('repository_id'),
    clusterId: row.text('cluster_id'),
    layer: row.text('layer') as RepositoryRecord['layer'],
    engine: row.text('engine') as RepositoryRecord['engine'],
    provider: row.text('provider'),
    endpointHost: row.textOrNull('endpoint_host'),
    region: row.textOrNull('region'),
    bucket: row.textOrNull('bucket'),
    prefix: row.text('prefix'),
    stanza: row.textOrNull('stanza'),
    repoIndex: row.intOrNull('repo_index'),
    priority: row.int('priority'),
    purpose: row.text('purpose') as RepositoryRecord['purpose'],
    ownership: row.text('ownership') as RepositoryRecord['ownership'],
    lockMode: row.text('lock_mode') as RepositoryRecord['lockMode'],
    lockCapability: row.text('lock_capability') as RepositoryRecord['lockCapability'],
    lockRetentionDays: row.intOrNull('lock_retention_days'),
    cipher: row.text('cipher') as RepositoryRecord['cipher'],
    offlineCopyConfirmedAt: row.dateOrNull('offline_copy_confirmed_at'),
    pinnedEngineVersion: row.textOrNull('pinned_engine_version'),
    observedEngineVersion: row.textOrNull('observed_engine_version'),
    engineAdvisory: row.text('engine_advisory') as RepositoryRecord['engineAdvisory'],
    state: row.text('state') as RepositoryRecord['state'],
    revision: row.int('revision'),
    reconciledAt: row.dateOrNull('reconciled_at'),
    reconciliationOutcome: row.textOrNull(
      'reconciliation_outcome',
    ) as RepositoryRecord['reconciliationOutcome'],
    reconciliationError: row.textOrNull('reconciliation_error'),
    createdAt: row.date('created_at'),
    retiredAt: row.dateOrNull('retired_at'),
  }
}

export async function listRepositories(
  q: Queryable,
  clusterId: string,
  options: { readonly includeRetired?: boolean } = {},
): Promise<RepositoryRecord[]> {
  const { rows } = await q.query(
    'backups.repositories.list',
    `SELECT ${REPOSITORY_COLUMNS} FROM backups.repositories
      WHERE cluster_id = $1 AND ($2 OR state <> 'retired')
      ORDER BY priority, created_at, repository_id LIMIT 64`,
    [clusterId, options.includeRetired ?? true],
  )
  return rows.map(repositoryOf)
}

export async function getRepository(
  q: Queryable,
  repositoryId: string,
  lock = false,
): Promise<RepositoryRecord | undefined> {
  const { rows } = await q.query(
    lock ? 'backups.repositories.get_locked' : 'backups.repositories.get',
    `SELECT ${REPOSITORY_COLUMNS} FROM backups.repositories WHERE repository_id = $1${lock ? ' FOR UPDATE' : ''}`,
    [repositoryId],
  )
  const row = rows[0]
  return row === undefined ? undefined : repositoryOf(row)
}

/** The REST view; `withLocation` only for `registry.manage` holders (ADR-0036 §1). */
export function repositoryView(r: RepositoryRecord, withLocation: boolean): BackupRepositoryView {
  return {
    id: r.repositoryId as BackupRepositoryView['id'],
    clusterId: r.clusterId as BackupRepositoryView['clusterId'],
    layer: r.layer,
    engine: r.engine,
    provider: r.provider as BackupRepositoryView['provider'],
    location: withLocation
      ? {
          endpointHost: r.endpointHost,
          region: r.region,
          bucket: r.bucket,
          prefix: r.prefix,
          stanza: r.stanza,
          repoIndex: r.repoIndex,
        }
      : null,
    priority: r.priority,
    purpose: r.purpose,
    ownership: r.ownership,
    secretSource: 'host_config',
    lock: {
      mode: r.lockMode,
      capability: r.lockCapability,
      retentionDays: r.lockRetentionDays,
      provenAt: null,
    },
    encryption: { cipher: r.cipher, offlineCopyConfirmedAt: iso(r.offlineCopyConfirmedAt) },
    engineVersion: {
      pinned: r.pinnedEngineVersion,
      observed: r.observedEngineVersion,
      advisory: r.engineAdvisory,
    },
    state: r.state,
    revision: r.revision,
    reconciliation:
      r.reconciledAt === null || r.reconciliationOutcome === null
        ? null
        : {
            outcome: r.reconciliationOutcome,
            at: r.reconciledAt.toISOString(),
            errorCode: r.reconciliationError,
          },
    createdAt: r.createdAt.toISOString(),
    retiredAt: iso(r.retiredAt),
  }
}

// ----- catalog -----

const CATALOG_COLUMNS = `c.backup_id, c.repository_id, c.engine_label, c.kind, c.state, c.started_at, c.finished_at,
  c.size_bytes, c.repository_size_bytes, c.lsn_start, c.lsn_stop, c.timeline, c.pg_major, c.system_identifier,
  c.engine_version, c.verification_state, c.verified_at, c.divergence, c.first_seen_at, c.last_seen_at`

export interface CatalogRecord {
  readonly view: BackupEntryView
  readonly walStart: string | null
  readonly systemIdentifier: string | null
}

function catalogOf(row: Row): CatalogRecord {
  return {
    view: {
      id: row.text('backup_id') as BackupEntryView['id'],
      repositoryId: row.text('repository_id') as BackupEntryView['repositoryId'],
      engineLabel: row.text('engine_label'),
      kind: row.text('kind') as BackupEntryView['kind'],
      state: row.text('state') as BackupEntryView['state'],
      startedAt: row.date('started_at').toISOString(),
      finishedAt: iso(row.dateOrNull('finished_at')),
      sizeBytes: row.intOrNull('size_bytes'),
      repositorySizeBytes: row.intOrNull('repository_size_bytes'),
      lsnStart: row.textOrNull('lsn_start'),
      lsnStop: row.textOrNull('lsn_stop'),
      timeline: row.intOrNull('timeline'),
      postgresMajor: row.intOrNull('pg_major'),
      engineVersion: row.textOrNull('engine_version'),
      verification: {
        state: row.text('verification_state') as BackupEntryView['verification']['state'],
        verifiedAt: iso(row.dateOrNull('verified_at')),
      },
      divergence: row.text('divergence') as BackupEntryView['divergence'],
      firstSeenAt: row.date('first_seen_at').toISOString(),
      lastSeenAt: row.date('last_seen_at').toISOString(),
    },
    walStart: row.has('wal_start') ? row.textOrNull('wal_start') : null,
    systemIdentifier: row.textOrNull('system_identifier'),
  }
}

/** Catalog entries of a cluster's repositories, newest first, keyset paged by (started_at, backup_id). */
export async function listCatalog(
  q: Queryable,
  clusterId: string,
  page: {
    readonly limit: number
    readonly after?: { readonly startedAt: string; readonly id: string }
  },
): Promise<{ readonly items: CatalogRecord[]; readonly more: boolean }> {
  const { rows } = await q.query(
    'backups.catalog.list',
    `SELECT ${CATALOG_COLUMNS}, NULL::text AS wal_start
       FROM backups.catalog c JOIN backups.repositories r USING (repository_id)
      WHERE r.cluster_id = $1
        AND ($2::timestamptz IS NULL OR (c.started_at, c.backup_id) < ($2::timestamptz, $3::text))
      ORDER BY c.started_at DESC, c.backup_id DESC
      LIMIT $4`,
    [clusterId, page.after?.startedAt ?? null, page.after?.id ?? null, page.limit + 1],
  )
  const items = rows.map(catalogOf)
  return { items: items.slice(0, page.limit), more: items.length > page.limit }
}

export async function getCatalogEntry(
  q: Queryable,
  backupId: string,
): Promise<(CatalogRecord & { readonly clusterId: string }) | undefined> {
  const { rows } = await q.query(
    'backups.catalog.get',
    `SELECT ${CATALOG_COLUMNS}, r.cluster_id,
            (SELECT b ->> 'walStart' FROM jsonb_array_elements(coalesce(r.observed -> 'backups', '[]'::jsonb)) b
              WHERE b ->> 'label' = c.engine_label LIMIT 1) AS wal_start
       FROM backups.catalog c JOIN backups.repositories r USING (repository_id)
      WHERE c.backup_id = $1`,
    [backupId],
  )
  const row = rows[0]
  return row === undefined ? undefined : { ...catalogOf(row), clusterId: row.text('cluster_id') }
}

// ----- WAL coverage -----

export interface CoverageRecord {
  readonly repositoryId: string
  readonly archiveId: string
  readonly timeline: number
  readonly minSegment: string | null
  readonly maxSegment: string | null
  readonly maxArchivedAt: Date | null
  readonly gapEnds: readonly string[]
  readonly observedAt: Date
}

export async function listCoverage(q: Queryable, clusterId: string): Promise<CoverageRecord[]> {
  const { rows } = await q.query(
    'backups.wal_coverage.list',
    `SELECT w.repository_id, w.archive_id, w.timeline, w.min_segment, w.max_segment, w.max_archived_at,
            w.gaps, w.observed_at
       FROM backups.wal_coverage w JOIN backups.repositories r USING (repository_id)
      WHERE r.cluster_id = $1 AND r.state <> 'retired'
      ORDER BY w.repository_id, w.timeline LIMIT 64`,
    [clusterId],
  )
  return rows.map((row) => {
    const gaps = row.json('gaps')
    return {
      repositoryId: row.text('repository_id'),
      archiveId: row.text('archive_id'),
      timeline: row.int('timeline'),
      minSegment: row.textOrNull('min_segment'),
      maxSegment: row.textOrNull('max_segment'),
      maxArchivedAt: row.dateOrNull('max_archived_at'),
      gapEnds: Array.isArray(gaps)
        ? gaps.flatMap((g) =>
            typeof g === 'object' && g !== null && typeof (g as { to?: unknown }).to === 'string'
              ? [(g as { to: string }).to]
              : [],
          )
        : [],
      observedAt: row.date('observed_at'),
    }
  })
}

/** A WAL segment name as an LSN at its start (`TTTTTTTTXXXXXXXXYYYYYYYY` with 16 MiB segments). */
export function segmentLsn(segment: string | null): string {
  if (segment === null || !/^[0-9A-F]{24}$/.test(segment)) return '0/0'
  const hi = Number.parseInt(segment.slice(8, 16), 16)
  const seg = Number.parseInt(segment.slice(16, 24), 16)
  return `${hi.toString(16).toUpperCase()}/${(seg * 0x1000000).toString(16).toUpperCase()}`
}

export function coverageView(c: CoverageRecord): WalCoverageView {
  return {
    repositoryId: c.repositoryId as WalCoverageView['repositoryId'],
    timeline: c.timeline,
    from: { lsn: segmentLsn(c.minSegment), at: null },
    to: { lsn: segmentLsn(c.maxSegment), at: iso(c.maxArchivedAt) },
    gaps: c.gapEnds.slice(0, 64).map((end) => ({ fromLsn: '0/0', toLsn: segmentLsn(end) })),
    observedAt: c.observedAt.toISOString(),
  }
}

// ----- runs, restores, drills -----

const RUN_COLUMNS = `run_id, cluster_id, repository_id, node_id, purpose, kind, operation_id, start_job_id,
  start_args_hash, state, started_at, finished_at, last_status_at, exit_code, progress, error_code, created_at`

export interface RunRecord {
  readonly view: EngineRunView
  readonly kind: string | null
  readonly startJobId: string | null
  readonly startArgsHash: string | null
}

function runOf(row: Row): RunRecord {
  const progress = row.json('progress') as { percent?: unknown; bytes?: unknown } | null
  const purpose = row.text('purpose')
  return {
    view: {
      id: row.text('run_id') as EngineRunView['id'],
      clusterId: row.text('cluster_id') as EngineRunView['clusterId'],
      repositoryId: row.textOrNull('repository_id') as EngineRunView['repositoryId'],
      nodeId: row.text('node_id') as EngineRunView['nodeId'],
      purpose: (purpose === 'reverify' ? 'verify' : purpose) as EngineRunView['purpose'],
      state: row.text('state') as EngineRunView['state'],
      operationId: row.text('operation_id') as EngineRunView['operationId'],
      startedAt: iso(row.dateOrNull('started_at')),
      finishedAt: iso(row.dateOrNull('finished_at')),
      lastStatusAt: iso(row.dateOrNull('last_status_at')),
      progress:
        progress === null
          ? null
          : {
              percent: typeof progress.percent === 'number' ? progress.percent : null,
              bytes: typeof progress.bytes === 'number' ? progress.bytes : null,
            },
      exitCode: row.intOrNull('exit_code'),
      errorCode: row.textOrNull('error_code'),
    },
    kind: row.textOrNull('kind'),
    startJobId: row.textOrNull('start_job_id'),
    startArgsHash: row.textOrNull('start_args_hash'),
  }
}

export async function listRuns(
  q: Queryable,
  clusterId: string,
  page: { readonly limit: number; readonly before?: string },
): Promise<{ readonly items: RunRecord[]; readonly more: boolean }> {
  const { rows } = await q.query(
    'backups.runs.list',
    `SELECT ${RUN_COLUMNS} FROM backups.runs
      WHERE cluster_id = $1 AND ($2::text IS NULL OR run_id < $2)
      ORDER BY run_id DESC LIMIT $3`,
    [clusterId, page.before ?? null, page.limit + 1],
  )
  const items = rows.map(runOf)
  return { items: items.slice(0, page.limit), more: items.length > page.limit }
}

export async function getRun(q: Queryable, runId: string): Promise<RunRecord | undefined> {
  const { rows } = await q.query(
    'backups.runs.get',
    `SELECT ${RUN_COLUMNS} FROM backups.runs WHERE run_id = $1`,
    [runId],
  )
  const row = rows[0]
  return row === undefined ? undefined : runOf(row)
}

const RESTORE_COLUMNS = `restore_id, cluster_id, target_id, purpose, state, repository_id, backup_id, point_in_time,
  timeline, wal_from, wal_to, destination_kind, node_id, run_id, port, phases, checks, plan_id, operation_id,
  created_at, finished_at`

function restoreOf(row: Row): RestoreView {
  const phases = row.json('phases')
  const checks = row.json('checks')
  return {
    id: row.text('restore_id') as RestoreView['id'],
    clusterId: row.text('cluster_id') as RestoreView['clusterId'],
    targetId: row.textOrNull('target_id') as RestoreView['targetId'],
    purpose: row.text('purpose') as RestoreView['purpose'],
    state: row.text('state') as RestoreView['state'],
    source: {
      repositoryId: row.text('repository_id') as RestoreView['source']['repositoryId'],
      backupId: row.textOrNull('backup_id') as RestoreView['source']['backupId'],
      pointInTime: iso(row.dateOrNull('point_in_time')),
      timeline: row.intOrNull('timeline'),
      walFrom: row.textOrNull('wal_from'),
      walTo: row.textOrNull('wal_to'),
    },
    destination: {
      kind: row.text('destination_kind') as RestoreView['destination']['kind'],
      nodeId: row.text('node_id') as RestoreView['destination']['nodeId'],
      runId: row.textOrNull('run_id') as RestoreView['destination']['runId'],
      port: row.intOrNull('port'),
    },
    phases: (Array.isArray(phases) ? phases : []) as RestoreView['phases'],
    checks: (Array.isArray(checks) ? checks : []) as RestoreView['checks'],
    planId: row.text('plan_id') as RestoreView['planId'],
    operationId: row.textOrNull('operation_id') as RestoreView['operationId'],
    createdAt: row.date('created_at').toISOString(),
    finishedAt: iso(row.dateOrNull('finished_at')),
  }
}

export async function listRestores(
  q: Queryable,
  clusterId: string,
  page: { readonly limit: number; readonly before?: string },
): Promise<{ readonly items: RestoreView[]; readonly more: boolean }> {
  const { rows } = await q.query(
    'backups.restores.list',
    `SELECT ${RESTORE_COLUMNS} FROM backups.restores
      WHERE cluster_id = $1 AND ($2::text IS NULL OR restore_id < $2)
      ORDER BY restore_id DESC LIMIT $3`,
    [clusterId, page.before ?? null, page.limit + 1],
  )
  const items = rows.map(restoreOf)
  return { items: items.slice(0, page.limit), more: items.length > page.limit }
}

export async function getRestore(
  q: Queryable,
  restoreId: string,
): Promise<RestoreView | undefined> {
  const { rows } = await q.query(
    'backups.restores.get',
    `SELECT ${RESTORE_COLUMNS} FROM backups.restores WHERE restore_id = $1`,
    [restoreId],
  )
  const row = rows[0]
  return row === undefined ? undefined : restoreOf(row)
}

function drillOf(row: Row): DrillView {
  return {
    id: row.text('drill_id') as DrillView['id'],
    clusterId: row.text('cluster_id') as DrillView['clusterId'],
    restoreId: row.textOrNull('restore_id') as DrillView['restoreId'],
    repositoryId: row.text('repository_id') as DrillView['repositoryId'],
    selection: row.text('selection') as DrillView['selection'],
    mode: row.text('mode') as DrillView['mode'],
    outcome: row.text('outcome') as DrillView['outcome'],
    measuredRtoSeconds: row.intOrNull('measured_rto_seconds'),
    startedAt: iso(row.dateOrNull('started_at')),
    finishedAt: iso(row.dateOrNull('finished_at')),
  }
}

export async function listDrills(
  q: Queryable,
  clusterId: string,
  page: { readonly limit: number; readonly before?: string },
): Promise<{ readonly items: DrillView[]; readonly more: boolean }> {
  const { rows } = await q.query(
    'backups.drills.list',
    `SELECT drill_id, cluster_id, restore_id, repository_id, selection, mode, outcome, measured_rto_seconds,
            started_at, finished_at
       FROM backups.drills WHERE cluster_id = $1 AND ($2::text IS NULL OR drill_id < $2)
      ORDER BY drill_id DESC LIMIT $3`,
    [clusterId, page.before ?? null, page.limit + 1],
  )
  const items = rows.map(drillOf)
  return { items: items.slice(0, page.limit), more: items.length > page.limit }
}

// ----- policy -----

export interface PolicyRecord {
  readonly policyId: string
  readonly clusterId: string
  readonly revision: number
  readonly body: BackupPolicyBody
  readonly operationId: string
  readonly createdAt: Date
}

export async function activePolicy(
  q: Queryable,
  clusterId: string,
): Promise<PolicyRecord | undefined> {
  const { rows } = await q.query(
    'backups.policies.active',
    `SELECT policy_id, cluster_id, revision, body, operation_id, created_at
       FROM backups.policies WHERE cluster_id = $1 AND state = 'active'`,
    [clusterId],
  )
  const row = rows[0]
  if (row === undefined) return undefined
  return {
    policyId: row.text('policy_id'),
    clusterId: row.text('cluster_id'),
    revision: row.int('revision'),
    body: row.json('body') as BackupPolicyBody,
    operationId: row.text('operation_id'),
    createdAt: row.date('created_at'),
  }
}

// ----- protection facts of a cluster -----

/** Everything `computeProtection` needs for one cluster, read in one pass. */
export async function protectionFacts(
  q: Queryable,
  clusterId: string,
  nowMs: number,
): Promise<ProtectionInput> {
  const repositories = await listRepositories(q, clusterId, { includeRetired: false })
  const { rows: backupRows } = await q.query(
    'backups.protection.backups',
    `SELECT c.repository_id, c.kind, c.state, c.started_at, c.finished_at, c.verification_state, c.divergence,
            o.wal_start
       FROM backups.catalog c JOIN backups.repositories r USING (repository_id)
       LEFT JOIN LATERAL (
         SELECT b ->> 'walStart' AS wal_start
           FROM jsonb_array_elements(coalesce(r.observed -> 'backups', '[]'::jsonb)) b
          WHERE b ->> 'label' = c.engine_label LIMIT 1) o ON true
      WHERE r.cluster_id = $1 AND r.state <> 'retired'
      ORDER BY c.started_at DESC LIMIT 2000`,
    [clusterId],
  )
  const backups: BackupFact[] = backupRows.map((row) => ({
    repositoryId: row.text('repository_id'),
    kind: row.text('kind') as BackupFact['kind'],
    state: row.text('state') as BackupFact['state'],
    startedAtMs: row.date('started_at').getTime(),
    finishedAtMs: row.dateOrNull('finished_at')?.getTime() ?? null,
    verification: row.text('verification_state') as BackupFact['verification'],
    divergence: row.text('divergence') as BackupFact['divergence'],
    walStart: row.textOrNull('wal_start'),
  }))
  const wal: WalFact[] = (await listCoverage(q, clusterId)).map((c) => ({
    repositoryId: c.repositoryId,
    timeline: c.timeline,
    minSegment: c.minSegment,
    maxSegment: c.maxSegment,
    maxArchivedAtMs: c.maxArchivedAt?.getTime() ?? null,
    gapEnds: c.gapEnds,
    observedAtMs: c.observedAt.getTime(),
  }))
  const { rows: archiveRows } = await q.query(
    'backups.protection.archive',
    `SELECT o.result, o.observed_at, (n.heartbeat ->> 'clockSkewMs')::bigint AS skew_ms
       FROM registry.clusters c
       JOIN nodes.nodes n ON n.server_id = c.server_id AND n.state IN ('active', 'degraded')
       LEFT JOIN LATERAL (
         SELECT result, observed_at FROM nodes.observations
          WHERE node_id = n.node_id AND cluster_id = c.cluster_id AND capability = 'wal.archive_status@1'
          ORDER BY observed_at DESC LIMIT 1) o ON true
      WHERE c.cluster_id = $1 AND c.management_mode = 'agent'
      ORDER BY n.last_heartbeat_at DESC NULLS LAST LIMIT 1`,
    [clusterId],
  )
  let archive: ArchiveFact | null = null
  let clockSkewSeconds: number | null = null
  const a = archiveRows[0]
  if (a !== undefined) {
    const skew = a.intOrNull('skew_ms')
    clockSkewSeconds = skew === null ? null : Math.ceil(Math.abs(skew) / 1000)
    const result = a.json('result') as Record<string, unknown> | null
    const observedAt = a.dateOrNull('observed_at')
    if (result !== null && observedAt !== null) {
      const lastArchived =
        typeof result['lastArchivedAt'] === 'string' ? Date.parse(result['lastArchivedAt']) : null
      const lastFailed =
        typeof result['lastFailedAt'] === 'string' ? Date.parse(result['lastFailedAt']) : null
      archive = {
        failing:
          result['archiveMode'] !== 'on' && result['archiveMode'] !== 'always'
            ? true
            : lastFailed !== null && (lastArchived === null || lastFailed > lastArchived),
        lastArchivedAtMs: lastArchived,
        observedAtMs: observedAt.getTime(),
      }
    }
  }
  const { rows: drillRows } = await q.query(
    'backups.protection.drills',
    `SELECT drill_id, mode, outcome, finished_at, measured_rto_seconds FROM backups.drills
      WHERE cluster_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [clusterId],
  )
  const drills: DrillFact[] = drillRows.map((row) => ({
    id: row.text('drill_id'),
    mode: row.text('mode') as DrillFact['mode'],
    outcome: row.text('outcome') as DrillFact['outcome'],
    finishedAtMs: row.dateOrNull('finished_at')?.getTime() ?? null,
    measuredRtoSeconds: row.intOrNull('measured_rto_seconds'),
  }))
  const policyRecord = await activePolicy(q, clusterId)
  const policy: PolicyFact | null =
    policyRecord === undefined
      ? null
      : {
          rpoObjectiveSeconds: policyRecord.body.objectives.rpoSeconds,
          rtoObjectiveSeconds: policyRecord.body.objectives.rtoSeconds,
          drillCadenceDays: policyRecord.body.drillCadenceDays,
        }
  return {
    nowMs,
    repositories: repositories.map((r) => ({
      id: r.repositoryId,
      layer: r.layer,
      provider: r.provider,
      state: r.state,
      ownership: r.ownership,
      lockCapability: r.lockCapability,
      cipher: r.cipher,
      offlineCopyConfirmed: r.offlineCopyConfirmedAt !== null,
      engineAdvisory: r.engineAdvisory,
      reconciledAtMs: r.reconciledAt?.getTime() ?? null,
      reconciliationOutcome: r.reconciliationOutcome,
    })),
    backups,
    wal,
    archive,
    drills,
    policy,
    clockSkewSeconds,
  }
}

import type {
  BackupPolicyBody,
  BackupRepositoryAdoptRequest,
  DrillPlanRequest,
  NodeCapabilityKey,
  RestorePlanRequest,
} from '@exponetdb/contracts'
import type { Tx } from '@exponetdb/control-store'
import { type JsonObject, newId } from '@exponetdb/kernel'
import { mapCluster, NodeError, requireCapabilities } from '@exponetdb/nodes'
import type { PlanRecord } from '@exponetdb/operations'
import {
  getCluster,
  type RegistryActor,
  type RegistryPlanContext,
  storeRegistryPlan,
} from '@exponetdb/registry'
import {
  type ExecutionSettings,
  requireBackupExecution,
  requireRestoreExecution,
} from './activation.ts'
import { CronInvalid, parseCron } from './cron.ts'
import { BackupError, conflict } from './errors.ts'
import {
  activePolicy,
  getRepository,
  listCoverage,
  listRepositories,
  type RepositoryRecord,
} from './records.ts'
import { type SelectableBackup, type SourceRequest, selectSource } from './selection.ts'

/**
 * Backup and restore plans (ADR-0036 §3, ADR-0037, ADR-0038 §1). A planner
 * reads the Control Store in the caller's transaction, refuses what cannot
 * be applied, and stores an immutable plan whose `content` is exactly what
 * the worker will do and whose `expectedState` the kind checks again at
 * acceptance and under the locks (`PLAN_STALE`). Nothing changes on a host
 * or in a bucket when a plan is made.
 */
export interface BackupPlanContext {
  readonly policy: RegistryPlanContext['policy']
  readonly execution: ExecutionSettings
  /** The random source of `pitr_random` drills (tests inject one). */
  readonly random?: () => number
}

const nowOf = (c: BackupPlanContext) => c.policy.clock.nowMs()

/** The capabilities each plan needs the node to accept (checked at plan and at acceptance). */
export const RUN_CAPABILITIES: Readonly<Record<string, readonly NodeCapabilityKey[]>> = {
  'backup.catalog.refresh': ['backup.list@1'],
  'backup.run': ['backup.run@1', 'run.status@1', 'backup.list@1'],
  'backup.verify': ['backup.verify@1', 'run.status@1'],
  'restore.drill': ['restore.prepare@1', 'restore.execute@1', 'run.status@1', 'restore.discard@1'],
  'restore.execute': ['restore.prepare@1', 'restore.execute@1', 'run.status@1'],
  'restore.discard': ['restore.discard@1'],
}

async function liveCluster(tx: Tx, clusterId: string) {
  const cluster = await getCluster(tx, clusterId)
  if (cluster === undefined) throw new BackupError('NOT_FOUND')
  if (cluster.state === 'retired') throw conflict('cluster_retired')
  if (cluster.state !== 'active' || cluster.systemIdentifier === null)
    throw conflict('cluster_not_confirmed')
  return cluster
}

/** The node that serves an agent-managed cluster, with its mapping; refusals in the catalog's codes. */
async function nodeFor(
  tx: Tx,
  clusterId: string,
  nowMs: number,
  capabilities: readonly NodeCapabilityKey[],
  nodeId?: string,
) {
  try {
    const { mapping, node } = await mapCluster(
      tx,
      clusterId,
      nowMs,
      nodeId === undefined ? {} : { nodeId },
    )
    requireCapabilities(node, capabilities)
    return { mapping, node }
  } catch (error) {
    if (error instanceof NodeError) {
      throw new BackupError(error.code, error.details)
    }
    throw error
  }
}

function repositoryRef(r: RepositoryRecord): JsonObject {
  return {
    repositoryId: r.repositoryId,
    engine: r.engine,
    stanza: r.stanza,
    repoIndex: r.repoIndex,
  }
}

const FORBIDDEN_HOST_SUFFIXES = [
  '.local',
  '.localhost',
  '.internal',
  '.invalid',
  '.test',
  '.example',
]

// ----- repositories -----

export async function planRepositoryAdopt(
  tx: Tx,
  context: BackupPlanContext,
  actor: RegistryActor,
  clusterId: string,
  input: BackupRepositoryAdoptRequest,
): Promise<PlanRecord> {
  const cluster = await liveCluster(tx, clusterId)
  const host = input.location.endpointHost
  if (host !== null && FORBIDDEN_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new BackupError('VALIDATION_FAILED')
  }
  const { rows } = await tx.query(
    'backups.plans.location_taken',
    `SELECT 1 FROM backups.repositories
      WHERE cluster_id = $1 AND engine = $2 AND coalesce(stanza, '') = coalesce($3, '')
        AND coalesce(repo_index, 0) = coalesce($4, 0) AND coalesce(endpoint_host, '') = coalesce($5, '')
        AND coalesce(bucket, '') = coalesce($6, '') AND prefix = $7 AND state <> 'retired'`,
    [
      clusterId,
      input.engine,
      input.location.stanza,
      input.location.repoIndex,
      input.location.endpointHost,
      input.location.bucket,
      input.location.prefix,
    ],
  )
  if (rows.length > 0) throw conflict('repository_location_taken')
  const repositoryId = newId('bkr', nowOf(context))
  const tier = cluster.derivedTier ?? undefined
  return storeRegistryPlan(tx, context, actor, {
    kind: 'backup.repository.adopt',
    actionClass: 'standard',
    subject: { clusterId, ...(tier === undefined ? {} : { tier }) },
    content: {
      repositoryId,
      clusterId,
      layer: input.layer,
      engine: input.engine,
      provider: input.provider,
      endpointHost: input.location.endpointHost,
      region: input.location.region,
      bucket: input.location.bucket,
      prefix: input.location.prefix,
      stanza: input.location.stanza,
      repoIndex: input.location.repoIndex,
      priority: input.priority,
      purpose: input.purpose,
      lockMode: input.declaredLockMode,
      cipher: input.cipher,
      pinnedEngineVersion: input.pinnedEngineVersion,
    },
    expectedState: { clusterState: 'active', systemIdentifier: cluster.systemIdentifier ?? '' },
    analysis: {
      managementMode: cluster.managementMode,
      effect:
        'ExponetDB records the repository and starts read-only observation of its catalog; nothing changes on the host or in the bucket (no archive_command, restore_command, timer, repository chain or key).',
      observation:
        cluster.managementMode === 'agent'
          ? 'The node reads the catalog with backup.list@1 from the host configuration.'
          : 'The cluster has no node agent: the repository stays observing, and its protection unknown, until the cluster gains one (registry.cluster.adopt_agent).',
      lock: 'The declared lock is not a proof: the lock capability stays unknown until a deletion and overwrite experiment with the writer credential is recorded.',
    },
  })
}

export async function planRepositoryOwnership(
  tx: Tx,
  context: BackupPlanContext,
  actor: RegistryActor,
  repositoryId: string,
  to: 'adopted_runs' | 'owned',
): Promise<PlanRecord> {
  const r = await getRepository(tx, repositoryId)
  if (r === undefined) throw new BackupError('NOT_FOUND')
  if (r.state === 'retired') throw conflict('repository_retired')
  if (to === 'owned') {
    // Owning a repository writes its configuration and schedules on the host,
    // which needs a capability that does not exist yet (ADR-0036 §3).
    throw new BackupError('CAPABILITY_UNAVAILABLE')
  }
  if (r.ownership !== 'adopted_observed') throw conflict('repository_not_adopted_observed')
  const cluster = await liveCluster(tx, r.clusterId)
  const tier = cluster.derivedTier ?? undefined
  return storeRegistryPlan(tx, context, actor, {
    kind: 'backup.repository.ownership',
    actionClass: 'high',
    subject: { clusterId: r.clusterId, ...(tier === undefined ? {} : { tier }) },
    content: { repositoryId, clusterId: r.clusterId, from: r.ownership, to },
    expectedState: { revision: r.revision, ownership: r.ownership },
    analysis: {
      effect:
        'ExponetDB may start incremental backups (without automatic expiry) and verifications in this repository with the host configuration; it changes no configuration, schedule, key or retention. The node refuses runs unless the host operator also allows them (/etc/exponetdb-node/repositories/<id>/mode).',
    },
  })
}

export async function planRepositoryRetire(
  tx: Tx,
  context: BackupPlanContext,
  actor: RegistryActor,
  repositoryId: string,
  reason: string | undefined,
): Promise<PlanRecord> {
  const r = await getRepository(tx, repositoryId)
  if (r === undefined) throw new BackupError('NOT_FOUND')
  if (r.state === 'retired') throw conflict('repository_retired')
  const { rows } = await tx.query(
    'backups.plans.repository_in_use',
    `SELECT (SELECT count(*) FROM backups.runs WHERE repository_id = $1 AND state IN ('starting', 'running', 'unknown'))::int AS runs,
            (SELECT count(*) FROM backups.restores WHERE repository_id = $1 AND state NOT IN ('discarded', 'promoted'))::int AS restores,
            (SELECT count(*) FROM backups.catalog WHERE repository_id = $1 AND divergence = 'none')::int AS backups`,
    [repositoryId],
  )
  const row = rows[0]
  if ((row?.int('runs') ?? 1) > 0 || (row?.int('restores') ?? 1) > 0)
    throw conflict('repository_in_use')
  const cluster = await getCluster(tx, r.clusterId)
  const tier = cluster?.derivedTier ?? undefined
  return storeRegistryPlan(tx, context, actor, {
    kind: 'backup.repository.retire',
    actionClass: 'high',
    subject: { clusterId: r.clusterId, ...(tier === undefined ? {} : { tier }) },
    content: { repositoryId, clusterId: r.clusterId, reason: reason ?? null },
    expectedState: { revision: r.revision, openRuns: 0, openRestores: 0 },
    analysis: {
      backupsListed: row?.int('backups') ?? 0,
      effect:
        'The repository record leaves ExponetDB (final) with its catalog, runs, restores and drills as history. Nothing in the bucket or on the host is deleted, and ExponetDB no longer counts this repository as protection.',
    },
  })
}

// ----- policy -----

export async function planPolicySet(
  tx: Tx,
  context: BackupPlanContext,
  actor: RegistryActor,
  clusterId: string,
  body: BackupPolicyBody,
): Promise<PlanRecord> {
  const cluster = await liveCluster(tx, clusterId)
  const repositories = await listRepositories(tx, clusterId, { includeRetired: false })
  for (const s of body.schedules) {
    const repo = repositories.find((r) => r.repositoryId === s.repositoryId)
    if (repo === undefined) throw conflict('policy_repository_unknown')
    try {
      parseCron(s.cron)
    } catch (error) {
      if (error instanceof CronInvalid) throw new BackupError('VALIDATION_FAILED')
      throw error
    }
    if ((s.kind === 'logical') !== (repo.engine !== 'pgbackrest')) {
      throw new BackupError('VALIDATION_FAILED')
    }
  }
  const current = await activePolicy(tx, clusterId)
  const revision = (current?.revision ?? 0) + 1
  const tier = cluster.derivedTier ?? undefined
  return storeRegistryPlan(tx, context, actor, {
    kind: 'backup.policy.set',
    actionClass: 'high',
    subject: { clusterId, ...(tier === undefined ? {} : { tier }) },
    content: {
      policyId: newId('bpl', nowOf(context)),
      clusterId,
      revision,
      body: body as unknown as JsonObject,
    },
    expectedState: { currentRevision: current?.revision ?? 0 },
    analysis: {
      schedules: body.schedules.length,
      effect:
        'A new policy revision: schedules, retention, objectives and drill cadence. Scheduled runs start only where the repository allows runs and the installation has activated backup execution for the tier.',
    },
  })
}

// ----- runs -----

export async function planBackupRun(
  tx: Tx,
  context: BackupPlanContext,
  actor: RegistryActor,
  clusterId: string,
  input: {
    readonly repositoryId: string
    readonly kind: 'full' | 'differential' | 'incremental' | 'logical'
  },
): Promise<PlanRecord> {
  const cluster = await liveCluster(tx, clusterId)
  const r = await getRepository(tx, input.repositoryId)
  if (r === undefined || r.clusterId !== clusterId) throw new BackupError('NOT_FOUND')
  if (r.state === 'retired') throw conflict('repository_retired')
  if ((input.kind === 'logical') !== (r.engine !== 'pgbackrest'))
    throw new BackupError('VALIDATION_FAILED')
  const tier = cluster.derivedTier ?? undefined
  requireBackupExecution(context.execution, tier)
  const { mapping, node } = await nodeFor(
    tx,
    clusterId,
    nowOf(context),
    RUN_CAPABILITIES['backup.run'] ?? [],
  )
  const open = await tx.query(
    'backups.plans.open_run',
    `SELECT 1 FROM backups.runs WHERE cluster_id = $1 AND state IN ('starting', 'running', 'unknown')`,
    [clusterId],
  )
  if (open.rows.length > 0) throw conflict('run_active')
  let databases: string[] = []
  if (input.kind === 'logical') {
    const { rows } = await tx.query(
      'backups.plans.databases',
      `SELECT name FROM registry.databases WHERE cluster_id = $1 AND state = 'registered' ORDER BY name LIMIT 64`,
      [clusterId],
    )
    databases = rows
      .map((row) => row.text('name'))
      .filter((n) => /^[A-Za-z0-9_][A-Za-z0-9_$-]{0,62}$/.test(n))
  }
  return storeRegistryPlan(tx, context, actor, {
    kind: 'backup.run',
    actionClass: 'standard',
    subject: { clusterId, nodeId: node.nodeId, ...(tier === undefined ? {} : { tier }) },
    content: {
      clusterId,
      repositoryId: r.repositoryId,
      runId: newId('run', nowOf(context)),
      kind: input.kind,
      nodeId: node.nodeId,
      localName: mapping.localName,
      systemIdentifier: mapping.systemIdentifier,
      repository: { ...repositoryRef(r), ownership: r.ownership },
      databases,
    },
    expectedState: {
      repositoryRevision: r.revision,
      ownership: r.ownership,
      nodeId: node.nodeId,
      localName: mapping.localName,
      systemIdentifier: mapping.systemIdentifier,
    },
    analysis: {
      effect:
        r.engine === 'pgbackrest'
          ? 'The node starts a supervised pgBackRest backup run with --no-expire-auto (expiry is its own run); the backup counts only once the engine catalog lists it with the expected size.'
          : 'The node dumps each registered database with pg_dump -Fc and the globals, checks each dump with pg_restore --list, and uploads them with restic.',
      databases: databases.length,
    },
  })
}

// ----- restores and drills -----

async function selectable(tx: Tx, repositoryId: string): Promise<SelectableBackup[]> {
  const { rows } = await tx.query(
    'backups.plans.selectable',
    `SELECT c.backup_id, c.repository_id, c.engine_label, c.kind, c.state, c.started_at, c.finished_at,
            c.size_bytes, c.repository_size_bytes, c.lsn_start, c.lsn_stop, c.timeline, c.pg_major,
            c.system_identifier, c.engine_version, c.verification_state, c.verified_at, c.divergence,
            c.first_seen_at, c.last_seen_at,
            (SELECT b ->> 'walStart' FROM jsonb_array_elements(coalesce(r.observed -> 'backups', '[]'::jsonb)) b
              WHERE b ->> 'label' = c.engine_label LIMIT 1) AS wal_start
       FROM backups.catalog c JOIN backups.repositories r USING (repository_id)
      WHERE c.repository_id = $1
      ORDER BY c.finished_at DESC NULLS LAST LIMIT 1000`,
    [repositoryId],
  )
  return rows.map((row) => ({
    view: {
      id: row.text('backup_id') as SelectableBackup['view']['id'],
      repositoryId: row.text('repository_id') as SelectableBackup['view']['repositoryId'],
      engineLabel: row.text('engine_label'),
      kind: row.text('kind') as SelectableBackup['view']['kind'],
      state: row.text('state') as SelectableBackup['view']['state'],
      startedAt: row.date('started_at').toISOString(),
      finishedAt: row.dateOrNull('finished_at')?.toISOString() ?? null,
      sizeBytes: row.intOrNull('size_bytes'),
      repositorySizeBytes: row.intOrNull('repository_size_bytes'),
      lsnStart: row.textOrNull('lsn_start'),
      lsnStop: row.textOrNull('lsn_stop'),
      timeline: row.intOrNull('timeline'),
      postgresMajor: row.intOrNull('pg_major'),
      engineVersion: row.textOrNull('engine_version'),
      verification: {
        state: row.text('verification_state') as 'pending' | 'passed' | 'failed',
        verifiedAt: row.dateOrNull('verified_at')?.toISOString() ?? null,
      },
      divergence: row.text('divergence') as 'none' | 'missing_in_engine',
      firstSeenAt: row.date('first_seen_at').toISOString(),
      lastSeenAt: row.date('last_seen_at').toISOString(),
    },
    walStart: row.textOrNull('wal_start'),
    systemIdentifier: row.textOrNull('system_identifier'),
  }))
}

interface RestoreDraft {
  readonly purpose: 'drill' | 'recovery'
  readonly clusterId: string
  readonly repositoryId: string
  readonly request: SourceRequest
  readonly selectionKind: 'latest' | 'older' | 'pitr_random' | 'backup' | 'pitr'
  readonly nodeId: string | undefined
  readonly targetId: string | null
  readonly reason: string | null
}

async function planRestoreLike(
  tx: Tx,
  context: BackupPlanContext,
  actor: RegistryActor,
  d: RestoreDraft,
): Promise<PlanRecord> {
  const cluster = await liveCluster(tx, d.clusterId)
  const r = await getRepository(tx, d.repositoryId)
  if (r === undefined || r.clusterId !== d.clusterId) throw new BackupError('NOT_FOUND')
  if (r.state === 'retired') throw conflict('repository_retired')
  if (r.engine !== 'pgbackrest') {
    // Restores of logical (pg_dump/restic) repositories run from the offline runbook in V1.
    throw new BackupError('CAPABILITY_UNAVAILABLE')
  }
  const kind = d.purpose === 'drill' ? 'restore.drill' : 'restore.execute'
  const { mapping, node } = await nodeFor(
    tx,
    d.clusterId,
    nowOf(context),
    RUN_CAPABILITIES[kind] ?? [],
    d.nodeId,
  )
  const selection = selectSource(
    await selectable(tx, r.repositoryId),
    await listCoverage(tx, d.clusterId),
    d.request,
    context.random,
  )
  if (!selection.ok) throw conflict(selection.reason)
  const s = selection.source
  if (s.systemIdentifier !== null && s.systemIdentifier !== mapping.systemIdentifier) {
    throw new BackupError('RESTORE_TARGET_MISMATCH')
  }
  const tier = cluster.derivedTier ?? undefined
  const restoreId = newId('rst', nowOf(context))
  const runId = newId('run', nowOf(context))
  const content: JsonObject = {
    restoreId,
    runId,
    drillId: d.purpose === 'drill' ? newId('drl', nowOf(context)) : null,
    purpose: d.purpose,
    selection: d.selectionKind,
    clusterId: d.clusterId,
    targetId: d.targetId,
    repositoryId: r.repositoryId,
    repository: repositoryRef(r),
    nodeId: node.nodeId,
    localName: mapping.localName,
    systemIdentifier: mapping.systemIdentifier,
    source: {
      backupId: s.backupId,
      label: s.label,
      verification: s.verification,
      verificationAt: s.verificationAt,
      timeline: s.timeline,
      walFrom: s.walFrom,
      walTo: s.walTo,
      pointInTime: s.pointInTime,
      walContinuous: s.walContinuous,
      postgresMajor: s.postgresMajor,
      systemIdentifier: mapping.systemIdentifier,
      engineVersion: s.engineVersion,
    },
    destination: { kind: d.purpose === 'drill' ? 'scratch' : 'new_cluster', nodeId: node.nodeId },
    checks: ['recovery_target_reached', 'probe_simple', 'probe_extended', 'amcheck'],
    reason: d.reason,
  }
  return storeRegistryPlan(tx, context, actor, {
    kind,
    actionClass: d.purpose === 'drill' ? 'standard' : 'critical',
    subject: {
      clusterId: d.clusterId,
      nodeId: node.nodeId,
      ...(d.targetId === null ? {} : { targetId: d.targetId }),
      ...(tier === undefined ? {} : { tier }),
    },
    content,
    expectedState: {
      repositoryRevision: r.revision,
      backupId: s.backupId,
      verification: s.verification,
      verificationAt: s.verificationAt,
      walTo: s.walTo,
      nodeId: node.nodeId,
      localName: mapping.localName,
      systemIdentifier: mapping.systemIdentifier,
    },
    analysis: {
      effect:
        d.purpose === 'drill'
          ? 'The node prepares a scratch directory named by the run, restores into it, starts a localhost-only temporary cluster, runs the checks, stops it and discards the scratch directory. No registered cluster or target is touched.'
          : 'The node restores into a new cluster directory named by the run and starts it on a localhost port; the target is not switched (a placement move is a separate critical plan) and the old cluster stays.',
      dataLossWindow: s.pointInTime,
      activation:
        context.execution.restores === 'all' ||
        (context.execution.restores === 'scratch' && d.purpose === 'drill')
          ? 'activated'
          : 'not activated on this installation: the plan can be reviewed, its apply is refused (FEATURE_NOT_ACTIVATED)',
    },
  })
}

export function planDrill(
  tx: Tx,
  context: BackupPlanContext,
  actor: RegistryActor,
  clusterId: string,
  input: DrillPlanRequest,
): Promise<PlanRecord> {
  const sel = input.selection
  const request: SourceRequest =
    sel.kind === 'backup'
      ? { kind: 'backup', backupId: sel.backupId }
      : sel.kind === 'pitr'
        ? { kind: 'pitr', atMs: Date.parse(sel.at) }
        : { kind: sel.kind }
  return planRestoreLike(tx, context, actor, {
    purpose: 'drill',
    clusterId,
    repositoryId: input.repositoryId,
    request,
    selectionKind: sel.kind,
    nodeId: input.nodeId,
    targetId: null,
    reason: null,
  })
}

export async function planRecovery(
  tx: Tx,
  context: BackupPlanContext,
  actor: RegistryActor,
  target: { readonly targetId: string; readonly clusterId: string },
  input: RestorePlanRequest,
): Promise<PlanRecord> {
  const src = input.source
  const request: SourceRequest =
    'backupId' in src
      ? { kind: 'backup', backupId: src.backupId }
      : 'pointInTime' in src
        ? { kind: 'pitr', atMs: Date.parse(src.pointInTime) }
        : { kind: 'latest' }
  return planRestoreLike(tx, context, actor, {
    purpose: 'recovery',
    clusterId: target.clusterId,
    repositoryId: input.repositoryId,
    request,
    selectionKind: 'backupId' in src ? 'backup' : 'pointInTime' in src ? 'pitr' : 'latest',
    nodeId: input.destination.nodeId,
    targetId: target.targetId,
    reason: input.reason,
  })
}

export async function planRestoreDiscard(
  tx: Tx,
  context: BackupPlanContext,
  actor: RegistryActor,
  clusterId: string,
  restoreId: string,
): Promise<PlanRecord> {
  const { rows } = await tx.query(
    'backups.plans.restore',
    `SELECT restore_id, cluster_id, state, run_id, node_id, purpose FROM backups.restores WHERE restore_id = $1`,
    [restoreId],
  )
  const row = rows[0]
  if (row === undefined || row.text('cluster_id') !== clusterId) throw new BackupError('NOT_FOUND')
  const state = row.text('state')
  const runId = row.textOrNull('run_id')
  if (runId === null || !['ready', 'failed', 'needs_attention'].includes(state)) {
    throw conflict('restore_not_discardable')
  }
  const cluster = await getCluster(tx, clusterId)
  const tier = cluster?.derivedTier ?? undefined
  requireRestoreExecution(context.execution, 'drill')
  await nodeFor(
    tx,
    clusterId,
    nowOf(context),
    RUN_CAPABILITIES['restore.discard'] ?? [],
    row.text('node_id'),
  )
  return storeRegistryPlan(tx, context, actor, {
    kind: 'restore.discard',
    actionClass: 'standard',
    subject: { clusterId, nodeId: row.text('node_id'), ...(tier === undefined ? {} : { tier }) },
    content: {
      restoreId,
      clusterId,
      runId,
      nodeId: row.text('node_id'),
      purpose: row.text('purpose'),
    },
    expectedState: { state },
    analysis: {
      effect:
        "The node stops the temporary cluster of this restore if it runs and removes its scratch directory (only inside the node's scratch root). The restore record stays as history.",
    },
  })
}

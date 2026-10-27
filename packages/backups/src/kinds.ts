import { appendAuditEvent } from '@exponetdb/audit'
import { NODE_CAPABILITIES, type NodeCapabilityKey } from '@exponetdb/contracts'
import { type ControlStore, ControlStoreError, type Tx } from '@exponetdb/control-store'
import { type Clock, isId, isJsonObject, type JsonObject, type JsonValue } from '@exponetdb/kernel'
import {
  APPLY_JOB_SECONDS,
  argsHashOf,
  type JobEnd,
  judgedEnd,
  mapCluster,
  NodeError,
  outcomeOf,
  READ_JOB_SECONDS,
  type RunnerDeps,
  recordObservation,
  requireCapabilities,
  runJob,
  settleJob,
} from '@exponetdb/nodes'
import {
  type ChangedBinding,
  type ExecutionContext,
  type ExecutionOutcome,
  type OperationKind,
  type PlanRecord,
  WORKER_ACTOR,
} from '@exponetdb/operations'
import { Body, ContentInvalid, RegistryKind, type RegistryKindDeps } from '@exponetdb/registry'
import {
  type ExecutionSettings,
  requireBackupExecution,
  requireRestoreExecution,
} from './activation.ts'
import { BackupError } from './errors.ts'
import { PGBACKREST_LABEL, RUN_CAPABILITIES } from './plans.ts'
import { type ListResult, latestArchive, reconcileCatalog } from './reconcile.ts'
import { getRepository } from './records.ts'

/**
 * Operation kinds of the backup domain ([operations-engine.md §2](../../../exponetdb-docs/02-control-plane/operations-engine.md#2-operation-kinds)).
 *
 * - Record kinds (`backup.repository.*`, `backup.policy.set`) write the
 *   Control Store in one transaction with their audit event, like registry
 *   kinds; the guards of bundle `backup-catalog` decide again.
 * - Run kinds (`backup.run`, `backup.verify`, `restore.drill`,
 *   `restore.execute`) start one supervised engine run on the node with a
 *   short signed job (ADR-0037), report `applied` once the node stated that
 *   the run started, and verify by observing the run with `run.status@1`
 *   jobs until it is over, then against the engine's own catalog (a backup)
 *   or the run's checks (a restore). An unknown start is reconciled from the
 *   node's run record, never by starting again; nothing irreversible is
 *   retried.
 */

// ----- record kinds -----

/** `backup.repository.adopt`: a repository record starts read-only observation. */
export class BackupRepositoryAdoptKind extends RegistryKind {
  readonly kind = 'backup.repository.adopt'
  readonly actionClass = 'standard'

  async bindings(_plan: PlanRecord, c: Body, expected: Body): Promise<ChangedBinding[]> {
    const { rows } = await this.deps.store.query(
      'backups.kind.adopt.bindings',
      `SELECT c.state, c.system_identifier,
              EXISTS (SELECT FROM backups.repositories r
                       WHERE r.cluster_id = c.cluster_id AND r.engine = $2 AND coalesce(r.stanza, '') = coalesce($3, '')
                         AND coalesce(r.repo_index, 0) = coalesce($4, 0)
                         AND coalesce(r.endpoint_host, '') = coalesce($5, '') AND coalesce(r.bucket, '') = coalesce($6, '')
                         AND r.prefix = $7 AND r.state <> 'retired') AS taken
         FROM registry.clusters c WHERE c.cluster_id = $1`,
      [
        c.text('clusterId'),
        c.text('engine'),
        c.textOrNull('stanza'),
        c.intOrNull('repoIndex'),
        c.textOrNull('endpointHost'),
        c.textOrNull('bucket'),
        c.text('prefix'),
      ],
    )
    const row = rows[0]
    const changed: ChangedBinding[] = []
    if (row === undefined || row.text('state') !== expected.text('clusterState')) {
      changed.push({
        binding: 'clusterState',
        expected: expected.text('clusterState'),
        actual: row?.text('state') ?? null,
      })
    }
    if (
      row !== undefined &&
      row.textOrNull('system_identifier') !== expected.text('systemIdentifier')
    ) {
      changed.push({ binding: 'systemIdentifier', actual: 'changed' })
    }
    if (row?.bool('taken') === true) changed.push({ binding: 'location', actual: 'taken' })
    return changed
  }

  async run(ctx: ExecutionContext, c: Body) {
    return this.effect(async (tx) => {
      await tx.query(
        'backups.kind.adopt.insert',
        `INSERT INTO backups.repositories (repository_id, cluster_id, layer, engine, provider, endpoint_host, region,
           bucket, prefix, stanza, repo_index, priority, purpose, ownership, secret_source, lock_mode, lock_capability,
           cipher, pinned_engine_version, state, revision, created_by_operation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'adopted_observed', 'host_config', $14,
                 'unknown', $15, $16, 'observing', 1, $17)`,
        [
          c.id('bkr', 'repositoryId'),
          c.id('cls', 'clusterId'),
          c.text('layer'),
          c.text('engine'),
          c.text('provider'),
          c.textOrNull('endpointHost'),
          c.textOrNull('region'),
          c.textOrNull('bucket'),
          c.text('prefix'),
          c.textOrNull('stanza'),
          c.intOrNull('repoIndex'),
          c.int('priority'),
          c.text('purpose'),
          c.text('lockMode'),
          c.text('cipher'),
          c.textOrNull('pinnedEngineVersion'),
          ctx.operationId,
        ],
      )
      await this.audit(
        tx,
        ctx,
        {
          repositoryId: c.text('repositoryId'),
          layer: c.text('layer'),
          engine: c.text('engine'),
          provider: c.text('provider'),
          ownership: 'adopted_observed',
        },
        { clusterId: c.text('clusterId') },
      )
      return true
    })
  }

  check(ctx: ExecutionContext, c: Body) {
    return this.exists(
      'backups.kind.adopt.verify',
      `SELECT 1 FROM backups.repositories WHERE repository_id = $1 AND created_by_operation_id = $2
          AND ownership = 'adopted_observed' AND secret_source = 'host_config'`,
      [c.text('repositoryId'), ctx.operationId],
    )
  }

  applied(ctx: ExecutionContext, c: Body) {
    return this.check(ctx, c)
  }
}

/** `backup.repository.ownership`: adopted_observed → adopted_runs, the revision raised. */
export class BackupRepositoryOwnershipKind extends RegistryKind {
  readonly kind = 'backup.repository.ownership'
  readonly actionClass = 'high'

  async bindings(_plan: PlanRecord, c: Body, expected: Body): Promise<ChangedBinding[]> {
    const r = await getRepository(this.deps.store, c.text('repositoryId'))
    if (r === undefined || r.state === 'retired')
      return [{ binding: 'repository', actual: 'retired' }]
    return r.revision === expected.int('revision') && r.ownership === expected.text('ownership')
      ? []
      : [{ binding: 'revision', expected: expected.int('revision'), actual: r.revision }]
  }

  async run(ctx: ExecutionContext, c: Body) {
    if (c.text('to') !== 'adopted_runs') return 'not_applied' as const
    return this.effect(async (tx) => {
      const { rowCount } = await tx.query(
        'backups.kind.ownership.update',
        `UPDATE backups.repositories SET ownership = 'adopted_runs', revision = revision + 1, changed_by_operation_id = $2
          WHERE repository_id = $1 AND ownership = 'adopted_observed' AND state <> 'retired'`,
        [c.id('bkr', 'repositoryId'), ctx.operationId],
      )
      if (rowCount !== 1) return false
      await this.audit(
        tx,
        ctx,
        { repositoryId: c.text('repositoryId'), from: 'adopted_observed', to: 'adopted_runs' },
        { clusterId: c.text('clusterId') },
      )
      return true
    })
  }

  check(ctx: ExecutionContext, c: Body) {
    return this.exists(
      'backups.kind.ownership.verify',
      `SELECT 1 FROM backups.repositories WHERE repository_id = $1 AND changed_by_operation_id = $2
          AND ownership = 'adopted_runs'`,
      [c.text('repositoryId'), ctx.operationId],
    )
  }

  applied(ctx: ExecutionContext, c: Body) {
    return this.check(ctx, c)
  }
}

/** `backup.repository.retire`: the record leaves ExponetDB; nothing in storage is touched. */
export class BackupRepositoryRetireKind extends RegistryKind {
  readonly kind = 'backup.repository.retire'
  readonly actionClass = 'high'

  async bindings(_plan: PlanRecord, c: Body, expected: Body): Promise<ChangedBinding[]> {
    const r = await getRepository(this.deps.store, c.text('repositoryId'))
    if (r === undefined || r.state === 'retired')
      return [{ binding: 'repository', actual: 'retired' }]
    const { rows } = await this.deps.store.query(
      'backups.kind.retire.bindings',
      `SELECT (SELECT count(*) FROM backups.runs WHERE repository_id = $1 AND state IN ('starting', 'running', 'unknown'))::int AS runs,
              (SELECT count(*) FROM backups.restores WHERE repository_id = $1 AND state NOT IN ('discarded', 'promoted'))::int AS restores`,
      [c.text('repositoryId')],
    )
    const changed: ChangedBinding[] = []
    if (r.revision !== expected.int('revision'))
      changed.push({ binding: 'revision', actual: r.revision })
    if ((rows[0]?.int('runs') ?? 1) > 0)
      changed.push({ binding: 'openRuns', actual: rows[0]?.int('runs') ?? null })
    if ((rows[0]?.int('restores') ?? 1) > 0) {
      changed.push({ binding: 'openRestores', actual: rows[0]?.int('restores') ?? null })
    }
    return changed
  }

  async run(ctx: ExecutionContext, c: Body) {
    return this.effect(async (tx) => {
      const { rowCount } = await tx.query(
        'backups.kind.retire.update',
        `UPDATE backups.repositories SET state = 'retired', revision = revision + 1, retired_at = clock_timestamp(),
                retired_by_operation_id = $2
          WHERE repository_id = $1 AND state <> 'retired'`,
        [c.id('bkr', 'repositoryId'), ctx.operationId],
      )
      if (rowCount !== 1) return false
      await this.audit(
        tx,
        ctx,
        {
          repositoryId: c.text('repositoryId'),
          storageTouched: false,
          reason: c.textOrNull('reason'),
        },
        { clusterId: c.text('clusterId') },
      )
      return true
    })
  }

  check(ctx: ExecutionContext, c: Body) {
    return this.exists(
      'backups.kind.retire.verify',
      `SELECT 1 FROM backups.repositories WHERE repository_id = $1 AND retired_by_operation_id = $2 AND state = 'retired'`,
      [c.text('repositoryId'), ctx.operationId],
    )
  }

  applied(ctx: ExecutionContext, c: Body) {
    return this.check(ctx, c)
  }
}

/** `backup.policy.set`: a new policy revision supersedes the active one. */
export class BackupPolicySetKind extends RegistryKind {
  readonly kind = 'backup.policy.set'
  readonly actionClass = 'high'

  async bindings(_plan: PlanRecord, c: Body, expected: Body): Promise<ChangedBinding[]> {
    const { rows } = await this.deps.store.query(
      'backups.kind.policy.bindings',
      `SELECT coalesce(max(revision) FILTER (WHERE state = 'active'), 0)::int AS current
         FROM backups.policies WHERE cluster_id = $1`,
      [c.text('clusterId')],
    )
    const current = rows[0]?.int('current') ?? 0
    return current === expected.int('currentRevision')
      ? []
      : [{ binding: 'policyRevision', expected: expected.int('currentRevision'), actual: current }]
  }

  async run(ctx: ExecutionContext, c: Body) {
    const body = c.raw('body')
    if (!isJsonObject(body)) return 'not_applied' as const
    return this.effect(async (tx) => {
      await tx.query(
        'backups.kind.policy.supersede',
        `UPDATE backups.policies SET state = 'superseded' WHERE cluster_id = $1 AND state = 'active'`,
        [c.id('cls', 'clusterId')],
      )
      await tx.query(
        'backups.kind.policy.insert',
        `INSERT INTO backups.policies (policy_id, cluster_id, revision, state, body, operation_id)
         VALUES ($1, $2, $3, 'active', $4, $5)`,
        [
          c.id('bpl', 'policyId'),
          c.text('clusterId'),
          c.int('revision'),
          JSON.stringify(body),
          ctx.operationId,
        ],
      )
      await this.audit(
        tx,
        ctx,
        { policyId: c.text('policyId'), revision: c.int('revision') },
        { clusterId: c.text('clusterId') },
      )
      return true
    })
  }

  check(ctx: ExecutionContext, c: Body) {
    return this.exists(
      'backups.kind.policy.verify',
      `SELECT 1 FROM backups.policies WHERE policy_id = $1 AND operation_id = $2 AND state = 'active'`,
      [c.text('policyId'), ctx.operationId],
    )
  }

  applied(ctx: ExecutionContext, c: Body) {
    return this.exists(
      'backups.kind.policy.applied',
      'SELECT 1 FROM backups.policies WHERE policy_id = $1 AND operation_id = $2',
      [c.text('policyId'), ctx.operationId],
    )
  }
}

export function backupRecordKinds(deps: RegistryKindDeps): OperationKind[] {
  return [
    new BackupRepositoryAdoptKind(deps),
    new BackupRepositoryOwnershipKind(deps),
    new BackupRepositoryRetireKind(deps),
    new BackupPolicySetKind(deps),
  ]
}

// ----- run kinds -----

export interface BackupRunKindDeps extends RunnerDeps {
  readonly store: ControlStore
  readonly clock: Clock
  /** The installation's activation, read again when a run would start (an operator may turn it off). */
  readonly execution: () => ExecutionSettings
  /** Pause between two `run.status@1` reads (default 30 s, growing to 5 min). */
  readonly statusPollMs?: number
  /** How long a run is observed at most after its start (default its RuntimeMaxSec plus ten minutes). */
  readonly observeLimitMs?: (purpose: string) => number
}

const RUNTIME_MAX_MS: Readonly<Record<string, number>> = {
  backup: 12 * 3_600_000,
  verify: 12 * 3_600_000,
  restore: 24 * 3_600_000,
  reverify: 3_600_000,
}

const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'lost', 'not_found'])

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(t)
      resolve()
    })
  })
}

function obj(v: JsonValue | undefined): JsonObject {
  return isJsonObject(v) ? v : {}
}

/** The audit event a run kind writes when a run ends (the operations engine audits the operation itself). */
async function auditRun(
  tx: Tx,
  clock: Clock,
  ctx: ExecutionContext,
  kind: string,
  changes: JsonObject,
  clusterId: string,
): Promise<void> {
  if (!isId('op', ctx.operationId)) throw new BackupError('INTERNAL')
  await appendAuditEvent(
    tx,
    {
      action: kind,
      phase: 'completed',
      actor: { kind: 'system', identityId: null, label: WORKER_ACTOR.label },
      subject: { clusterId } as never,
      refs: { operationId: ctx.operationId, planId: ctx.plan.planId, planHash: ctx.plan.planHash },
      changes: { ...changes },
      result: { status: 'succeeded', applyOutcome: 'applied' },
    },
    { clock },
  )
}

abstract class RunKind implements OperationKind {
  abstract readonly kind: 'backup.run' | 'backup.verify' | 'restore.drill' | 'restore.execute'
  readonly version = 1
  abstract readonly actionClass: 'low' | 'standard' | 'high' | 'critical'
  readonly verifies = true
  protected readonly d: BackupRunKindDeps

  constructor(deps: BackupRunKindDeps) {
    this.d = deps
  }

  /** One engine activity per cluster at a time, backups and restores alike (ADR-0037 §3). */
  exclusivity(plan: PlanRecord): readonly string[] {
    return [`cluster:${Body.content(plan).text('clusterId')}:backup`]
  }

  /** The start capability and the purpose the run has. */
  protected abstract start(): { readonly capability: NodeCapabilityKey; readonly purpose: string }
  /** Kind-specific bindings beyond the node mapping and the capabilities. */
  protected abstract more(plan: PlanRecord, c: Body, e: Body): Promise<ChangedBinding[]>
  /** Refuses the start when the installation has not activated it (throws `BackupError`). */
  protected abstract activated(c: Body, plan: PlanRecord): void

  async checkBindings(plan: PlanRecord): Promise<readonly ChangedBinding[]> {
    let c: Body
    let e: Body
    try {
      c = Body.content(plan)
      e = Body.expected(plan)
    } catch (error) {
      if (error instanceof ContentInvalid) return [{ binding: 'content', actual: 'invalid' }]
      throw error
    }
    try {
      const { mapping, node } = await mapCluster(
        this.d.store,
        c.text('clusterId'),
        this.d.clock.nowMs(),
        {
          nodeId: e.text('nodeId'),
        },
      )
      const changed: ChangedBinding[] = []
      for (const key of ['localName', 'systemIdentifier'] as const) {
        if (mapping[key] !== e.text(key))
          changed.push({ binding: key, expected: e.text(key), actual: mapping[key] })
      }
      requireCapabilities(node, RUN_CAPABILITIES[this.kind] ?? [])
      return [...changed, ...(await this.more(plan, c, e))]
    } catch (error) {
      if (error instanceof NodeError) return [{ binding: 'node', actual: error.code.toLowerCase() }]
      if (error instanceof ContentInvalid) return [{ binding: 'content', actual: 'invalid' }]
      throw error
    }
  }

  protected cluster(c: Body): JsonObject {
    return { localName: c.text('localName'), systemIdentifier: c.text('systemIdentifier') }
  }

  protected job(
    ctx: ExecutionContext,
    capability: NodeCapabilityKey,
    args: JsonObject,
  ): Promise<JobEnd> {
    const c = Body.content(ctx.plan)
    const apply = NODE_CAPABILITIES[capability].kind === 'apply'
    return runJob(
      this.d,
      {
        nodeId: c.text('nodeId'),
        operationId: ctx.operationId,
        capability,
        args: () => args,
        windowSeconds: apply ? APPLY_JOB_SECONDS : READ_JOB_SECONDS,
      },
      ctx.signal,
      ctx.leaseOwner,
      apply ? ctx.readmit : undefined,
    )
  }

  /** The start job's arguments; `prepared` is what `prepare` found for this one operation. */
  protected abstract startArgs(c: Body, prepared: JsonObject): JsonObject

  /** Inserts the run (and what goes with it) before the start job, in one transaction. */
  protected async begin(
    _tx: Tx,
    _ctx: ExecutionContext,
    _c: Body,
    _prepared: JsonObject,
  ): Promise<void> {}

  async execute(ctx: ExecutionContext): Promise<ExecutionOutcome> {
    let c: Body
    try {
      c = Body.content(ctx.plan)
    } catch {
      return 'not_applied'
    }
    try {
      this.activated(c, ctx.plan)
    } catch (error) {
      if (error instanceof BackupError) {
        return {
          outcome: 'not_applied',
          errorCode: error.code,
          ...(error.details === undefined ? {} : { detail: error.details }),
        }
      }
      throw error
    }
    const { capability, purpose } = this.start()
    // Per operation, never on the kind (one instance serves every operation of the worker).
    const prepared = await this.prepare(ctx, c)
    if ('refused' in prepared) return prepared.refused
    try {
      await this.d.store.transaction(`backups.kind.${this.kind}.begin`, async (tx) => {
        await tx.query(
          'backups.kind.run.insert',
          `INSERT INTO backups.runs (run_id, cluster_id, repository_id, node_id, purpose, kind, operation_id, state)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'starting')`,
          [
            c.id('run', 'runId'),
            c.id('cls', 'clusterId'),
            c.textOrNull('repositoryId'),
            c.id('nod', 'nodeId'),
            purpose,
            purpose === 'backup' ? c.text('kind') : null,
            ctx.operationId,
          ],
        )
        await this.begin(tx, ctx, c, prepared.facts)
      })
    } catch (error) {
      if (error instanceof ControlStoreError && error.sqlstate === '23505') {
        return {
          outcome: 'not_applied',
          errorCode: 'REGISTRY_CONFLICT',
          detail: { reason: 'run_active' },
        }
      }
      if (error instanceof ControlStoreError && error.sqlstate?.startsWith('EX'))
        return 'not_applied'
      throw error
    }
    const args = this.startArgs(c, prepared.facts)
    const end = await this.job(ctx, capability, args)
    const runId = c.text('runId')
    if (end.end === 'succeeded') {
      await this.d.store.query(
        'backups.kind.run.started',
        `UPDATE backups.runs SET state = 'running', start_job_id = $2, start_args_hash = $3, started_at = $4,
                last_status_at = clock_timestamp()
          WHERE run_id = $1 AND state = 'starting'`,
        [
          runId,
          end.jobId,
          argsHashOf(args),
          String(end.result['startedAt'] ?? new Date(this.d.clock.nowMs()).toISOString()),
        ],
      )
      return 'applied'
    }
    const outcome = outcomeOf(end, capability) ?? 'unknown'
    // A start whose effect may have begun is not known to have failed: the run stays `unknown`, never retried.
    await this.d.store.query(
      'backups.kind.run.not_started',
      `UPDATE backups.runs SET state = $2, start_job_id = nullif($3, ''), start_args_hash = $4,
              finished_at = CASE WHEN $2 = 'failed' THEN clock_timestamp() END, error_code = $5
        WHERE run_id = $1 AND state = 'starting'`,
      [
        runId,
        outcome === 'unknown' ? 'unknown' : 'failed',
        end.jobId,
        end.jobId === '' ? null : argsHashOf(args),
        typeof outcome === 'object'
          ? outcome.errorCode
          : outcome === 'unknown'
            ? null
            : 'NODE_CAPABILITY_FAILED',
      ],
    )
    await this.failed(c, outcome)
    return outcome
  }

  /** A check before anything starts (restores: `restore.prepare@1`): refused, or the facts the start needs. */
  protected async prepare(
    _ctx: ExecutionContext,
    _c: Body,
  ): Promise<{ readonly refused: ExecutionOutcome } | { readonly facts: JsonObject }> {
    return { facts: {} }
  }

  /** Records what a refused or unknown start means for the kind's own rows. */
  protected async failed(_c: Body, _outcome: ExecutionOutcome): Promise<void> {}

  /**
   * Observes the run until it is over: one `run.status@1` job per look,
   * bound to the job that started it, with growing pauses. The terminal
   * statement is node-signed; the run row records it.
   */
  protected async observe(
    ctx: ExecutionContext,
    c: Body,
  ): Promise<JsonObject | 'aborted' | 'gone'> {
    const runId = c.text('runId')
    const { rows } = await this.d.store.query(
      'backups.kind.run.read',
      'SELECT start_job_id, start_args_hash, started_at, state FROM backups.runs WHERE run_id = $1',
      [runId],
    )
    const row = rows[0]
    const startJobId = row?.textOrNull('start_job_id') ?? null
    const startArgsHash = row?.textOrNull('start_args_hash') ?? null
    if (startJobId === null || startArgsHash === null) return 'gone'
    const { purpose } = this.start()
    const limit =
      this.d.observeLimitMs?.(purpose) ?? (RUNTIME_MAX_MS[purpose] ?? 3_600_000) + 10 * 60_000
    const startedAt = row?.dateOrNull('started_at')?.getTime() ?? this.d.clock.nowMs()
    let pause = this.d.statusPollMs ?? 30_000
    for (;;) {
      if (ctx.signal.aborted) return 'aborted'
      const end = await this.job(ctx, 'run.status@1', { runId, startJobId, startArgsHash })
      if (end.end === 'succeeded') {
        const status = end.result
        const state = String(status['state'])
        await this.d.store.query(
          'backups.kind.run.status',
          `UPDATE backups.runs
              SET state = CASE WHEN $2 IN ('succeeded', 'failed', 'canceled', 'lost') THEN $2
                               WHEN $2 = 'not_found' THEN 'lost' ELSE 'running' END,
                  finished_at = CASE WHEN $2 IN ('succeeded', 'failed', 'canceled', 'lost', 'not_found')
                                     THEN coalesce($3::timestamptz, clock_timestamp()) END,
                  last_status_at = clock_timestamp(), exit_code = $4, progress = $5, outcome = $6
            WHERE run_id = $1 AND state IN ('starting', 'running', 'unknown')`,
          [
            runId,
            state,
            typeof status['finishedAt'] === 'string' ? status['finishedAt'] : null,
            typeof status['exitCode'] === 'number' ? status['exitCode'] : null,
            status['progress'] === null || status['progress'] === undefined
              ? null
              : JSON.stringify(status['progress']),
            status['outcome'] === null || status['outcome'] === undefined
              ? null
              : JSON.stringify(status['outcome']),
          ],
        )
        if (TERMINAL.has(state)) return status
      }
      if (this.d.clock.nowMs() - startedAt > limit) return 'gone'
      await sleep(pause, ctx.signal)
      pause = Math.min(pause * 2, 5 * 60_000)
    }
  }

  abstract verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'>

  /**
   * After a lost worker: the start job's own statement decides; an unknown
   * start is settled and the node's run record is asked (`run.status@1`
   * with no record means it never started). Never starts the run again.
   */
  async reconcile(ctx: ExecutionContext): Promise<'applied' | 'not_applied' | 'unknown'> {
    const { capability } = this.start()
    const { rows } = await this.d.store.query(
      'backups.kind.run.own_job',
      `SELECT job_id FROM nodes.jobs WHERE operation_id = $1 AND capability = $2 ORDER BY created_at DESC LIMIT 1`,
      [ctx.operationId, capability],
    )
    const jobId = rows[0]?.text('job_id')
    if (jobId === undefined) return 'not_applied'
    const end = await settleJob(this.d, jobId, capability, ctx.signal)
    if (ctx.signal.aborted) return 'unknown'
    if (end.end === 'succeeded') return 'applied'
    return outcomeOf(end, capability) === 'unknown' ? 'unknown' : 'not_applied'
  }
}

/** `backup.run`: a supervised backup run into one repository. */
export class BackupRunKind extends RunKind {
  readonly kind = 'backup.run'
  readonly actionClass = 'standard'

  protected start() {
    return { capability: 'backup.run@1' as const, purpose: 'backup' }
  }

  protected activated(_c: Body, plan: PlanRecord): void {
    requireBackupExecution(this.d.execution(), tierOf(plan))
  }

  protected async more(_plan: PlanRecord, c: Body, e: Body): Promise<ChangedBinding[]> {
    const r = await getRepository(this.d.store, c.text('repositoryId'))
    if (r === undefined || r.state === 'retired')
      return [{ binding: 'repository', actual: 'retired' }]
    const changed: ChangedBinding[] = []
    if (r.revision !== e.int('repositoryRevision'))
      changed.push({ binding: 'repositoryRevision', actual: r.revision })
    if (r.ownership !== e.text('ownership'))
      changed.push({ binding: 'ownership', actual: r.ownership })
    return changed
  }

  protected startArgs(c: Body): JsonObject {
    return {
      cluster: this.cluster(c),
      repository: repositoryArg(c),
      runId: c.text('runId'),
      kind: c.text('kind'),
      databases: (c.raw('databases') as JsonValue[] | undefined) ?? [],
    }
  }

  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    const c = Body.content(ctx.plan)
    const status = await this.observe(ctx, c)
    if (status === 'aborted') return 'error'
    if (status === 'gone' || status['state'] !== 'succeeded') return 'failed'
    const label = obj(status['outcome'])['label']
    if (typeof label !== 'string') return 'failed'
    // A run that exited 0 is not a backup: the engine's catalog must list it (architecture.md §6).
    const listed = await refreshRepository(this.d, ctx, c, (cap, args) => this.job(ctx, cap, args))
    if (listed !== 'ok') return 'error'
    const { rows } = await this.d.store.query(
      'backups.kind.run.listed',
      `SELECT c.size_bytes, c.kind,
              (SELECT p.size_bytes FROM backups.catalog p
                WHERE p.repository_id = c.repository_id AND p.kind = c.kind AND p.state = 'succeeded'
                  AND p.engine_label <> c.engine_label AND p.started_at < c.started_at
                ORDER BY p.started_at DESC LIMIT 1) AS previous
         FROM backups.catalog c
        WHERE c.repository_id = $1 AND c.engine_label = $2 AND c.state = 'succeeded' AND c.divergence = 'none'
          -- The label the node names must be new: first mirrored after this run's row existed, so an
          -- older backup (or engine-user state naming one) never passes for this run.
          AND c.first_seen_at >= (SELECT r.created_at FROM backups.runs r WHERE r.run_id = $3)`,
      [c.text('repositoryId'), label, c.text('runId')],
    )
    const row = rows[0]
    if (row === undefined) return 'failed'
    const size = row.intOrNull('size_bytes')
    const previous = row.intOrNull('previous')
    const floor = await sizeFloorPercent(this.d.store, c.text('clusterId'))
    if (size !== null && previous !== null && previous > 0 && size * 100 < previous * floor)
      return 'failed'
    await this.d.store.transaction('backups.kind.run.audit', (tx) =>
      auditRun(
        tx,
        this.d.clock,
        ctx,
        'backup.run',
        { runId: c.text('runId'), label, sizeBytes: size },
        c.text('clusterId'),
      ),
    )
    return 'passed'
  }
}

/** `backup.verify`: the engine's verify command over one backup; the catalog records the result. */
export class BackupVerifyKind extends RunKind {
  readonly kind = 'backup.verify'
  readonly actionClass = 'low'

  protected start() {
    return { capability: 'backup.verify@1' as const, purpose: 'verify' }
  }

  protected activated(_c: Body, plan: PlanRecord): void {
    requireBackupExecution(this.d.execution(), tierOf(plan))
  }

  protected async more(_plan: PlanRecord, c: Body): Promise<ChangedBinding[]> {
    const { rows } = await this.d.store.query(
      'backups.kind.verify.bindings',
      `SELECT c.divergence, r.state FROM backups.catalog c JOIN backups.repositories r USING (repository_id)
        WHERE c.backup_id = $1`,
      [c.text('backupId')],
    )
    const row = rows[0]
    if (row === undefined || row.text('state') === 'retired')
      return [{ binding: 'backup', actual: 'gone' }]
    return row.text('divergence') === 'none'
      ? []
      : [{ binding: 'backup', actual: 'missing_in_engine' }]
  }

  protected startArgs(c: Body): JsonObject {
    return {
      cluster: this.cluster(c),
      repository: repositoryArg(c),
      runId: c.text('runId'),
      label: c.textOrNull('label'),
      snapshot: c.textOrNull('snapshot'),
    }
  }

  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    const c = Body.content(ctx.plan)
    const status = await this.observe(ctx, c)
    if (status === 'aborted') return 'error'
    const passed =
      status !== 'gone' &&
      status['state'] === 'succeeded' &&
      obj(status['outcome'])['verifyErrors'] === 0
    const finished =
      status !== 'gone' && (status['state'] === 'succeeded' || status['state'] === 'failed')
    if (finished) {
      await this.d.store.transaction('backups.kind.verify.record', async (tx) => {
        await tx.query(
          'backups.kind.verify.catalog',
          `UPDATE backups.catalog SET verification_state = $2, verified_at = clock_timestamp(), verification_run_id = $3
            WHERE backup_id = $1`,
          [c.text('backupId'), passed ? 'passed' : 'failed', c.text('runId')],
        )
        await auditRun(
          tx,
          this.d.clock,
          ctx,
          'backup.verify',
          {
            backupId: c.text('backupId'),
            runId: c.text('runId'),
            verification: passed ? 'passed' : 'failed',
          },
          c.text('clusterId'),
        )
      })
    }
    return passed ? 'passed' : 'failed'
  }
}

/** The tier the plan bound in its subject; a missing tier is unknown and the activation check treats it as production. */
function tierOf(plan: PlanRecord): 'prod' | 'nonprod' | undefined {
  const subject = plan.body['subject']
  const t = isJsonObject(subject) ? subject['tier'] : undefined
  return t === 'prod' || t === 'nonprod' ? t : undefined
}

function repositoryArg(c: Body): JsonObject {
  const r = obj(c.raw('repository'))
  return {
    repositoryId: String(r['repositoryId']),
    engine: String(r['engine']),
    stanza: typeof r['stanza'] === 'string' ? r['stanza'] : null,
    repoIndex: typeof r['repoIndex'] === 'number' ? r['repoIndex'] : null,
  }
}

async function sizeFloorPercent(store: ControlStore, clusterId: string): Promise<number> {
  const { rows } = await store.query(
    'backups.kind.size_floor',
    `SELECT (body ->> 'sizeFloorPercent')::int AS floor FROM backups.policies WHERE cluster_id = $1 AND state = 'active'`,
    [clusterId],
  )
  const floor = rows[0]?.intOrNull('floor') ?? null
  return floor === null || floor < 1 || floor > 100 ? 50 : floor
}

/** Reads one repository's engine catalog through the node and reconciles the mirror. */
export async function refreshRepository(
  d: Pick<BackupRunKindDeps, 'store' | 'clock'>,
  ctx: ExecutionContext,
  c: Body,
  job: (capability: NodeCapabilityKey, args: JsonObject) => Promise<JobEnd>,
): Promise<'ok' | 'failed'> {
  const repositoryId = c.text('repositoryId')
  const repo = await getRepository(d.store, repositoryId)
  if (repo === undefined || repo.state === 'retired') return 'failed'
  const args = {
    cluster: { localName: c.text('localName'), systemIdentifier: c.text('systemIdentifier') },
    repository: {
      repositoryId,
      engine: repo.engine,
      stanza: repo.stanza,
      repoIndex: repo.repoIndex,
    },
  }
  const end = await job('backup.list@1', args)
  if (end.end !== 'succeeded') {
    await d.store.transaction('backups.kind.refresh.failed', (tx) =>
      reconcileCatalog(tx, {
        repositoryId,
        clusterId: repo.clusterId,
        engine: repo.engine,
        clusterSystemIdentifier: c.text('systemIdentifier'),
        jobId: end.jobId === '' ? null : end.jobId,
        result: {
          engineVersion: null,
          stanza: { status: 'error', message: '', systemIdentifier: null, cipher: 'unknown' },
          backups: [],
          archive: [],
          truncated: false,
        },
        archive: null,
        nowMs: d.clock.nowMs(),
      }),
    )
    return 'failed'
  }
  const archive = await latestArchive(d.store, repo.clusterId)
  const outcome = await d.store.transaction('backups.kind.refresh.reconcile', async (tx) => {
    await recordObservation(tx, {
      jobId: end.jobId,
      nodeId: c.text('nodeId'),
      clusterId: repo.clusterId,
      capability: 'backup.list@1',
      argsHash: argsHashOf(args),
      operationId: ctx.operationId,
      result: end.result,
    })
    return reconcileCatalog(tx, {
      repositoryId,
      clusterId: repo.clusterId,
      engine: repo.engine,
      clusterSystemIdentifier: c.text('systemIdentifier'),
      jobId: end.jobId,
      result: end.result as unknown as ListResult,
      archive,
      nowMs: d.clock.nowMs(),
    })
  })
  return outcome.outcome === 'failed' ? 'failed' : 'ok'
}

/** `backup.catalog.refresh` (inline, low): reads every observed repository of the cluster. */
export class CatalogRefreshKind implements OperationKind {
  readonly kind = 'backup.catalog.refresh'
  readonly version = 1
  readonly actionClass = 'low'
  readonly verifies = true
  readonly #d: BackupRunKindDeps

  constructor(deps: BackupRunKindDeps) {
    this.#d = deps
  }

  exclusivity(): readonly string[] {
    return []
  }

  async checkBindings(plan: PlanRecord): Promise<readonly ChangedBinding[]> {
    try {
      const c = Body.content(plan)
      const { node } = await mapCluster(this.#d.store, c.text('clusterId'), this.#d.clock.nowMs(), {
        nodeId: c.text('nodeId'),
      })
      requireCapabilities(node, RUN_CAPABILITIES['backup.catalog.refresh'] ?? [])
      return []
    } catch (error) {
      if (error instanceof NodeError) return [{ binding: 'node', actual: error.code.toLowerCase() }]
      if (error instanceof ContentInvalid) return [{ binding: 'content', actual: 'invalid' }]
      throw error
    }
  }

  async execute(ctx: ExecutionContext): Promise<ExecutionOutcome> {
    const c = Body.content(ctx.plan)
    const { rows } = await this.#d.store.query(
      'backups.kind.refresh.repositories',
      `SELECT repository_id FROM backups.repositories
        WHERE cluster_id = $1 AND state <> 'retired' AND ownership <> 'external' ORDER BY priority, repository_id`,
      [c.text('clusterId')],
    )
    let ok = 0
    for (const row of rows) {
      const body = new Body({
        ...(ctx.plan.body['content'] as JsonObject),
        repositoryId: row.text('repository_id'),
      })
      const outcome = await refreshRepository(this.#d, ctx, body, (capability, args) =>
        runJob(
          this.#d,
          {
            nodeId: c.text('nodeId'),
            operationId: ctx.operationId,
            capability,
            args: () => args,
            windowSeconds: READ_JOB_SECONDS,
          },
          ctx.signal,
          ctx.leaseOwner,
        ),
      )
      if (outcome === 'ok') ok++
    }
    return rows.length === 0
      ? 'not_applied'
      : ok === rows.length
        ? 'applied'
        : ok > 0
          ? 'partially_applied'
          : 'not_applied'
  }

  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    const { rows } = await this.#d.store.query(
      'backups.kind.refresh.verify',
      `SELECT count(*) FILTER (WHERE x.outcome = 'ok')::int AS ok, count(*)::int AS n
         FROM backups.reconciliations x JOIN nodes.jobs j ON j.job_id = x.job_id WHERE j.operation_id = $1`,
      [ctx.operationId],
    )
    const ok = rows[0]?.int('ok') ?? 0
    const n = rows[0]?.int('n') ?? 0
    return n === 0 ? 'failed' : ok === n ? 'passed' : ok > 0 ? 'partial' : 'failed'
  }

  async reconcile(): Promise<'applied' | 'not_applied' | 'unknown'> {
    // A read changes nothing on the host; what it recorded is in the mirror.
    return 'not_applied'
  }
}

// ----- restores -----

function restoreTarget(c: Body): JsonObject {
  const s = obj(c.raw('source'))
  const pit = typeof s['pointInTime'] === 'string' ? s['pointInTime'] : null
  // The planner refuses a label the node cannot take (PGBACKREST_LABEL); a missing one here is content damage.
  if (typeof s['label'] !== 'string' || !PGBACKREST_LABEL.test(s['label'])) {
    throw new ContentInvalid('source.label')
  }
  return {
    label: s['label'],
    time: pit,
    lsn: null,
    timeline: typeof s['timeline'] === 'number' ? s['timeline'] : null,
  }
}

abstract class RestoreRunKind extends RunKind {
  protected abstract purpose(): 'drill' | 'recovery'

  protected start() {
    return { capability: 'restore.execute@1' as const, purpose: 'restore' }
  }

  protected activated(): void {
    requireRestoreExecution(this.d.execution(), this.purpose())
  }

  protected async more(_plan: PlanRecord, c: Body, e: Body): Promise<ChangedBinding[]> {
    const r = await getRepository(this.d.store, c.text('repositoryId'))
    if (r === undefined || r.state === 'retired')
      return [{ binding: 'repository', actual: 'retired' }]
    const changed: ChangedBinding[] = []
    if (r.revision !== e.int('repositoryRevision'))
      changed.push({ binding: 'repositoryRevision', actual: r.revision })
    const { rows } = await this.d.store.query(
      'backups.kind.restore.source',
      `SELECT verification_state, verified_at, divergence FROM backups.catalog WHERE backup_id = $1`,
      [e.text('backupId')],
    )
    const b = rows[0]
    if (b === undefined || b.text('divergence') !== 'none')
      changed.push({ binding: 'backup', actual: 'missing' })
    else if (
      b.text('verification_state') !== e.text('verification') ||
      (b.dateOrNull('verified_at')?.toISOString() ?? null) !== e.textOrNull('verificationAt')
    ) {
      changed.push({
        binding: 'verification',
        expected: e.text('verification'),
        actual: b.text('verification_state'),
      })
    }
    return changed
  }

  protected override async prepare(
    ctx: ExecutionContext,
    c: Body,
  ): Promise<{ readonly refused: ExecutionOutcome } | { readonly facts: JsonObject }> {
    let target: JsonObject
    try {
      target = restoreTarget(c)
    } catch (error) {
      if (!(error instanceof ContentInvalid)) throw error
      return { refused: { outcome: 'not_applied', errorCode: 'RESTORE_SOURCE_INVALID' } }
    }
    const end = await this.job(ctx, 'restore.prepare@1', {
      cluster: this.cluster(c),
      repository: repositoryArg(c),
      runId: c.text('runId'),
      purpose: this.purpose(),
      target,
    })
    if (end.end !== 'succeeded') {
      const o = outcomeOf(end, 'restore.prepare@1')
      return {
        refused:
          o === undefined || o === 'unknown' || o === 'applied' || o === 'partially_applied'
            ? {
                outcome: 'not_applied',
                errorCode: 'NODE_CAPABILITY_FAILED',
                detail: { capability: 'restore.prepare@1' },
              }
            : o,
      }
    }
    const p = end.result
    const refusals = Array.isArray(p['refusals']) ? p['refusals'].map(String) : []
    if (
      refusals.length > 0 ||
      p['scratchFree'] !== true ||
      p['engineCanRead'] !== true ||
      typeof p['port'] !== 'number'
    ) {
      return {
        refused: {
          outcome: 'not_applied',
          errorCode: refusals.includes('system_identifier_mismatch')
            ? 'RESTORE_TARGET_MISMATCH'
            : 'RESTORE_SOURCE_INVALID',
          detail: { refusals },
        },
      }
    }
    if (p['walContinuous'] === false) {
      return {
        refused: {
          outcome: 'not_applied',
          errorCode: 'RESTORE_SOURCE_INVALID',
          detail: { refusals: ['wal_not_continuous'] },
        },
      }
    }
    return { facts: { port: p['port'] } }
  }

  protected override async begin(
    tx: Tx,
    ctx: ExecutionContext,
    c: Body,
    prepared: JsonObject,
  ): Promise<void> {
    const s = obj(c.raw('source'))
    await tx.query(
      'backups.kind.restore.insert',
      `INSERT INTO backups.restores (restore_id, cluster_id, target_id, purpose, state, repository_id, backup_id,
         point_in_time, timeline, wal_from, wal_to, destination_kind, node_id, run_id, port, plan_id, operation_id)
       VALUES ($1, $2, $3, $4, 'planned', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        c.id('rst', 'restoreId'),
        c.text('clusterId'),
        c.textOrNull('targetId'),
        this.purpose(),
        c.text('repositoryId'),
        typeof s['backupId'] === 'string' ? s['backupId'] : null,
        typeof s['pointInTime'] === 'string' ? s['pointInTime'] : null,
        typeof s['timeline'] === 'number' ? s['timeline'] : null,
        typeof s['walFrom'] === 'string' ? s['walFrom'] : null,
        typeof s['walTo'] === 'string' ? s['walTo'] : null,
        this.purpose() === 'drill' ? 'scratch' : 'new_cluster',
        c.text('nodeId'),
        c.text('runId'),
        typeof prepared['port'] === 'number' ? prepared['port'] : null,
        ctx.plan.planId,
        ctx.operationId,
      ],
    )
    await tx.query(
      'backups.kind.restore.preparing',
      `UPDATE backups.restores SET state = 'restoring', phases = $2 WHERE restore_id = $1`,
      [
        c.text('restoreId'),
        JSON.stringify([
          {
            name: 'prepare',
            startedAt: new Date(this.d.clock.nowMs()).toISOString(),
            finishedAt: new Date(this.d.clock.nowMs()).toISOString(),
            outcome: 'passed',
          },
        ]),
      ],
    )
    if (this.purpose() === 'drill') {
      await tx.query(
        'backups.kind.drill.insert',
        `INSERT INTO backups.drills (drill_id, cluster_id, restore_id, repository_id, selection, mode, outcome, started_at)
         VALUES ($1, $2, $3, $4, $5, 'control_plane', 'pending', clock_timestamp())`,
        [
          c.id('drl', 'drillId'),
          c.text('clusterId'),
          c.text('restoreId'),
          c.text('repositoryId'),
          c.text('selection'),
        ],
      )
    }
  }

  protected startArgs(c: Body, prepared: JsonObject): JsonObject {
    const checks = (c.raw('checks') as JsonValue[] | undefined) ?? []
    return {
      cluster: this.cluster(c),
      repository: repositoryArg(c),
      runId: c.text('runId'),
      purpose: this.purpose(),
      target: restoreTarget(c),
      // prepare refuses without a port, so the start always names the one the node chose.
      port: prepared['port'] as number,
      checks: checks.filter((x) => typeof x === 'string'),
      rowCounts: [],
    }
  }

  protected override async failed(c: Body, outcome: ExecutionOutcome): Promise<void> {
    await this.d.store.query(
      'backups.kind.restore.failed',
      `UPDATE backups.restores SET state = $2, finished_at = clock_timestamp() WHERE restore_id = $1 AND state NOT IN ('discarded', 'promoted')`,
      [c.text('restoreId'), outcome === 'unknown' ? 'needs_attention' : 'failed'],
    )
    if (this.purpose() === 'drill') {
      await this.d.store.query(
        'backups.kind.drill.aborted',
        `UPDATE backups.drills SET outcome = 'aborted', finished_at = clock_timestamp() WHERE drill_id = $1 AND outcome = 'pending'`,
        [c.text('drillId')],
      )
    }
  }

  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    const c = Body.content(ctx.plan)
    const status = await this.observe(ctx, c)
    if (status === 'aborted') return 'error'
    const out = status === 'gone' ? {} : obj(status['outcome'])
    const nodeChecks = (Array.isArray(out['checks']) ? out['checks'] : []).filter(isJsonObject)
    const phases = (Array.isArray(out['phases']) ? out['phases'] : []).filter(isJsonObject)
    const succeeded = status !== 'gone' && status['state'] === 'succeeded'
    const configured = ((c.raw('checks') as JsonValue[] | undefined) ?? []).map(String)
    const allPassed =
      succeeded &&
      configured.every((name) =>
        nodeChecks.some((k) => k['check'] === name && k['outcome'] === 'passed'),
      )
    // The fingerprint and the ledger head need a Control Plane read of the scratch cluster, which V1 does not have.
    const checks = [
      ...nodeChecks.map((k) => ({
        check: k['check'],
        outcome: k['outcome'],
        detail: k['detail'] ?? null,
      })),
      {
        check: 'fingerprint',
        outcome: 'not_run',
        detail: 'needs a Control Plane read of the scratch cluster (not in V1)',
      },
      {
        check: 'ledger_head',
        outcome: 'not_run',
        detail: 'needs a Control Plane read of the scratch cluster (not in V1)',
      },
    ]
    const ms = (p: JsonObject) => {
      const a = Date.parse(String(p['startedAt']))
      const b = Date.parse(String(p['finishedAt']))
      return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : 0
    }
    const rtoSeconds = Math.round(phases.reduce((sum, p) => sum + ms(p), 0) / 1000)
    await this.d.store.query(
      'backups.kind.restore.result',
      `UPDATE backups.restores SET state = $2, checks = $3, phases = phases || $4::jsonb, finished_at = clock_timestamp()
        WHERE restore_id = $1 AND state NOT IN ('discarded', 'promoted')`,
      [
        c.text('restoreId'),
        allPassed ? 'ready' : status === 'gone' ? 'needs_attention' : 'failed',
        JSON.stringify(checks),
        JSON.stringify(
          phases.map((p) => ({
            name: p['name'] === 'stop' ? 'verify' : p['name'],
            startedAt: p['startedAt'],
            finishedAt: p['finishedAt'],
            outcome: p['outcome'] === 'running' ? 'failed' : p['outcome'],
          })),
        ),
      ],
    )
    if (this.purpose() !== 'drill') {
      return allPassed ? 'passed' : 'failed'
    }
    // A drill is passed only after its scratch cluster is discarded (restore.md §6).
    const discard = await this.job(ctx, 'restore.discard@1', { runId: c.text('runId') })
    const discarded = discard.end === 'succeeded'
    if (discarded) {
      await this.d.store.query(
        'backups.kind.drill.discarded',
        `UPDATE backups.restores SET state = 'discarded', phases = phases || $2::jsonb WHERE restore_id = $1 AND state <> 'discarded'`,
        [
          c.text('restoreId'),
          JSON.stringify([
            {
              name: 'discard',
              startedAt: new Date(this.d.clock.nowMs()).toISOString(),
              finishedAt: new Date(this.d.clock.nowMs()).toISOString(),
              outcome: 'passed',
            },
          ]),
        ],
      )
    }
    const passed = allPassed && discarded
    await this.d.store.transaction('backups.kind.drill.outcome', async (tx) => {
      await tx.query(
        'backups.kind.drill.outcome',
        `UPDATE backups.drills SET outcome = $2, measured_rto_seconds = $3, finished_at = clock_timestamp()
          WHERE drill_id = $1 AND outcome = 'pending'`,
        [c.text('drillId'), passed ? 'passed' : 'failed', passed ? rtoSeconds : null],
      )
      await auditRun(
        tx,
        this.d.clock,
        ctx,
        'restore.drill',
        {
          drillId: c.text('drillId'),
          restoreId: c.text('restoreId'),
          outcome: passed ? 'passed' : 'failed',
          discarded,
        },
        c.text('clusterId'),
      )
    })
    return passed ? 'passed' : 'failed'
  }
}

/** `restore.drill`: a restore into scratch, checked and discarded. */
export class RestoreDrillKind extends RestoreRunKind {
  readonly kind = 'restore.drill'
  readonly actionClass = 'standard'
  protected purpose() {
    return 'drill' as const
  }
}

/** `restore.execute`: a recovery into a new cluster directory; never in place, never promoted here. */
export class RestoreExecuteKind extends RestoreRunKind {
  readonly kind = 'restore.execute'
  readonly actionClass = 'critical'
  protected purpose() {
    return 'recovery' as const
  }
}

/** `restore.discard`: stops a scratch cluster and removes its directory. */
export class RestoreDiscardKind implements OperationKind {
  readonly kind = 'restore.discard'
  readonly version = 1
  readonly actionClass = 'standard'
  readonly verifies = true
  readonly #d: BackupRunKindDeps

  constructor(deps: BackupRunKindDeps) {
    this.#d = deps
  }

  exclusivity(plan: PlanRecord): readonly string[] {
    return [`cluster:${Body.content(plan).text('clusterId')}:backup`]
  }

  async checkBindings(plan: PlanRecord): Promise<readonly ChangedBinding[]> {
    const c = Body.content(plan)
    const e = Body.expected(plan)
    const { rows } = await this.#d.store.query(
      'backups.kind.discard.bindings',
      'SELECT state FROM backups.restores WHERE restore_id = $1',
      [c.text('restoreId')],
    )
    const state = rows[0]?.text('state') ?? null
    return state === e.text('state')
      ? []
      : [{ binding: 'restoreState', expected: e.text('state'), actual: state }]
  }

  async execute(ctx: ExecutionContext): Promise<ExecutionOutcome> {
    const c = Body.content(ctx.plan)
    try {
      requireRestoreExecution(
        this.#d.execution(),
        c.text('purpose') === 'drill' ? 'drill' : 'recovery',
      )
    } catch (error) {
      if (error instanceof BackupError) return { outcome: 'not_applied', errorCode: error.code }
      throw error
    }
    const end = await runJob(
      this.#d,
      {
        nodeId: c.text('nodeId'),
        operationId: ctx.operationId,
        capability: 'restore.discard@1',
        args: () => ({ runId: c.text('runId') }),
        windowSeconds: APPLY_JOB_SECONDS,
      },
      ctx.signal,
      ctx.leaseOwner,
      ctx.readmit,
    )
    if (end.end !== 'succeeded') return outcomeOf(end, 'restore.discard@1') ?? 'unknown'
    await this.#d.store.query(
      'backups.kind.discard.record',
      `UPDATE backups.restores SET state = 'discarded' WHERE restore_id = $1 AND state NOT IN ('discarded', 'promoted')`,
      [c.text('restoreId')],
    )
    return 'applied'
  }

  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    const c = Body.content(ctx.plan)
    const { rows } = await this.#d.store.query(
      'backups.kind.discard.verify',
      'SELECT state FROM backups.restores WHERE restore_id = $1',
      [c.text('restoreId')],
    )
    return rows[0]?.text('state') === 'discarded' ? 'passed' : 'failed'
  }

  async reconcile(ctx: ExecutionContext): Promise<'applied' | 'not_applied' | 'unknown'> {
    const { rows } = await this.#d.store.query(
      'backups.kind.discard.own_job',
      `SELECT job_id FROM nodes.jobs WHERE operation_id = $1 AND capability = 'restore.discard@1' ORDER BY created_at DESC LIMIT 1`,
      [ctx.operationId],
    )
    const jobId = rows[0]?.text('job_id')
    if (jobId === undefined) return 'not_applied'
    const end = await judgedEnd(this.#d, jobId, 'restore.discard@1')
    return end?.end === 'succeeded' ? 'applied' : 'unknown'
  }
}

export function backupRunKinds(deps: BackupRunKindDeps): OperationKind[] {
  return [
    new CatalogRefreshKind(deps),
    new BackupRunKind(deps),
    new BackupVerifyKind(deps),
    new RestoreDrillKind(deps),
    new RestoreExecuteKind(deps),
    new RestoreDiscardKind(deps),
  ]
}

export { settleJob }

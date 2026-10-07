import {
  appendAuditEvent,
  type CheckpointExporter,
  checkpointExportState,
  createCheckpoint,
  ensureAuditPartitions,
  exportPendingCheckpoints,
  fileCheckpointExporter,
  s3CheckpointExporter,
  verifyAuditChain,
} from '@exponetdb/audit'
import { oauth, pruneAuthState } from '@exponetdb/auth'
import {
  type ControlStore,
  claimDueTask,
  finishTask,
  pruneHeartbeats,
  registerTasks,
  releaseTasks,
  taskStates,
} from '@exponetdb/control-store'
import type { InstallationId, ProcessInstanceId, SecretId } from '@exponetdb/kernel'
import { bindPendingNodes, judgeCompletions, sweepJobs } from '@exponetdb/nodes'
import { type Gauge, type HealthCheck, pass, warn } from '@exponetdb/observability'
import { expirePlans, pruneIdempotencyKeys, WORKER_ACTOR } from '@exponetdb/operations'
import { type Keyring, rewrapBatch } from '@exponetdb/secrets'
import type { AuditExportConfig } from '../config/env.ts'
import type { ObservationTasks } from './registry.ts'
import type { Runtime } from './runtime.ts'

/**
 * The worker's background tasks ([data-retention.md §2](../../../../exponetdb-docs/02-control-plane/data-retention.md#2-mechanism),
 * [audit.md §4](../../../../exponetdb-docs/02-control-plane/audit.md#4-immutability-and-integrity),
 * [secrets.md §3](../../../../exponetdb-docs/08-auth-and-security/secrets.md#3-rotation)).
 * Each runs on one worker at a time under a maintenance lease, is bounded per
 * run, and is idempotent, so a repeated run after a lost lease is harmless.
 */
export interface TaskContext {
  readonly store: ControlStore
  readonly runtime: Runtime
  readonly keyring: Keyring
  readonly installationId: InstallationId
  readonly exporter: CheckpointExporter | undefined
  readonly state: WorkerTaskState
  /** Wave 4: credential verification, health sampling, scheduled drift checks, sample partitions. */
  readonly observation?: ObservationTasks
}

export interface WorkerTaskState {
  lastExportError: string | undefined
  lastVerification: { readonly scope: 'incremental' | 'full'; readonly ok: boolean } | undefined
}

interface TaskDefinition {
  readonly name: string
  readonly intervalSeconds: number
  run(ctx: TaskContext): Promise<string | undefined>
}

const MINUTE = 60
const HOUR = 3600

export function checkpointExporter(config: AuditExportConfig): CheckpointExporter | undefined {
  switch (config.kind) {
    case 'none':
      return undefined
    case 'file':
      return fileCheckpointExporter(config.directory)
    case 's3':
      return s3CheckpointExporter({
        endpoint: config.endpoint,
        region: config.region,
        bucket: config.bucket,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        ...(config.prefix === undefined ? {} : { prefix: config.prefix }),
        ...(config.objectLock === undefined ? {} : { objectLock: config.objectLock }),
      })
  }
}

async function exportCheckpoints(ctx: TaskContext): Promise<string | undefined> {
  if (ctx.exporter === undefined) {
    return 'export_unconfigured'
  }
  const run = await exportPendingCheckpoints(ctx.store, ctx.installationId, ctx.exporter)
  if (run.failed !== undefined) {
    ctx.state.lastExportError = 'export_failed'
    ctx.runtime.logger.warn('audit.checkpoint_export_failed', {
      seq: run.failed,
      count: run.exported.length,
    })
    throw new TaskFailure('export_failed')
  }
  ctx.state.lastExportError = undefined
  return undefined
}

async function verify(
  ctx: TaskContext,
  scope: 'incremental' | 'full',
): Promise<string | undefined> {
  let fromCheckpointSeq: number | undefined
  if (scope === 'incremental') {
    const { rows } = await ctx.store.query(
      'audit.verify.latest_checkpoint',
      'SELECT max(seq) AS seq FROM audit.audit_chain_checkpoints',
    )
    fromCheckpointSeq = rows[0]?.intOrNull('seq') ?? undefined
  }
  const result = await verifyAuditChain(
    ctx.store,
    fromCheckpointSeq === undefined ? {} : { fromCheckpointSeq },
  )
  const ok = result.ok || (!result.ok && result.reason === 'empty_chain')
  ctx.state.lastVerification = { scope, ok }
  verifiedGauge(ctx).set({ scope }, ok ? 1 : 0)
  if (!ok && !result.ok) {
    ctx.runtime.logger.error('audit.chain_verification_failed', {
      seq: result.firstFailingSeq,
      reason: result.reason,
      check: scope,
    })
    throw new TaskFailure(result.reason)
  }
  return undefined
}

const gauges = new WeakMap<Runtime, Gauge<'scope'>>()
function verifiedGauge(ctx: TaskContext): Gauge<'scope'> {
  let gauge = gauges.get(ctx.runtime)
  if (gauge === undefined) {
    gauge = ctx.runtime.metrics.gauge<'scope'>(
      'exdb_audit_chain_verified',
      'Result of the last audit chain verification (1 verified, 0 failed).',
      {
        scope: { values: ['incremental', 'full'] },
      },
    )
    gauges.set(ctx.runtime, gauge)
  }
  return gauge
}

async function rewrap(ctx: TaskContext): Promise<string | undefined> {
  let after: { secretId: SecretId; version: number } | undefined
  let unreadable = 0
  for (let batch = 0; batch < 20; batch++) {
    const result = await ctx.store.transaction('secrets.rewrap.batch', async (tx) => {
      const r = await rewrapBatch(tx, ctx.keyring, {
        limit: 500,
        ...(after === undefined ? {} : { after }),
      })
      if (r.rewrapped > 0) {
        await appendAuditEvent(
          tx,
          {
            action: 'secrets.rewrapped',
            phase: 'completed',
            actor: { kind: 'system', identityId: null, label: WORKER_ACTOR.label },
            refs: { keyIds: [...r.fromKeyIds, ctx.keyring.activeKeyId].slice(0, 32) },
            result: { status: 'succeeded' },
            changes: { rewrapped: r.rewrapped, toKey: ctx.keyring.activeKeyId },
          },
          { clock: ctx.runtime.clock },
        )
      }
      return r
    })
    unreadable += result.unreadable.length
    if (result.next === undefined) {
      break
    }
    after = result.next
  }
  if (unreadable > 0) {
    ctx.runtime.logger.error('secrets.rewrap_unreadable', { count: unreadable })
    throw new TaskFailure('unreadable_data_keys')
  }
  return undefined
}

export const WORKER_TASKS: readonly TaskDefinition[] = [
  {
    name: 'audit.partitions',
    intervalSeconds: 6 * HOUR,
    run: async (ctx) => {
      await ensureAuditPartitions(ctx.store, 3)
      return undefined
    },
  },
  {
    name: 'audit.checkpoint',
    intervalSeconds: HOUR,
    run: async (ctx) => {
      await createCheckpoint(ctx.store, 'scheduled')
      return exportCheckpoints(ctx)
    },
  },
  { name: 'audit.export', intervalSeconds: 5 * MINUTE, run: exportCheckpoints },
  {
    name: 'audit.verify_incremental',
    intervalSeconds: HOUR,
    run: (ctx) => verify(ctx, 'incremental'),
  },
  { name: 'audit.verify_full', intervalSeconds: 24 * HOUR, run: (ctx) => verify(ctx, 'full') },
  {
    name: 'plans.expire',
    intervalSeconds: MINUTE,
    run: async (ctx) => {
      await ctx.store.transaction('plans.expire.batch', (tx) =>
        expirePlans(tx, WORKER_ACTOR, { clock: ctx.runtime.clock, limit: 1000 }),
      )
      return undefined
    },
  },
  {
    name: 'idempotency.prune',
    intervalSeconds: HOUR,
    run: async (ctx) => {
      await pruneIdempotencyKeys(ctx.store)
      return undefined
    },
  },
  {
    name: 'auth.prune',
    intervalSeconds: HOUR,
    run: async (ctx) => {
      await pruneAuthState(ctx.store)
      return undefined
    },
  },
  {
    name: 'oauth.prune',
    intervalSeconds: 15 * MINUTE,
    run: async (ctx) => {
      await oauth.pruneOAuthState(ctx.store)
      return undefined
    },
  },
  {
    name: 'heartbeats.prune',
    intervalSeconds: HOUR,
    run: async (ctx) => {
      await pruneHeartbeats(ctx.store)
      return undefined
    },
  },
  { name: 'secrets.rewrap', intervalSeconds: 10 * MINUTE, run: rewrap },
  // ----- Wave 4: observation of registered targets -----
  {
    name: 'registry.credentials.verify',
    intervalSeconds: 30,
    run: (ctx) => ctx.observation?.verifyCredentials() ?? Promise.resolve('observation_off'),
  },
  {
    name: 'health.sample',
    intervalSeconds: 15,
    run: (ctx) => ctx.observation?.sampleHealth() ?? Promise.resolve('observation_off'),
  },
  {
    name: 'drift.schedule',
    intervalSeconds: MINUTE,
    run: (ctx) => ctx.observation?.checkDrift() ?? Promise.resolve('observation_off'),
  },
  {
    name: 'health.partitions',
    intervalSeconds: 6 * HOUR,
    run: (ctx) => ctx.observation?.partitions() ?? Promise.resolve('observation_off'),
  },
  // ----- Wave 5: the node agent's control plane (control-plane.md §6) -----
  {
    name: 'nodes.bind',
    intervalSeconds: 5,
    run: async (ctx) => {
      const report = await bindPendingNodes(
        ctx.store,
        ctx.keyring,
        ctx.runtime.clock,
        ctx.installationId,
      )
      if (report.undecided > 0) {
        ctx.runtime.logger.warn('nodes.bind.undecided', { nodes: report.undecided })
      }
      return undefined
    },
  },
  {
    name: 'nodes.judge',
    intervalSeconds: 5,
    run: async (ctx) => {
      await judgeCompletions(ctx.store, ctx.installationId)
      return undefined
    },
  },
  {
    name: 'nodes.sweep',
    intervalSeconds: 15,
    run: async (ctx) => {
      await sweepJobs(ctx.store)
      return undefined
    },
  },
]

class TaskFailure extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(reason)
    this.reason = /^[a-z][a-z0-9_]{0,63}$/.test(reason) ? reason : 'task_failed'
  }
}

/** The maintenance loop: claims one due task at a time, runs it, records the outcome. */
export function maintenanceLoop(ctx: TaskContext, workerId: ProcessInstanceId, pollMs = 5000) {
  const names = WORKER_TASKS.map((t) => t.name)
  const runs = ctx.runtime.metrics.counter<'task' | 'outcome'>(
    'exdb_maintenance_task_runs_total',
    'Worker maintenance task runs.',
    {
      task: { values: names },
      outcome: { values: ['succeeded', 'failed', 'skipped'] },
    },
  )
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  let running: Promise<void> = Promise.resolve()

  async function tick(): Promise<void> {
    if (stopped) {
      return
    }
    try {
      await registerTasks(ctx.store, names)
      for (;;) {
        if (stopped) {
          return
        }
        const name = await claimDueTask(ctx.store, workerId, names, 300)
        const task = WORKER_TASKS.find((t) => t.name === name)
        if (task === undefined) {
          return
        }
        let outcome: 'succeeded' | 'failed' | 'skipped' = 'succeeded'
        let reason: string | null = null
        try {
          const skipped = await task.run(ctx)
          if (skipped !== undefined) {
            outcome = 'skipped'
            reason = skipped
          }
        } catch (error) {
          outcome = 'failed'
          reason = error instanceof TaskFailure ? error.reason : 'task_failed'
          ctx.runtime.logger.warn('maintenance.task_failed', { task: task.name, reason })
        }
        runs.inc({ task: task.name, outcome })
        const next =
          outcome === 'failed' ? Math.min(task.intervalSeconds, 5 * MINUTE) : task.intervalSeconds
        await finishTask(ctx.store, task.name, workerId, outcome, reason, next)
      }
    } catch (error) {
      ctx.runtime.logger.warn('maintenance.loop_failed', {
        code: error instanceof Error ? error.name : 'unknown',
      })
    }
  }

  return {
    start() {
      const loop = () => {
        running = tick().finally(() => {
          if (!stopped) {
            timer = setTimeout(loop, pollMs)
          }
        })
      }
      loop()
    },
    async stop() {
      stopped = true
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      await running
      await releaseTasks(ctx.store, workerId).catch(() => 0)
    },
  }
}

/** Worker readiness: degraded while checkpoints are not exported or verification failed. */
export function workerChecks(ctx: TaskContext): readonly HealthCheck[] {
  return [
    {
      name: 'audit_export',
      severity: 'degrading',
      run: async () => {
        if (ctx.exporter === undefined) {
          return warn('audit_export_unconfigured')
        }
        if (ctx.state.lastExportError !== undefined) {
          return warn('audit_export_failing')
        }
        const state = await checkpointExportState(ctx.store, ctx.exporter.sink)
        return state.unexported > 2 ? warn('audit_export_lagging') : pass()
      },
    },
    {
      name: 'audit_chain',
      severity: 'degrading',
      run: async () =>
        ctx.state.lastVerification?.ok === false ? warn('audit_chain_unverified') : pass(),
    },
    {
      name: 'maintenance',
      severity: 'degrading',
      run: async () => {
        const failing = (await taskStates(ctx.store)).filter((t) => t.consecutiveFailures >= 3)
        return failing.length > 0 ? warn('maintenance_failing') : pass()
      },
    },
  ]
}

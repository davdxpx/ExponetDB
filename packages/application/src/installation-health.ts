import { chainHead, exportSinks, latestCheckpoints } from '@exponetdb/audit'
import type { InstallationHealth } from '@exponetdb/contracts'
import {
  HEARTBEAT_STALE_SECONDS,
  type LiveProcess,
  liveProcesses,
  type Queryable,
  type TaskState,
  taskStates,
} from '@exponetdb/control-store'
import { liveDataReadWorkers } from '@exponetdb/diagnostics'
import type { Clock } from '@exponetdb/kernel'
import { agentConnections } from '@exponetdb/nodes'

/**
 * Control Plane health for `GET /installation/health` (health.md §8,
 * self-observability.md §5; Wave 8 order §9). Every component is read from
 * what the Control Store holds or what the process that serves the request
 * knows of itself:
 *
 * - `control_store`: serve's own readiness checks (the loop evaluates them
 *   every few seconds in the serving process);
 * - `workers`: the process heartbeats of the worker role;
 * - `maintenance`: the lease table of the worker's maintenance tasks;
 * - `samplers`: the lag of the worker's `health.sample` task;
 * - `data_reads`: the data-read workers' heartbeats;
 * - `gateway`: the gateway process heartbeat and the nodes' heartbeats;
 * - `keyring`: the keys this process loaded against what the store references;
 * - `audit_chain`: the head, the checkpoints, the export progress and the
 *   outcome of the worker's verification tasks. The verification itself is
 *   `GET /audit-events/chain`; the sequence a worker verified is not stored.
 *
 * Not known, and said so (`unobserved`): the gateway certificate (the gateway
 * mints it in memory), a gateway nobody needs, a task no worker ever
 * registered. A failed read is an error: nothing here answers `operational`
 * by catching a failure. No host name, build or commit leaves this function.
 */
export interface ReadinessCheck {
  readonly name: string
  readonly status: 'pass' | 'warn' | 'fail'
  readonly reason?: string | undefined
}

export interface InstallationHealthSources {
  /** The serving process's latest readiness report. */
  readonly readiness: () => {
    readonly evaluatedAt: string
    readonly checks: readonly ReadinessCheck[]
  }
  /** The keyring this process loaded compared with the store (`keyringStatus`). */
  readonly keyring: () => Promise<{ readonly missing: number; readonly mismatched: number }>
}

type Component = InstallationHealth['components'][number]
type State = Component['state']

const RANK: Readonly<Record<State, number>> = { operational: 0, degraded: 1, down: 2 }

const worst = (states: readonly State[]): State =>
  states.reduce<State>((acc, s) => (RANK[s] > RANK[acc] ? s : acc), 'operational')

/** The sampler's task period (apps/server worker-tasks: `health.sample`, 15 seconds). */
const SAMPLER_PERIOD_SECONDS = 15
/** The sampler lags when its scheduled run is more than two periods late (health.md §8). */
const SAMPLER_LAG_SECONDS = 2 * SAMPLER_PERIOD_SECONDS
/** A task nobody claimed for this long is overdue: a live worker claims due tasks every few seconds. */
const TASK_OVERDUE_SECONDS = 15 * 60
/** Hourly checkpoints: older than two hours is stale. */
const CHECKPOINT_STALE_SECONDS = 2 * 3600

const iso = (ms: number) => new Date(ms).toISOString()
const count = (n: number) => Math.max(0, Math.trunc(n))

function task(tasks: readonly TaskState[], name: string): TaskState | undefined {
  return tasks.find((t) => t.task === name)
}

function newestBeat(processes: readonly LiveProcess[], nowMs: number): string | undefined {
  if (processes.length === 0) return undefined
  const age = Math.min(...processes.map((p) => p.ageSeconds))
  return Number.isFinite(age) ? iso(nowMs - age * 1000) : undefined
}

function controlStore(sources: InstallationHealthSources, nowMs: number): Component {
  const report = sources.readiness()
  // The checks that say whether this process can use the store as it expects.
  const names = new Set(['control_store', 'role_credential', 'installation', 'schema'])
  const own = report.checks.filter((c) => names.has(c.name))
  const reasons = own.filter((c) => c.status !== 'pass').map((c) => c.reason ?? c.name)
  const evaluatedAt = Date.parse(report.evaluatedAt)
  if (own.length === 0) {
    // No readiness is wired (a test composition): this very request read the store, nothing more.
    return {
      component: 'control_store',
      state: 'operational',
      source: 'live',
      observedAt: iso(nowMs),
      reasons: ['read_in_this_request'],
    }
  }
  return {
    component: 'control_store',
    state: reasons.length === 0 ? 'operational' : 'degraded',
    source: 'sampled',
    observedAt: Number.isFinite(evaluatedAt) ? iso(evaluatedAt) : iso(nowMs),
    ...(reasons.length === 0 ? {} : { reasons: [...new Set(reasons)].sort().slice(0, 16) }),
  }
}

function workers(processes: readonly LiveProcess[], nowMs: number): Component {
  const live = processes.filter((p) => p.role === 'worker')
  const serve = processes.filter((p) => p.role === 'serve')
  const beat = newestBeat(live, nowMs)
  return {
    component: 'workers',
    state: live.length > 0 ? 'operational' : 'degraded',
    source: live.length > 0 ? 'sampled' : 'inferred',
    observedAt: beat ?? iso(nowMs),
    ...(live.length > 0 ? {} : { reasons: ['no_live_worker'] }),
    values: {
      liveWorkers: live.length,
      liveServe: serve.length,
      staleAfterSeconds: HEARTBEAT_STALE_SECONDS,
    },
  }
}

function maintenance(
  tasks: readonly TaskState[],
  nowMs: number,
): { component?: Component; unobserved?: string } {
  if (tasks.length === 0) return { unobserved: 'never_registered' }
  const failing = tasks.filter((t) => t.consecutiveFailures >= 3)
  const overdue = tasks.filter((t) => nowMs - t.nextRunAt.getTime() > TASK_OVERDUE_SECONDS * 1000)
  const reasons = [
    ...(failing.length > 0 ? ['tasks_failing'] : []),
    ...(overdue.length > 0 ? ['tasks_overdue'] : []),
  ]
  const finished = tasks.flatMap((t) =>
    t.lastFinishedAt === null ? [] : [t.lastFinishedAt.getTime()],
  )
  return {
    component: {
      component: 'maintenance',
      state: reasons.length === 0 ? 'operational' : 'degraded',
      source: 'sampled',
      observedAt: finished.length > 0 ? iso(Math.max(...finished)) : iso(nowMs),
      ...(reasons.length === 0 ? {} : { reasons }),
      values: { tasks: tasks.length, failing: failing.length, overdue: overdue.length },
    },
  }
}

function samplers(
  tasks: readonly TaskState[],
  nowMs: number,
): { component?: Component; unobserved?: string } {
  const sample = task(tasks, 'health.sample')
  if (sample === undefined) return { unobserved: 'never_registered' }
  const lag = Math.max(0, (nowMs - sample.nextRunAt.getTime()) / 1000)
  const reasons = [
    ...(lag > SAMPLER_LAG_SECONDS ? ['sampler_lagging'] : []),
    ...(sample.consecutiveFailures > 0 ? ['sampler_failing'] : []),
    ...(sample.lastOutcome === 'skipped' && sample.lastReason !== null ? [sample.lastReason] : []),
  ]
  return {
    component: {
      component: 'samplers',
      state: reasons.length === 0 ? 'operational' : 'degraded',
      source: 'sampled',
      observedAt:
        sample.lastFinishedAt === null ? iso(nowMs) : iso(sample.lastFinishedAt.getTime()),
      ...(reasons.length === 0 ? {} : { reasons: [...new Set(reasons)].slice(0, 16) }),
      values: {
        lagSeconds: Math.round(lag),
        consecutiveFailures: sample.consecutiveFailures,
        periodSeconds: SAMPLER_PERIOD_SECONDS,
      },
    },
  }
}

function dataReads(
  live: { live: number; newestAgeSeconds: number | null },
  nowMs: number,
): Component {
  return {
    component: 'data_reads',
    state: live.live > 0 ? 'operational' : 'degraded',
    source: live.live > 0 ? 'sampled' : 'inferred',
    observedAt:
      live.newestAgeSeconds === null ? iso(nowMs) : iso(nowMs - live.newestAgeSeconds * 1000),
    // Without a worker a data read is CAPABILITY_UNAVAILABLE, never an empty result.
    ...(live.live > 0 ? {} : { reasons: ['no_live_data_read_worker'] }),
    values: { liveWorkers: live.live },
  }
}

function gateway(
  processes: readonly LiveProcess[],
  agents: { enrolled: number; connected: number; lastHeartbeatAt: string | null },
  nowMs: number,
): { component?: Component; unobserved?: string } {
  const live = processes.filter((p) => p.role === 'gateway')
  if (agents.enrolled === 0 && live.length === 0) return { unobserved: 'not_applicable' }
  const beat = newestBeat(live, nowMs)
  const values = {
    liveGateways: live.length,
    enrolledNodes: count(agents.enrolled),
    connectedNodes: count(agents.connected),
  }
  if (agents.enrolled === 0) {
    return {
      component: {
        component: 'gateway',
        state: 'operational',
        source: 'sampled',
        observedAt: beat ?? iso(nowMs),
        reasons: ['no_nodes_enrolled'],
        values,
      },
    }
  }
  const state: State =
    live.length === 0 ? 'down' : agents.connected === 0 ? 'degraded' : 'operational'
  const reasons =
    live.length === 0 ? ['gateway_not_live'] : agents.connected === 0 ? ['no_agent_connected'] : []
  // The newest signal either side gave: a gateway beat or a node's heartbeat.
  const signals = [beat, agents.lastHeartbeatAt].flatMap((t) =>
    t === undefined || t === null ? [] : [Date.parse(t)],
  )
  return {
    component: {
      component: 'gateway',
      state,
      source: 'inferred',
      observedAt: signals.length > 0 ? iso(Math.max(...signals)) : iso(nowMs),
      ...(reasons.length === 0 ? {} : { reasons }),
      values,
    },
  }
}

function keyring(status: { missing: number; mismatched: number }, nowMs: number): Component {
  const reasons = [
    ...(status.mismatched > 0 ? ['keyring_mismatch'] : []),
    ...(status.missing > 0 ? ['keyring_missing_key'] : []),
  ]
  return {
    component: 'keyring',
    state: status.mismatched > 0 ? 'down' : status.missing > 0 ? 'degraded' : 'operational',
    source: 'live',
    observedAt: iso(nowMs),
    ...(reasons.length === 0 ? {} : { reasons }),
    values: { missingKeys: count(status.missing), mismatchedKeys: count(status.mismatched) },
  }
}

async function auditChain(
  q: Queryable,
  tasks: readonly TaskState[],
  nowMs: number,
): Promise<Component> {
  const [head, checkpoints, sinks] = [
    await chainHead(q),
    await latestCheckpoints(q, 1),
    await exportSinks(q),
  ]
  const reasons: string[] = []
  const checkpoint = checkpoints[0]
  if (head !== null) {
    if (checkpoint === undefined) reasons.push('no_checkpoint')
    else if (
      checkpoint.seq < head.seq &&
      nowMs - checkpoint.createdAt.getTime() > CHECKPOINT_STALE_SECONDS * 1000
    ) {
      reasons.push('checkpoint_stale')
    }
  }
  const exportTask = task(tasks, 'audit.export')
  if (exportTask?.lastOutcome === 'failed') reasons.push('export_failing')
  else if (exportTask?.lastOutcome === 'skipped') {
    reasons.push(exportTask.lastReason ?? 'export_skipped')
  } else if (sinks.length === 0) reasons.push('export_not_recorded')
  else if ((sinks[0]?.pendingCheckpoints ?? 0) > 2) reasons.push('export_lagging')
  for (const name of ['audit.verify_incremental', 'audit.verify_full'] as const) {
    const t = task(tasks, name)
    const label = name === 'audit.verify_full' ? 'full' : 'incremental'
    if (t === undefined || t.lastOutcome === null)
      reasons.push(`${label}_verification_not_recorded`)
    else if (t.lastOutcome === 'failed') {
      reasons.push(`${label}_verification_failed`)
      if (t.lastReason !== null) reasons.push(t.lastReason)
    }
  }
  const unique = [...new Set(reasons)].sort().slice(0, 16)
  return {
    component: 'audit_chain',
    state: unique.length === 0 ? 'operational' : 'degraded',
    source: 'live',
    observedAt: iso(nowMs),
    ...(unique.length === 0 ? {} : { reasons: unique }),
    values: {
      headSeq: head?.seq ?? null,
      checkpointSeq: checkpoint?.seq ?? null,
      exporters: sinks.length,
      pendingCheckpoints: sinks[0]?.pendingCheckpoints ?? null,
    },
  }
}

export async function readInstallationHealth(
  q: Queryable,
  clock: Clock,
  sources: InstallationHealthSources,
): Promise<InstallationHealth> {
  const nowMs = clock.nowMs()
  const processes = await liveProcesses(q)
  const tasks = await taskStates(q)
  const dataRead = await liveDataReadWorkers(q)
  const agents = await agentConnections(q)
  const keyringStatus = await sources.keyring()
  const audit = await auditChain(q, tasks, nowMs)

  const components: Component[] = [controlStore(sources, nowMs), workers(processes, nowMs)]
  const unobserved: { component: string; reason: string }[] = []
  for (const [name, result] of [
    ['maintenance', maintenance(tasks, nowMs)],
    ['samplers', samplers(tasks, nowMs)],
  ] as const) {
    if (result.component === undefined) {
      unobserved.push({ component: name, reason: result.unobserved ?? 'not_recorded' })
    } else components.push(result.component)
  }
  components.push(dataReads(dataRead, nowMs))
  const gate = gateway(processes, agents, nowMs)
  if (gate.component === undefined) {
    unobserved.push({ component: 'gateway', reason: gate.unobserved ?? 'not_recorded' })
  } else components.push(gate.component)
  components.push(keyring(keyringStatus, nowMs), audit)
  return {
    state: worst(components.map((c) => c.state)),
    components,
    ...(unobserved.length === 0 ? {} : { unobserved }),
    observedAt: iso(nowMs),
  }
}

import {
  isRetiredNodeCapabilityKey,
  NODE_CAPABILITIES,
  type NodeCapabilityKey,
} from '@exponetdb/contracts'
import type { ControlStore, Tx } from '@exponetdb/control-store'
import { type Clock, isJsonObject, type JsonObject, toJsonValue } from '@exponetdb/kernel'
import { type ChangedBinding, type ExecutionOutcome, leaseHeld } from '@exponetdb/operations'
import type { Keyring } from '@exponetdb/secrets'
import { createJob, DELIVERY_REJECTIONS, judgeJob, type NewJob, sweepJobs } from './jobs.ts'

/**
 * Runs one signed job for a capability operation and says what its end
 * proves ([control-plane.md §9.4](../../../exponetdb-docs/07-node-agent/control-plane.md#94-execution-and-outcomes)).
 * The worker creates the job, waits for it while its operation lease is
 * renewed, judges the node's statement itself, and never assumes more than
 * the statement proves.
 */
export interface RunnerDeps {
  readonly store: ControlStore
  readonly keyring: Keyring
  readonly clock: Clock
  readonly installationId: string
  /** Pause between two looks at a job (default 250 ms). */
  readonly pollMs?: number
}

/** Read and plan jobs live 5 minutes, apply jobs 15. */
export const READ_JOB_SECONDS = 5 * 60
export const APPLY_JOB_SECONDS = 15 * 60

export type JobEnd =
  /** The node ran it and signed a result that matches the capability's schema. */
  | { readonly end: 'succeeded'; readonly jobId: string; readonly result: JsonObject }
  /** The node ran it and reported a failure; `effectBegan` says whether the host may have changed. */
  | {
      readonly end: 'failed'
      readonly jobId: string
      readonly effectBegan: boolean
      readonly precondition: boolean
    }
  /** The node refused the job itself; it did not run. */
  | { readonly end: 'rejected'; readonly jobId: string; readonly reason: string }
  /** Canceled before it started (by a revocation when `revoked`). */
  | { readonly end: 'canceled'; readonly jobId: string; readonly revoked: boolean }
  /** Never started within its window. */
  | { readonly end: 'expired'; readonly jobId: string }
  /** Nothing is proven: no valid signature, a delivery rejection, a result outside its schema, a lost lease. */
  | { readonly end: 'unproven'; readonly jobId: string; readonly why: string }
  /**
   * Never created: what authorized the operation no longer holds where the
   * job would have been created (the re-admission, correction review of F2).
   */
  | { readonly end: 'stale'; readonly jobId: ''; readonly changed: readonly string[] }

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

/**
 * Signs and stores a job in its own transaction; returns its id, or
 * `undefined` when `leaseOwner` no longer holds the operation's lease (an
 * executor that lost it creates nothing, so reconciliation sees every job
 * the operation will ever have; §9.4).
 */
export async function startJob(
  deps: RunnerDeps,
  job: NewJob,
  leaseOwner: string,
): Promise<string | undefined>
export async function startJob(
  deps: RunnerDeps,
  job: NewJob,
  leaseOwner: string,
  readmit: Readmission | undefined,
): Promise<string | undefined | { readonly stale: readonly string[] }>
export async function startJob(
  deps: RunnerDeps,
  job: NewJob,
  leaseOwner: string,
  readmit?: Readmission,
): Promise<string | undefined | { readonly stale: readonly string[] }> {
  return deps.store.transaction('nodes.runner.create', async (tx) => {
    if (!(await leaseHeld(tx, job.operationId, leaseOwner))) {
      return undefined
    }
    if (readmit !== undefined) {
      const changed = await readmit(tx)
      if (changed.length > 0) {
        return { stale: changed.map((c) => c.binding) }
      }
    }
    return (await createJob(tx, deps.keyring, deps.clock, deps.installationId, job)).jobId
  })
}

/** The dispatch admission checked again where an apply job is created. */
export type Readmission = (tx: Tx) => Promise<readonly ChangedBinding[]>

/**
 * What a judged, stored completion proves (§9.4). `stored` is the job's own
 * capability when it differs from `capability`: a job of a major the Wave 5
 * correction retired (F1) is quarantined, its statement never read; it proves
 * nothing (`unproven`), and reconciliation decides from the host.
 */
export async function judgedEnd(
  deps: RunnerDeps,
  jobId: string,
  capability: NodeCapabilityKey,
  stored: string = capability,
): Promise<JobEnd | undefined> {
  if (stored !== capability) {
    if (!isRetiredNodeCapabilityKey(stored)) {
      return { end: 'unproven', jobId, why: 'capability' }
    }
    const { rows } = await deps.store.query(
      'nodes.runner.stated',
      'SELECT completion IS NOT NULL AS stated FROM nodes.jobs WHERE job_id = $1',
      [jobId],
    )
    return rows[0]?.bool('stated') === true
      ? { end: 'unproven', jobId, why: 'quarantined' }
      : undefined
  }
  const valid = await judgeJob(deps.store, deps.installationId, jobId)
  if (valid === undefined) {
    return undefined
  }
  if (!valid) {
    return { end: 'unproven', jobId, why: 'signature' }
  }
  const { rows } = await deps.store.query(
    'nodes.runner.completion',
    'SELECT completion FROM nodes.jobs WHERE job_id = $1',
    [jobId],
  )
  const parsed = toJsonValue(rows[0]?.json('completion'))
  const completion = parsed.ok && isJsonObject(parsed.value) ? parsed.value : undefined
  if (completion === undefined) {
    return { end: 'unproven', jobId, why: 'completion' }
  }
  const definition = NODE_CAPABILITIES[capability]
  switch (completion['outcome']) {
    case 'succeeded': {
      const result = completion['result']
      return isJsonObject(result) && definition.result.safeParse(result).success
        ? { end: 'succeeded', jobId, result }
        : { end: 'unproven', jobId, why: 'schema' }
    }
    case 'failed': {
      const steps = Array.isArray(completion['steps']) ? completion['steps'] : []
      const effect = definition.effectStep
      const effectBegan =
        effect !== null && steps.some((s) => isJsonObject(s) && s['name'] === effect)
      const excerpt = completion['outputExcerpt']
      return {
        end: 'failed',
        jobId,
        effectBegan,
        precondition: typeof excerpt === 'string' && excerpt.startsWith('precondition_failed'),
      }
    }
    case 'rejected': {
      const reason = completion['rejectionReason']
      return typeof reason !== 'string' || DELIVERY_REJECTIONS.has(reason)
        ? { end: 'unproven', jobId, why: 'delivery_rejection' }
        : { end: 'rejected', jobId, reason }
    }
    case 'canceled':
      return { end: 'canceled', jobId, revoked: false }
    default:
      return { end: 'unproven', jobId, why: 'completion' }
  }
}

/**
 * Waits for a job's end. Pending or dispatched past its window, or running
 * past its lease, the job is swept (expired, outcome unknown); an aborted
 * signal (the operation's lease is lost) proves nothing.
 */
export async function awaitJob(
  deps: RunnerDeps,
  jobId: string,
  capability: NodeCapabilityKey,
  signal: AbortSignal,
  stored: string = capability,
): Promise<JobEnd> {
  for (;;) {
    if (signal.aborted) {
      return { end: 'unproven', jobId, why: 'lease_lost' }
    }
    const { rows } = await deps.store.query(
      'nodes.runner.job',
      `SELECT j.state, j.expires_at, j.lease_expires_at, j.first_dispatched_at,
              j.completion IS NOT NULL AS stated, n.state AS node_state
         FROM nodes.jobs j JOIN nodes.nodes n USING (node_id) WHERE j.job_id = $1`,
      [jobId],
    )
    const row = rows[0]
    if (row === undefined) {
      return { end: 'unproven', jobId, why: 'missing' }
    }
    const now = deps.clock.nowMs()
    const state = row.text('state')
    switch (state) {
      case 'completed':
      case 'expired':
      case 'canceled':
      case 'outcome_unknown': {
        // A node statement, even a late one, is judged over the job's state.
        if (row.bool('stated')) {
          const end = await judgedEnd(deps, jobId, capability, stored)
          if (end !== undefined) {
            return end
          }
          break
        }
        if (state === 'outcome_unknown') {
          return { end: 'unproven', jobId, why: 'outcome_unknown' }
        }
        // Once handed out, only the node's statement proves that a job did
        // not run: the gateway alone wrote this state.
        if (row.dateOrNull('first_dispatched_at') !== null) {
          return { end: 'unproven', jobId, why: 'handed_out' }
        }
        if (state === 'expired') {
          return { end: 'expired', jobId }
        }
        const node = row.text('node_state')
        return { end: 'canceled', jobId, revoked: node === 'revoked' || node === 'decommissioned' }
      }
      case 'running': {
        const lease = row.dateOrNull('lease_expires_at')
        if (lease !== null && lease.getTime() < now) {
          await sweepJobs(deps.store)
          continue
        }
        break
      }
      default:
        if (row.date('expires_at').getTime() < now) {
          await sweepJobs(deps.store)
          continue
        }
    }
    await sleep(deps.pollMs ?? 250, signal)
  }
}

/** Starts a job and waits for its end. */
export async function runJob(
  deps: RunnerDeps,
  job: NewJob,
  signal: AbortSignal,
  leaseOwner: string,
  readmit?: Readmission,
): Promise<JobEnd> {
  if (signal.aborted) {
    return { end: 'unproven', jobId: '', why: 'lease_lost' }
  }
  const jobId = await startJob(deps, job, leaseOwner, readmit)
  if (jobId === undefined) {
    return { end: 'unproven', jobId: '', why: 'lease_lost' }
  }
  if (typeof jobId !== 'string') {
    return { end: 'stale', jobId: '', changed: jobId.stale }
  }
  return awaitJob(deps, jobId, job.capability, signal)
}

/**
 * Waits until nothing about a job can still change the host, before
 * reconciliation judges the host (§9.4). A pending job is canceled; one
 * handed out or running is asked to cancel (the agent honors it before the
 * effect point) and waited for, which ends within its window or its start
 * plus its run limit. An end that proves nothing, or a failure after the
 * effect point, is then waited past by the capability's settle time: from
 * the statement for a stated failure, otherwise from the later of the end
 * and the latest moment the agent could still be running the job. A
 * statement that arrives meanwhile is judged instead.
 */
export async function settleJob(
  deps: RunnerDeps,
  jobId: string,
  capability: NodeCapabilityKey,
  signal: AbortSignal,
  stored: string = capability,
): Promise<JobEnd> {
  await deps.store.query(
    'nodes.runner.cancel_pending',
    `UPDATE nodes.jobs SET state = 'canceled', cancel_requested = true WHERE job_id = $1 AND state = 'pending'`,
    [jobId],
  )
  await deps.store.query(
    'nodes.runner.request_cancel',
    `UPDATE nodes.jobs SET cancel_requested = true
      WHERE job_id = $1 AND state IN ('dispatched', 'running') AND NOT cancel_requested`,
    [jobId],
  )
  const settle = NODE_CAPABILITIES[capability].settleSeconds
  for (;;) {
    const end = await awaitJob(deps, jobId, capability, signal, stored)
    if (end.end === 'unproven' && end.why === 'lease_lost') {
      return end
    }
    const open = end.end === 'unproven' || (end.end === 'failed' && end.effectBegan)
    if (!open) {
      return end
    }
    const { rows } = await deps.store.query(
      'nodes.runner.settled',
      `SELECT CASE WHEN node_signature_valid IS TRUE THEN completed_at
                   ELSE greatest(state_changed_at, coalesce(started_at, expires_at) + make_interval(secs => run_seconds))
              END + make_interval(secs => $2::integer) <= clock_timestamp() AS settled
         FROM nodes.jobs WHERE job_id = $1`,
      [jobId, settle],
    )
    if (rows[0]?.bool('settled') !== false) {
      return end
    }
    await sleep(Math.max(deps.pollMs ?? 250, 1000), signal)
    if (signal.aborted) {
      return { end: 'unproven', jobId, why: 'lease_lost' }
    }
  }
}

const JOB_EXPIRED_REASONS = new Set([
  'expired',
  'not_yet_valid',
  'clock_untrusted',
  'start_unacknowledged',
])

/**
 * The error code of a refused job (§9.4). `precondition_failed` covers an
 * instance that is unmapped, unreachable or has another system identifier:
 * the reason names it, no narrower code is claimed.
 */
export function rejectionCode(reason: string): string {
  if (reason === 'capability_unsupported' || reason === 'capability_disabled') {
    return 'CAPABILITY_UNAVAILABLE'
  }
  return JOB_EXPIRED_REASONS.has(reason) ? 'JOB_EXPIRED' : 'NODE_CAPABILITY_FAILED'
}

/**
 * The operation outcome of a job that did not succeed (§9.4); `undefined`
 * for a success, which the kind turns into `applied` itself.
 */
export function outcomeOf(
  end: JobEnd,
  capability: NodeCapabilityKey,
): ExecutionOutcome | undefined {
  switch (end.end) {
    case 'succeeded':
      return undefined
    case 'failed':
      if (end.effectBegan) {
        return 'unknown'
      }
      return end.precondition
        ? {
            outcome: 'not_applied',
            errorCode: 'PLAN_STALE',
            detail: { changedBindings: ['host_state'], jobId: end.jobId },
          }
        : {
            outcome: 'not_applied',
            errorCode: 'NODE_CAPABILITY_FAILED',
            detail: { capability, jobId: end.jobId },
          }
    case 'rejected':
      return {
        outcome: 'not_applied',
        errorCode: rejectionCode(end.reason),
        detail: { capability, jobId: end.jobId, reason: end.reason },
      }
    case 'canceled':
      return end.revoked
        ? { outcome: 'not_applied', errorCode: 'NODE_REVOKED', detail: { jobId: end.jobId } }
        : 'not_applied'
    case 'expired':
      return { outcome: 'not_applied', errorCode: 'JOB_EXPIRED', detail: { jobId: end.jobId } }
    case 'unproven':
      return 'unknown'
    case 'stale':
      return {
        outcome: 'not_applied',
        errorCode: 'PLAN_STALE',
        detail: { changedBindings: end.changed.join(',') },
      }
  }
}

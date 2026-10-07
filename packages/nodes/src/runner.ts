import { NODE_CAPABILITIES, type NodeCapabilityKey } from '@exponetdb/contracts'
import type { ControlStore } from '@exponetdb/control-store'
import { type Clock, isJsonObject, type JsonObject, toJsonValue } from '@exponetdb/kernel'
import type { ExecutionOutcome } from '@exponetdb/operations'
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

/** Signs and stores a job in its own transaction; returns its id. */
export async function startJob(deps: RunnerDeps, job: NewJob): Promise<string> {
  const created = await deps.store.transaction('nodes.runner.create', (tx) =>
    createJob(tx, deps.keyring, deps.clock, deps.installationId, job),
  )
  return created.jobId
}

/** What a judged, stored completion proves (§9.4). */
export async function judgedEnd(
  deps: RunnerDeps,
  jobId: string,
  capability: NodeCapabilityKey,
): Promise<JobEnd | undefined> {
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
): Promise<JobEnd> {
  for (;;) {
    if (signal.aborted) {
      return { end: 'unproven', jobId, why: 'lease_lost' }
    }
    const { rows } = await deps.store.query(
      'nodes.runner.job',
      `SELECT j.state, j.expires_at, j.lease_expires_at, n.state AS node_state
         FROM nodes.jobs j JOIN nodes.nodes n USING (node_id) WHERE j.job_id = $1`,
      [jobId],
    )
    const row = rows[0]
    if (row === undefined) {
      return { end: 'unproven', jobId, why: 'missing' }
    }
    const now = deps.clock.nowMs()
    switch (row.text('state')) {
      case 'completed': {
        const end = await judgedEnd(deps, jobId, capability)
        if (end !== undefined) {
          return end
        }
        break
      }
      case 'expired':
        return { end: 'expired', jobId }
      case 'canceled': {
        const node = row.text('node_state')
        return { end: 'canceled', jobId, revoked: node === 'revoked' || node === 'decommissioned' }
      }
      case 'outcome_unknown':
        return { end: 'unproven', jobId, why: 'outcome_unknown' }
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
export async function runJob(deps: RunnerDeps, job: NewJob, signal: AbortSignal): Promise<JobEnd> {
  const jobId = await startJob(deps, job)
  return awaitJob(deps, jobId, job.capability, signal)
}

const JOB_EXPIRED_REASONS = new Set([
  'expired',
  'not_yet_valid',
  'clock_untrusted',
  'start_unacknowledged',
])

/** The error code of a refused job (§9.4). */
export function rejectionCode(reason: string): string {
  if (reason === 'precondition_failed') {
    return 'CLUSTER_IDENTITY_MISMATCH'
  }
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
  }
}

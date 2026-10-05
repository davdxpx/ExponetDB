import type { ProcessInstanceId } from '@exponetdb/kernel'
import type { Queryable } from './store.ts'

/**
 * Leases for the worker's background maintenance tasks (partition upkeep,
 * checkpoints, verification, retention). A task runs on one worker at a time:
 * it is claimed with `FOR UPDATE SKIP LOCKED` and a lease; a crashed worker's
 * lease expires and another worker runs the task at its next due time. Tasks
 * are idempotent, so a repeated run after a lost lease is harmless.
 */
const TASK = /^[a-z][a-z0-9_.]{0,63}$/

export function checkTaskName(task: string): string {
  if (!TASK.test(task)) {
    throw new Error('task names are static identifiers')
  }
  return task
}

/** Registers task rows (idempotent); new tasks are due immediately. */
export async function registerTasks(q: Queryable, tasks: readonly string[]): Promise<void> {
  await q.query(
    'maintenance.register',
    `INSERT INTO control.maintenance_tasks (task) SELECT unnest($1::text[]) ON CONFLICT (task) DO NOTHING`,
    [tasks.map(checkTaskName)],
  )
}

/** Claims the most overdue due task among `tasks`, or undefined. */
export async function claimDueTask(
  q: Queryable,
  owner: ProcessInstanceId,
  tasks: readonly string[],
  leaseSeconds: number,
): Promise<string | undefined> {
  const { rows } = await q.query(
    'maintenance.claim',
    `WITH due AS (
       SELECT task FROM control.maintenance_tasks
        WHERE task = ANY($1::text[]) AND next_run_at <= clock_timestamp()
          AND (lease_expires_at IS NULL OR lease_expires_at < clock_timestamp())
        ORDER BY next_run_at, task LIMIT 1 FOR UPDATE SKIP LOCKED)
     UPDATE control.maintenance_tasks t
        SET lease_owner = $2, lease_expires_at = clock_timestamp() + make_interval(secs => $3),
            last_started_at = clock_timestamp()
       FROM due WHERE t.task = due.task
     RETURNING t.task`,
    [tasks.map(checkTaskName), owner, leaseSeconds],
  )
  return rows[0]?.text('task')
}

export type TaskOutcome = 'succeeded' | 'failed' | 'skipped'

/** Ends a run this owner holds; false when the lease was lost meanwhile. */
export async function finishTask(
  q: Queryable,
  task: string,
  owner: ProcessInstanceId,
  outcome: TaskOutcome,
  reason: string | null,
  nextRunInSeconds: number,
): Promise<boolean> {
  const { rowCount } = await q.query(
    'maintenance.finish',
    `UPDATE control.maintenance_tasks
        SET lease_owner = NULL, lease_expires_at = NULL, last_finished_at = clock_timestamp(),
            last_outcome = $3, last_reason = $4,
            consecutive_failures = CASE WHEN $3 = 'failed' THEN consecutive_failures + 1 ELSE 0 END,
            next_run_at = clock_timestamp() + make_interval(secs => $5)
      WHERE task = $1 AND lease_owner = $2`,
    [checkTaskName(task), owner, outcome, reason, nextRunInSeconds],
  )
  return rowCount === 1
}

/** Releases every lease of `owner` without recording a run (graceful shutdown). */
export async function releaseTasks(q: Queryable, owner: ProcessInstanceId): Promise<number> {
  const { rowCount } = await q.query(
    'maintenance.release',
    `UPDATE control.maintenance_tasks SET lease_owner = NULL, lease_expires_at = NULL WHERE lease_owner = $1`,
    [owner],
  )
  return rowCount
}

export interface TaskState {
  readonly task: string
  readonly lastOutcome: TaskOutcome | null
  readonly lastReason: string | null
  readonly lastFinishedAt: Date | null
  readonly consecutiveFailures: number
  readonly nextRunAt: Date
}

export async function taskStates(q: Queryable): Promise<TaskState[]> {
  const { rows } = await q.query(
    'maintenance.states',
    `SELECT task, last_outcome, last_reason, last_finished_at, consecutive_failures, next_run_at
       FROM control.maintenance_tasks ORDER BY task`,
  )
  return rows.map((r) => {
    const outcome = r.textOrNull('last_outcome')
    return {
      task: r.text('task'),
      lastOutcome:
        outcome === 'succeeded' || outcome === 'failed' || outcome === 'skipped' ? outcome : null,
      lastReason: r.textOrNull('last_reason'),
      lastFinishedAt: r.dateOrNull('last_finished_at'),
      consecutiveFailures: r.int('consecutive_failures'),
      nextRunAt: r.date('next_run_at'),
    }
  })
}

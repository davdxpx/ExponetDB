import type { ProcessInstanceId } from '@exponetdb/kernel'
import type { ProcessRoleName } from './roles.ts'
import type { Queryable } from './store.ts'

/**
 * Process heartbeats ([health.md §8](../../../exponetdb-docs/10-observability/health.md#8-control-plane-health)).
 * One row per process instance: id, role, build, start and last heartbeat;
 * no host name or user data. Row-level security lets each login write only
 * rows of its own role, so a compromised `serve` cannot fake a worker's
 * liveness. Times are database times.
 */
export const HEARTBEAT_INTERVAL_MS = 15_000
/** A role without a heartbeat for three intervals is not live (health.md §8: 45 s). */
export const HEARTBEAT_STALE_SECONDS = 45

export interface ProcessInfo {
  readonly processId: ProcessInstanceId
  readonly role: ProcessRoleName
  readonly buildVersion: string
  readonly buildCommit: string
}

export async function registerProcess(q: Queryable, info: ProcessInfo): Promise<void> {
  await q.query(
    'heartbeat.register',
    `INSERT INTO control.process_heartbeats (process_id, role, build_version, build_commit)
     VALUES ($1, $2, $3, $4)`,
    [info.processId, info.role, info.buildVersion, info.buildCommit],
  )
}

/** Writes a heartbeat; false when the row is gone (pruned) or stopped. */
export async function beat(q: Queryable, processId: ProcessInstanceId): Promise<boolean> {
  const { rowCount } = await q.query(
    'heartbeat.beat',
    `UPDATE control.process_heartbeats SET heartbeat_at = clock_timestamp()
      WHERE process_id = $1 AND stopped_at IS NULL`,
    [processId],
  )
  return rowCount === 1
}

export async function markStopped(q: Queryable, processId: ProcessInstanceId): Promise<void> {
  await q.query(
    'heartbeat.stop',
    `UPDATE control.process_heartbeats SET stopped_at = clock_timestamp(), heartbeat_at = clock_timestamp()
      WHERE process_id = $1 AND stopped_at IS NULL`,
    [processId],
  )
}

export interface LiveProcess {
  readonly processId: string
  readonly role: ProcessRoleName
  readonly buildVersion: string
  readonly buildCommit: string
  readonly ageSeconds: number
}

function roleOf(value: string): ProcessRoleName | undefined {
  return value === 'serve' || value === 'worker' || value === 'gateway' ? value : undefined
}

/** Processes with a heartbeat within `withinSeconds`, by database time. */
export async function liveProcesses(
  q: Queryable,
  withinSeconds = HEARTBEAT_STALE_SECONDS,
): Promise<LiveProcess[]> {
  const { rows } = await q.query(
    'heartbeat.live',
    `SELECT process_id, role, build_version, build_commit,
            extract(epoch FROM clock_timestamp() - heartbeat_at)::float8 AS age
       FROM control.process_heartbeats
      WHERE stopped_at IS NULL AND heartbeat_at > clock_timestamp() - make_interval(secs => $1)
      ORDER BY role, process_id`,
    [withinSeconds],
  )
  return rows.flatMap((r) => {
    const role = roleOf(r.text('role'))
    const age = r.json('age')
    return role === undefined
      ? []
      : [
          {
            processId: r.text('process_id'),
            role,
            buildVersion: r.text('build_version'),
            buildCommit: r.text('build_commit'),
            ageSeconds: typeof age === 'number' ? age : Number.NaN,
          },
        ]
  })
}

/**
 * Deletes rows of processes that stopped more than a day ago or have not
 * beaten for seven days (worker only; row-level security enforces the
 * bounds). Bounded per call.
 */
export async function pruneHeartbeats(q: Queryable, limit = 10_000): Promise<number> {
  const { rowCount } = await q.query(
    'heartbeat.prune',
    `DELETE FROM control.process_heartbeats WHERE process_id IN (
       SELECT process_id FROM control.process_heartbeats
        WHERE (stopped_at IS NOT NULL AND stopped_at < clock_timestamp() - interval '1 day')
           OR heartbeat_at < clock_timestamp() - interval '7 days'
        ORDER BY process_id LIMIT $1)`,
    [limit],
  )
  return rowCount
}

import type { Queryable } from '@exponetdb/control-store'
import { OFFLINE_AFTER_MS } from '@exponetdb/nodes'
import type { MetricsRegistry } from '@exponetdb/observability'

/**
 * The operational gauges the worker refreshes from the Control Store (VC-037, self-observability.md
 * §3): what an alert needs and no request or step records by itself. The label values are closed
 * sets, so the series are bounded; nothing here names a target, a person or a cluster.
 */
export const WAITING_OPERATION_STATES = [
  'awaiting_approval',
  'queued',
  'running',
  'verifying',
  'needs_reconciliation',
  'needs_attention',
] as const
export const NODE_STATES = [
  'pending_binding',
  'active',
  'degraded',
  'offline',
  'binding_failed',
  'revoked',
  'decommissioned',
] as const
export const TARGET_HEALTH_STATES = [
  'healthy',
  'degraded',
  'unhealthy',
  'unreachable',
  'unknown',
  'suspended',
] as const

/** Reported when no node has a certificate: the year 2100, so an alert on "soon" never fires on nothing. */
export const NO_CERTIFICATE_TIMESTAMP = 4_102_444_800

export interface OperationalCounts {
  readonly operations: Readonly<Record<string, number>>
  /** Age of the oldest operation that has not started (awaiting approval or queued), 0 for none. */
  readonly oldestWaitingSeconds: number
  readonly nodes: Readonly<Record<string, number>>
  /** When the soonest certificate of a node that can still connect ends (epoch seconds). */
  readonly nodeCertificateNotAfter: number
  readonly targets: Readonly<Record<string, number>>
}

export async function readOperationalCounts(q: Queryable): Promise<OperationalCounts> {
  // One query after the other: the worker's pool is small and this is not on a request's path.
  const ops = await q.query(
    'metrics.operations_by_state',
    `SELECT state, count(*)::int AS n FROM operations.operations
      WHERE state IN ('awaiting_approval', 'queued', 'running', 'verifying', 'needs_reconciliation', 'needs_attention')
      GROUP BY state`,
  )
  const oldest = await q.query(
    'metrics.oldest_waiting',
    `SELECT coalesce(floor(extract(epoch FROM (clock_timestamp() - min(created_at)))), 0)::bigint AS s
       FROM operations.operations WHERE state IN ('awaiting_approval', 'queued')`,
  )
  const nodes = await q.query(
    'metrics.nodes_by_state',
    `SELECT CASE WHEN state IN ('active', 'degraded')
                  AND (last_heartbeat_at IS NULL
                       OR clock_timestamp() - last_heartbeat_at > make_interval(secs => $1::double precision / 1000))
                 THEN 'offline' ELSE state END AS state,
            count(*)::int AS n
       FROM nodes.nodes GROUP BY 1`,
    [OFFLINE_AFTER_MS],
  )
  const cert = await q.query(
    'metrics.node_certificate',
    `SELECT floor(extract(epoch FROM min(certificate_expires_at)))::bigint AS ts
       FROM nodes.nodes WHERE state IN ('pending_binding', 'active', 'degraded')`,
  )
  const targets = await q.query(
    'metrics.targets_by_health',
    `SELECT s.state, count(*)::int AS n FROM observation.target_status s
       JOIN registry.targets t ON t.target_id = s.target_id AND t.state <> 'decommissioned'
      GROUP BY s.state`,
  )
  const counts = (rows: typeof ops.rows) =>
    Object.fromEntries(rows.map((r) => [r.text('state'), r.int('n')]))
  const soonest = cert.rows[0]?.textOrNull('ts')
  return {
    operations: counts(ops.rows),
    oldestWaitingSeconds: Number(oldest.rows[0]?.text('s') ?? 0),
    nodes: counts(nodes.rows),
    nodeCertificateNotAfter:
      soonest === null || soonest === undefined ? NO_CERTIFICATE_TIMESTAMP : Number(soonest),
    targets: counts(targets.rows),
  }
}

/** Registers the gauges once per registry and returns the function that sets them from the counts. */
export function operationalGauges(
  metrics: MetricsRegistry,
): (counts: OperationalCounts, nowMs?: number) => void {
  const operations = metrics.gauge<'state'>(
    'exdb_operations',
    'Operations that have not finished, by state.',
    { state: { values: WAITING_OPERATION_STATES } },
  )
  const oldest = metrics.gauge(
    'exdb_operation_oldest_waiting_seconds',
    'Age of the oldest operation awaiting approval or queued (0 for none).',
    {},
  )
  const nodes = metrics.gauge<'state'>(
    'exdb_nodes',
    'Nodes by state (offline: no recent heartbeat).',
    {
      state: { values: NODE_STATES },
    },
  )
  const certificate = metrics.gauge(
    'exdb_node_certificate_not_after_timestamp_seconds',
    'When the soonest certificate of a node that can connect ends, as a Unix time (the year 2100 when none). Alert on this minus time() below a day.',
    {},
  )
  const refreshed = metrics.gauge(
    'exdb_metrics_refreshed_timestamp_seconds',
    'When the worker last refreshed the operational gauges: alert when it stops advancing, they are then stale.',
    {},
  )
  const targets = metrics.gauge<'state'>('exdb_targets', 'Registered targets by health state.', {
    state: { values: TARGET_HEALTH_STATES },
  })
  return (counts, nowMs = Date.now()) => {
    for (const state of WAITING_OPERATION_STATES)
      operations.set({ state }, counts.operations[state] ?? 0)
    for (const state of NODE_STATES) nodes.set({ state }, counts.nodes[state] ?? 0)
    for (const state of TARGET_HEALTH_STATES) targets.set({ state }, counts.targets[state] ?? 0)
    oldest.set({}, counts.oldestWaitingSeconds)
    certificate.set({}, counts.nodeCertificateNotAfter)
    refreshed.set({}, Math.floor(nowMs / 1000))
  }
}

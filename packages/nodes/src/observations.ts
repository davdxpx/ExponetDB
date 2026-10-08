import type { NodeObservation } from '@exponetdb/contracts'
import type { Queryable } from '@exponetdb/control-store'
import { isJsonObject, type JsonObject, toJsonValue } from '@exponetdb/kernel'

/**
 * Node-signed observations ([control-plane.md §9.2](../../../exponetdb-docs/07-node-agent/control-plane.md#92-observations-nodeinspect)):
 * the succeeded result of one judged read or plan job, written once by the
 * worker (the schema refuses anything else). Plans bind them; they are shown
 * as the node's word with their time.
 */
export interface ObservationRecord {
  readonly jobId: string
  readonly nodeId: string
  readonly clusterId: string | null
  readonly capability: string
  readonly argsHash: string
  readonly operationId: string
  readonly observedAt: Date
  readonly result: JsonObject
}

/** Observations older than this are no basis for a plan (§9.3). */
export const OBSERVATION_MAX_AGE_MS = 10 * 60_000

const COLUMNS =
  'job_id, node_id, cluster_id, capability, args_hash, operation_id, observed_at, result'

function recordOf(row: {
  text(c: string): string
  textOrNull(c: string): string | null
  date(c: string): Date
  json(c: string): unknown
}): ObservationRecord {
  const parsed = toJsonValue(row.json('result'))
  return {
    jobId: row.text('job_id'),
    nodeId: row.text('node_id'),
    clusterId: row.textOrNull('cluster_id'),
    capability: row.text('capability'),
    argsHash: row.text('args_hash'),
    operationId: row.text('operation_id'),
    observedAt: row.date('observed_at'),
    result: parsed.ok && isJsonObject(parsed.value) ? parsed.value : {},
  }
}

/** Records the observation of a succeeded, judged job (worker). */
export async function recordObservation(
  q: Queryable,
  o: Omit<ObservationRecord, 'observedAt'>,
): Promise<void> {
  await q.query(
    'nodes.observations.insert',
    `INSERT INTO nodes.observations (job_id, node_id, cluster_id, capability, args_hash, operation_id, result)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (job_id) DO NOTHING`,
    [
      o.jobId,
      o.nodeId,
      o.clusterId,
      o.capability,
      o.argsHash,
      o.operationId,
      JSON.stringify(o.result),
    ],
  )
}

/** The observation an operation's own job produced, if any. */
export async function observationOfOperation(
  q: Queryable,
  operationId: string,
): Promise<ObservationRecord | undefined> {
  const { rows } = await q.query(
    'nodes.observations.of_operation',
    `SELECT ${COLUMNS} FROM nodes.observations WHERE operation_id = $1 ORDER BY observed_at DESC LIMIT 1`,
    [operationId],
  )
  const row = rows[0]
  return row === undefined ? undefined : recordOf(row)
}

/** The latest observation of a capability for a cluster (and these exact arguments when given). */
export async function latestObservation(
  q: Queryable,
  key: {
    readonly nodeId: string
    readonly clusterId: string | null
    readonly capability: string
    readonly argsHash?: string
    /** Only an observation at most this old by the Control Store's clock. */
    readonly withinMs?: number
  },
): Promise<ObservationRecord | undefined> {
  const { rows } = await q.query(
    'nodes.observations.latest',
    `SELECT ${COLUMNS} FROM nodes.observations
      WHERE node_id = $1 AND capability = $2 AND cluster_id IS NOT DISTINCT FROM $3
        AND ($4::text IS NULL OR args_hash = $4)
        AND ($5::bigint IS NULL OR observed_at > clock_timestamp() - $5::bigint * interval '1 millisecond')
      ORDER BY observed_at DESC LIMIT 1`,
    [key.nodeId, key.capability, key.clusterId, key.argsHash ?? null, key.withinMs ?? null],
  )
  const row = rows[0]
  return row === undefined ? undefined : recordOf(row)
}

/** The latest observation per capability, cluster and arguments of a node (at most 500). */
export async function listObservations(
  q: Queryable,
  nodeId: string,
  filter: { readonly capability?: string; readonly clusterId?: string } = {},
): Promise<NodeObservation[]> {
  const { rows } = await q.query(
    'nodes.observations.list',
    `SELECT * FROM (
       SELECT DISTINCT ON (capability, cluster_id, args_hash) ${COLUMNS}
         FROM nodes.observations
        WHERE node_id = $1 AND ($2::text IS NULL OR capability = $2)
          AND ($3::text IS NULL OR cluster_id = $3)
        ORDER BY capability, cluster_id, args_hash, observed_at DESC) latest
      ORDER BY observed_at DESC LIMIT 500`,
    [nodeId, filter.capability ?? null, filter.clusterId ?? null],
  )
  return rows.map((row) => {
    const o = recordOf(row)
    return {
      capability: o.capability as NodeObservation['capability'],
      clusterId: o.clusterId as NodeObservation['clusterId'],
      argsHash: o.argsHash,
      operationId: o.operationId as NodeObservation['operationId'],
      jobId: o.jobId as NodeObservation['jobId'],
      source: 'agent_reported' as const,
      observedAt: o.observedAt.toISOString(),
      result: o.result,
    }
  })
}

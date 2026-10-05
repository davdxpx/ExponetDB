import { type ControlStore, ControlStoreError, type Queryable } from '@exponetdb/control-store'
import type { Clock } from '@exponetdb/kernel'
import { createCheckpoint } from './checkpoints.ts'
import { appendAuditEvent } from './writer.ts'

/**
 * Audit retention ([data-retention.md §2](../../../exponetdb-docs/02-control-plane/data-retention.md#2-mechanism),
 * [audit.md §4.6](../../../exponetdb-docs/02-control-plane/audit.md#46-retention-purge)).
 *
 * The default is `permanent`: nothing is ever removed. A finite period is
 * never shorter than 400 days (OD-8 keeps the final legal setting open).
 * Audit is partitioned by month; a purge drops whole partitions, oldest
 * first, through `audit.drop_expired_partition`, which only the
 * `exdb_audit_maint` login may call and which refuses (`EXA05`) a partition
 * inside the period, the partition holding the chain head, a partition that
 * is not the oldest, and a partition no exported checkpoint covers. Each drop
 * and its `retention.pruned` event commit in one transaction, and the event
 * records the boundary `(droppedThroughSeq, boundaryHash)` from which
 * verification continues. A purge ends with a `retention` checkpoint of the
 * new head, which the worker exports.
 */
export const AUDIT_RETENTION_SETTING = 'retention.audit'
export const AUDIT_RETENTION_MIN_DAYS = 400
/** One hundred years: the upper bound of a finite period. */
export const AUDIT_RETENTION_MAX_DAYS = 36_500

export type AuditRetention =
  | { readonly kind: 'permanent' }
  | { readonly kind: 'days'; readonly days: number }

export const PERMANENT: AuditRetention = { kind: 'permanent' }

/**
 * Parses the stored setting: the string `"permanent"` or a whole number of
 * days within the bounds. Anything else is `undefined` (the caller refuses
 * to prune: an unreadable retention setting fails closed).
 */
export function parseAuditRetention(value: unknown): AuditRetention | undefined {
  if (value === 'permanent') {
    return PERMANENT
  }
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= AUDIT_RETENTION_MIN_DAYS &&
    value <= AUDIT_RETENTION_MAX_DAYS
  ) {
    return { kind: 'days', days: value }
  }
  return undefined
}

export class AuditRetentionError extends Error {
  override readonly name = 'AuditRetentionError'
  readonly code: 'audit_retention_invalid' | 'audit_retention_refused'
  readonly partition: string | undefined
  constructor(
    code: 'audit_retention_invalid' | 'audit_retention_refused',
    partition?: string,
    options?: { cause?: unknown },
  ) {
    super(
      code === 'audit_retention_invalid'
        ? 'The audit retention setting is not valid; nothing is pruned.'
        : 'The audit partition was not pruned.',
      options,
    )
    this.code = code
    this.partition = partition
  }
}

/** Reads the installation's setting; a missing setting is the default, `permanent`. */
export async function readAuditRetention(q: Queryable): Promise<AuditRetention> {
  const { rows } = await q.query(
    'audit.retention.setting',
    'SELECT value::text AS value FROM control.settings WHERE key = $1',
    [AUDIT_RETENTION_SETTING],
  )
  const row = rows[0]
  if (row === undefined) {
    return PERMANENT
  }
  let value: unknown
  try {
    value = JSON.parse(row.text('value'))
  } catch {
    throw new AuditRetentionError('audit_retention_invalid')
  }
  const parsed = parseAuditRetention(value)
  if (parsed === undefined) {
    throw new AuditRetentionError('audit_retention_invalid')
  }
  return parsed
}

/** Creates the monthly partitions from the current month to `monthsAhead` months ahead. */
export async function ensureAuditPartitions(q: Queryable, monthsAhead = 3): Promise<number> {
  const { rows } = await q.query(
    'audit.partitions.ensure',
    'SELECT audit.ensure_partitions($1::int) AS created',
    [monthsAhead],
  )
  return rows[0]?.int('created') ?? 0
}

export interface AuditPartition {
  readonly partition: string
  readonly lowerBound: Date
  readonly upperBound: Date
}

/** Partitions entirely outside the retention period, oldest first; none when permanent. */
export async function expiredAuditPartitions(
  q: Queryable,
  retention: AuditRetention,
): Promise<readonly AuditPartition[]> {
  if (retention.kind === 'permanent') {
    return []
  }
  const { rows } = await q.query(
    'audit.partitions.expired',
    `SELECT partition, lower_bound, upper_bound FROM audit.partition_inventory
      WHERE upper_bound <= clock_timestamp() - make_interval(days => $1::int)
      ORDER BY lower_bound`,
    [retention.days],
  )
  return rows.map((r) => ({
    partition: r.text('partition'),
    lowerBound: r.date('lower_bound'),
    upperBound: r.date('upper_bound'),
  }))
}

export interface PrunedPartition extends AuditPartition {
  readonly rows: number
  readonly droppedThroughSeq: number | null
  readonly boundaryHash: string | null
  readonly eventSeq: number
}

export interface PruneOptions {
  readonly clock: Clock
  /** Partitions dropped per run (each in its own transaction). */
  readonly maxPartitions?: number
}

export interface PruneReport {
  readonly retention: AuditRetention
  readonly pruned: readonly PrunedPartition[]
  /** Expired partitions left for a later run (limit reached). */
  readonly remaining: number
}

/**
 * `exponetdb audit prune`: drops expired partitions under the
 * `exdb_audit_maint` login. Idempotent: a partition that is gone is not
 * listed again. Stops at the first refusal and reports it as an error;
 * partitions dropped before it stay dropped (each was its own transaction
 * with its own `retention.pruned` event).
 */
export async function pruneAuditPartitions(
  store: ControlStore,
  options: PruneOptions,
): Promise<PruneReport> {
  const retention = await readAuditRetention(store)
  if (retention.kind === 'permanent') {
    return { retention, pruned: [], remaining: 0 }
  }
  const days = retention.days
  const expired = await expiredAuditPartitions(store, retention)
  const limit = Math.max(1, options.maxPartitions ?? 1)
  const pruned: PrunedPartition[] = []
  for (const partition of expired.slice(0, limit)) {
    try {
      pruned.push(
        await store.transaction('audit.retention.prune', async (tx) => {
          const dropped = await tx.query(
            'audit.retention.drop',
            `SELECT dropped_through_seq, boundary_hash, dropped_rows
               FROM audit.drop_expired_partition($1, $2::int)`,
            [partition.partition, days],
          )
          const row = dropped.rows[0]
          if (row === undefined) {
            throw new ControlStoreError('control_store_invalid_result')
          }
          const droppedThroughSeq = row.intOrNull('dropped_through_seq')
          const boundaryHash = row.textOrNull('boundary_hash')
          const rows = row.int('dropped_rows')
          const event = await appendAuditEvent(
            tx,
            {
              action: 'retention.pruned',
              phase: 'completed',
              actor: { kind: 'system', identityId: null, label: 'system:maintenance' },
              refs: {
                ...(droppedThroughSeq === null ? {} : { droppedThroughSeq }),
                ...(boundaryHash === null ? {} : { boundaryHash }),
              },
              result: { status: 'succeeded' },
              changes: {
                class: 'audit',
                partition: partition.partition,
                from: partition.lowerBound.toISOString(),
                to: partition.upperBound.toISOString(),
                rows,
                retentionDays: days,
              },
            },
            { clock: options.clock },
          )
          return { ...partition, rows, droppedThroughSeq, boundaryHash, eventSeq: event.seq }
        }),
      )
    } catch (error) {
      throw new AuditRetentionError('audit_retention_refused', partition.partition, {
        cause: error,
      })
    }
  }
  if (pruned.length > 0) {
    await createCheckpoint(store, 'retention')
  }
  return { retention, pruned, remaining: Math.max(0, expired.length - pruned.length) }
}

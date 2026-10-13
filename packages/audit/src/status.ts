import type { ControlStore, Queryable } from '@exponetdb/control-store'
import { type ChainFailureReason, verifyAuditChain } from './verify.ts'

/**
 * Reads of the audit chain's state for the Web App and the REST API (Wave 8,
 * order §9): the head, the newest checkpoints, the export state per exporter
 * and a bounded verification. Read-only. An exporter is described by its
 * kind and its progress, never by its name: the name of an S3 sink carries
 * the bucket.
 */
export interface ChainHead {
  readonly seq: number
  readonly occurredAt: Date
  readonly hash: string
}

export async function chainHead(q: Queryable): Promise<ChainHead | null> {
  const { rows } = await q.query(
    'audit.status.head',
    'SELECT seq, occurred_at, hash FROM audit.audit_events ORDER BY seq DESC LIMIT 1',
  )
  const row = rows[0]
  return row === undefined
    ? null
    : { seq: row.int('seq'), occurredAt: row.date('occurred_at'), hash: row.text('hash') }
}

export interface CheckpointRead {
  readonly seq: number
  readonly hash: string
  readonly createdAt: Date
  readonly reason: 'scheduled' | 'retention' | 'manual'
}

export async function latestCheckpoints(q: Queryable, limit: number): Promise<CheckpointRead[]> {
  const { rows } = await q.query(
    'audit.status.checkpoints',
    `SELECT seq, hash, created_at, reason FROM audit.audit_chain_checkpoints
      ORDER BY seq DESC LIMIT $1`,
    [Math.min(Math.max(1, Math.trunc(limit)), 100)],
  )
  return rows.map((r) => {
    const reason = r.text('reason')
    return {
      seq: r.int('seq'),
      hash: r.text('hash'),
      createdAt: r.date('created_at'),
      // The table's CHECK allows nothing else.
      reason: reason === 'retention' || reason === 'manual' ? reason : 'scheduled',
    }
  })
}

export type ExportKind = 'file' | 's3' | 'other'

/** The kind of an exporter from its recorded sink name (`file`, `s3.<bucket>`); the name itself is not returned. */
export function exportKind(sink: string): ExportKind {
  if (sink === 'file') return 'file'
  return sink === 's3' || sink.startsWith('s3.') ? 's3' : 'other'
}

export interface ExportSinkRead {
  readonly kind: ExportKind
  readonly lastExportedSeq: number | null
  readonly lastExportedAt: Date | null
  readonly pendingCheckpoints: number
}

/** At most this many exporters are described (the most recently used first). */
export const EXPORT_SINK_LIMIT = 16

/** One entry per exporter that ever recorded an export, most recent first. */
export async function exportSinks(q: Queryable): Promise<ExportSinkRead[]> {
  const { rows } = await q.query(
    'audit.status.sinks',
    `SELECT x.sink, max(x.checkpoint_seq) AS last_seq, max(x.exported_at) AS last_at,
            (SELECT count(*) FROM audit.audit_chain_checkpoints c
              WHERE NOT EXISTS (SELECT 1 FROM audit.checkpoint_exports y
                                 WHERE y.checkpoint_seq = c.seq AND y.sink = x.sink)) AS pending
       FROM audit.checkpoint_exports x
      GROUP BY x.sink
      ORDER BY max(x.exported_at) DESC, x.sink
      LIMIT $1`,
    [EXPORT_SINK_LIMIT],
  )
  return rows.map((r) => ({
    kind: exportKind(r.text('sink')),
    lastExportedSeq: r.intOrNull('last_seq'),
    lastExportedAt: r.dateOrNull('last_at'),
    pendingCheckpoints: r.int('pending'),
  }))
}

/** Events the incremental verification of a request will walk at most; above it nothing is verified. */
export const CHAIN_VERIFY_LIMIT = 10_000

export type BoundedVerification =
  | {
      readonly status: 'verified'
      readonly scope: 'from_checkpoint' | 'full'
      readonly anchorCheckpointSeq: number | null
      readonly fromSeq: number
      readonly throughSeq: number
      readonly verifiedEvents: number
    }
  | {
      readonly status: 'broken'
      readonly scope: 'from_checkpoint' | 'full'
      readonly anchorCheckpointSeq: number | null
      readonly failingSeq: number
      readonly reason: Exclude<ChainFailureReason, 'empty_chain'>
      readonly verifiedEvents: number
    }
  | {
      readonly status: 'not_verified'
      readonly reason: 'too_many_events' | 'empty_chain'
      readonly anchorCheckpointSeq: number | null
      readonly eventsSinceAnchor: number
      readonly limit: number
    }

/**
 * Verifies the chain from the latest checkpoint (the checkpoint must match
 * its event) to the head, read-only, in one repeatable-read transaction like
 * `exponetdb audit verify --from-checkpoint`. The work is bounded: with more
 * than `limit` events since the latest checkpoint (or since the oldest event,
 * when no checkpoint exists) nothing is walked and the answer says so. A full
 * verification is the worker's daily task; its result is not kept.
 */
export async function verifyChainBounded(
  store: ControlStore,
  options: { readonly limit?: number } = {},
): Promise<BoundedVerification> {
  const limit = options.limit ?? CHAIN_VERIFY_LIMIT
  return store.transaction(
    'audit.status.verify',
    async (tx) => {
      const { rows } = await tx.query(
        'audit.status.verify_bounds',
        `SELECT (SELECT max(seq) FROM audit.audit_events) AS head,
                (SELECT min(seq) FROM audit.audit_events) AS oldest,
                (SELECT max(seq) FROM audit.audit_chain_checkpoints) AS checkpoint`,
      )
      const row = rows[0]
      const head = row?.intOrNull('head') ?? null
      const oldest = row?.intOrNull('oldest') ?? null
      const checkpoint = row?.intOrNull('checkpoint') ?? null
      if (head === null || oldest === null) {
        return {
          status: 'not_verified',
          reason: 'empty_chain',
          anchorCheckpointSeq: checkpoint,
          eventsSinceAnchor: 0,
          limit,
        }
      }
      const eventsSinceAnchor =
        checkpoint === null ? head - oldest + 1 : Math.max(0, head - checkpoint)
      if (eventsSinceAnchor > limit) {
        return {
          status: 'not_verified',
          reason: 'too_many_events',
          anchorCheckpointSeq: checkpoint,
          eventsSinceAnchor,
          limit,
        }
      }
      const scope = checkpoint === null ? 'full' : 'from_checkpoint'
      const result = await verifyAuditChain(
        tx,
        checkpoint === null ? {} : { fromCheckpointSeq: checkpoint },
      )
      if (result.ok) {
        return {
          status: 'verified',
          scope,
          anchorCheckpointSeq: checkpoint,
          fromSeq: result.fromSeq,
          throughSeq: result.lastSeq,
          verifiedEvents: result.verifiedEvents,
        }
      }
      if (result.reason === 'empty_chain') {
        return {
          status: 'not_verified',
          reason: 'empty_chain',
          anchorCheckpointSeq: checkpoint,
          eventsSinceAnchor,
          limit,
        }
      }
      return {
        status: 'broken',
        scope,
        anchorCheckpointSeq: checkpoint,
        failingSeq: result.firstFailingSeq,
        reason: result.reason,
        verifiedEvents: result.verifiedEvents,
      }
    },
    { readOnly: true, isolation: 'repeatable read' },
  )
}

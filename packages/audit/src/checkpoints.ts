import type { ControlStore, Queryable } from '@exponetdb/control-store'
import type { InstallationId } from '@exponetdb/kernel'

/**
 * Checkpoints and their off-host export (audit.md §4.4).
 *
 * A checkpoint is the current `(seq, hash)` of the chain, stored in
 * `audit.audit_chain_checkpoints` (the database refuses a pair that does not
 * match an event) and then exported off-host through a
 * {@link CheckpointExporter}. A superuser who rewrites history in the
 * database cannot rewrite exported checkpoints. Checkpoints contain no
 * secrets and no event content.
 *
 * Export failures never block audit writes. They are retried with backoff by
 * the worker, make the self-health `degraded`, and block retention: a
 * partition is dropped only when an exported checkpoint covers it.
 */
export interface Checkpoint {
  readonly seq: number
  readonly hash: string
  readonly createdAt: Date
}

/** The document written off-host for one checkpoint. */
export interface CheckpointDocument {
  readonly format: 'exponetdb.audit-checkpoint/v1'
  readonly installationId: InstallationId
  readonly seq: number
  readonly hash: string
  readonly createdAt: string
}

export interface ExportedCheckpoint {
  /** Where the sink put it (bucket key, file name); never a credential. */
  readonly location: string
}

/** The export boundary. Implementations: a file sink and an S3-compatible sink. */
export interface CheckpointExporter {
  /** Stable sink name recorded with each export, `lower-case`. */
  readonly sink: string
  export(document: CheckpointDocument): Promise<ExportedCheckpoint>
}

export type CheckpointReason = 'scheduled' | 'retention' | 'manual'

/** Records the current chain head as a checkpoint (no-op when it is already one). */
export async function createCheckpoint(
  q: Queryable,
  reason: CheckpointReason,
): Promise<Checkpoint | undefined> {
  await q.query(
    'audit.checkpoint.create',
    `WITH head AS (SELECT seq, hash FROM audit.audit_events ORDER BY seq DESC LIMIT 1)
     INSERT INTO audit.audit_chain_checkpoints (seq, hash, reason)
     SELECT seq, hash, $1 FROM head
     ON CONFLICT (seq) DO NOTHING`,
    [reason],
  )
  const latest = await q.query(
    'audit.checkpoint.latest',
    'SELECT seq, hash, created_at FROM audit.audit_chain_checkpoints ORDER BY seq DESC LIMIT 1',
  )
  const row = latest.rows[0]
  return row === undefined
    ? undefined
    : { seq: row.int('seq'), hash: row.text('hash'), createdAt: row.date('created_at') }
}

export interface ExportRun {
  readonly exported: readonly number[]
  readonly failed: number | undefined
}

/**
 * Exports every checkpoint the sink does not have yet, oldest first, and
 * records each export. Stops at the first failure (the next run retries);
 * a failure is reported, never thrown away.
 */
export async function exportPendingCheckpoints(
  store: ControlStore,
  installationId: InstallationId,
  exporter: CheckpointExporter,
  limit = 100,
): Promise<ExportRun> {
  const { rows } = await store.query(
    'audit.checkpoint.pending',
    `SELECT c.seq, c.hash, to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
       FROM audit.audit_chain_checkpoints c
      WHERE NOT EXISTS (SELECT FROM audit.checkpoint_exports x WHERE x.checkpoint_seq = c.seq AND x.sink = $1)
      ORDER BY c.seq LIMIT $2`,
    [exporter.sink, limit],
  )
  const exported: number[] = []
  for (const row of rows) {
    const seq = row.int('seq')
    let result: ExportedCheckpoint
    try {
      result = await exporter.export({
        format: 'exponetdb.audit-checkpoint/v1',
        installationId,
        seq,
        hash: row.text('hash'),
        createdAt: row.text('created_at'),
      })
    } catch {
      return { exported, failed: seq }
    }
    const location = result.location
    await store.query(
      'audit.checkpoint.exported',
      `INSERT INTO audit.checkpoint_exports (checkpoint_seq, sink, location) VALUES ($1, $2, $3)
       ON CONFLICT (checkpoint_seq, sink) DO NOTHING`,
      [seq, exporter.sink, location.slice(0, 1024)],
    )
    exported.push(seq)
  }
  return { exported, failed: undefined }
}

export interface CheckpointExportState {
  readonly latestCheckpointSeq: number | null
  readonly latestExportedSeq: number | null
  readonly unexported: number
}

export async function checkpointExportState(
  q: Queryable,
  sink: string,
): Promise<CheckpointExportState> {
  const { rows } = await q.query(
    'audit.checkpoint.export_state',
    `SELECT (SELECT max(seq) FROM audit.audit_chain_checkpoints) AS latest,
            (SELECT max(checkpoint_seq) FROM audit.checkpoint_exports WHERE sink = $1) AS exported,
            (SELECT count(*) FROM audit.audit_chain_checkpoints c
              WHERE NOT EXISTS (SELECT FROM audit.checkpoint_exports x WHERE x.checkpoint_seq = c.seq AND x.sink = $1)) AS unexported`,
    [sink],
  )
  const row = rows[0]
  return {
    latestCheckpointSeq: row?.intOrNull('latest') ?? null,
    latestExportedSeq: row?.intOrNull('exported') ?? null,
    unexported: row?.int('unexported') ?? 0,
  }
}

import type { Queryable } from '@exponetdb/control-store'
import type { JsonObject } from '@exponetdb/kernel'

/**
 * The comparison of a target's ledger with the Control Store mirror
 * ([`ledger.md` §5](../../../exponetdb-docs/04-migrations/ledger.md#5-mirror-and-reconciliation)).
 * A row the mirror lacks is healed when an operation of this target wrote
 * it (a crash between the target's commit and the mirror update); every
 * other difference is a divergence: a mirrored row the target no longer
 * has (a restore or a manual delete), a row whose checksum or operation
 * differs from the mirror (tampering or a bug), or a row no operation of
 * this target wrote (a hand-written ledger, or another installation).
 * **[DECIDED]** (verification campaign VC-063) "wrote" means the operation's
 * own progress lists that migration (`migrations.operation_migrations`; the
 * baseline and the import replay write their rows without one): an operation
 * id of this target on a row it never applied is no proof, so a restored store
 * that still holds the operation, or a hand-written row quoting a genuine
 * operation id, is a divergence like any other.
 */
export interface LedgerRowFact {
  readonly migrationId: string
  readonly checksum: string
  readonly operationId: string
}

export interface LedgerDivergence {
  readonly missing: readonly string[]
  readonly checksumDiffers: readonly string[]
  readonly unrecorded: readonly string[]
}

const SHOWN = 16

/** A ledger row in the set of recorded rows: the operation and the migration it wrote together. */
export const recordKey = (operationId: string, migrationId: string): string =>
  `${operationId}\u0000${migrationId}`

export function compareLedger(
  mirror: readonly LedgerRowFact[],
  live: readonly LedgerRowFact[],
  /** The rows (see {@link recordKey}) an operation of this target wrote. */
  recorded: ReadonlySet<string>,
  /** How many ids of each class to keep: a refusal names a few, a reconciliation needs them all. */
  shown = SHOWN,
): LedgerDivergence | null {
  const liveById = new Map(live.map((r) => [r.migrationId, r]))
  const mirrored = new Set(mirror.map((r) => r.migrationId))
  const missing: string[] = []
  const checksumDiffers: string[] = []
  for (const m of mirror) {
    const row = liveById.get(m.migrationId)
    if (row === undefined) missing.push(m.migrationId)
    else if (row.checksum !== m.checksum || row.operationId !== m.operationId) {
      checksumDiffers.push(m.migrationId)
    }
  }
  const unrecorded = live
    .filter(
      (r) => !mirrored.has(r.migrationId) && !recorded.has(recordKey(r.operationId, r.migrationId)),
    )
    .map((r) => r.migrationId)
  if (missing.length + checksumDiffers.length + unrecorded.length === 0) return null
  return {
    missing: missing.slice(0, shown),
    checksumDiffers: checksumDiffers.slice(0, shown),
    unrecorded: unrecorded.slice(0, shown),
  }
}

export function divergenceDetails(d: LedgerDivergence): JsonObject {
  return {
    missing: d.missing.map((id) => id.slice(0, 210)),
    checksumDiffers: d.checksumDiffers.map((id) => id.slice(0, 210)),
    unrecorded: d.unrecorded.map((id) => id.slice(0, 210)),
  }
}

/**
 * What the Control Store holds of a target's mirror (VC-023): nothing yet (no comparison is
 * possible), the rows of this generation, or rows of another generation only. The last is not a
 * fresh start: a bumped generation (a restore) must not switch the check off, and nothing is
 * adopted for it except through `ledger.reconcile`.
 */
export type MirrorState =
  | { readonly kind: 'never' }
  | { readonly kind: 'other_generation'; readonly generation: number }
  | { readonly kind: 'current'; readonly rows: readonly LedgerRowFact[] }

export async function readMirrorState(
  q: Queryable,
  targetId: string,
  generation: number,
): Promise<MirrorState> {
  const { rows: state } = await q.query(
    'migrations.mirror.state_of',
    'SELECT generation FROM migrations.ledger_state WHERE target_id = $1',
    [targetId],
  )
  if (state[0] === undefined) return { kind: 'never' }
  if (state[0].int('generation') !== generation) {
    return { kind: 'other_generation', generation: state[0].int('generation') }
  }
  const { rows } = await q.query(
    'migrations.mirror.rows_of',
    `SELECT migration_id, checksum, operation_id FROM migrations.ledger_mirror
      WHERE target_id = $1 AND generation = $2`,
    [targetId, generation],
  )
  return {
    kind: 'current',
    rows: rows.map((r) => ({
      migrationId: r.text('migration_id'),
      checksum: r.text('checksum'),
      operationId: r.text('operation_id'),
    })),
  }
}

/** The rows of `rows` an operation of this target wrote (see {@link recordKey}). */
export async function recordedRows(
  q: Queryable,
  targetId: string,
  rows: readonly LedgerRowFact[],
): Promise<ReadonlySet<string>> {
  if (rows.length === 0) return new Set()
  const { rows: found } = await q.query(
    'migrations.mirror.recorded_rows',
    `SELECT r.operation_id, r.migration_id
       FROM jsonb_to_recordset($1::jsonb) AS r (operation_id text, migration_id text)
       JOIN operations.operations o ON o.operation_id = r.operation_id
       JOIN operations.plans p ON p.plan_id = o.plan_id
      WHERE p.target_id = $2
        AND (o.kind IN ('migration.baseline', 'migration.import.replay')
             OR EXISTS (SELECT FROM migrations.operation_migrations m
                         WHERE m.operation_id = o.operation_id AND m.migration_id = r.migration_id))`,
    [
      JSON.stringify(
        rows.map((r) => ({ operation_id: r.operationId, migration_id: r.migrationId })),
      ),
      targetId,
    ],
  )
  return new Set(found.map((r) => recordKey(r.text('operation_id'), r.text('migration_id'))))
}

/**
 * The one comparison for status, plan, reconcile and the mirror write (VC-063): `null` when the
 * ledger agrees or the target was never mirrored. At another generation than the mirror's every
 * live row is unadopted.
 */
export async function compareWithMirror(
  q: Queryable,
  targetId: string,
  generation: number,
  live: readonly LedgerRowFact[],
  shown = SHOWN,
): Promise<{ readonly divergence: LedgerDivergence; readonly mirrorRows: number } | null> {
  const state = await readMirrorState(q, targetId, generation)
  if (state.kind === 'never') return null
  if (state.kind === 'other_generation') {
    return live.length === 0
      ? null
      : {
          divergence: {
            missing: [],
            checksumDiffers: [],
            unrecorded: live.map((r) => r.migrationId).slice(0, shown),
          },
          mirrorRows: 0,
        }
  }
  const mirrored = new Set(state.rows.map((r) => r.migrationId))
  const recorded = await recordedRows(
    q,
    targetId,
    live.filter((r) => !mirrored.has(r.migrationId)),
  )
  const divergence = compareLedger(state.rows, live, recorded, shown)
  return divergence === null ? null : { divergence, mirrorRows: state.rows.length }
}

/** Compares the live rows with the mirror of the target's generation; `null` when they agree or no mirror exists. */
export async function ledgerDivergence(
  q: Queryable,
  targetId: string,
  generation: number,
  live: readonly LedgerRowFact[],
): Promise<LedgerDivergence | null> {
  return (await compareWithMirror(q, targetId, generation, live))?.divergence ?? null
}

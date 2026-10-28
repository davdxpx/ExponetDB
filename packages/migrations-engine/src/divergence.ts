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

export function compareLedger(
  mirror: readonly LedgerRowFact[],
  live: readonly LedgerRowFact[],
  known: ReadonlySet<string>,
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
    .filter((r) => !mirrored.has(r.migrationId) && !known.has(r.operationId))
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
 * The mirror of one target generation, or `undefined` when the target was
 * never mirrored (no comparison is possible yet).
 */
export async function readMirrorFacts(
  q: Queryable,
  targetId: string,
  generation: number,
): Promise<readonly LedgerRowFact[] | undefined> {
  const { rows: state } = await q.query(
    'migrations.mirror.state_of',
    'SELECT generation FROM migrations.ledger_state WHERE target_id = $1',
    [targetId],
  )
  if (state[0] === undefined || state[0].int('generation') !== generation) return undefined
  const { rows } = await q.query(
    'migrations.mirror.rows_of',
    `SELECT migration_id, checksum, operation_id FROM migrations.ledger_mirror
      WHERE target_id = $1 AND generation = $2`,
    [targetId, generation],
  )
  return rows.map((r) => ({
    migrationId: r.text('migration_id'),
    checksum: r.text('checksum'),
    operationId: r.text('operation_id'),
  }))
}

/** The operation ids among `ids` that an operation planned for this target has. */
export async function operationsOfTarget(
  q: Queryable,
  targetId: string,
  ids: readonly string[],
): Promise<ReadonlySet<string>> {
  if (ids.length === 0) return new Set()
  const { rows } = await q.query(
    'migrations.mirror.known_operations',
    `SELECT o.operation_id FROM operations.operations o
       JOIN operations.plans p ON p.plan_id = o.plan_id
      WHERE p.target_id = $2
        AND o.operation_id = ANY (ARRAY(SELECT jsonb_array_elements_text($1::jsonb)))`,
    [JSON.stringify([...new Set(ids)]), targetId],
  )
  return new Set(rows.map((r) => r.text('operation_id')))
}

/** Compares the live rows with the mirror of the target's generation; `null` when they agree or no mirror exists. */
export async function ledgerDivergence(
  q: Queryable,
  targetId: string,
  generation: number,
  live: readonly LedgerRowFact[],
): Promise<LedgerDivergence | null> {
  const mirror = await readMirrorFacts(q, targetId, generation)
  if (mirror === undefined) return null
  const mirrored = new Set(mirror.map((r) => r.migrationId))
  const known = await operationsOfTarget(
    q,
    targetId,
    live.filter((r) => !mirrored.has(r.migrationId)).map((r) => r.operationId),
  )
  return compareLedger(mirror, live, known)
}

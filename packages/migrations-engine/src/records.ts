import type { ControlStore, Queryable, Tx } from '@exponetdb/control-store'
import type { JsonObject } from '@exponetdb/kernel'
import { leaseHeld } from '@exponetdb/operations'
import type { LedgerRecord } from '@exponetdb/postgres'
import {
  compareLedger,
  divergenceDetails,
  operationsOfTarget,
  readMirrorFacts,
} from './divergence.ts'
import type { VerificationRun } from './verification.ts'

/**
 * The engine's Control Store records (bundle `migration-engine`): the
 * per-migration progress of an operation, the ledger mirror and the
 * verification mirror. Every write runs in a transaction that first holds
 * the operation's lease row `FOR SHARE` (`leaseHeld`): a worker that lost
 * its lease writes nothing (G6 order §22). The target's ledger stays the
 * truth; the mirror never decides an outcome alone.
 */
export class LeaseLost extends Error {
  override readonly name = 'LeaseLost'
}

export interface Fence {
  readonly store: ControlStore
  readonly operationId: string
  readonly leaseOwner: string
}

/** Runs `fn` in a Control Store transaction only while this worker holds the operation's lease. */
export async function fenced<T>(
  fence: Fence,
  name: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return fence.store.transaction(name, async (tx) => {
    if (!(await leaseHeld(tx, fence.operationId, fence.leaseOwner))) {
      throw new LeaseLost('the operation lease is no longer held')
    }
    return fn(tx)
  })
}

export type ApplyOutcome =
  | 'not_started'
  | 'applied'
  | 'not_applied'
  | 'partially_applied'
  | 'unknown'
export type VerificationOutcome =
  | 'not_applicable'
  | 'pending'
  | 'passed'
  | 'failed'
  | 'partial'
  | 'error'

export interface Progress {
  readonly position: number
  readonly migrationId: string
  readonly name: string
  readonly applyOutcome: ApplyOutcome
  readonly verificationOutcome: VerificationOutcome
  readonly statementIndex: number | null
  readonly sqlstate: string | null
  readonly errorCode: string | null
  readonly gate: JsonObject | null
}

export async function writeProgress(tx: Tx, operationId: string, p: Progress): Promise<void> {
  await tx.query(
    'migrations.progress.upsert',
    `INSERT INTO migrations.operation_migrations
       (operation_id, position, migration_id, name, apply_outcome, verification_outcome, statement_index,
        sqlstate, error_code, gate, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, clock_timestamp())
     ON CONFLICT (operation_id, position) DO UPDATE SET
       apply_outcome = EXCLUDED.apply_outcome, verification_outcome = EXCLUDED.verification_outcome,
       statement_index = EXCLUDED.statement_index, sqlstate = EXCLUDED.sqlstate,
       error_code = EXCLUDED.error_code, gate = EXCLUDED.gate, updated_at = clock_timestamp()`,
    [
      operationId,
      p.position,
      p.migrationId,
      p.name,
      p.applyOutcome,
      p.verificationOutcome,
      p.statementIndex,
      p.sqlstate,
      p.errorCode,
      p.gate === null ? null : JSON.stringify(p.gate),
    ],
  )
}

export async function readProgress(q: Queryable, operationId: string): Promise<Progress[]> {
  const { rows } = await q.query(
    'migrations.progress.read',
    `SELECT position, migration_id, name, apply_outcome, verification_outcome, statement_index, sqlstate,
            error_code, gate
       FROM migrations.operation_migrations WHERE operation_id = $1 ORDER BY position`,
    [operationId],
  )
  return rows.map((r) => {
    const gate = r.json('gate')
    return {
      position: r.int('position'),
      migrationId: r.text('migration_id'),
      name: r.text('name'),
      applyOutcome: r.text('apply_outcome') as ApplyOutcome,
      verificationOutcome: r.text('verification_outcome') as VerificationOutcome,
      statementIndex: r.intOrNull('statement_index'),
      sqlstate: r.textOrNull('sqlstate'),
      errorCode: r.textOrNull('error_code'),
      gate:
        typeof gate === 'object' && gate !== null && !Array.isArray(gate)
          ? (gate as JsonObject)
          : null,
    }
  })
}

/** Writes one ledger row to the mirror; a mirrored row only has its revert recorded again. */
export async function insertMirrorRow(
  tx: Tx,
  targetId: string,
  generation: number,
  r: LedgerRecord,
): Promise<void> {
  await tx.query(
    'migrations.mirror.upsert',
    `INSERT INTO migrations.ledger_mirror
       (target_id, generation, migration_id, origin, name, checksum, verify_digest, rollback_digest,
        applied_seq, applied_at, operation_id, plan_id, fingerprint_before, fingerprint_after,
        reverted_at, reverted_by_op)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::bigint, $10::timestamptz, $11, $12, $13, $14,
             $15::timestamptz, $16)
     ON CONFLICT (target_id, generation, migration_id) DO UPDATE SET
       reverted_at = EXCLUDED.reverted_at, reverted_by_op = EXCLUDED.reverted_by_op,
       mirrored_at = clock_timestamp()`,
    [
      targetId,
      generation,
      r.migrationId,
      r.origin,
      r.name.slice(0, 200),
      r.checksum.slice(0, 200),
      r.verifyDigest,
      r.rollbackDigest,
      r.appliedSeq,
      r.appliedAt,
      r.operationId,
      r.planId,
      r.fingerprintBefore,
      r.fingerprintAfter,
      r.revertedAt,
      r.revertedByOp,
    ],
  )
}

/**
 * Mirrors the target's ledger rows of one generation and its state hash
 * (ledger.md §5). Only rows an operation of this target wrote are added; a
 * mirrored row is never rewritten (only its revert is recorded), so a
 * changed checksum stays visible. What differs is recorded as the
 * divergence the worker saw; plans compare live again.
 */
export async function writeMirror(
  tx: Tx,
  input: {
    readonly targetId: string
    readonly generation: number
    readonly rows: readonly LedgerRecord[]
    readonly ledgerStateHash: string
    readonly baselineId: string | null
  },
): Promise<void> {
  const mirror = (await readMirrorFacts(tx, input.targetId, input.generation)) ?? []
  const mirrored = new Set(mirror.map((r) => r.migrationId))
  const known = await operationsOfTarget(
    tx,
    input.targetId,
    input.rows.filter((r) => !mirrored.has(r.migrationId)).map((r) => r.operationId),
  )
  const divergence = compareLedger(mirror, input.rows, known)
  for (const r of input.rows) {
    if (!mirrored.has(r.migrationId) && !known.has(r.operationId)) continue
    await insertMirrorRow(tx, input.targetId, input.generation, r)
  }
  await tx.query(
    'migrations.mirror.state',
    `INSERT INTO migrations.ledger_state
       (target_id, generation, ledger_state_hash, baseline_id, observed_at, divergent, divergence)
     VALUES ($1, $2, $3, $4, clock_timestamp(), $5, $6::jsonb)
     ON CONFLICT (target_id) DO UPDATE SET generation = EXCLUDED.generation,
       ledger_state_hash = EXCLUDED.ledger_state_hash, baseline_id = EXCLUDED.baseline_id,
       observed_at = EXCLUDED.observed_at, divergent = EXCLUDED.divergent,
       divergence = EXCLUDED.divergence`,
    [
      input.targetId,
      input.generation,
      input.ledgerStateHash,
      input.baselineId,
      divergence !== null,
      divergence === null ? null : JSON.stringify(divergenceDetails(divergence)),
    ],
  )
}

export async function writeVerificationMirror(
  tx: Tx,
  input: { readonly targetId: string; readonly generation: number; readonly operationId: string },
  run: VerificationRun,
): Promise<void> {
  await tx.query(
    'migrations.mirror.verification',
    `INSERT INTO migrations.verification_mirror
       (verification_id, target_id, generation, migration_id, operation_id, verify_digest, status,
        started_at, finished_at, structural, runtime, engine, fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10::jsonb, $11::jsonb, $12::jsonb, $13)
     ON CONFLICT (verification_id) DO NOTHING`,
    [
      run.verificationId,
      input.targetId,
      input.generation,
      run.migrationId,
      input.operationId,
      run.verifyDigest,
      run.status,
      run.startedAt,
      run.finishedAt,
      JSON.stringify(run.structural),
      JSON.stringify(run.runtime),
      JSON.stringify(run.engine),
      run.fingerprint,
    ],
  )
}

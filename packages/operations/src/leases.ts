import type { ControlStore, Queryable } from '@exponetdb/control-store'
import type { Clock, ProcessInstanceId } from '@exponetdb/kernel'
import { WORKER_ACTOR } from './actors.ts'
import {
  OPERATION_COLUMNS,
  type OperationRecord,
  operationFromRow,
  transitionOperation,
} from './transitions.ts'

/**
 * Worker leases ([operations-engine.md §4.2](../../../exponetdb-docs/02-control-plane/operations-engine.md#42-workers-and-leases)).
 * A worker claims one operation with `FOR UPDATE SKIP LOCKED` and holds a
 * lease (30 s, renewed every 10 s). A lease that expires is taken over by
 * another worker, which **never continues blindly**: a `running` operation
 * whose worker vanished goes to `needs_reconciliation` (outcome unknown) in
 * the same transaction as the takeover, and the kind's `reconcile` decides
 * what happened. A worker that loses its lease can no longer make any
 * transition (`operation_lease_lost`).
 */
export const LEASE_MS = 30_000
export const LEASE_RENEW_MS = 10_000

export type NextStep = 'start' | 'reconcile' | 'verify'

export interface Claim {
  readonly operation: OperationRecord
  readonly next: NextStep
  /** A previous worker's lease expired; this worker took over. */
  readonly takenOver: boolean
}

export interface ClaimOptions {
  readonly workerId: ProcessInstanceId
  /** Kinds this worker can run; operations of other kinds are left alone. */
  readonly kinds: readonly string[]
  readonly clock: Clock
  readonly leaseMs?: number
}

export async function claimNextOperation(
  store: ControlStore,
  options: ClaimOptions,
): Promise<Claim | undefined> {
  if (options.kinds.length === 0) {
    return undefined
  }
  const leaseMs = options.leaseMs ?? LEASE_MS
  return store.transaction('operations.lease.claim', async (tx) => {
    const { rows } = await tx.query(
      'operations.lease.candidate',
      `SELECT ${OPERATION_COLUMNS}, lease_expires_at
         FROM operations.operations
        WHERE state IN ('queued', 'running', 'verifying', 'needs_reconciliation')
          AND (lease_expires_at IS NULL OR lease_expires_at < clock_timestamp())
          AND kind = ANY($1::text[])
        ORDER BY created_at, operation_id
        LIMIT 1
          FOR UPDATE SKIP LOCKED`,
      [options.kinds],
    )
    const row = rows[0]
    if (row === undefined) {
      return undefined
    }
    const before = operationFromRow(row)
    const takenOver = before.leaseOwner !== null
    const leased = await tx.query(
      'operations.lease.acquire',
      `UPDATE operations.operations
          SET lease_owner = $2, lease_expires_at = clock_timestamp() + make_interval(secs => $3::double precision / 1000),
              attempt = attempt + 1
        WHERE operation_id = $1
        RETURNING ${OPERATION_COLUMNS}`,
      [before.operationId, options.workerId, leaseMs],
    )
    await tx.query(
      'operations.event.lease',
      `INSERT INTO operations.operation_events (operation_id, kind, from_state, to_state, detail)
       VALUES ($1, $2, $3, $3, jsonb_build_object('worker', $4::text, 'previousWorker', $5::text))`,
      [
        before.operationId,
        takenOver ? 'lease_taken_over' : 'lease_acquired',
        before.state,
        options.workerId,
        before.leaseOwner,
      ],
    )
    const leasedRow = leased.rows[0]
    if (leasedRow === undefined) {
      return undefined
    }
    let operation = operationFromRow(leasedRow)
    if (operation.state === 'running') {
      // The previous worker vanished mid-execution: the outcome is unknown.
      operation = await transitionOperation(
        tx,
        {
          operationId: operation.operationId,
          from: 'running',
          to: 'needs_reconciliation',
          applyOutcome: 'unknown',
          lease: { owner: options.workerId },
          actor: WORKER_ACTOR,
          errorCode: 'OUTCOME_UNKNOWN',
          detail: { reason: 'lease_expired', previousWorker: before.leaseOwner ?? 'none' },
        },
        { clock: options.clock },
      )
    }
    const next: NextStep =
      operation.state === 'queued'
        ? 'start'
        : operation.state === 'verifying'
          ? 'verify'
          : 'reconcile'
    return { operation, next, takenOver }
  })
}

/** Extends the lease; `false` means it was lost and the worker must stop. */
export async function renewLease(
  q: Queryable,
  operationId: string,
  workerId: ProcessInstanceId,
  leaseMs = LEASE_MS,
): Promise<boolean> {
  const { rowCount } = await q.query(
    'operations.lease.renew',
    `UPDATE operations.operations
        SET lease_expires_at = clock_timestamp() + make_interval(secs => $3::double precision / 1000)
      WHERE operation_id = $1 AND lease_owner = $2 AND lease_expires_at > clock_timestamp()`,
    [operationId, workerId, leaseMs],
  )
  return rowCount === 1
}

/** Gives a queued operation back (for example while it waits for a lock). */
export async function releaseQueuedLease(
  q: Queryable,
  operationId: string,
  workerId: ProcessInstanceId,
): Promise<boolean> {
  const { rowCount } = await q.query(
    'operations.lease.release',
    `UPDATE operations.operations SET lease_owner = NULL, lease_expires_at = NULL
      WHERE operation_id = $1 AND lease_owner = $2 AND state = 'queued'`,
    [operationId, workerId],
  )
  return rowCount === 1
}

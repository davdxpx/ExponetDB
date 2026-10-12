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
  /** An operator's request moved the operation from needs_attention to verifying. */
  readonly retried: boolean
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
        WHERE (state IN ('queued', 'running', 'verifying', 'needs_reconciliation')
               -- An operator asked to verify an applied change again (needs_attention to verifying).
               OR (state = 'needs_attention' AND apply_outcome IN ('applied', 'partially_applied')
                   AND EXISTS (SELECT 1 FROM recovery.verification_retries r
                                WHERE r.operation_id = operations.operation_id AND r.started_at IS NULL)))
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
    const retried = operation.state === 'needs_attention'
    if (retried) {
      // The operator's request starts now, once; the change itself never runs again.
      const started = await tx.query(
        'operations.retry.start',
        `UPDATE recovery.verification_retries SET started_at = clock_timestamp()
          WHERE operation_id = $1 AND started_at IS NULL
          RETURNING retry_id, requested_by_identity_id`,
        [operation.operationId],
      )
      const request = started.rows[0]
      operation = await transitionOperation(
        tx,
        {
          operationId: operation.operationId,
          from: 'needs_attention',
          to: 'verifying',
          verificationOutcome: 'pending',
          lease: { owner: options.workerId },
          actor: WORKER_ACTOR,
          detail: {
            reason: 'verification_retry',
            requestedBy: request?.textOrNull('requested_by_identity_id') ?? 'unknown',
          },
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
    return { operation, next, takenOver, retried }
  })
}

/**
 * Whether the worker still holds the operation's lease, checked in the
 * caller's transaction and kept until it ends (`FOR SHARE`: a takeover waits
 * for it). A step that starts work outside the Control Store calls it in the
 * transaction that records the work.
 */
export async function leaseHeld(
  q: Queryable,
  operationId: string,
  owner: string,
): Promise<boolean> {
  const { rows } = await q.query(
    'operations.lease.held',
    `SELECT 1 FROM operations.operations
      WHERE operation_id = $1 AND lease_owner = $2 AND lease_expires_at > clock_timestamp()
        FOR SHARE`,
    [operationId, owner],
  )
  return rows.length > 0
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

/**
 * Records an operator's request to verify an operation in `needs_attention`
 * again ([operations-engine.md §4.1](../../../exponetdb-docs/02-control-plane/operations-engine.md)).
 * serve may not move an operation that started; the worker claims it, starts
 * the request and moves it to `verifying` under its lease. An open request
 * is kept, never doubled.
 */
export async function requestVerificationRetry(
  q: Queryable,
  operationId: string,
  requestedBy: string,
): Promise<void> {
  await q.query(
    'operations.retry.request',
    `INSERT INTO recovery.verification_retries (operation_id, requested_by_identity_id)
     VALUES ($1, $2)
     ON CONFLICT (operation_id) WHERE started_at IS NULL DO NOTHING`,
    [operationId, requestedBy],
  )
}

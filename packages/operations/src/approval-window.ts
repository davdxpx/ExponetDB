import type { Tx } from '@exponetdb/control-store'
import { type Clock, InvariantError, parseId } from '@exponetdb/kernel'
import type { OperationActor } from './actors.ts'
import { transitionOperation } from './transitions.ts'

/**
 * How long an apply request may wait in `awaiting_approval` (VC-057, OD-64,
 * [operations-engine.md §3.3](../../../exponetdb-docs/02-control-plane/operations-engine.md#33-expiry)):
 * four hours from the request. After that an approval is refused
 * (`APPROVAL_EXPIRED`) and the worker cancels the operation; nothing ran.
 * Bindings are re-checked at dispatch anyway; the window bounds how long an
 * unattended request holds a place in the approval queue.
 */
export const APPROVAL_WINDOW_SECONDS = 4 * 3600

/** The SQL test of an operation row (`created_at`) past the window; `$1` is the window in seconds. */
export const PAST_APPROVAL_WINDOW = `created_at <= clock_timestamp() - make_interval(secs => $1::double precision)`

/** Worker job: cancels operations that waited past the window, at most `limit` per transaction. */
export async function expireAwaitingApprovals(
  tx: Tx,
  actor: OperationActor,
  options: { readonly clock: Clock; readonly limit?: number },
): Promise<number> {
  const { rows } = await tx.query(
    'operations.approvals.expire_due',
    `SELECT operation_id FROM operations.operations
      WHERE state = 'awaiting_approval' AND ${PAST_APPROVAL_WINDOW}
      ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
    [APPROVAL_WINDOW_SECONDS, Math.min(Math.max(1, options.limit ?? 1000), 10_000)],
  )
  for (const row of rows) {
    const operationId = parseId('op', row.text('operation_id'))
    if (!operationId.ok) throw new InvariantError('stored operation ids are canonical')
    await transitionOperation(
      tx,
      {
        operationId: operationId.value,
        from: 'awaiting_approval',
        to: 'canceled',
        verificationOutcome: 'not_applicable',
        actor,
        errorCode: 'APPROVAL_EXPIRED',
        detail: { reason: 'approval_window', windowSeconds: APPROVAL_WINDOW_SECONDS },
      },
      { clock: options.clock },
    )
  }
  return rows.length
}

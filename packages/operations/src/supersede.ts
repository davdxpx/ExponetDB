import type { Tx } from '@exponetdb/control-store'
import { type Clock, type OperationId, parseId } from '@exponetdb/kernel'
import { WORKER_ACTOR } from './actors.ts'
import type { OperationKind } from './kinds.ts'
import { expandDomains, heldLocks } from './locks.ts'
import type { PlanRecord } from './plans.ts'
import { OPERATION_COLUMNS, operationFromRow, transitionOperation } from './transitions.ts'

/** A plan names a handful of operations; more is not a recovery. */
const MAX_NAMED = 16

/**
 * The recovery of an operation that needs attention (TC-005, MIG-01,
 * [operations-engine.md §4.1](../../../exponetdb-docs/02-control-plane/operations-engine.md#41-state-machine)).
 * `needs_attention` keeps its exclusivity domains and is never claimed, so a
 * verify revision or a resume plan, the documented recovery, waited for ever
 * behind the operation it was meant to recover. A recovery plan names that
 * operation; when the operation is still in `needs_attention` and holds a
 * domain the recovery needs, it is closed in the transaction that takes the
 * domains, as `verification_failed` (its change was applied, or may have been,
 * and was not verified): its locks go, the audit trail and its events say who
 * superseded it, and the recovery's own plan, which the person accepted, is the
 * authority. An outcome that was `unknown` becomes `partially_applied`, the
 * only finished state that admits work stopped part-way; the event keeps the
 * outcome it had. Nothing is ever re-executed (C-16).
 */
export async function closeSuperseded(
  tx: Tx,
  supersededBy: OperationId,
  kind: OperationKind,
  plan: PlanRecord,
  options: { readonly clock: Clock },
): Promise<void> {
  const named = (kind.supersedes?.(plan) ?? []).slice(0, MAX_NAMED)
  if (named.length === 0) return
  const needed = new Set(expandDomains(kind.exclusivity(plan)))
  for (const text of new Set(named)) {
    const id = parseId('op', text)
    if (!id.ok) continue
    const read = await tx.query(
      'operations.supersede.read',
      `SELECT ${OPERATION_COLUMNS} FROM operations.operations WHERE operation_id = $1 FOR UPDATE`,
      [id.value],
    )
    const row = read.rows[0]
    if (row === undefined) continue
    const target = operationFromRow(row)
    if (target.state !== 'needs_attention') continue
    if (!(await heldLocks(tx, target.operationId)).some((d) => needed.has(d))) continue
    await transitionOperation(
      tx,
      {
        operationId: target.operationId,
        from: 'needs_attention',
        to: 'verification_failed',
        applyOutcome: target.applyOutcome === 'unknown' ? 'partially_applied' : target.applyOutcome,
        verificationOutcome: 'failed',
        actor: WORKER_ACTOR,
        detail: {
          supersededBy,
          previousApplyOutcome: target.applyOutcome,
          previousVerificationOutcome: target.verificationOutcome,
        },
      },
      options,
    )
  }
}

import { approvalsHold } from '@exponetdb/auth'
import type { DispatchAdmission } from '@exponetdb/operations'
import { type RegistryAcceptContext, recheckAtDispatch } from '@exponetdb/registry'

/**
 * The worker's dispatch admission for node and cluster operations (Wave 5
 * correction F2, [operations-engine.md §4](../../../exponetdb-docs/02-control-plane/operations-engine.md)):
 * before such an operation starts, its policy is evaluated again, with the
 * tier the registry derives now, and compared with the plan's decision; and
 * the approvals the plan requires must still hold (`approvalsHold`). An
 * operation accepted before the production rule existed carries a decision
 * without that requirement, so it fails as `PLAN_STALE` and is planned
 * again: nothing runs on a production cluster without an effective
 * approval. The same engine and rules as at acceptance; no second one.
 */
export function nodeDispatchAdmission(
  accept: RegistryAcceptContext,
  kinds: Iterable<string>,
): DispatchAdmission {
  const covered = new Set(kinds)
  return async (tx, plan, operation) => {
    if (!covered.has(plan.kind)) {
      return []
    }
    const recheck = await recheckAtDispatch(tx, accept, plan)
    if (recheck.status === 'stale') {
      return [{ binding: 'policy', actual: recheck.reason }]
    }
    const approval = await approvalsHold(tx, operation.operationId, plan)
    return approval === undefined ? [] : [approval]
  }
}

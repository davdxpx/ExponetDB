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
 * For every kind, a `critical` plan whose actor is not a person through the
 * Web App or the first-party CLI never starts.
 */
export function nodeDispatchAdmission(
  accept: RegistryAcceptContext,
  kinds: Iterable<string>,
): DispatchAdmission {
  const covered = new Set(kinds)
  return async (tx, plan, operation) => {
    // A critical plan runs for a person only, on every tier, whatever its
    // kind (G6 finding A2): an operation accepted before that rule held for
    // `by_plan` kinds is stale here, before anything is dispatched.
    if (
      plan.actionClass === 'critical' &&
      (plan.actor.kind !== 'human' || (plan.actor.client !== 'web' && plan.actor.client !== 'cli'))
    ) {
      return [{ binding: 'actor', actual: 'not_human' }]
    }
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

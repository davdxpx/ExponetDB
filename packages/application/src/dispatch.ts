import {
  type AuthorizationSubjectResolver,
  approvalsHold,
  planAuthorityHolds,
} from '@exponetdb/auth'
import type { Queryable } from '@exponetdb/control-store'
import type { DispatchAdmission } from '@exponetdb/operations'
import { type RegistryAcceptContext, recheckAtDispatch } from '@exponetdb/registry'
import { subjectOf } from './application.ts'

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
 *
 * For the covered kinds the person or service account that applied the plan
 * must still hold its authority (`planAuthorityHolds`: the live role
 * bindings and the applying client's grant), on the plan's subject resolved
 * the way the authorization engine resolves it (`subjects`: the target's
 * product, project and environment, the cluster's tier). A migration operation asks
 * again before each further migration (failure case E27); a revoked
 * authority is `{ binding: 'authorization', actual: 'revoked' }`, which the
 * driver and the engine report as `GRANT_REVOKED`.
 */
export function nodeDispatchAdmission(
  accept: RegistryAcceptContext,
  kinds: Iterable<string>,
  subjects: (q: Queryable) => AuthorizationSubjectResolver,
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
    // The worker's own plans have no identity to re-check.
    if (plan.actor.kind !== 'system') {
      const subject = await subjects(tx).resolve({ kind: 'plan', subject: subjectOf(plan) })
      const authority =
        subject !== undefined &&
        (await planAuthorityHolds(tx, { kind: plan.kind, actor: plan.actor, subject }))
      if (!authority) {
        return [{ binding: 'authorization', actual: 'revoked' }]
      }
    }
    const recheck = await recheckAtDispatch(tx, accept, plan)
    if (recheck.status === 'stale') {
      return [{ binding: 'policy', actual: recheck.reason }]
    }
    const approval = await approvalsHold(tx, operation.operationId, plan)
    return approval === undefined ? [] : [approval]
  }
}

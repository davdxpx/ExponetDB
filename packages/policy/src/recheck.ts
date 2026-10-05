import { decisionRank, sameRequirement } from './engine.ts'
import type { PolicyDecision, Requirement } from './model.ts'

/**
 * Re-evaluation at apply ([policy-engine.md §5](../../../exponetdb-docs/02-control-plane/policy-engine.md#5-policy-configuration)):
 * a stricter current result makes the plan stale (`PLAN_STALE`, binding
 * `policy`); an equal or more permissive one proceeds with the plan's
 * requirements. A plan never becomes more permissive after the fact.
 */
export type Recheck =
  | { readonly status: 'proceed'; readonly requirements: readonly Requirement[] }
  | { readonly status: 'stale'; readonly reason: 'decision_stricter' | 'requirements_added' }

export function recheckDecision(planned: PolicyDecision, current: PolicyDecision): Recheck {
  if (decisionRank(current.decision) > decisionRank(planned.decision)) {
    return { status: 'stale', reason: 'decision_stricter' }
  }
  for (const requirement of current.requirements) {
    if (!planned.requirements.some((p) => sameRequirement(p, requirement))) {
      return { status: 'stale', reason: 'requirements_added' }
    }
  }
  return { status: 'proceed', requirements: planned.requirements }
}

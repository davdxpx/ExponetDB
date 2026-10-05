import type { Tx } from '@exponetdb/control-store'
import { isJsonArray, isJsonObject } from '@exponetdb/kernel'
import {
  type AcceptDependencies,
  acceptPlan,
  type KindRegistry,
  type OperationActor,
  OperationError,
  type OperationRecord,
  type PlanRecord,
} from '@exponetdb/operations'
import {
  type PolicyDecision,
  type Recheck,
  type Requirement,
  recheckDecision,
} from '@exponetdb/policy'
import { releaseAfterCooling } from '../approvals.ts'
import { freshProof, type Principal } from '../authorization/engine.ts'
import { AuthError } from '../errors.ts'
import type { SessionContext } from '../sessions.ts'
import { type AccessPolicyContext, operationActor, reevaluateAccessPlan } from './operations.ts'

/**
 * Applying an access plan (operations-engine.md §3.2): the Operations
 * Engine's `acceptPlan` with the policy recheck of the access kinds and
 * the requirements the request itself can meet. A re-authentication
 * requirement is met by a fresh passkey or TOTP proof of the applying
 * session; approvals are left to the approval flow; anything else (backup,
 * window, break-glass) is unmet in Wave 3A and refuses (fail closed).
 */
export const SERVE_OPERATION_ACTOR: OperationActor = {
  kind: 'system',
  identityId: null,
  label: 'system:serve',
  client: 'system',
  clientId: null,
}

/** The decision recorded in a plan body (only decision and requirements matter for the recheck). */
export function storedDecision(plan: PlanRecord): PolicyDecision | undefined {
  const policy = plan.body['policy']
  if (!isJsonObject(policy)) {
    return undefined
  }
  const decision = policy['decision']
  const list = policy['requirements']
  const version = policy['policyVersion']
  const evaluatedAt = policy['evaluatedAt']
  if (
    (decision !== 'allow' && decision !== 'require' && decision !== 'deny') ||
    !isJsonArray(list) ||
    typeof version !== 'string' ||
    typeof evaluatedAt !== 'string'
  ) {
    return undefined
  }
  const requirements: Requirement[] = []
  for (const item of list) {
    if (!isJsonObject(item)) {
      return undefined
    }
    if (item['kind'] === 'approval' && typeof item['count'] === 'number') {
      requirements.push({ kind: 'approval', count: item['count'], permission: 'plans.approve' })
    } else if (item['kind'] === 'reauth' && typeof item['withinSeconds'] === 'number') {
      requirements.push({ kind: 'reauth', withinSeconds: item['withinSeconds'] })
    } else {
      // An unrecognized requirement makes the plan unusable rather than lighter.
      return undefined
    }
  }
  return {
    decision,
    requirements,
    rules: [],
    overriddenRules: [],
    policyVersion: version,
    evaluatedAt,
  }
}

export function accessAcceptDependencies(
  tx: Tx,
  context: AccessPolicyContext,
  kinds: KindRegistry,
  session: SessionContext,
): AcceptDependencies {
  const principal: Principal = {
    kind: 'human',
    identityId: session.identityId,
    client: 'web',
    session,
  }
  return {
    kinds,
    clock: context.clock,
    systemActor: SERVE_OPERATION_ACTOR,
    async recheckPolicy(plan): Promise<Recheck> {
      const planned = storedDecision(plan)
      const current = await reevaluateAccessPlan(tx, context, plan, {
        identityId: session.identityId,
        reauthAt: session.reauthAt,
      })
      if (planned === undefined || current === undefined) {
        return { status: 'stale', reason: 'decision_stricter' }
      }
      return recheckDecision(planned, current)
    },
    async requirementMet(requirement) {
      return requirement.kind === 'reauth' && freshProof(principal, requirement.withinSeconds)
    },
  }
}

export type ApplyResult =
  | {
      readonly status: 'accepted'
      readonly operation: OperationRecord
      readonly alreadyAccepted: boolean
    }
  | { readonly status: 'refused'; readonly error: OperationError | AuthError }

/**
 * Accepts the plan (first apply) or, for the same actor applying again,
 * releases an operation whose approvals and cooling period are complete.
 */
export async function applyAccessPlan(
  tx: Tx,
  context: AccessPolicyContext,
  kinds: KindRegistry,
  session: SessionContext,
  planId: string,
): Promise<ApplyResult> {
  const result = await acceptPlan(
    tx,
    { planId, actor: operationActor(session) },
    accessAcceptDependencies(tx, context, kinds, session),
  )
  if (result.status !== 'accepted') {
    return result
  }
  if (result.alreadyAccepted && result.operation.state === 'awaiting_approval') {
    try {
      const operation = await releaseAfterCooling(
        tx,
        context,
        session,
        result.operation.operationId,
      )
      return { status: 'accepted', operation, alreadyAccepted: true }
    } catch (error) {
      if (error instanceof AuthError || error instanceof OperationError) {
        return { status: 'refused', error }
      }
      throw error
    }
  }
  return result
}

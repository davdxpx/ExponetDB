import { type ControlStore, EXDB_LOCK_NAMESPACE, lockKey2, type Tx } from '@exponetdb/control-store'
import type { JsonObject } from '@exponetdb/kernel'
import {
  type AcceptDependencies,
  type AcceptResult,
  acceptPlan,
  type KindRegistry,
  type OperationActor,
  type PlanRecord,
  storedPolicyDecision,
  WORKER_ACTOR,
} from '@exponetdb/operations'
import { type Recheck, recheckDecision, type SubjectScope } from '@exponetdb/policy'
import { Body } from './content.ts'
import { planSystemSuspension } from './plans.ts'
import {
  evaluateRegistryPolicy,
  operationActor,
  type RegistryActor,
  type RegistryPolicyContext,
} from './policy.ts'
import { findTarget } from './reads.ts'

/**
 * Applying a registry plan ([operations-engine.md §3.2](../../../exponetdb-docs/02-control-plane/operations-engine.md)):
 * the Operations Engine's `acceptPlan` with the registry's policy recheck
 * (the same rules, current settings; a stricter result makes the plan
 * stale) and the requirements the applying request itself can meet. A
 * re-authentication requirement is met by a re-authentication of the
 * applying person within the window; approvals go through the approval
 * flow; anything else is unmet (fail closed).
 */
export interface RegistryAcceptContext {
  readonly policy: RegistryPolicyContext
  readonly kinds: KindRegistry
  /** The process applying (`system:serve` or `system:worker`), for the stale-plan audit event. */
  readonly systemActor: OperationActor
}

function subjectScope(plan: PlanRecord): SubjectScope {
  const subject = new Body(plan.body['subject'], 'subject')
  const scope: { -readonly [K in keyof SubjectScope]: SubjectScope[K] } = {}
  for (const member of ['productId', 'projectId', 'environmentId', 'targetId'] as const) {
    const value = subject.textOrNull(member)
    if (value !== null) scope[member] = value
  }
  const tier = subject.textOrNull('tier')
  if (tier === 'prod' || tier === 'nonprod') scope.tier = tier
  return scope
}

export function registryAcceptDependencies(
  tx: Tx,
  context: RegistryAcceptContext,
  actor: RegistryActor | 'system',
): AcceptDependencies {
  return {
    kinds: context.kinds,
    clock: context.policy.clock,
    systemActor: context.systemActor,
    async recheckPolicy(plan): Promise<Recheck> {
      const planned = storedPolicyDecision(plan)
      if (planned === undefined) {
        return { status: 'stale', reason: 'decision_stricter' }
      }
      const current = await evaluateRegistryPolicy(tx, context.policy, {
        kind: plan.kind,
        actor,
        subject: subjectScope(plan),
        content: plan.body['content'] ?? null,
      })
      return recheckDecision(planned, current)
    },
    async requirementMet(requirement) {
      if (actor === 'system' || requirement.kind !== 'reauth' || actor.reauthAt === null) {
        return false
      }
      const age = context.policy.clock.nowMs() - Date.parse(actor.reauthAt)
      return Number.isFinite(age) && age >= 0 && age <= requirement.withinSeconds * 1000
    },
  }
}

/** Accepts a registry plan as the person who planned it (`plan.apply`). */
export function applyRegistryPlan(
  tx: Tx,
  context: RegistryAcceptContext,
  actor: RegistryActor,
  planId: string,
): Promise<AcceptResult> {
  return acceptPlan(
    tx,
    { planId: planId as PlanRecord['planId'], actor: operationActor(actor) },
    registryAcceptDependencies(tx, context, actor),
  )
}

export type SystemSuspension = 'planned' | 'already_pending' | 'not_active'

const OPEN_SUSPENSION = `SELECT 1 FROM operations.operations o JOIN operations.plans p ON p.plan_id = o.plan_id
  WHERE p.target_id = $1 AND o.kind = 'target.suspend'
    AND o.state IN ('awaiting_approval', 'queued', 'running', 'verifying', 'needs_reconciliation')`

/**
 * The worker suspends a target whose database no longer carries its
 * identity (health.md §3 `identity_mismatch`): one suspension per target at
 * a time (a per-target lock and the open operation are checked first), so
 * a mismatch seen every 15 seconds plans it once. The Operations Engine
 * executes it like any suspension. Nothing is re-stamped.
 */
export function suspendForIdentityMismatch(
  worker: ControlStore,
  context: RegistryAcceptContext,
  targetId: string,
  observed: JsonObject,
): Promise<SystemSuspension> {
  return worker.transaction('registry.system_suspension', async (tx) => {
    await tx.query(
      'registry.system_suspension.lock',
      'SELECT pg_advisory_xact_lock($1::int, $2::int)',
      [EXDB_LOCK_NAMESPACE, lockKey2(`registry/system-suspension/${targetId}`)],
    )
    const target = await findTarget(tx, targetId)
    if (target === undefined || target.state !== 'active') {
      return 'not_active'
    }
    const open = await tx.query('registry.system_suspension.open', OPEN_SUSPENSION, [targetId])
    if (open.rows.length > 0) {
      return 'already_pending'
    }
    const plan = await planSystemSuspension(tx, context, targetId, 'identity_mismatch', observed)
    const accepted = await acceptPlan(
      tx,
      { planId: plan.planId, actor: WORKER_ACTOR },
      registryAcceptDependencies(tx, context, 'system'),
    )
    if (accepted.status !== 'accepted') {
      throw accepted.error
    }
    return 'planned'
  })
}

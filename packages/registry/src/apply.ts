import { appendAuditEvent } from '@exponetdb/audit'
import {
  type ControlStore,
  EXDB_LOCK_NAMESPACE,
  lockKey2,
  type Queryable,
  type Tx,
} from '@exponetdb/control-store'
import { isJsonArray, isJsonObject, type JsonObject } from '@exponetdb/kernel'
import {
  type AcceptDependencies,
  type AcceptResult,
  acceptPlan,
  type KindRegistry,
  type OperationActor,
  OperationError,
  type PlanRecord,
  readPlan,
  storedPolicyDecision,
  WORKER_ACTOR,
} from '@exponetdb/operations'
import { type Recheck, recheckDecision, type SubjectScope } from '@exponetdb/policy'
import {
  grantUsable,
  planBreakGlass,
  readBreakGlassGrant,
  useBreakGlassGrant,
} from './breakglass.ts'
import { Body } from './content.ts'
import { planSystemSuspension } from './plans.ts'
import {
  evaluateRegistryPolicy,
  operationActor,
  type RegistryActor,
  type RegistryPolicyActor,
  type RegistryPolicyContext,
  recordedPolicyActor,
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
  /**
   * The policy subject of a plan as the registry derives it now, for kinds
   * whose tier comes from resources that can change after planning (the
   * node and cluster kinds, Wave 5 correction F2); undefined keeps the
   * subject the plan recorded.
   */
  readonly liveSubject?: (q: Queryable, plan: PlanRecord) => Promise<SubjectScope | undefined>
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

/**
 * The registry's policy re-check of a stored plan: the same rules with the
 * current settings and, where the composition derives one, the current
 * subject (a stricter result makes the plan stale).
 */
export async function recheckRegistryPolicy(
  q: Queryable,
  context: RegistryAcceptContext,
  plan: PlanRecord,
  actor: RegistryPolicyActor | 'system',
): Promise<Recheck> {
  const planned = storedPolicyDecision(plan)
  if (planned === undefined) {
    return { status: 'stale', reason: 'decision_stricter' }
  }
  const breakGlass = planBreakGlass(plan)
  const current = await evaluateRegistryPolicy(q, context.policy, {
    kind: plan.kind,
    actor,
    subject: (await context.liveSubject?.(q, plan)) ?? subjectScope(plan),
    content: plan.body['content'] ?? null,
    ...(breakGlass === undefined ? {} : { breakGlass }),
  })
  return recheckDecision(planned, current)
}

/**
 * The re-check before an accepted operation starts (the worker's dispatch
 * admission, Wave 5 correction F2): as at acceptance, for the actor the plan
 * recorded.
 */
export function recheckAtDispatch(
  q: Queryable,
  context: RegistryAcceptContext,
  plan: PlanRecord,
): Promise<Recheck> {
  return recheckRegistryPolicy(q, context, plan, recordedPolicyActor(plan.actor))
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
    recheckPolicy: (plan) => recheckRegistryPolicy(tx, context, plan, actor),
    async requirementMet(requirement, plan) {
      if (actor === 'system') {
        return false
      }
      if (requirement.kind === 'break_glass') {
        // The plan's own grant, still the acceptor's, on the plan's target, naming
        // every overridden rule (operations-engine.md §8).
        const breakGlass = planBreakGlass(plan)
        const targetId = subjectScope(plan).targetId
        if (
          breakGlass === undefined ||
          targetId === undefined ||
          !requirement.rules.every((r) => breakGlass.rules.includes(r))
        ) {
          return false
        }
        const grant = await readBreakGlassGrant(tx, breakGlass.grantId)
        // Checked here; the use is counted once the plan is accepted (applyRegistryPlan).
        return (
          grant !== undefined &&
          requirement.rules.every((r) => grant.rules.includes(r)) &&
          grantUsable(grant, actor.identityId, targetId, context.policy.clock.nowMs())
        )
      }
      if (requirement.kind !== 'reauth' || actor.reauthAt === null) {
        return false
      }
      const age = context.policy.clock.nowMs() - Date.parse(actor.reauthAt)
      return Number.isFinite(age) && age >= 0 && age <= requirement.withinSeconds * 1000
    },
  }
}

/**
 * Accepts a registry plan as the person who planned it (`plan.apply`). A
 * plan accepted under a break-glass grant counts one use of it in the same
 * transaction; a use that can no longer be counted (expired, revoked or used
 * up meanwhile) undoes the acceptance.
 */
export async function applyRegistryPlan(
  tx: Tx,
  context: RegistryAcceptContext,
  actor: RegistryActor,
  planId: string,
): Promise<AcceptResult> {
  const result = await acceptPlan(
    tx,
    { planId: planId as PlanRecord['planId'], actor: operationActor(actor) },
    registryAcceptDependencies(tx, context, actor),
  )
  if (result.status !== 'accepted' || result.alreadyAccepted) return result
  const plan = await readPlan(tx, planId)
  const breakGlass = plan === undefined ? undefined : planBreakGlass(plan)
  if (plan === undefined || breakGlass === undefined || !overridesRules(plan)) return result
  const targetId = subjectScope(plan).targetId
  if (
    targetId === undefined ||
    !(await useBreakGlassGrant(tx, breakGlass.grantId, actor.identityId, targetId))
  ) {
    throw new OperationError('BREAK_GLASS_REQUIRED')
  }
  // The operation carries the grant in its audit trail (operations-engine.md §8).
  await appendAuditEvent(
    tx,
    {
      action: 'breakglass.used',
      phase: 'completed',
      actor: {
        kind: 'human',
        identityId: actor.identityId,
        label: actor.label as never,
        reauthAt: actor.reauthAt,
        viaBreakGlass: breakGlass.grantId as never,
      },
      client: { clientId: actor.clientId ?? null, kind: actor.client ?? 'web' },
      subject: { targetId: targetId as never },
      refs: {
        planId: plan.planId,
        planHash: plan.planHash,
        operationId: result.operation.operationId,
      },
      changes: { grantId: breakGlass.grantId, rules: [...breakGlass.rules] },
      result: { status: 'succeeded' },
    },
    { clock: context.policy.clock },
  )
  return result
}

/** Whether the stored decision overrode rules (a `break_glass` requirement). */
function overridesRules(plan: PlanRecord): boolean {
  const policy = plan.body['policy']
  const list = isJsonObject(policy) ? policy['requirements'] : undefined
  return isJsonArray(list) && list.some((r) => isJsonObject(r) && r['kind'] === 'break_glass')
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

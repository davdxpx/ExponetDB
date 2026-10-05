import { appendAuditEvent } from '@exponetdb/audit'
import type { Tx } from '@exponetdb/control-store'
import { type Clock, isJsonArray, isJsonObject, newId } from '@exponetdb/kernel'
import type { Recheck, Requirement } from '@exponetdb/policy'
import { auditActor, auditClient, type OperationActor, sameCaller } from './actors.ts'
import { type ChangedBinding, OperationError } from './errors.ts'
import type { KindRegistry } from './kinds.ts'
import { endPlan, type PlanRecord, readPlan } from './plans.ts'
import { OPERATION_COLUMNS, type OperationRecord, operationFromRow } from './transitions.ts'

/**
 * `apply(planId)` ([operations-engine.md §3.2, §5](../../../exponetdb-docs/02-control-plane/operations-engine.md#5-idempotency)).
 *
 * The plan row is locked first, so concurrent acceptances serialize: the
 * first one consumes the plan and creates the operation (`plan_id` is
 * unique); a repetition by the same actor and client gets the existing
 * operation with `alreadyAccepted`; anyone else gets `PLAN_ALREADY_USED`.
 * Bindings are checked in the documented order; a failing live binding
 * invalidates the plan (persisted, audited) and refuses with `PLAN_STALE`.
 *
 * Returns a result instead of throwing for refusals that change state
 * (invalidation), so the caller commits them; plain refusals change nothing.
 */
export interface AcceptRequest {
  readonly planId: string
  readonly actor: OperationActor
}

export interface AcceptDependencies {
  readonly kinds: KindRegistry
  readonly clock: Clock
  /** The process role detecting a stale plan (`system:serve` or `system:worker`), for its audit event. */
  readonly systemActor: OperationActor
  /** Policy re-evaluation (the engine with current facts and settings), compared with the plan's decision. */
  readonly recheckPolicy: (plan: PlanRecord) => Promise<Recheck>
  /**
   * Requirements other than approvals that the request itself satisfies
   * (re-authentication proof, a valid break-glass grant, a fresh backup).
   * Unmet ones refuse the request; Wave 2 has no source for them, so they
   * stay unmet: fail closed.
   */
  readonly requirementMet?: (requirement: Requirement, plan: PlanRecord) => Promise<boolean>
}

export type AcceptResult =
  | {
      readonly status: 'accepted'
      readonly operation: OperationRecord
      readonly alreadyAccepted: boolean
    }
  | { readonly status: 'refused'; readonly error: OperationError }

const REQUIREMENT_ERRORS = {
  reauth: 'REAUTH_REQUIRED',
  backup: 'BACKUP_REQUIRED',
  maintenance_window: 'MAINTENANCE_WINDOW_REQUIRED',
  break_glass: 'BREAK_GLASS_REQUIRED',
} as const

function planRequirements(plan: PlanRecord): readonly Requirement[] {
  const policy = plan.body['policy']
  const list = isJsonObject(policy) ? policy['requirements'] : undefined
  if (!isJsonArray(list)) {
    return []
  }
  const out: Requirement[] = []
  for (const item of list) {
    const kind = isJsonObject(item) ? item['kind'] : undefined
    if (!isJsonObject(item)) {
      out.push(UNRECOGNIZED)
    } else if (kind === 'approval' && typeof item['count'] === 'number') {
      out.push({ kind: 'approval', count: item['count'], permission: 'plans.approve' })
    } else if (kind === 'reauth' && typeof item['withinSeconds'] === 'number') {
      out.push({ kind: 'reauth', withinSeconds: item['withinSeconds'] })
    } else if (kind === 'backup' && typeof item['newerThan'] === 'string') {
      out.push({ kind: 'backup', newerThan: item['newerThan'], verified: true })
    } else if (kind === 'maintenance_window' && typeof item['windowId'] === 'string') {
      out.push({ kind: 'maintenance_window', windowId: item['windowId'] })
    } else {
      const rules = item['rules']
      out.push(
        kind === 'break_glass' && isJsonArray(rules)
          ? { kind: 'break_glass', rules: rules.filter((r) => typeof r === 'string') }
          : UNRECOGNIZED,
      )
    }
  }
  return out
}

/** An unrecognized requirement can never be met here: it refuses rather than being dropped. */
const UNRECOGNIZED: Requirement = { kind: 'break_glass', rules: ['unrecognized-requirement'] }

async function existingOperation(tx: Tx, planId: string): Promise<OperationRecord | undefined> {
  const { rows } = await tx.query(
    'operations.operation.by_plan',
    `SELECT ${OPERATION_COLUMNS} FROM operations.operations WHERE plan_id = $1`,
    [planId],
  )
  const row = rows[0]
  return row === undefined ? undefined : operationFromRow(row)
}

async function invalidate(
  tx: Tx,
  plan: PlanRecord,
  bindings: readonly ChangedBinding[],
  deps: AcceptDependencies,
): Promise<AcceptResult> {
  await endPlan(tx, plan, 'invalidated', deps.systemActor, {
    clock: deps.clock,
    reason: bindings
      .map((b) => b.binding)
      .join(',')
      .slice(0, 256),
  })
  return {
    status: 'refused',
    error: new OperationError('PLAN_STALE', { changedBindings: bindings }),
  }
}

export async function acceptPlan(
  tx: Tx,
  request: AcceptRequest,
  deps: AcceptDependencies,
): Promise<AcceptResult> {
  const plan = await readPlan(tx, request.planId, true)
  if (plan === undefined) {
    return { status: 'refused', error: new OperationError('PLAN_NOT_FOUND') }
  }
  const sameActor = sameCaller(plan.actor, request.actor)
  if (plan.state === 'consumed') {
    const existing = await existingOperation(tx, plan.planId)
    if (existing !== undefined && sameActor) {
      return { status: 'accepted', operation: existing, alreadyAccepted: true }
    }
    return { status: 'refused', error: new OperationError('PLAN_ALREADY_USED') }
  }
  if (!sameActor) {
    return { status: 'refused', error: new OperationError('PLAN_BINDING_ACTOR') }
  }
  if (plan.state === 'denied') {
    return { status: 'refused', error: new OperationError('PLAN_DENIED') }
  }
  if (plan.state === 'expired') {
    return { status: 'refused', error: new OperationError('PLAN_EXPIRED') }
  }
  if (plan.state !== 'active') {
    return {
      status: 'refused',
      error: new OperationError('PLAN_STALE', {
        changedBindings: [{ binding: 'state', expected: 'active', actual: plan.state }],
      }),
    }
  }
  const clock = await tx.query('operations.clock', 'SELECT clock_timestamp() AS now')
  if (
    (clock.rows[0]?.date('now').getTime() ?? Number.POSITIVE_INFINITY) >= plan.expiresAt.getTime()
  ) {
    return { status: 'refused', error: new OperationError('PLAN_EXPIRED') }
  }
  const kind = deps.kinds.get(plan.kind)
  if (kind === undefined || kind.version !== plan.kindVersion) {
    return { status: 'refused', error: new OperationError('operation_kind_unknown') }
  }
  const changed = await kind.checkBindings(plan)
  if (changed.length > 0) {
    return invalidate(tx, plan, changed, deps)
  }
  const recheck = await deps.recheckPolicy(plan)
  if (recheck.status === 'stale') {
    return invalidate(tx, plan, [{ binding: 'policy', actual: recheck.reason }], deps)
  }
  const requirements = planRequirements(plan)
  for (const requirement of requirements) {
    if (requirement.kind === 'approval') {
      continue
    }
    const met = (await deps.requirementMet?.(requirement, plan)) ?? false
    if (!met) {
      const code = REQUIREMENT_ERRORS[requirement.kind]
      return { status: 'refused', error: new OperationError(code) }
    }
  }
  const awaitingApproval = requirements.some((r) => r.kind === 'approval')
  await endPlan(tx, plan, 'consumed', request.actor, { clock: deps.clock })
  const operationId = newId('op', deps.clock.nowMs())
  const state = awaitingApproval ? 'awaiting_approval' : 'queued'
  const created = await tx.query(
    'operations.operation.insert',
    `INSERT INTO operations.operations
       (operation_id, plan_id, kind, kind_version, state, apply_outcome, verification_outcome,
        actor_kind, actor_id, client_kind, client_id)
     VALUES ($1, $2, $3, $4, $5, 'not_started', $6, $7, $8, $9, $10)
     RETURNING ${OPERATION_COLUMNS}`,
    [
      operationId,
      plan.planId,
      plan.kind,
      plan.kindVersion,
      state,
      kind.verifies ? 'pending' : 'not_applicable',
      request.actor.kind,
      request.actor.identityId,
      request.actor.client,
      request.actor.clientId,
    ],
  )
  const row = created.rows[0]
  if (row === undefined) {
    throw new OperationError('operation_state_changed')
  }
  await tx.query(
    'operations.event.created',
    `INSERT INTO operations.operation_events (operation_id, kind, to_state) VALUES ($1, 'created', $2)`,
    [operationId, state],
  )
  await appendAuditEvent(
    tx,
    {
      action: 'operation.accepted',
      phase: 'accepted',
      actor: auditActor(request.actor),
      client: auditClient(request.actor),
      refs: { planId: plan.planId, planHash: plan.planHash, operationId },
      result: { status: 'succeeded', applyOutcome: 'not_started' },
      changes: { kind: plan.kind, state },
    },
    { clock: deps.clock },
  )
  return { status: 'accepted', operation: operationFromRow(row), alreadyAccepted: false }
}

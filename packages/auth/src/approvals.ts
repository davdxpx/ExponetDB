import { appendAuditEvent } from '@exponetdb/audit'
import {
  type ApprovalQueueItem,
  type ApprovalView,
  type AuditEventInput,
  isActionId,
} from '@exponetdb/contracts'
import { ControlStoreError, type Queryable, type Row, type Tx } from '@exponetdb/control-store'
import {
  type ApprovalId,
  isId,
  isJsonArray,
  isJsonObject,
  newId,
  type OperationId,
} from '@exponetdb/kernel'
import {
  type ChangedBinding,
  type OperationRecord,
  type PlanRecord,
  readOperation,
  readPlan,
  readPolicySettings,
  transitionOperation,
} from '@exponetdb/operations'
import {
  approvalSelfApproval,
  PolicyEngine,
  principalFacts,
  resolveParams,
} from '@exponetdb/policy'
import type { AccessPolicyContext } from './access/operations.ts'
import { operationActor } from './access/operations.ts'
import { humanActor, webClient } from './audit.ts'
import {
  holds,
  INSTALLATION_SUBJECT,
  loadGrants,
  type SubjectChain,
} from './authorization/scope.ts'
import { AuthError } from './errors.ts'
import type { SessionContext } from './sessions.ts'

/**
 * Approvals on the existing state machine (operations-engine.md §6, OD-9
 * resolved 2026-10-05, option a).
 *
 * - An operation whose plan requires approval is created
 *   `awaiting_approval`. A human with `plans.approve` at a scope covering
 *   the plan's subject approves it through a full Web App session with a
 *   passkey or TOTP re-authentication of at most 5 minutes (the central
 *   engine checks it; the Control Store checks it again, EXR01). The
 *   approval names the plan hash the person reviewed; another hash is
 *   another plan.
 * - Agents propose, humans approve: an agent client can never approve
 *   (client kind `web` only), and approving what an agent proposed on
 *   one's behalf is not a self-approval.
 * - A self-approval (the approver is the plan's human actor through the
 *   Web App or CLI) is allowed when `approval.self-approval` allows it and
 *   must be acknowledged explicitly; it is recorded as such and audited as
 *   its own event.
 * - A `critical` self-approval starts a cooling period (default 600 s, a
 *   policy parameter) from the database time of the approval; the
 *   operation stays `awaiting_approval` until the actor applies the
 *   unchanged plan again after it, with a fresh re-authentication of at
 *   most 5 minutes. Only then is it queued.
 * - Other approvals queue the operation as soon as the required number is
 *   reached. A rejection cancels it. Approvals are append-only evidence.
 */
export interface ApprovalOutcome {
  readonly approval: ApprovalView
  readonly operation: OperationRecord
  /** Set while a critical self-approval cools down. */
  readonly notBefore: string | null
}

const TS = (column: string, alias = column) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${alias}`

const APPROVAL_COLUMNS = `approval_id, operation_id, plan_id, plan_hash, approver_identity_id, decision,
  self_approval, cooling_seconds, ${TS('decided_at')}, ${TS('not_before')}`

function approvalFromRow(row: Row): ApprovalView {
  const id = row.text('approval_id')
  const operationId = row.text('operation_id')
  const planId = row.text('plan_id')
  const approver = row.text('approver_identity_id')
  const decision = row.text('decision')
  if (
    !isId('apr', id) ||
    !isId('op', operationId) ||
    !isId('pln', planId) ||
    !isId('idn', approver) ||
    (decision !== 'approved' && decision !== 'rejected')
  ) {
    throw new AuthError('INTERNAL')
  }
  return {
    id,
    operationId,
    planId,
    planHash: row.text('plan_hash'),
    approverIdentityId: approver,
    decision,
    selfApproval: row.bool('self_approval'),
    decidedAt: row.text('decided_at'),
    notBefore: row.text('not_before'),
  }
}

export async function approvalsOf(q: Queryable, operationId: string): Promise<ApprovalView[]> {
  const { rows } = await q.query(
    'auth.approvals.of_operation',
    `SELECT ${APPROVAL_COLUMNS} FROM approvals.plan_approvals WHERE operation_id = $1 ORDER BY decided_at, approval_id`,
    [operationId],
  )
  return rows.map(approvalFromRow)
}

/** The approvals a plan requires (0 when none). */
export function requiredApprovals(plan: PlanRecord): number {
  const policy = plan.body['policy']
  const list = isJsonObject(policy) ? policy['requirements'] : undefined
  if (!isJsonArray(list)) {
    return 0
  }
  let count = 0
  for (const item of list) {
    if (isJsonObject(item) && item['kind'] === 'approval' && typeof item['count'] === 'number') {
      count = Math.max(count, item['count'])
    }
  }
  return count
}

export function isSelfApproval(plan: PlanRecord, session: SessionContext): boolean {
  return (
    plan.actor.kind === 'human' &&
    plan.actor.identityId === session.identityId &&
    (plan.actor.client === 'web' || plan.actor.client === 'cli')
  )
}

async function pendingOperation(
  tx: Tx,
  operationId: OperationId,
): Promise<{ operation: OperationRecord; plan: PlanRecord }> {
  const { rows } = await tx.query(
    'auth.approvals.lock_operation',
    'SELECT 1 FROM operations.operations WHERE operation_id = $1 FOR UPDATE',
    [operationId],
  )
  const operation = rows.length === 0 ? undefined : await readOperation(tx, operationId)
  if (operation === undefined || operation.planId === null) {
    throw new AuthError('OPERATION_NOT_FOUND')
  }
  if (operation.state !== 'awaiting_approval') {
    throw new AuthError('APPROVAL_NOT_PENDING')
  }
  const plan = await readPlan(tx, operation.planId)
  if (plan === undefined) {
    throw new AuthError('OPERATION_NOT_FOUND')
  }
  return { operation, plan }
}

async function selfApprovalParams(
  tx: Queryable,
  context?: AccessPolicyContext,
): Promise<{ readonly allowed: boolean; readonly criticalCoolingSeconds: number }> {
  const params = resolveParams(approvalSelfApproval, await readPolicySettings(tx, {}), {})
  const allowed = params.ok ? params.value['allowed'] : undefined
  const cooling = params.ok ? params.value['criticalCoolingSeconds'] : undefined
  if (
    typeof allowed !== 'boolean' ||
    typeof cooling !== 'number' ||
    !Number.isSafeInteger(cooling) ||
    cooling < 0 ||
    cooling > 86_400
  ) {
    // An unreadable configuration never weakens the rule: no self-approval.
    return { allowed: false, criticalCoolingSeconds: 86_400 }
  }
  void context
  return { allowed, criticalCoolingSeconds: cooling }
}

/**
 * The scope chain an approval must cover: the plan's subject as recorded at
 * planning time from the registry (authorization.md §5: the recorded
 * subject governs, so an approval cannot be widened or narrowed by a later
 * registry change). An installation-wide plan has the empty chain.
 */
export function planSubjectChain(plan: PlanRecord): SubjectChain | undefined {
  const subject = plan.body['subject']
  if (!isJsonObject(subject)) {
    return undefined
  }
  const chain: { -readonly [K in keyof SubjectChain]: SubjectChain[K] } = {}
  for (const member of ['productId', 'projectId', 'environmentId', 'targetId'] as const) {
    const value = subject[member]
    if (value !== undefined) {
      if (typeof value !== 'string') return undefined
      chain[member] = value
    }
  }
  const tier = subject['tier']
  if (tier === 'prod' || tier === 'nonprod') {
    chain.tier = tier
  } else if (tier !== undefined) {
    return undefined
  }
  return Object.keys(chain).length === 0 ? INSTALLATION_SUBJECT : chain
}

/**
 * Whether the approvals a plan requires still hold when its operation is
 * about to start (the worker's dispatch admission, Wave 5 correction F2).
 * An approval counts only when it names the plan's hash, its cooling period
 * is over, its approver still is an active human holding `plans.approve` at
 * a scope covering the plan's subject, and, for a self-approval, the policy
 * still allows self-approvals; a rejection holds the operation back. A plan
 * that requires none holds trivially. The `approval` binding names what is
 * missing; undefined when they hold.
 */
export async function approvalsHold(
  q: Queryable,
  operationId: string,
  plan: PlanRecord,
): Promise<ChangedBinding | undefined> {
  const required = requiredApprovals(plan)
  if (required === 0) {
    return undefined
  }
  const chain = planSubjectChain(plan)
  if (chain === undefined) {
    return { binding: 'approval', actual: 'subject_invalid' }
  }
  const { rows } = await q.query(
    'auth.approvals.at_dispatch',
    `SELECT approver_identity_id, decision, plan_hash, self_approval,
            not_before <= clock_timestamp() AS due
       FROM approvals.plan_approvals WHERE operation_id = $1 AND plan_id = $2
      ORDER BY decided_at, approval_id`,
    [operationId, plan.planId],
  )
  if (rows.some((r) => r.text('decision') === 'rejected')) {
    return { binding: 'approval', actual: 'rejected' }
  }
  const self = await selfApprovalParams(q)
  let held = 0
  for (const row of rows) {
    const approver = row.text('approver_identity_id')
    if (
      row.text('plan_hash') !== plan.planHash ||
      !row.bool('due') ||
      (row.bool('self_approval') && !self.allowed) ||
      !isId('idn', approver)
    ) {
      continue
    }
    if (holds(await loadGrants(q, approver), 'plans.approve', chain)) {
      held += 1
    }
  }
  return held >= Math.max(1, required)
    ? undefined
    : { binding: 'approval', expected: required, actual: held }
}

async function liveApprovals(tx: Tx, operationId: string, plan: PlanRecord): Promise<number> {
  const chain = planSubjectChain(plan)
  if (chain === undefined) {
    return 0
  }
  let count = 0
  for (const approval of await approvalsOf(tx, operationId)) {
    if (approval.decision !== 'approved') {
      continue
    }
    const grants = await loadGrants(tx, approval.approverIdentityId)
    if (holds(grants, 'plans.approve', chain)) {
      count += 1
    }
  }
  return count
}

/**
 * Queues the operation when enough approvals exist and every cooling period
 * has passed (database clock). A cooling self-approval is released only by
 * the actor's apply (`releaseAfterCooling`).
 */
async function releaseIfReady(
  tx: Tx,
  context: AccessPolicyContext,
  operation: OperationRecord,
  plan: PlanRecord,
  session: SessionContext,
  byApply: boolean,
): Promise<{ operation: OperationRecord; notBefore: string | null }> {
  const { rows } = await tx.query(
    'auth.approvals.status',
    `SELECT count(*) FILTER (WHERE decision = 'approved')::int AS approved,
            bool_or(cooling_seconds > 0) AS cooling,
            ${TS("max(not_before) FILTER (WHERE decision = 'approved')", 'not_before')},
            coalesce(bool_or(not_before > clock_timestamp()), false) AS waiting
       FROM approvals.plan_approvals WHERE operation_id = $1`,
    [operation.operationId],
  )
  const row = rows[0]
  // Stale approvals (§38 of the Wave 3A order): only approvals whose approver
  // still is an active human holding `plans.approve` at a scope covering the
  // plan's subject count; a revoked approver's earlier approval does not.
  const approved = await liveApprovals(tx, operation.operationId, plan)
  const cooling = row?.boolOrNull('cooling') === true
  const notBefore = row?.textOrNull('not_before') ?? null
  if (approved < Math.max(1, requiredApprovals(plan))) {
    return { operation, notBefore: null }
  }
  if (cooling && !byApply) {
    return { operation, notBefore }
  }
  if (row?.bool('waiting') === true) {
    if (byApply && notBefore !== null) {
      throw new AuthError('APPROVAL_COOLING_PERIOD', { details: { notBefore } })
    }
    return { operation, notBefore }
  }
  const queued = await transitionOperation(
    tx,
    {
      operationId: operation.operationId,
      from: 'awaiting_approval',
      to: 'queued',
      actor: operationActor(session),
      detail: { approvals: approved, cooled: cooling },
    },
    { clock: context.clock },
  )
  return { operation: queued, notBefore: null }
}

function evaluatePolicy(
  context: AccessPolicyContext,
  session: SessionContext,
  selfApproval: boolean,
  settings: Awaited<ReturnType<typeof readPolicySettings>>,
) {
  return new PolicyEngine({
    registry: context.registry,
    providers: [principalFacts],
    codeVersion: context.codeVersion,
    clock: context.clock,
  }).evaluate({
    request: {
      kind: 'approval.approve',
      principal: {
        kind: 'human',
        identityId: session.identityId,
        client: 'web',
        ...(session.reauthAt === null ? {} : { reauthAt: session.reauthAt }),
      },
      subject: {},
      content: { selfApproval },
    },
    settings,
  })
}

function decisionError(error: unknown): AuthError | undefined {
  if (!(error instanceof ControlStoreError)) {
    return undefined
  }
  if (error.sqlstate === 'EXR01') {
    return new AuthError('REAUTH_REQUIRED')
  }
  if (error.sqlstate === '23505') {
    return new AuthError('APPROVAL_DUPLICATE')
  }
  return undefined
}

async function record(
  tx: Tx,
  context: AccessPolicyContext,
  session: SessionContext,
  plan: PlanRecord,
  operation: OperationRecord,
  decision: 'approved' | 'rejected',
  coolingSeconds: number,
  policyVersion: string,
): Promise<ApprovalView> {
  if (session.reauthEventId === null) {
    throw new AuthError('REAUTH_REQUIRED')
  }
  const approvalId: ApprovalId = newId('apr', context.clock.nowMs())
  try {
    const { rows } = await tx.savepoint((sp) =>
      sp.query(
        'auth.approvals.insert',
        `INSERT INTO approvals.plan_approvals
           (approval_id, operation_id, plan_id, plan_hash, approver_identity_id, approver_session_id,
            approver_client, decision, self_approval, reauth_event_id, cooling_seconds, policy_version,
            decided_at, not_before)
         VALUES ($1, $2, $3, $4, $5, $6, 'web', $7, false, $8, $9, $10, clock_timestamp(),
                 clock_timestamp() + make_interval(secs => $9::int))
         RETURNING ${APPROVAL_COLUMNS}`,
        [
          approvalId,
          operation.operationId,
          plan.planId,
          plan.planHash,
          session.identityId,
          session.sessionId,
          decision,
          session.reauthEventId,
          coolingSeconds,
          policyVersion,
        ],
      ),
    )
    const row = rows[0]
    if (row === undefined) {
      throw new AuthError('INTERNAL')
    }
    return approvalFromRow(row)
  } catch (error) {
    throw decisionError(error) ?? error
  }
}

export async function approve(
  tx: Tx,
  context: AccessPolicyContext,
  session: SessionContext,
  operationId: OperationId,
  input: { readonly planHash: string; readonly acknowledgeSelfApproval?: true | undefined },
): Promise<ApprovalOutcome> {
  const { operation, plan } = await pendingOperation(tx, operationId)
  if (input.planHash !== plan.planHash) {
    throw new AuthError('PLAN_STALE', {
      details: { planId: plan.planId, changedBindings: [{ binding: 'planHash' }] },
    })
  }
  const self = isSelfApproval(plan, session)
  if (self && input.acknowledgeSelfApproval !== true) {
    throw new AuthError('SELF_APPROVAL_UNACKNOWLEDGED')
  }
  const settings = await readPolicySettings(tx, {})
  const decision = await evaluatePolicy(context, session, self, settings)
  if (decision.decision !== 'allow') {
    throw new AuthError('POLICY_DENIED', {
      details: {
        rules: decision.rules
          .filter((r) => r.result === 'fail' || r.result === 'unknown')
          .map((r) => ({
            id: r.id,
            result: r.result,
            severity: r.severity,
            message: r.message,
            overridableByBreakGlass: r.overridableByBreakGlass,
          })),
      },
    })
  }
  const params = await selfApprovalParams(tx, context)
  const cooling = self && plan.actionClass === 'critical' ? params.criticalCoolingSeconds : 0
  const approval = await record(
    tx,
    context,
    session,
    plan,
    operation,
    'approved',
    cooling,
    decision.policyVersion,
  )
  if (approval.selfApproval !== self) {
    // The Control Store decides what a self-approval is; the code must agree.
    throw new AuthError('INTERNAL')
  }
  const audit: Omit<AuditEventInput, 'action' | 'changes'> = {
    phase: 'completed',
    actor: humanActor(session, session.reauthAt),
    client: webClient(session.sessionId),
    refs: {
      operationId: operation.operationId,
      planId: plan.planId,
      planHash: plan.planHash,
      approvalIds: [approval.id],
    },
    decision: {
      decision: decision.decision,
      rules: decision.rules.map((r) => `${r.id}:${r.result}`).slice(0, 128),
      policyVersion: decision.policyVersion,
    },
    result: { status: 'succeeded' },
  }
  await appendAuditEvent(
    tx,
    {
      ...audit,
      action: 'approval.approve',
      changes: { selfApproval: self, coolingSeconds: cooling, actionClass: plan.actionClass },
    },
    { clock: context.clock },
  )
  if (self) {
    await appendAuditEvent(
      tx,
      {
        ...audit,
        action: 'approval.self_approval',
        changes: {
          acknowledged: true,
          coolingSeconds: cooling,
          notBefore: approval.notBefore,
          actionClass: plan.actionClass,
        },
      },
      { clock: context.clock },
    )
  }
  const released = await releaseIfReady(tx, context, operation, plan, session, false)
  return {
    approval,
    operation: released.operation,
    notBefore: cooling > 0 ? approval.notBefore : released.notBefore,
  }
}

export async function reject(
  tx: Tx,
  context: AccessPolicyContext,
  session: SessionContext,
  operationId: OperationId,
  input: { readonly planHash: string },
): Promise<ApprovalOutcome> {
  const { operation, plan } = await pendingOperation(tx, operationId)
  if (input.planHash !== plan.planHash) {
    throw new AuthError('PLAN_STALE', {
      details: { planId: plan.planId, changedBindings: [{ binding: 'planHash' }] },
    })
  }
  const settings = await readPolicySettings(tx, {})
  const decision = await evaluatePolicy(context, session, false, settings)
  const approval = await record(
    tx,
    context,
    session,
    plan,
    operation,
    'rejected',
    0,
    decision.policyVersion,
  )
  const canceled = await transitionOperation(
    tx,
    {
      operationId: operation.operationId,
      from: 'awaiting_approval',
      to: 'canceled',
      actor: operationActor(session),
      errorCode: 'OPERATION_CANCELLED',
      detail: { rejectedBy: session.identityId },
    },
    { clock: context.clock },
  )
  await appendAuditEvent(
    tx,
    {
      action: 'approval.reject',
      phase: 'completed',
      actor: humanActor(session, session.reauthAt),
      client: webClient(session.sessionId),
      refs: {
        operationId: operation.operationId,
        planId: plan.planId,
        planHash: plan.planHash,
        approvalIds: [approval.id],
      },
      result: { status: 'succeeded' },
    },
    { clock: context.clock },
  )
  return { approval, operation: canceled, notBefore: null }
}

/**
 * The actor applies the plan again after a critical self-approval cooled
 * down: the engine already required a fresh re-authentication for the
 * plan's kind; this queues the operation, or refuses with
 * `APPROVAL_COOLING_PERIOD` (details `notBefore`) while it still cools.
 * The proof must be newer than the end of the cooling period (database
 * clock), so the proof given for the approval never also serves the apply,
 * whatever the cooling length; and the self-approval policy is evaluated
 * again, so a self-approval the owner has since forbidden no longer counts.
 */
export async function releaseAfterCooling(
  tx: Tx,
  context: AccessPolicyContext,
  session: SessionContext,
  operationId: OperationId,
): Promise<OperationRecord> {
  const { operation, plan } = await pendingOperation(tx, operationId)
  if (plan.actor.identityId !== session.identityId) {
    throw new AuthError('PLAN_BINDING_ACTOR')
  }
  if (
    (await liveApprovals(tx, operation.operationId, plan)) < Math.max(1, requiredApprovals(plan))
  ) {
    throw new AuthError('APPROVAL_REQUIRED')
  }
  if (
    session.reauthMethod === null ||
    session.reauthMethod === 'recovery_code' ||
    session.reauthAt === null ||
    session.reauthAgeSeconds === null ||
    session.reauthAgeSeconds > 300
  ) {
    throw new AuthError('REAUTH_REQUIRED')
  }
  const { rows } = await tx.query(
    'auth.approvals.self_cooling',
    `SELECT count(*) FILTER (WHERE self_approval)::int AS self,
            coalesce(bool_or(self_approval AND not_before <= clock_timestamp()
                             AND $2::timestamptz <= not_before), false) AS proof_before_end
       FROM approvals.plan_approvals WHERE operation_id = $1 AND decision = 'approved'`,
    [operation.operationId, session.reauthAt],
  )
  if (rows[0]?.bool('proof_before_end') === true) {
    throw new AuthError('REAUTH_REQUIRED')
  }
  if ((rows[0]?.int('self') ?? 0) > 0) {
    const decision = await evaluatePolicy(context, session, true, await readPolicySettings(tx, {}))
    if (decision.decision !== 'allow') {
      throw new AuthError('POLICY_DENIED', {
        details: {
          rules: decision.rules
            .filter((r) => r.result === 'fail' || r.result === 'unknown')
            .map((r) => ({
              id: r.id,
              result: r.result,
              severity: r.severity,
              message: r.message,
              overridableByBreakGlass: r.overridableByBreakGlass,
            })),
        },
      })
    }
  }
  const released = await releaseIfReady(tx, context, operation, plan, session, true)
  if (released.operation.state === 'queued') {
    await appendAuditEvent(
      tx,
      {
        action: 'approval.released',
        phase: 'completed',
        actor: humanActor(session, session.reauthAt),
        client: webClient(session.sessionId),
        refs: { operationId: operation.operationId, planId: plan.planId, planHash: plan.planHash },
        changes: { after: 'cooling_period' },
        result: { status: 'succeeded' },
      },
      { clock: context.clock },
    )
  }
  return released.operation
}

/** Operations awaiting approval that the person may decide on (subject coverage is the caller's filter). */
/**
 * The reviewable content of an access or target plan; other kinds show
 * theirs from their own wave. Registry plans that carry addresses (cluster,
 * endpoint) are not shown here: an approver may hold `plans.approve`
 * without `registry.manage`, the only permission that reads addresses.
 */
function changeOf(plan: PlanRecord): Pick<ApprovalQueueItem, 'change'> {
  const content = plan.body['content']
  const reviewable = plan.kind.startsWith('access.') || plan.kind.startsWith('target.')
  if (!reviewable || content === undefined) {
    return {}
  }
  return { change: { content, analysis: plan.body['analysis'] ?? null } }
}

export async function approvalQueue(
  q: Queryable,
  session: SessionContext,
): Promise<ApprovalQueueItem[]> {
  const { rows } = await q.query(
    'auth.approvals.queue',
    `SELECT o.operation_id, o.plan_id, p.plan_hash, p.kind, p.action_class, p.tier, p.actor_id, p.client_kind,
            ${TS('p.created_at', 'requested_at')}
       FROM operations.operations o JOIN operations.plans p ON p.plan_id = o.plan_id
      WHERE o.state = 'awaiting_approval' ORDER BY p.created_at, o.operation_id`,
  )
  const items: ApprovalQueueItem[] = []
  for (const row of rows) {
    const operationId = row.text('operation_id')
    const planId = row.text('plan_id')
    const plan = await readPlan(q, planId)
    const kind = row.text('kind')
    const cls = row.text('action_class')
    const tier = row.textOrNull('tier')
    const actorId = row.textOrNull('actor_id')
    const client = row.text('client_kind')
    if (
      plan === undefined ||
      !isId('op', operationId) ||
      !isId('pln', planId) ||
      !isActionId(kind) ||
      (cls !== 'standard' && cls !== 'high' && cls !== 'critical') ||
      (tier !== null && tier !== 'prod' && tier !== 'nonprod') ||
      (actorId !== null && !isId('idn', actorId)) ||
      (client !== 'web' &&
        client !== 'rest' &&
        client !== 'mcp' &&
        client !== 'cli' &&
        client !== 'ci' &&
        client !== 'system')
    ) {
      throw new AuthError('INTERNAL')
    }
    items.push({
      operationId,
      planId,
      planHash: row.text('plan_hash'),
      kind,
      class: cls,
      tier,
      actorIdentityId: actorId,
      actorClient: client,
      requestedAt: row.text('requested_at'),
      ownPlan: isSelfApproval(plan, session),
      approvals: await approvalsOf(q, operationId),
      required: Math.max(1, requiredApprovals(plan)),
      ...changeOf(plan),
    })
  }
  return items
}

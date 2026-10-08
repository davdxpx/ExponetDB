import {
  type ActionClassName,
  isActionId,
  type OperationView,
  type PlanView,
} from '@exponetdb/contracts'
import type { Queryable } from '@exponetdb/control-store'
import { isId, isJsonArray, isJsonObject, type JsonValue } from '@exponetdb/kernel'
import type { PlanRecord } from '@exponetdb/operations'

/**
 * Read projections of plans and operations for the REST contract
 * (resources.md "Plans", "Operations"). Fixed shapes; nothing secret is in a
 * plan (secrets never enter plan content), and the content and analysis of
 * Wave 3A access plans are shown as `change`.
 */
export type { OperationView, PlanView }

type ActionClass = ActionClassName

export class ViewError extends Error {
  override readonly name = 'ViewError'
}

function cls(value: string): ActionClass {
  if (value === 'low' || value === 'standard' || value === 'high' || value === 'critical') {
    return value
  }
  throw new ViewError('action class')
}

function requirementsOf(plan: PlanRecord): PlanView['requirements'] {
  const policy = plan.body['policy']
  const list = isJsonObject(policy) ? policy['requirements'] : undefined
  if (!isJsonArray(list)) {
    return []
  }
  const out: PlanView['requirements'] = []
  for (const item of list) {
    if (!isJsonObject(item)) {
      continue
    }
    if (item['kind'] === 'approval' && typeof item['count'] === 'number') {
      out.push({ kind: 'approval', count: item['count'], permission: 'plans.approve' })
    } else if (item['kind'] === 'reauth' && typeof item['withinSeconds'] === 'number') {
      out.push({ kind: 'reauth', withinSeconds: item['withinSeconds'] })
    }
  }
  return out
}

const TARGET_PATH = /^[a-z][a-z0-9-]{0,38}\/[a-z][a-z0-9-]{0,38}\/[a-z][a-z0-9-]{0,38}$/

function subjectOf(body: JsonValue | undefined): PlanView['subject'] {
  const subject = isJsonObject(body) ? body : {}
  const targetId = subject['targetId']
  const targetPath = subject['targetPath']
  const clusterId = subject['clusterId']
  const nodeId = subject['nodeId']
  const tier = subject['tier']
  return {
    targetId: isId('tgt', targetId) ? targetId : null,
    targetPath:
      typeof targetPath === 'string' && TARGET_PATH.test(targetPath)
        ? (targetPath as PlanView['subject']['targetPath'])
        : null,
    clusterId: isId('cls', clusterId) ? clusterId : null,
    nodeId: isId('nod', nodeId) ? nodeId : null,
    tier: tier === 'prod' || tier === 'nonprod' ? tier : null,
  }
}

export async function planView(q: Queryable, plan: PlanRecord): Promise<PlanView> {
  const { rows } = await q.query(
    'application.plan.view',
    `SELECT content_checksum, client_id,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
            to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at,
            (SELECT count(*)::int FROM approvals.plan_approvals a
              WHERE a.plan_id = p.plan_id AND a.decision = 'approved') AS given
       FROM operations.plans p WHERE plan_id = $1`,
    [plan.planId],
  )
  const row = rows[0]
  const identityId = plan.actor.identityId
  const kind = plan.kind
  const via = plan.actor.client
  const clientId = row?.textOrNull('client_id') ?? null
  if (
    row === undefined ||
    identityId === null ||
    !isActionId(kind) ||
    (plan.actor.kind !== 'human' && plan.actor.kind !== 'service') ||
    (via !== 'web' && via !== 'rest' && via !== 'mcp' && via !== 'cli' && via !== 'ci') ||
    (clientId !== null && !isId('cli', clientId))
  ) {
    throw new ViewError('plan')
  }
  const requirements = requirementsOf(plan)
  const required = requirements.reduce(
    (max, r) => (r.kind === 'approval' ? Math.max(max, r.count) : max),
    0,
  )
  const policy = plan.body['policy']
  const overridden = isJsonObject(policy) ? policy['overriddenRules'] : undefined
  const content = plan.body['content']
  const analysis = plan.body['analysis']
  return {
    id: plan.planId,
    kind,
    kindVersion: plan.kindVersion,
    class: cls(plan.actionClass),
    state: plan.state,
    planHash: plan.planHash,
    createdAt: row.text('created_at'),
    expiresAt: row.text('expires_at'),
    actor: { identityId, kind: plan.actor.kind, via },
    clientId,
    subject: subjectOf(plan.body['subject']),
    contentChecksum: row.text('content_checksum'),
    decision: plan.decision,
    requirements,
    overriddenRules: isJsonArray(overridden) ? overridden.map(String) : [],
    approvals: { required, given: row.int('given') },
    // The planner sees what the plan will write (a registry plan's planner holds registry.manage).
    ...((kind.startsWith('access.') ||
      kind.startsWith('registry.') ||
      kind.startsWith('target.') ||
      kind.startsWith('node.')) &&
    content !== undefined
      ? { change: { content, analysis: analysis ?? null } }
      : {}),
  }
}

export async function operationView(
  q: Queryable,
  operationId: string,
  publicOrigin: string,
): Promise<OperationView> {
  const { rows } = await q.query(
    'application.operation.view',
    `SELECT o.operation_id, o.kind, o.plan_id, o.state, o.apply_outcome, o.verification_outcome,
            o.actor_kind, o.actor_id, o.client_kind,
            to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
            to_char(o.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
            p.target_id, p.tier,
            (SELECT e.detail->>'errorCode' FROM operations.operation_events e
              WHERE e.operation_id = o.operation_id AND e.detail ? 'errorCode'
              ORDER BY e.event_id DESC LIMIT 1) AS error_code
       FROM operations.operations o LEFT JOIN operations.plans p ON p.plan_id = o.plan_id
      WHERE o.operation_id = $1`,
    [operationId],
  )
  const row = rows[0]
  if (row === undefined) {
    throw new ViewError('operation')
  }
  const id = row.text('operation_id')
  const kind = row.text('kind')
  const planId = row.textOrNull('plan_id')
  const state = row.text('state')
  const apply = row.text('apply_outcome')
  const verification = row.text('verification_outcome')
  const actorKind = row.text('actor_kind')
  const actorId = row.textOrNull('actor_id')
  const via = row.text('client_kind')
  const targetId = row.textOrNull('target_id')
  const tier = row.textOrNull('tier')
  const errorCode = row.textOrNull('error_code')
  const states = [
    'awaiting_approval',
    'queued',
    'running',
    'verifying',
    'needs_reconciliation',
    'needs_attention',
    'succeeded',
    'failed',
    'verification_failed',
    'canceled',
  ] as const
  const applies = ['not_started', 'applied', 'not_applied', 'partially_applied', 'unknown'] as const
  const verifications = [
    'not_applicable',
    'pending',
    'passed',
    'failed',
    'partial',
    'error',
  ] as const
  const operationState = states.find((s) => s === state)
  const applyOutcome = applies.find((s) => s === apply)
  const verificationOutcome = verifications.find((s) => s === verification)
  if (
    !isId('op', id) ||
    !isActionId(kind) ||
    (planId !== null && !isId('pln', planId)) ||
    operationState === undefined ||
    applyOutcome === undefined ||
    verificationOutcome === undefined ||
    (actorKind !== 'human' && actorKind !== 'service') ||
    !isId('idn', actorId) ||
    (via !== 'web' && via !== 'rest' && via !== 'mcp' && via !== 'cli' && via !== 'ci')
  ) {
    throw new ViewError('operation')
  }
  return {
    id,
    kind,
    planId,
    state: operationState,
    applyOutcome,
    verificationOutcome,
    subject: {
      targetId: isId('tgt', targetId) ? targetId : null,
      targetPath: null,
      clusterId: null,
      nodeId: null,
      tier: tier === 'prod' || tier === 'nonprod' ? tier : null,
    },
    actor: { identityId: actorId, kind: actorKind, via },
    createdAt: row.text('created_at'),
    updatedAt: row.text('updated_at'),
    waitingFor: null,
    approvalUrl:
      operationState === 'awaiting_approval' ? `${publicOrigin}/approvals#operation=${id}` : null,
    errorCode: errorCode !== null && /^[A-Z][A-Z0-9_]{1,63}$/.test(errorCode) ? errorCode : null,
    steps: [],
  }
}

import { appendAuditEvent } from '@exponetdb/audit'
import { PolicyDecisionSchema, RequirementSchema } from '@exponetdb/contracts'
import type { Queryable, Row, Tx } from '@exponetdb/control-store'
import {
  type Clock,
  canonicalize,
  formatTimestamp,
  InvariantError,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  newId,
  type PlanId,
  parseId,
  parseJson,
  toJsonValue,
} from '@exponetdb/kernel'
import { computePlanHash, sha256Hex } from '@exponetdb/kernel/hash'
import type { PolicyDecision } from '@exponetdb/policy'
import { auditActor, auditClient, type OperationActor } from './actors.ts'
import { OperationError } from './errors.ts'

/**
 * Plans ([operations-engine.md §3](../../../exponetdb-docs/02-control-plane/operations-engine.md#3-plans)):
 * immutable, short-lived, single use, bound to actor, client, subject,
 * content and policy. The canonical body `B` is stored next to the row; its
 * SHA-256 is the plan hash (the database refuses a body that does not hash
 * to it).
 */
export type StoredActionClass = 'low' | 'standard' | 'high' | 'critical'

/** Default and maximum lifetimes per class (§3.3). */
export const PLAN_LIFETIME_MS: Readonly<
  Record<StoredActionClass, { default: number; max: number }>
> = {
  // An inline plan is accepted in the request that makes it.
  low: { default: 5 * 60_000, max: 15 * 60_000 },
  standard: { default: 30 * 60_000, max: 2 * 60 * 60_000 },
  high: { default: 15 * 60_000, max: 60 * 60_000 },
  critical: { default: 15 * 60_000, max: 60 * 60_000 },
}

/**
 * What a plan acts on. A target plan names the target (and, before the
 * target exists, its path); a registry plan may name the product, project,
 * environment, server or cluster it changes (Wave 4), so authorization
 * resolves the plan's subject chain from the registry, never from the
 * request. An empty subject is installation-wide.
 */
export interface PlanSubject {
  readonly targetId?: string
  readonly targetPath?: string
  readonly tier?: 'prod' | 'nonprod'
  readonly generation?: number
  readonly clusterId?: string
  readonly nodeId?: string
  readonly productId?: string
  readonly projectId?: string
  readonly environmentId?: string
  readonly serverId?: string
}

export interface NewPlan {
  readonly kind: string
  readonly kindVersion: number
  readonly actionClass: StoredActionClass
  readonly actor: OperationActor
  readonly subject: PlanSubject
  readonly content: JsonValue
  readonly expectedState?: JsonObject
  readonly analysis?: JsonObject
  readonly evidence?: readonly JsonValue[]
  readonly policy: PolicyDecision
  /** Shorter than the class default; never longer than its maximum. */
  readonly lifetimeMs?: number
}

export type PlanState = 'active' | 'consumed' | 'expired' | 'invalidated' | 'denied' | 'withdrawn'

export interface PlanRecord {
  readonly planId: PlanId
  readonly kind: string
  readonly kindVersion: number
  readonly actionClass: StoredActionClass
  readonly state: PlanState
  readonly decision: PolicyDecision['decision']
  readonly planHash: string
  readonly policyVersion: string
  readonly actor: Pick<OperationActor, 'kind' | 'identityId' | 'client' | 'clientId'>
  readonly expiresAt: Date
  /** The canonical body `B` (verified against the plan hash when read). */
  readonly body: JsonObject
}

function canonical(value: JsonValue): string {
  const text = canonicalize(value)
  if (!text.ok) {
    throw new InvariantError('plan members are I-JSON')
  }
  return text.value
}

function json(value: unknown): JsonValue {
  const checked = toJsonValue(value)
  if (!checked.ok) {
    throw new OperationError('VALIDATION_FAILED')
  }
  return checked.value
}

function policyMember(policy: PolicyDecision): JsonValue {
  return json({
    decision: policy.decision,
    requirements: policy.requirements,
    rules: policy.rules,
    overriddenRules: policy.overriddenRules,
    policyVersion: policy.policyVersion,
    evaluatedAt: policy.evaluatedAt,
  })
}

/**
 * The policy decision a plan was stored with (the inverse of the plan body's
 * `policy` member), for the recheck at apply. A member that does not parse,
 * or a requirement of an unknown kind, makes the plan unusable rather than
 * lighter: `undefined`, which the caller treats as stale.
 */
export function storedPolicyDecision(plan: PlanRecord): PolicyDecision | undefined {
  const policy = plan.body['policy']
  if (!isJsonObject(policy)) {
    return undefined
  }
  const decision = PolicyDecisionSchema.safeParse(policy['decision'])
  const requirements = RequirementSchema.array().safeParse(policy['requirements'])
  const version = policy['policyVersion']
  const evaluatedAt = policy['evaluatedAt']
  if (
    !decision.success ||
    !requirements.success ||
    typeof version !== 'string' ||
    typeof evaluatedAt !== 'string'
  ) {
    return undefined
  }
  return {
    decision: decision.data,
    requirements: requirements.data,
    rules: [],
    overriddenRules: [],
    policyVersion: version,
    evaluatedAt,
  }
}

/** Creates a plan in the caller's transaction and audits it there (`plan.created`). */
export async function createPlan(
  tx: Tx,
  plan: NewPlan,
  options: { readonly clock: Clock },
): Promise<PlanRecord> {
  const limits = PLAN_LIFETIME_MS[plan.actionClass]
  const lifetime = plan.lifetimeMs ?? limits.default
  if (!Number.isInteger(lifetime) || lifetime <= 0 || lifetime > limits.max) {
    throw new OperationError('VALIDATION_FAILED')
  }
  const now = options.clock.nowMs()
  const planId = newId('pln', now)
  const contentChecksum = `sha256:${sha256Hex(canonical(json(plan.content)))}`
  const body: Record<string, JsonValue> = {
    id: planId,
    kind: plan.kind,
    kindVersion: plan.kindVersion,
    createdAt: formatTimestamp(now),
    expiresAt: formatTimestamp(now + lifetime),
    actor: json({ kind: plan.actor.kind, identityId: plan.actor.identityId }),
    client: json({ kind: plan.actor.client, clientId: plan.actor.clientId }),
    subject: json(plan.subject),
    content: json(plan.content),
    contentChecksum,
    policy: policyMember(plan.policy),
  }
  if (plan.expectedState !== undefined) {
    body['expectedState'] = json(plan.expectedState)
  }
  if (plan.analysis !== undefined) {
    body['analysis'] = json(plan.analysis)
  }
  if (plan.evidence !== undefined) {
    body['evidence'] = json(plan.evidence)
  }
  const hashed = computePlanHash(body)
  if (!hashed.ok) {
    throw new OperationError('VALIDATION_FAILED')
  }
  const state: PlanState = plan.policy.decision === 'deny' ? 'denied' : 'active'
  await tx.query(
    'operations.plan.insert',
    `INSERT INTO operations.plans
       (plan_id, kind, kind_version, action_class, state, decision, plan_hash, content_checksum,
        policy_version, actor_kind, actor_id, client_kind, client_id, target_id, tier, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::timestamptz, $17::timestamptz)`,
    [
      planId,
      plan.kind,
      plan.kindVersion,
      plan.actionClass,
      state,
      plan.policy.decision,
      hashed.value,
      contentChecksum,
      plan.policy.policyVersion,
      plan.actor.kind,
      plan.actor.identityId,
      plan.actor.client,
      plan.actor.clientId,
      plan.subject.targetId ?? null,
      plan.subject.tier ?? null,
      formatTimestamp(now),
      formatTimestamp(now + lifetime),
    ],
  )
  await tx.query(
    'operations.plan_body.insert',
    'INSERT INTO operations.plan_bodies (plan_id, body) VALUES ($1, $2)',
    [planId, canonical(body)],
  )
  await appendAuditEvent(
    tx,
    {
      action: 'plan.created',
      phase: state === 'denied' ? 'denied' : 'completed',
      actor: auditActor(plan.actor),
      client: auditClient(plan.actor),
      refs: { planId, planHash: hashed.value },
      decision: {
        decision: plan.policy.decision,
        rules: plan.policy.rules.map((r) => `${r.id}:${r.result}`).slice(0, 128),
        policyVersion: plan.policy.policyVersion,
      },
      result: { status: state === 'denied' ? 'denied' : 'succeeded' },
      changes: { kind: plan.kind, actionClass: plan.actionClass, state },
    },
    { clock: options.clock },
  )
  return {
    planId,
    kind: plan.kind,
    kindVersion: plan.kindVersion,
    actionClass: plan.actionClass,
    state,
    decision: plan.policy.decision,
    planHash: hashed.value,
    policyVersion: plan.policy.policyVersion,
    actor: {
      kind: plan.actor.kind,
      identityId: plan.actor.identityId,
      client: plan.actor.client,
      clientId: plan.actor.clientId,
    },
    expiresAt: new Date(now + lifetime),
    body,
  }
}

const PLAN_STATES: readonly PlanState[] = [
  'active',
  'consumed',
  'expired',
  'invalidated',
  'denied',
  'withdrawn',
]
const CLASSES: readonly StoredActionClass[] = ['low', 'standard', 'high', 'critical']
const ACTOR_KINDS = ['human', 'service', 'system'] as const
const CLIENT_KINDS = ['web', 'rest', 'mcp', 'cli', 'ci', 'system'] as const

function oneOf<T extends string>(values: readonly T[], value: string): T {
  const found = values.find((v) => v === value)
  if (found === undefined) {
    throw new InvariantError('a stored plan column holds a value the database check allows')
  }
  return found
}

/** Builds a record from a joined plans/plan_bodies row; a body that no longer hashes to the plan hash is stale content. */
export function planFromRow(row: Row): PlanRecord {
  const planId = parseId('pln', row.text('plan_id'))
  const identity = row.textOrNull('actor_id')
  const client = row.textOrNull('client_id')
  const identityId = identity === null ? null : parseId('idn', identity)
  const clientId = client === null ? null : parseId('cli', client)
  if (
    !planId.ok ||
    (identityId !== null && !identityId.ok) ||
    (clientId !== null && !clientId.ok)
  ) {
    throw new InvariantError('stored ids match the database checks')
  }
  const text = row.text('body')
  const hash = `sha256:${sha256Hex(text)}`
  const parsed = parseJson(text)
  if (hash !== row.text('plan_hash') || !parsed.ok || !isJsonObject(parsed.value)) {
    throw new OperationError('PLAN_STALE', {
      changedBindings: [{ binding: 'content', expected: row.text('plan_hash'), actual: hash }],
    })
  }
  const decision = row.text('decision')
  return {
    planId: planId.value,
    kind: row.text('kind'),
    kindVersion: row.int('kind_version'),
    actionClass: oneOf(CLASSES, row.text('action_class')),
    state: oneOf(PLAN_STATES, row.text('state')),
    decision: oneOf(['allow', 'require', 'deny'] as const, decision),
    planHash: row.text('plan_hash'),
    policyVersion: row.text('policy_version'),
    actor: {
      kind: oneOf(ACTOR_KINDS, row.text('actor_kind')),
      identityId: identityId === null ? null : identityId.value,
      client: oneOf(CLIENT_KINDS, row.text('client_kind')),
      clientId: clientId === null ? null : clientId.value,
    },
    expiresAt: row.date('expires_at'),
    body: parsed.value,
  }
}

export const PLAN_COLUMNS = `p.plan_id, p.kind, p.kind_version, p.action_class, p.state, p.decision, p.plan_hash,
  p.policy_version, p.actor_kind, p.actor_id, p.client_kind, p.client_id, p.expires_at, b.body`

export async function readPlan(
  q: Queryable,
  planId: string,
  forUpdate = false,
): Promise<PlanRecord | undefined> {
  const { rows } = await q.query(
    forUpdate ? 'operations.plan.read_for_update' : 'operations.plan.read',
    `SELECT ${PLAN_COLUMNS}
       FROM operations.plans p JOIN operations.plan_bodies b USING (plan_id)
      WHERE p.plan_id = $1${forUpdate ? ' FOR UPDATE OF p' : ''}`,
    [planId],
  )
  const row = rows[0]
  return row === undefined ? undefined : planFromRow(row)
}

/** Moves an active plan to a terminal state and audits it in the same transaction. */
export async function endPlan(
  tx: Tx,
  plan: Pick<PlanRecord, 'planId' | 'planHash'>,
  state: 'consumed' | 'expired' | 'invalidated' | 'withdrawn',
  actor: OperationActor,
  options: { readonly clock: Clock; readonly reason?: string },
): Promise<void> {
  const { rowCount } = await tx.query(
    'operations.plan.end',
    `UPDATE operations.plans SET state = $2 WHERE plan_id = $1 AND state = 'active'`,
    [plan.planId, state],
  )
  if (rowCount !== 1) {
    throw new OperationError('operation_state_changed')
  }
  if (state === 'consumed') {
    return
  }
  await appendAuditEvent(
    tx,
    {
      action: `plan.${state}`,
      phase: 'completed',
      actor: auditActor(actor),
      refs: { planId: plan.planId, planHash: plan.planHash },
      result: { status: 'succeeded' },
      ...(options.reason === undefined ? {} : { changes: { reason: options.reason } }),
    },
    { clock: options.clock },
  )
}

/** The actor's withdrawal of its own active plan (§3.4). */
export async function withdrawPlan(
  tx: Tx,
  planId: string,
  actor: OperationActor,
  options: { readonly clock: Clock },
): Promise<void> {
  const plan = await readPlan(tx, planId, true)
  if (plan === undefined) {
    throw new OperationError('PLAN_NOT_FOUND')
  }
  if (
    plan.actor.identityId !== actor.identityId ||
    plan.actor.kind !== actor.kind ||
    plan.actor.client !== actor.client ||
    plan.actor.clientId !== actor.clientId
  ) {
    throw new OperationError('PLAN_BINDING_ACTOR')
  }
  if (plan.state !== 'active') {
    throw new OperationError(plan.state === 'consumed' ? 'PLAN_ALREADY_USED' : 'PLAN_STALE', {
      changedBindings: [{ binding: 'state', expected: 'active', actual: plan.state }],
    })
  }
  await endPlan(tx, plan, 'withdrawn', actor, options)
}

/**
 * Worker job: marks active plans past their expiry as expired, each with its
 * audit event, at most `limit` per transaction; rows locked elsewhere (an
 * acceptance in progress) are skipped.
 */
export async function expirePlans(
  tx: Tx,
  actor: OperationActor,
  options: { readonly clock: Clock; readonly limit?: number },
): Promise<number> {
  const { rows } = await tx.query(
    'operations.plan.expire_due',
    `SELECT plan_id, plan_hash FROM operations.plans
      WHERE state = 'active' AND expires_at <= clock_timestamp()
      ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
    [Math.min(Math.max(1, options.limit ?? 1000), 10_000)],
  )
  for (const row of rows) {
    const planId = parseId('pln', row.text('plan_id'))
    if (!planId.ok) {
      throw new InvariantError('stored plan ids are canonical')
    }
    await endPlan(
      tx,
      { planId: planId.value, planHash: row.text('plan_hash') },
      'expired',
      actor,
      options,
    )
  }
  return rows.length
}

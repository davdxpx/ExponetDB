import {
  type ActionClassName,
  type Actor,
  isActionId,
  type OperationRead,
  type OperationView,
  type PlanRead,
  type PlanView,
  type PolicyRuleResult,
  type VerificationLayer,
} from '@exponetdb/contracts'
import type { Queryable } from '@exponetdb/control-store'
import { type EntityId, isId, isJsonArray, isJsonObject, type JsonValue } from '@exponetdb/kernel'
import { type Layer, layerFrom } from '@exponetdb/migrations-engine'
import type { PlanRecord } from '@exponetdb/operations'

/**
 * Read projections of plans and operations for the REST contract
 * (resources.md "Plans", "Operations"). Fixed shapes; nothing secret is in a
 * plan (secrets never enter plan content), and the content and analysis of
 * Wave 3A access plans are shown as `change`.
 */
export type { OperationRead, OperationView, PlanRead, PlanView }

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

export function requirementsOf(plan: PlanRecord): PlanView['requirements'] {
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
    // Every requirement the plan carries is shown: a read that drops one would hide a gate.
    const rules = item['rules']
    if (item['kind'] === 'approval' && typeof item['count'] === 'number') {
      out.push({ kind: 'approval', count: item['count'], permission: 'plans.approve' })
    } else if (item['kind'] === 'reauth' && typeof item['withinSeconds'] === 'number') {
      out.push({ kind: 'reauth', withinSeconds: item['withinSeconds'] })
    } else if (item['kind'] === 'backup' && typeof item['newerThan'] === 'string') {
      out.push({ kind: 'backup', newerThan: item['newerThan'], verified: true })
    } else if (item['kind'] === 'maintenance_window' && typeof item['windowId'] === 'string') {
      out.push({ kind: 'maintenance_window', windowId: item['windowId'] })
    } else if (item['kind'] === 'break_glass' && isJsonArray(rules)) {
      out.push({ kind: 'break_glass', rules: rules.map(String).slice(0, 32) })
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
  const actor = actorOf(plan.actor.kind, identityId, via)
  if (
    row === undefined ||
    actor === undefined ||
    !isActionId(kind) ||
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
    actor,
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
      kind.startsWith('node.') ||
      kind.startsWith('migration.') ||
      // Wave 8: a drift acceptance names finding ids, fingerprints and the person's reason, never catalog text.
      kind.startsWith('drift.') ||
      // The role and the stored verifier's id, never the verifier (owner decision S3).
      kind === 'postgres.roles.verifier.set') &&
    content !== undefined
      ? { change: { content, analysis: analysis ?? null } }
      : {}),
    ...(kind.startsWith('migration.') || kind.startsWith('drift.')
      ? { policyRules: policyRulesOf(policy) }
      : {}),
  }
}

/** The stored rules that did not pass, without their facts (the facts stay in the plan). */
function policyRulesOf(policy: JsonValue | undefined): PolicyRuleResult[] {
  const rules = isJsonObject(policy) ? policy['rules'] : undefined
  if (!isJsonArray(rules)) return []
  const out: PolicyRuleResult[] = []
  for (const r of rules) {
    if (!isJsonObject(r)) continue
    const result = r['result']
    const severity = r['severity']
    if (
      typeof r['id'] !== 'string' ||
      (result !== 'fail' && result !== 'unknown') ||
      (severity !== 'deny' && severity !== 'require' && severity !== 'warn')
    ) {
      continue
    }
    out.push({
      id: r['id'],
      result,
      severity,
      message: String(r['message'] ?? '').slice(0, 1024),
      ...(typeof r['remediation'] === 'string'
        ? { remediation: r['remediation'].slice(0, 1024) }
        : {}),
      overridableByBreakGlass: r['overridableByBreakGlass'] === true,
    })
  }
  return out.slice(0, 128)
}

/**
 * Kinds whose verification an operator may run again: their verify step
 * re-runs the rows that errored or never ran (operations-engine.md §4.1),
 * or, for a baseline and a re-verification, the whole read-only run (a
 * verification that errored there otherwise kept the target's schema
 * domain for good; follow-up 3 review P1-1).
 */
export const VERIFICATION_RETRY_KINDS: ReadonlySet<string> = new Set([
  'migration.apply',
  'migration.resume',
  'migration.baseline',
  'migration.verify',
])

/**
 * Whether `POST /operations/{id}/retry-verification` passes the rules about
 * the operation itself: it needs attention after a change that was applied
 * (or applied in part) and whose verification errored or never finished, and
 * it is a kind that can verify again. The one place the rule lives: the
 * retry use case and the `retryable` flag of the read call this. The plan
 * kind's apply permission is a separate check of that call.
 */
export function verificationRetryable(operation: {
  readonly kind: string
  readonly state: string
  readonly applyOutcome: string
  readonly verificationOutcome: string
}): boolean {
  return (
    operation.state === 'needs_attention' &&
    VERIFICATION_RETRY_KINDS.has(operation.kind) &&
    (operation.applyOutcome === 'applied' || operation.applyOutcome === 'partially_applied') &&
    (operation.verificationOutcome === 'pending' || operation.verificationOutcome === 'error')
  )
}

/** The operation as the REST reads show it: with whether a verification retry would pass the operation's rules. */
export function operationRead(view: OperationView): OperationRead {
  return { ...view, retryable: view.planId !== null && verificationRetryable(view) }
}

/** The operation of each plan among `planIds` (at most one per plan: `plan_id` is unique). */
export async function operationsOfPlans(
  q: Queryable,
  planIds: readonly string[],
): Promise<Map<string, string>> {
  if (planIds.length === 0) return new Map()
  const { rows } = await q.query(
    'application.plan.operations',
    'SELECT plan_id, operation_id FROM operations.operations WHERE plan_id = ANY($1::text[])',
    [[...planIds]],
  )
  return new Map(rows.map((r) => [r.text('plan_id'), r.text('operation_id')]))
}

/** The plan as the REST reads show it: with the operation that applied it, if any. */
export function planRead(view: PlanView, operationId: string | undefined): PlanRead {
  return {
    ...view,
    operationId: operationId !== undefined && isId('op', operationId) ? operationId : null,
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
  const actor = actorOf(actorKind, actorId, via)
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
    actor === undefined
  ) {
    throw new ViewError('operation')
  }
  const migrations = kind.startsWith('migration.') ? await migrationProgress(q, id) : undefined
  const runs = kind.startsWith('migration.') ? await operationVerifications(q, id) : []
  const progress = await operationProgress(q, id)
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
    actor,
    createdAt: row.text('created_at'),
    updatedAt: row.text('updated_at'),
    waitingFor:
      operationState === 'queued' && progress.waitingFor !== null
        ? { operationId: progress.waitingFor }
        : null,
    approvalUrl:
      operationState === 'awaiting_approval' ? `${publicOrigin}/approvals#operation=${id}` : null,
    errorCode: errorCode !== null && /^[A-Z][A-Z0-9_]{1,63}$/.test(errorCode) ? errorCode : null,
    steps: progress.steps,
    ...(migrations === undefined ? {} : { migrations }),
    ...(runs.length === 0 ? {} : { verifications: runs }),
    observedAt: progress.observedAt,
    lastEventId: progress.lastEventId,
    nextAction: nextActionOf(operationState, applyOutcome, verificationOutcome, errorCode),
  }
}

type Step = OperationView['steps'][number]

/** How a finished step ended, from the outcome the driver recorded with it. */
function stepState(step: string, outcome: string | null): Step['state'] {
  if (step === 'verify')
    return outcome === 'passed' || outcome === 'not_applicable' ? 'succeeded' : 'failed'
  if (step === 'reconcile')
    return outcome === 'applied' || outcome === 'not_applied' ? 'succeeded' : 'failed'
  return outcome === 'applied' ? 'succeeded' : 'failed'
}

/**
 * Steps, lock waits and the newest event of an operation, from its
 * append-only events (the driver writes `step_started`/`step_finished` and
 * the lock events); read with the Control Store clock as `observedAt`.
 */
async function operationProgress(
  q: Queryable,
  operationId: string,
): Promise<{
  steps: Step[]
  waitingFor: EntityId<'op'> | null
  lastEventId: string
  observedAt: string
}> {
  const { rows } = await q.query(
    'application.operation.progress',
    `SELECT e.event_id::text AS event_id, e.kind, e.detail->>'step' AS step, e.detail->>'outcome' AS outcome,
            e.detail->>'blockingOperationId' AS blocking,
            to_char(e.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
            to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at
       FROM operations.operation_events e
      WHERE e.operation_id = $1
        AND e.kind IN ('created', 'step_started', 'step_finished', 'locks_waiting', 'locks_acquired', 'transition')
      ORDER BY e.event_id`,
    [operationId],
  )
  const steps: Step[] = []
  let waitingFor: EntityId<'op'> | null = null
  let lastEventId = '0'
  let observedAt: string | undefined
  for (const r of rows) {
    lastEventId = r.text('event_id')
    observedAt = r.text('observed_at')
    const kind = r.text('kind')
    const name = r.textOrNull('step')
    if (kind === 'step_started' && name !== null && /^[a-z][a-z0-9_.]{0,63}$/.test(name)) {
      steps.push({
        index: steps.length,
        name,
        state: 'running',
        startedAt: r.text('at'),
        finishedAt: null,
      })
    } else if (kind === 'step_finished' && name !== null) {
      const open = [...steps].reverse().find((s) => s.name === name && s.state === 'running')
      if (open !== undefined) {
        steps[open.index] = {
          ...open,
          state: stepState(name, r.textOrNull('outcome')),
          finishedAt: r.text('at'),
        }
      }
    } else if (kind === 'locks_waiting') {
      const blocking = r.textOrNull('blocking')
      waitingFor = isId('op', blocking) ? blocking : null
    } else if (kind === 'locks_acquired' || kind === 'transition') {
      waitingFor = null
    }
  }
  if (observedAt === undefined) {
    const now = await q.query(
      'application.operation.clock',
      `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t`,
    )
    observedAt = now.rows[0]?.text('t') ?? new Date().toISOString()
  }
  return { steps, waitingFor, lastEventId, observedAt }
}

/** What a person does next (OperationNextAction), from the state and the outcomes only. */
export function nextActionOf(
  state: OperationView['state'],
  apply: OperationView['applyOutcome'],
  verification: OperationView['verificationOutcome'],
  errorCode: string | null,
): NonNullable<OperationView['nextAction']> {
  switch (state) {
    case 'awaiting_approval':
      return 'approve'
    case 'queued':
    case 'running':
    case 'verifying':
    case 'needs_reconciliation':
      return 'wait'
    case 'needs_attention':
      return 'inspect'
    case 'succeeded':
    case 'canceled':
      return 'none'
    case 'verification_failed':
      return errorCode === 'MIGRATION_INCOMPLETE' || apply === 'partially_applied'
        ? 'resume'
        : 'forward_fix'
    case 'failed':
      if (apply === 'not_applied' || apply === 'not_started') return 'replan'
      if (apply === 'partially_applied') return 'resume'
      return verification === 'failed' ? 'forward_fix' : 'inspect'
  }
}

const MIGRATION_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/
const APPLY = ['not_started', 'applied', 'not_applied', 'partially_applied', 'unknown'] as const
const VERIFICATION = ['not_applicable', 'pending', 'passed', 'failed', 'partial', 'error'] as const

const RUN_MIGRATION_ID = /^([0-7][0-9A-HJKMNP-TV-Z]{25}|baseline:[a-z0-9]+(-[a-z0-9]+)*)$/

/**
 * The verification runs a migration operation recorded (the Control Store's
 * mirror of the target's history; Part A follow-up 3, F2): each with its
 * layers and failing expectations, so a failed verification says what
 * failed. At most the newest 50, oldest first.
 */
async function operationVerifications(
  q: Queryable,
  operationId: string,
): Promise<NonNullable<OperationView['verifications']>> {
  const { rows } = await q.query(
    'application.operation.verifications',
    `SELECT * FROM (
       SELECT verification_id, migration_id, operation_id, status, structural, runtime, engine, fingerprint,
              to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at,
              to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS finished_at,
              finished_at AS finished
         FROM migrations.verification_mirror WHERE operation_id = $1
        ORDER BY finished_at DESC LIMIT 50) v
     ORDER BY finished`,
    [operationId],
  )
  return rows.flatMap((r) => {
    const status = r.text('status')
    const migrationId = r.text('migration_id')
    if (
      (status !== 'passed' && status !== 'failed' && status !== 'partial' && status !== 'error') ||
      !RUN_MIGRATION_ID.test(migrationId) ||
      !isId('vfy', r.text('verification_id'))
    ) {
      throw new ViewError('operation')
    }
    return [
      {
        verificationId: r.text('verification_id') as never,
        migrationId: migrationId as never,
        operationId: operationId as never,
        status,
        startedAt: r.text('started_at'),
        finishedAt: r.text('finished_at'),
        structural: contractLayer(layerFrom(r.json('structural'), 'structural')),
        runtime: contractLayer(layerFrom(r.json('runtime'), 'runtime')),
        engine: contractLayer(layerFrom(r.json('engine'), 'engine')),
        fingerprint: r.text('fingerprint') as never,
      },
    ]
  })
}

function contractLayer(layer: Layer): VerificationLayer {
  const { failures, ...rest } = layer
  return {
    ...rest,
    firstFailure: layer.firstFailure === null ? null : { ...layer.firstFailure },
    ...(failures === undefined
      ? {}
      : { failures: failures.map((f) => ({ ...f, failed: [...f.failed] })) }),
  }
}

/** The per-migration progress of a migration operation (Wave 6; the engine's own rows). */
async function migrationProgress(q: Queryable, operationId: string) {
  const { rows } = await q.query(
    'application.operation.migrations',
    `SELECT migration_id, name, apply_outcome, verification_outcome, statement_index, sqlstate, error_code
       FROM migrations.operation_migrations WHERE operation_id = $1 ORDER BY position`,
    [operationId],
  )
  return rows.flatMap((r) => {
    const migrationId = r.text('migration_id')
    const apply = APPLY.find((a) => a === r.text('apply_outcome'))
    const verification = VERIFICATION.find((v) => v === r.text('verification_outcome'))
    const sqlstate = r.textOrNull('sqlstate')
    const errorCode = r.textOrNull('error_code')
    if (!MIGRATION_ID.test(migrationId) || apply === undefined || verification === undefined) {
      throw new ViewError('operation')
    }
    return [
      {
        migrationId: migrationId as never,
        name: r.text('name'),
        applyOutcome: apply,
        verificationOutcome: verification,
        statementIndex: r.intOrNull('statement_index'),
        sqlstate: sqlstate !== null && /^[0-9A-Z]{5}$/.test(sqlstate) ? sqlstate : null,
        errorCode:
          errorCode !== null && /^[A-Z][A-Z0-9_]{1,63}$/.test(errorCode) ? errorCode : null,
      },
    ]
  })
}

/**
 * The actor of a plan or an operation as the contract shows it: a person or
 * a service account through a client, or ExponetDB itself (the worker's own
 * reconciliations). Anything else is a stored row the view cannot vouch for.
 */
function actorOf(kind: string, identityId: string | null, via: string): Actor | undefined {
  if (kind === 'system') {
    return identityId === null && via === 'system'
      ? { identityId: null, kind: 'system', via: 'system' }
      : undefined
  }
  if (
    (kind !== 'human' && kind !== 'service') ||
    !isId('idn', identityId) ||
    (via !== 'web' && via !== 'rest' && via !== 'mcp' && via !== 'cli' && via !== 'ci')
  ) {
    return undefined
  }
  return { identityId, kind, via }
}

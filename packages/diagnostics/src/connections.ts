import { appendAuditEvent } from '@exponetdb/audit'
import type { Tx } from '@exponetdb/control-store'
import { type Clock, isId, type JsonObject } from '@exponetdb/kernel'
import {
  type ChangedBinding,
  createPlan,
  type ExecutionContext,
  type ExecutionOutcome,
  leaseHeld,
  type OperationKind,
  type PlanRecord,
  type StoredActionClass,
  WORKER_ACTOR,
} from '@exponetdb/operations'
import {
  idleInTransactionSession,
  longRunningSession,
  protectedSession,
  protectionReason,
  requireActivityVisibility,
  sql,
  stalledSession,
  TargetError,
  type TargetSession,
  type TrustedSql,
} from '@exponetdb/postgres'
import {
  activeCredential,
  Body,
  evaluateRegistryPolicy,
  findTarget,
  operationActor,
  type RegistryActor,
  RegistryError,
  type RegistryPolicyContext,
  type TargetRecord,
} from '@exponetdb/registry'
import { DiagnosticsError, failureCodeOf } from './errors.ts'
import { clip } from './findings.ts'
import { requireIdentity } from './identity.ts'
import { diagnosticLimits, onObserver } from './live.ts'
import type { SnapshotDeps } from './snapshots.ts'

/**
 * Cancelling a query and terminating a session from diagnostics
 * ([performance.md §5](../../../exponetdb-docs/10-observability/performance.md#5-actions-from-diagnostics),
 * [health.md §3](../../../exponetdb-docs/10-observability/health.md#3-named-conditions)).
 *
 * - **Planning** (`serve`, observer): the session is read live by pid (state,
 *   backend type, role, application name, start times, the conditions and
 *   why it is protected). The plan binds the target (id, generation), the
 *   pid and the `backend_start` the person saw (milliseconds, UTC), for a
 *   cancel also the `query_start`, for a terminate the condition. The
 *   session facts go into the content, where the policy reads them:
 *   `connections.replication-protect` and `connections.no-superuser-terminate`
 *   deny protected sessions; `connections.prod-terminate-approval` asks a
 *   person to approve a production termination an agent planned.
 * - A cluster without an active `exponetdb_operator` credential (the only
 *   ExponetDB login with `pg_signal_backend`) cannot be signaled: planning
 *   refuses with `TARGET_CREDENTIAL_INVALID` (fail closed).
 * - `connections.cancel` is an inline `low` plan (planned and accepted in one
 *   call); `connections.terminate` a stored plan, `standard` on nonprod and
 *   `high` on prod. At acceptance and before the worker starts, the session
 *   is read again (`PLAN_STALE` for another backend, another query, a
 *   condition that no longer holds).
 * - **Execution** (the worker, operator session, identity marker checked):
 *   exactly one statement that re-checks pid, `backend_start`, the
 *   database, client backend and not protected, and the query start (cancel)
 *   or the condition (terminate), in its `WHERE`, and signals only a row it
 *   finds. A row signaled is `applied`; none is `not_applied` with
 *   `PLAN_STALE` and `outcome: not_matched` (gone, pid reused, another
 *   query): never a success when nothing matched.
 * - **Verification**: for a cancel, the backend no longer runs that query
 *   (gone, idle or another `query_start`); for a terminate, the backend with
 *   that pid and start is gone. Read for up to about 3 seconds; still there
 *   is `failed`, unreadable is `error`.
 */
export const CANCEL_KIND = 'connections.cancel'
export const TERMINATE_KIND = 'connections.terminate'
export const TERMINATE_CONDITIONS = [
  'stalled',
  'idle_in_transaction',
  'long_running',
  'any',
] as const
export type TerminateCondition = (typeof TERMINATE_CONDITIONS)[number]

const MS = (column: TrustedSql) =>
  sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

const SESSION = sql`SELECT s.pid, ${MS(sql`s.backend_start`)} AS backend_start, ${MS(sql`s.query_start`)} AS query_start,
       s.state, s.backend_type, s.usename::text AS role, s.application_name, s.wait_event,
       (s.datname IS NOT DISTINCT FROM pg_catalog.current_database()) AS here,
       ${protectionReason(sql`s`)} AS protected,
       ${stalledSession(sql`s`)} AS stalled,
       ${idleInTransactionSession(sql`s`)} AS idle_in_transaction,
       ${longRunningSession(sql`s`)} AS long_running
  FROM pg_catalog.pg_stat_activity s
 WHERE s.pid = $1 AND s.pid <> pg_catalog.pg_backend_pid()`

/** What the session read says (role and application names are untrusted, bounded). */
export interface SessionFacts {
  readonly found: boolean
  readonly backendStart: string | null
  readonly queryStart: string | null
  readonly state: string | null
  readonly backendType: string | null
  readonly role: string | null
  readonly applicationName: string | null
  /** In the target's database. */
  readonly here: boolean
  /** Why ExponetDB never signals it, or null. */
  readonly protected: string | null
  readonly conditions: Readonly<Record<TerminateCondition, boolean>>
}

const NOT_FOUND: SessionFacts = {
  found: false,
  backendStart: null,
  queryStart: null,
  state: null,
  backendType: null,
  role: null,
  applicationName: null,
  here: false,
  protected: null,
  conditions: { stalled: false, idle_in_transaction: false, long_running: false, any: false },
}

/** Reads one session by pid on an opened session (observer or operator). */
export async function readSession(session: TargetSession, pid: number): Promise<SessionFacts> {
  await requireActivityVisibility(session)
  const r = (await session.query(SESSION, [pid]))[0]
  if (r === undefined) return NOT_FOUND
  return {
    found: true,
    backendStart: r.textOrNull('backend_start'),
    queryStart: r.textOrNull('query_start'),
    state: r.textOrNull('state'),
    backendType: r.textOrNull('backend_type'),
    role: r.textOrNull('role') === null ? null : clip(r.text('role'), 63),
    applicationName:
      r.textOrNull('application_name') === null ? null : clip(r.text('application_name'), 128),
    here: r.bool('here'),
    protected: r.textOrNull('protected'),
    conditions: {
      stalled: r.boolOrNull('stalled') === true,
      idle_in_transaction: r.boolOrNull('idle_in_transaction') === true,
      long_running: r.boolOrNull('long_running') === true,
      any: true,
    },
  }
}

/** The timestamp form the session list shows and the statements compare (ms, UTC, `Z`). */
export function normalizedInstant(value: string, path: string): string {
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) {
    throw new RegistryError('VALIDATION_FAILED', {
      errors: [{ path, code: 'invalid_timestamp', message: 'A timestamp.' }],
    })
  }
  return new Date(ms).toISOString()
}

export interface SessionBinding {
  readonly pid: number
  readonly backendStart: string
  readonly queryStart?: string
  readonly condition?: TerminateCondition
}

/** The bindings that no longer hold against what the session read now says (pure). */
export function sessionBindings(bound: SessionBinding, now: SessionFacts): ChangedBinding[] {
  if (!now.found || !now.here || now.backendStart !== bound.backendStart) {
    return [{ binding: 'session', expected: bound.backendStart, actual: now.backendStart }]
  }
  if (now.protected !== null) return [{ binding: 'session', actual: now.protected }]
  if (bound.queryStart !== undefined) {
    if (now.queryStart !== bound.queryStart || now.state !== 'active') {
      return [{ binding: 'query', expected: bound.queryStart, actual: now.queryStart }]
    }
  }
  if (bound.condition !== undefined && !now.conditions[bound.condition]) {
    return [{ binding: 'condition', expected: bound.condition, actual: false }]
  }
  return []
}

export interface ConnectionPlanContext {
  readonly policy: RegistryPolicyContext
  /** `serve`'s observer reads. */
  readonly observation: SnapshotDeps
}

function sessionMember(f: SessionFacts): JsonObject {
  return {
    found: f.found,
    here: f.here,
    backendType: f.backendType,
    role: f.role,
    applicationName: f.applicationName,
    state: f.state,
    protected: f.protected,
  }
}

async function planFor(
  tx: Tx,
  ctx: ConnectionPlanContext,
  actor: RegistryActor,
  targetRef: string,
  kind: typeof CANCEL_KIND | typeof TERMINATE_KIND,
  binding: SessionBinding,
  reason: string | null,
): Promise<PlanRecord> {
  const target = await findTarget(tx, targetRef)
  if (target === undefined) throw new RegistryError('TARGET_NOT_FOUND')
  if (target.state !== 'active') {
    throw new DiagnosticsError(
      target.state === 'decommissioned' ? 'TARGET_NOT_FOUND' : 'TARGET_UNAVAILABLE',
    )
  }
  if (target.placement === null) throw new DiagnosticsError('TARGET_UNAVAILABLE')
  // Only exponetdb_operator may signal backends: without its credential nothing can (fail closed).
  if ((await activeCredential(tx, target.placement.clusterId, 'operator')) === undefined) {
    throw new DiagnosticsError('TARGET_CREDENTIAL_INVALID')
  }
  const facts = await onObserver(ctx.observation, target, 'connections-plan', (s) =>
    readSession(s, binding.pid),
  )
  const content: JsonObject = {
    targetId: target.targetId,
    generation: target.generation,
    pid: binding.pid,
    backendStart: binding.backendStart,
    ...(binding.queryStart === undefined ? {} : { queryStart: binding.queryStart }),
    ...(binding.condition === undefined ? {} : { condition: binding.condition }),
    ...(kind === TERMINATE_KIND ? { reason } : {}),
    session: sessionMember(facts),
  }
  const subject = {
    productId: target.productId,
    projectId: target.projectId,
    environmentId: target.environmentId,
    targetId: target.targetId,
    tier: target.tier,
  }
  const policy = await evaluateRegistryPolicy(tx, ctx.policy, { kind, actor, subject, content })
  const changed = sessionBindings(binding, facts)
  return createPlan(
    tx,
    {
      kind,
      kindVersion: 1,
      actionClass: kind === CANCEL_KIND ? 'low' : terminateClass(target.tier),
      actor: operationActor(actor),
      subject: {
        ...subject,
        targetPath: target.path,
        generation: target.generation,
        clusterId: target.placement.clusterId,
      },
      content,
      expectedState: { generation: target.generation, backendStart: binding.backendStart },
      analysis: {
        production: target.tier === 'prod',
        sessionFound: facts.found && facts.here,
        protected: facts.protected,
        bindingsHoldNow: changed.length === 0,
        changedBindings: changed.map((c) => c.binding),
        ...(binding.condition === undefined
          ? {}
          : {
              condition: binding.condition,
              conditionHoldsNow: facts.conditions[binding.condition],
            }),
        effect:
          kind === CANCEL_KIND
            ? 'pg_cancel_backend on this backend, only while it still runs the same query'
            : 'pg_terminate_backend on this backend, only while the condition still holds',
      },
      policy,
    },
    { clock: ctx.policy.clock },
  )
}

/** `standard` on nonprod, `high` on prod (the action's `by_tier` rule). */
export function terminateClass(tier: 'prod' | 'nonprod'): StoredActionClass {
  return tier === 'prod' ? 'high' : 'standard'
}

/** `connections.cancel`: the inline plan of one cancel (accepted in the same call). */
export function planCancel(
  tx: Tx,
  ctx: ConnectionPlanContext,
  actor: RegistryActor,
  targetRef: string,
  request: { readonly pid: number; readonly backendStart: string; readonly queryStart: string },
): Promise<PlanRecord> {
  return planFor(
    tx,
    ctx,
    actor,
    targetRef,
    CANCEL_KIND,
    {
      pid: request.pid,
      backendStart: normalizedInstant(request.backendStart, '/backendStart'),
      queryStart: normalizedInstant(request.queryStart, '/queryStart'),
    },
    null,
  )
}

/** `connections.terminate.plan`: a stored plan, applied through `plan.apply`. */
export function planTerminate(
  tx: Tx,
  ctx: ConnectionPlanContext,
  actor: RegistryActor,
  targetRef: string,
  request: {
    readonly pid: number
    readonly backendStart: string
    readonly condition: TerminateCondition
    readonly reason?: string | undefined
  },
): Promise<PlanRecord> {
  return planFor(
    tx,
    ctx,
    actor,
    targetRef,
    TERMINATE_KIND,
    {
      pid: request.pid,
      backendStart: normalizedInstant(request.backendStart, '/backendStart'),
      condition: request.condition,
    },
    request.reason ?? null,
  )
}

// ----- the signaling statements -----

const MATCHES = (s: TrustedSql) => sql`${s}.pid = $1 AND ${MS(sql`${s}.backend_start`)} = $2
   AND ${s}.datname = pg_catalog.current_database() AND ${s}.pid <> pg_catalog.pg_backend_pid()
   AND NOT ${protectedSession(s)}`

const CANCEL = sql`SELECT s.pid, pg_catalog.pg_cancel_backend(s.pid) AS signaled
  FROM pg_catalog.pg_stat_activity s
 WHERE ${MATCHES(sql`s`)} AND s.state = 'active' AND ${MS(sql`s.query_start`)} = $3`

const TERMINATE = sql`SELECT s.pid, pg_catalog.pg_terminate_backend(s.pid) AS signaled
  FROM pg_catalog.pg_stat_activity s
 WHERE ${MATCHES(sql`s`)}
   AND CASE $3::text
         WHEN 'stalled' THEN ${stalledSession(sql`s`)}
         WHEN 'idle_in_transaction' THEN ${idleInTransactionSession(sql`s`)}
         WHEN 'long_running' THEN ${longRunningSession(sql`s`)}
         WHEN 'any' THEN true
         ELSE false END`

/**
 * The one signaling statement on an opened operator session (exposed for
 * tests): `signaled` when a row matched every re-check and the signal was
 * sent, `not_matched` otherwise (gone, pid reused, another query, the
 * condition no longer holds, protected now).
 */
export async function signalSession(
  session: TargetSession,
  kind: typeof CANCEL_KIND | typeof TERMINATE_KIND,
  binding: SessionBinding,
): Promise<'signaled' | 'not_matched'> {
  const rows =
    kind === CANCEL_KIND
      ? await session.query(CANCEL, [binding.pid, binding.backendStart, binding.queryStart ?? ''])
      : await session.query(TERMINATE, [
          binding.pid,
          binding.backendStart,
          binding.condition ?? 'none',
        ])
  return rows.some((r) => r.boolOrNull('signaled') === true) ? 'signaled' : 'not_matched'
}

interface SignalContent extends SessionBinding {
  readonly targetId: string
  readonly generation: number
  readonly reason: string | null
}

function contentOf(plan: PlanRecord): SignalContent {
  const c = Body.content(plan)
  const condition = c.has('condition') ? c.oneOf(TERMINATE_CONDITIONS, 'condition') : undefined
  const queryStart = c.has('queryStart') ? c.text('queryStart') : undefined
  return {
    targetId: c.id('tgt', 'targetId'),
    generation: c.int('generation'),
    pid: c.int('pid'),
    backendStart: c.text('backendStart'),
    ...(queryStart === undefined ? {} : { queryStart }),
    ...(condition === undefined ? {} : { condition }),
    reason: c.has('reason') ? c.textOrNull('reason') : null,
  }
}

export interface ConnectionKindDeps extends SnapshotDeps {
  readonly clock: Clock
}

const POLL_MS = 500
const POLLS = 6

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The two kinds share planning reads, execution and verification; they differ in the statement. */
abstract class SignalKind implements OperationKind {
  abstract readonly kind: typeof CANCEL_KIND | typeof TERMINATE_KIND
  readonly version = 1
  abstract readonly actionClass: 'low' | 'high'
  readonly verifies = true
  protected readonly deps: ConnectionKindDeps

  constructor(deps: ConnectionKindDeps) {
    this.deps = deps
  }

  exclusivity(): readonly string[] {
    return []
  }

  /** Whether what the session read says means the signal took effect. */
  protected abstract settled(c: SignalContent, now: SessionFacts): boolean

  async #target(c: SignalContent): Promise<TargetRecord | undefined> {
    const target = await findTarget(this.deps.store, c.targetId)
    return target === undefined || target.state !== 'active' || target.generation !== c.generation
      ? undefined
      : target
  }

  async #observe(target: TargetRecord, pid: number): Promise<SessionFacts> {
    return onObserver(this.deps, target, 'connections', (s) => readSession(s, pid))
  }

  async checkBindings(plan: PlanRecord): Promise<readonly ChangedBinding[]> {
    let c: SignalContent
    try {
      c = contentOf(plan)
    } catch {
      return [{ binding: 'content', actual: 'invalid' }]
    }
    const target = await this.#target(c)
    if (target === undefined) return [{ binding: 'target' }]
    try {
      return sessionBindings(c, await this.#observe(target, c.pid))
    } catch {
      return [{ binding: 'target', actual: 'unreachable' }]
    }
  }

  async execute(ctx: ExecutionContext): Promise<ExecutionOutcome> {
    let c: SignalContent
    try {
      c = contentOf(ctx.plan)
    } catch {
      return 'not_applied'
    }
    const target = await this.#target(c)
    if (target === undefined) {
      return {
        outcome: 'not_applied',
        errorCode: 'PLAN_STALE',
        detail: { changedBindings: ['target'] },
      }
    }
    const held = await this.deps.store.transaction('observation.connections.lease', (tx) =>
      leaseHeld(tx, ctx.operationId, ctx.leaseOwner),
    )
    if (!held) return 'not_applied'
    let session: TargetSession
    try {
      // The operator session: identity marker checked by the connector (C-27).
      const opened = await this.deps.connector.forTarget(
        target,
        'operator',
        `connections/${ctx.operationId}`,
      )
      session = opened.session
    } catch (error) {
      if (error instanceof RegistryError && error.code === 'REGISTRY_CONFLICT') {
        // No active operator credential: nothing can signal (fail closed).
        return { outcome: 'not_applied', errorCode: 'TARGET_CREDENTIAL_INVALID' }
      }
      return { outcome: 'not_applied', errorCode: failureCodeOf(error) }
    }
    try {
      try {
        await requireIdentity(session, target, this.deps.installationId)
        await diagnosticLimits(session)
      } catch (error) {
        return { outcome: 'not_applied', errorCode: failureCodeOf(error) }
      }
      let signaled: boolean
      try {
        signaled = (await signalSession(session, this.kind, c)) === 'signaled'
      } catch (error) {
        if (
          error instanceof TargetError &&
          (error.sqlstate === '42501' || error.code === 'PERMISSION_DENIED')
        ) {
          // The operator lacks pg_signal_backend, or the backend became a superuser's.
          return { outcome: 'not_applied', errorCode: 'PERMISSION_DENIED' }
        }
        return 'unknown'
      }
      await this.#audit(ctx, target, c, signaled ? 'signaled' : 'not_matched').catch(
        () => undefined,
      )
      return signaled
        ? 'applied'
        : {
            outcome: 'not_applied',
            errorCode: 'PLAN_STALE',
            detail: { changedBindings: ['session'], outcome: 'not_matched' },
          }
    } finally {
      await session.close()
    }
  }

  async #audit(
    ctx: ExecutionContext,
    target: TargetRecord,
    c: SignalContent,
    outcome: 'signaled' | 'not_matched',
  ): Promise<void> {
    const operationId = ctx.operationId
    if (!isId('op', operationId)) return
    await this.deps.store.transaction('observation.connections.audit', (tx) =>
      appendAuditEvent(
        tx,
        {
          action: this.kind,
          phase: outcome === 'signaled' ? 'completed' : 'failed',
          actor: { kind: 'system', identityId: null, label: WORKER_ACTOR.label },
          subject: {
            targetId: target.targetId,
            targetPath: target.path,
            tier: target.tier,
          } as never,
          refs: { operationId, planId: ctx.plan.planId, planHash: ctx.plan.planHash },
          ...(c.reason === null ? {} : { reason: c.reason }),
          changes: {
            pid: c.pid,
            backendStart: c.backendStart,
            ...(c.condition === undefined ? {} : { condition: c.condition }),
            outcome,
          },
          result:
            outcome === 'signaled'
              ? { status: 'succeeded', applyOutcome: 'applied' }
              : { status: 'failed', applyOutcome: 'not_applied', errorCode: 'PLAN_STALE' },
        },
        { clock: this.deps.clock },
      ),
    )
  }

  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    let c: SignalContent
    try {
      c = contentOf(ctx.plan)
    } catch {
      return 'error'
    }
    const target = await findTarget(this.deps.store, c.targetId)
    if (target === undefined) return 'error'
    for (let i = 0; i < POLLS; i++) {
      let now: SessionFacts
      try {
        now = await this.#observe(target, c.pid)
      } catch {
        return 'error'
      }
      if (this.settled(c, now)) return 'passed'
      await sleep(POLL_MS)
    }
    return 'failed'
  }

  /** After a lost worker: still unchanged is `not_applied`; anything else cannot be attributed. */
  async reconcile(ctx: ExecutionContext): Promise<'applied' | 'not_applied' | 'unknown'> {
    try {
      const c = contentOf(ctx.plan)
      const target = await findTarget(this.deps.store, c.targetId)
      if (target === undefined) return 'unknown'
      return this.settled(c, await this.#observe(target, c.pid)) ? 'unknown' : 'not_applied'
    } catch {
      return 'unknown'
    }
  }

  auditSummary(plan: PlanRecord): JsonObject {
    try {
      const c = contentOf(plan)
      return {
        targetId: c.targetId,
        pid: c.pid,
        ...(c.condition === undefined ? {} : { condition: c.condition }),
      }
    } catch {
      return {}
    }
  }
}

const sameBackend = (c: SignalContent, now: SessionFacts) =>
  now.found && now.backendStart === c.backendStart

export class CancelKind extends SignalKind {
  readonly kind = CANCEL_KIND
  readonly actionClass = 'low' as const
  /** The backend no longer runs that query: gone, idle, or another query. */
  protected settled(c: SignalContent, now: SessionFacts) {
    return !sameBackend(c, now) || now.state !== 'active' || now.queryStart !== c.queryStart
  }
}

export class TerminateKind extends SignalKind {
  readonly kind = TERMINATE_KIND
  /** The stricter of the two tier classes (the plan carries its own). */
  readonly actionClass = 'high' as const
  /** The backend with that pid and start is gone. */
  protected settled(c: SignalContent, now: SessionFacts) {
    return !sameBackend(c, now)
  }
}

export function connectionKinds(deps: ConnectionKindDeps): readonly OperationKind[] {
  return [new CancelKind(deps), new TerminateKind(deps)]
}

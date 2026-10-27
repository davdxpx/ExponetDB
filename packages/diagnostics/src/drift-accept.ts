import { appendAuditEvent } from '@exponetdb/audit'
import {
  ControlStoreError,
  EXDB_LOCK_NAMESPACE,
  lockKey2,
  type Queryable,
  type Tx,
} from '@exponetdb/control-store'
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
import type { ManagedScope } from '@exponetdb/postgres'
import {
  Body,
  ContentInvalid,
  evaluateRegistryPolicy,
  findTarget,
  getProject,
  operationActor,
  type RegistryActor,
  RegistryError,
  type RegistryPolicyContext,
  type TargetRecord,
} from '@exponetdb/registry'
import { connectionKinds } from './connections.ts'
import { DiagnosticsError, failureCodeOf } from './errors.ts'
import {
  type FindingRecord,
  getFinding,
  openFindings,
  resolveFinding,
  securitySensitive,
} from './findings.ts'
import {
  currentBaseline,
  insertBaseline,
  observeSchema,
  persistSnapshot,
  type SnapshotDeps,
  sameScope,
  scopeOfProject,
} from './snapshots.ts'

/**
 * Drift acceptance, `drift.accept` (Wave 8, order §9;
 * [drift-detection.md §5](../../../exponetdb-docs/03-database-model/drift-detection.md#5-resolutions),
 * [operations-engine.md §2](../../../exponetdb-docs/02-control-plane/operations-engine.md#2-operation-kinds)):
 * a person adopts the actual schema of a target as its expected schema.
 *
 * - Planned (`POST /findings/{finding}/accept`) by `serve` from one open
 *   drift finding: a live, complete snapshot of the target with the
 *   project's managed scope is taken and its `fp1` fingerprint is what the
 *   plan will record. The plan covers every open drift finding of the target
 *   at planning time (the new baseline is the whole schema, so all of them
 *   are absorbed) and binds the target identity (installation via the
 *   identity marker read with the snapshot, target id, generation), the
 *   current baseline, the open drift findings, the scope and the
 *   fingerprint. A covered finding that is critical or security-relevant
 *   needs a reason (policy-engine.md, `drift.accept-prod`).
 * - Applied through `plan.apply`; at acceptance and again under the locks
 *   every binding is checked live (`PLAN_STALE` when the target's schema,
 *   baseline, open drift findings, scope or generation changed). Production
 *   needs an approval and a fresh re-authentication (`drift.accept-prod`).
 * - Executed by the worker: a new complete snapshot with the plan's scope
 *   must have exactly the planned fingerprint; then one Control Store
 *   transaction stores it (purpose `drift_accept`), records it as the
 *   baseline (reason `drift_accept`), resolves the covered findings that are
 *   still open as `accepted` and writes the audit event. Nothing is written
 *   to the target; no DDL runs.
 * - Verified by reading back: the operation's baseline has the planned
 *   fingerprint, it equals the target's live fingerprint, and every covered
 *   finding is resolved. Reconciled by the baseline row the operation wrote.
 *
 * Plans, audit events and errors carry finding ids, counts, fingerprints and
 * the person's reason, never object names or other catalog text.
 */
export const DRIFT_ACCEPT_KIND = 'drift.accept'

/** At most this many open drift findings are covered by one plan (500 per check plus the overflow). */
export const MAX_COVERED_FINDINGS = 2000

export interface DriftAcceptPlanContext {
  readonly policy: RegistryPolicyContext
  /** `serve`'s observer reads (its Control Store login and connector). */
  readonly observation: SnapshotDeps
}

/** What the plan expects to find again at acceptance and execution. */
export interface AcceptanceExpectation {
  readonly generation: number
  readonly baselineId: string | null
  readonly fingerprint: string
  /** The open drift findings the plan covers. */
  readonly covered: readonly string[]
}

/** What is there now; `snapshot` is undefined when no live snapshot was taken. */
export interface AcceptanceObservation {
  readonly target: { readonly state: string; readonly generation: number } | undefined
  readonly baselineId: string | null
  /** The open drift findings of the target now. */
  readonly open: readonly string[]
  readonly sameScope: boolean
  readonly snapshot?: { readonly complete: boolean; readonly fingerprint: string }
}

/**
 * The bindings of a drift acceptance that no longer hold (pure). A covered
 * finding that was resolved since planning changes nothing (its drift is
 * gone or recorded); a new open drift finding is drift the person did not
 * see, so the plan is stale.
 */
export function acceptanceBindings(
  expected: AcceptanceExpectation,
  now: AcceptanceObservation,
): ChangedBinding[] {
  if (now.target === undefined) return [{ binding: 'target', actual: 'missing' }]
  if (now.target.state !== 'active') return [{ binding: 'target', actual: now.target.state }]
  if (now.target.generation !== expected.generation) {
    return [{ binding: 'generation', expected: expected.generation, actual: now.target.generation }]
  }
  const changed: ChangedBinding[] = []
  if (!now.sameScope) changed.push({ binding: 'scope', actual: 'changed' })
  if (now.baselineId !== expected.baselineId) {
    changed.push({ binding: 'baseline', expected: expected.baselineId, actual: now.baselineId })
  }
  const covered = new Set(expected.covered)
  const added = now.open.filter((id) => !covered.has(id)).length
  if (added > 0) changed.push({ binding: 'findings', actual: `${added} new` })
  if (now.snapshot !== undefined) {
    if (!now.snapshot.complete) {
      changed.push({ binding: 'schemaFingerprint', actual: 'incomplete' })
    } else if (now.snapshot.fingerprint !== expected.fingerprint) {
      changed.push({
        binding: 'schemaFingerprint',
        expected: expected.fingerprint,
        actual: now.snapshot.fingerprint,
      })
    }
  }
  return changed
}

/** Whether a reason is required: a covered finding is critical or security-relevant. */
export function reasonRequired(
  findings: readonly Pick<FindingRecord, 'severity' | 'details'>[],
): boolean {
  return findings.some(securitySensitive)
}

/** The plan's class: `standard` on nonprod, `high` on prod (the action's `by_tier` rule). */
export function acceptClass(tier: 'prod' | 'nonprod'): StoredActionClass {
  return tier === 'prod' ? 'high' : 'standard'
}

function invalid(path: string, code: string, message: string): RegistryError {
  return new RegistryError('VALIDATION_FAILED', { errors: [{ path, code, message }] })
}

function scopeMember(scope: ManagedScope): JsonObject {
  return {
    includeSchemas: scope.includeSchemas === undefined ? null : [...scope.includeSchemas],
    excludeSchemas: [...(scope.excludeSchemas ?? [])],
  }
}

/** `drift.accept.plan`: plans adopting the target's current schema from one open drift finding. */
export async function planDriftAccept(
  tx: Tx,
  ctx: DriftAcceptPlanContext,
  actor: RegistryActor,
  findingId: string,
  input: { readonly reason?: string | undefined },
): Promise<PlanRecord> {
  const finding = await getFinding(tx, findingId)
  if (finding === undefined) throw new RegistryError('NOT_FOUND')
  if (finding.kind !== 'drift') {
    throw invalid('/finding', 'not_drift_finding', 'Only a drift finding can be accepted.')
  }
  if (finding.state !== 'open') {
    throw new RegistryError('REGISTRY_CONFLICT', { reason: 'finding_resolved' })
  }
  const target = await findTarget(tx, finding.targetId)
  if (target === undefined) throw new RegistryError('TARGET_NOT_FOUND')
  if (target.state !== 'active') {
    throw new RegistryError('REGISTRY_CONFLICT', { reason: 'target_state' })
  }
  if (target.placement === null) throw new DiagnosticsError('TARGET_UNAVAILABLE')
  const open = await openFindings(tx, target.targetId, 'drift')
  if (open.length > MAX_COVERED_FINDINGS) {
    throw invalid(
      '/finding',
      'too_many_findings',
      'Too many open drift findings to accept at once.',
    )
  }
  const reason = input.reason ?? null
  if (reasonRequired(open) && reason === null) {
    throw invalid(
      '/reason',
      'reason_required',
      'A critical or security-relevant drift is accepted only with a reason.',
    )
  }
  const project = await getProject(tx, target.projectId)
  if (project === undefined) throw new RegistryError('TARGET_NOT_FOUND')
  const scope = scopeOfProject(project)
  const baseline = await currentBaseline(tx, target)
  const snapshot = await observeSchema(ctx.observation, target, 'drift_accept', scope)
  if (!snapshot.complete) {
    throw new RegistryError('REGISTRY_CONFLICT', { reason: 'snapshot_incomplete' })
  }
  const covered = open.map((f) => f.findingId).sort()
  const content: JsonObject = {
    targetId: target.targetId,
    findingId: finding.findingId,
    generation: target.generation,
    scope: scopeMember(scope),
    fingerprint: snapshot.fingerprint,
    covered,
    reason,
  }
  const subject = {
    productId: target.productId,
    projectId: target.projectId,
    environmentId: target.environmentId,
    targetId: target.targetId,
    tier: target.tier,
  }
  const policy = await evaluateRegistryPolicy(tx, ctx.policy, {
    kind: DRIFT_ACCEPT_KIND,
    actor,
    subject,
    content,
  })
  return createPlan(
    tx,
    {
      kind: DRIFT_ACCEPT_KIND,
      kindVersion: 1,
      actionClass: acceptClass(target.tier),
      actor: operationActor(actor),
      subject: {
        ...subject,
        targetPath: target.path,
        generation: target.generation,
        clusterId: target.placement.clusterId,
      },
      content,
      expectedState: {
        generation: target.generation,
        baselineId: baseline?.baselineId ?? null,
        baselineFingerprint: baseline?.fingerprint ?? null,
        schemaFingerprint: snapshot.fingerprint,
        openDriftFindings: covered.length,
      },
      analysis: {
        covered: covered.length,
        critical: open.filter((f) => f.severity === 'critical').length,
        securityRelevant: open.filter((f) => f.details['securityRelevant'] === true).length,
        production: target.tier === 'prod',
        previousFingerprint: baseline?.fingerprint ?? null,
        newFingerprint: snapshot.fingerprint,
        effect:
          "the target's current schema becomes its expected schema and the covered drift findings are resolved as accepted; no DDL runs",
      },
      policy,
    },
    { clock: ctx.policy.clock },
  )
}

interface AcceptContent {
  readonly targetId: string
  readonly findingId: string
  readonly generation: number
  readonly scope: ManagedScope
  readonly fingerprint: string
  readonly covered: readonly string[]
  readonly reason: string | null
  readonly baselineId: string | null
}

function contentOf(plan: PlanRecord): AcceptContent {
  const c = Body.content(plan)
  const expected = Body.expected(plan)
  const scope = c.object('scope')
  const include = scope.stringsOrNull('includeSchemas')
  const covered = c.strings('covered')
  if (!covered.every((id) => isId('fnd', id))) throw new ContentInvalid('content.covered')
  return {
    targetId: c.id('tgt', 'targetId'),
    findingId: c.id('fnd', 'findingId'),
    generation: c.int('generation'),
    scope: {
      ...(include === null ? {} : { includeSchemas: include }),
      excludeSchemas: scope.strings('excludeSchemas'),
    },
    fingerprint: c.text('fingerprint'),
    covered,
    reason: c.textOrNull('reason'),
    baselineId: expected.textOrNull('baselineId'),
  }
}

function lockDrift(tx: Tx, targetId: string) {
  // The drift check's lock (drift.ts): a check and an acceptance never interleave.
  return tx.query('observation.drift.lock', 'SELECT pg_advisory_xact_lock($1::int, $2::int)', [
    EXDB_LOCK_NAMESPACE,
    lockKey2(`observation/drift/${targetId}`),
  ])
}

async function baselineOf(
  q: Queryable,
  operationId: string,
): Promise<{ readonly baselineId: string; readonly fingerprint: string } | undefined> {
  const { rows } = await q.query(
    'observation.baselines.of_operation',
    `SELECT b.baseline_id, b.fingerprint FROM observation.schema_baselines b
      WHERE b.operation_id = $1 AND b.reason = 'drift_accept'`,
    [operationId],
  )
  const row = rows[0]
  return row === undefined
    ? undefined
    : { baselineId: row.text('baseline_id'), fingerprint: row.text('fingerprint') }
}

/** Refusals inside the apply transaction (rolled back, nothing written). */
class Stale extends Error {
  readonly changed: readonly ChangedBinding[]
  constructor(changed: readonly ChangedBinding[]) {
    super('drift acceptance bindings changed')
    this.changed = changed
  }
}
class LeaseGone extends Error {}

function stale(changed: readonly ChangedBinding[]): ExecutionOutcome {
  return {
    outcome: 'not_applied',
    errorCode: 'PLAN_STALE',
    detail: { changedBindings: changed.map((b) => b.binding).slice(0, 32) },
  }
}

export interface DriftAcceptKindDeps extends SnapshotDeps {
  readonly clock: Clock
}

/** `drift.accept`: records the target's current schema as its baseline and resolves the covered findings. */
export class DriftAcceptKind implements OperationKind {
  readonly kind = DRIFT_ACCEPT_KIND
  readonly version = 1
  /** The stricter of the two tier classes (the plan carries its own). */
  readonly actionClass = 'high' as const
  readonly verifies = true
  readonly #deps: DriftAcceptKindDeps

  constructor(deps: DriftAcceptKindDeps) {
    this.#deps = deps
  }

  /** The target's schema domain: no migration records a baseline at the same time. */
  exclusivity(plan: PlanRecord): readonly string[] {
    try {
      return [`target:${contentOf(plan).targetId}:schema`]
    } catch {
      return []
    }
  }

  async #observe(
    q: Queryable,
    c: AcceptContent,
    live: boolean,
  ): Promise<{ readonly target: TargetRecord | undefined; readonly now: AcceptanceObservation }> {
    const target = await findTarget(q, c.targetId)
    if (target === undefined || target.state !== 'active' || target.generation !== c.generation) {
      return {
        target,
        now: {
          target:
            target === undefined
              ? undefined
              : { state: target.state, generation: target.generation },
          baselineId: null,
          open: [],
          sameScope: true,
        },
      }
    }
    const project = await getProject(q, target.projectId)
    const baseline = await currentBaseline(q, target)
    const open = await openFindings(q, target.targetId, 'drift')
    let snapshot: AcceptanceObservation['snapshot']
    if (live) {
      const taken = await observeSchema(this.#deps, target, 'drift_accept', c.scope)
      snapshot = { complete: taken.complete, fingerprint: taken.fingerprint }
    }
    return {
      target,
      now: {
        target: { state: target.state, generation: target.generation },
        baselineId: baseline?.baselineId ?? null,
        open: open.map((f) => f.findingId),
        sameScope: project !== undefined && sameScope(scopeOfProject(project), c.scope),
        ...(snapshot === undefined ? {} : { snapshot }),
      },
    }
  }

  #expectation(c: AcceptContent): AcceptanceExpectation {
    return {
      generation: c.generation,
      baselineId: c.baselineId,
      fingerprint: c.fingerprint,
      covered: c.covered,
    }
  }

  async checkBindings(plan: PlanRecord): Promise<readonly ChangedBinding[]> {
    let c: AcceptContent
    try {
      c = contentOf(plan)
    } catch {
      return [{ binding: 'content', actual: 'invalid' }]
    }
    try {
      const { now } = await this.#observe(this.#deps.store, c, true)
      return acceptanceBindings(this.#expectation(c), now)
    } catch {
      return [{ binding: 'target', actual: 'unreachable' }]
    }
  }

  async execute(ctx: ExecutionContext): Promise<ExecutionOutcome> {
    let c: AcceptContent
    try {
      c = contentOf(ctx.plan)
    } catch {
      return 'not_applied'
    }
    const target = await findTarget(this.#deps.store, c.targetId)
    if (target === undefined || target.state !== 'active' || target.generation !== c.generation) {
      return stale([{ binding: 'target' }])
    }
    let snapshot: Awaited<ReturnType<typeof observeSchema>>
    try {
      snapshot = await observeSchema(this.#deps, target, 'drift_accept', c.scope)
    } catch (error) {
      return { outcome: 'not_applied', errorCode: failureCodeOf(error) }
    }
    if (!snapshot.complete || snapshot.fingerprint !== c.fingerprint) {
      return stale([{ binding: 'schemaFingerprint' }])
    }
    try {
      await this.#deps.store.transaction('observation.drift_accept', async (tx) => {
        await lockDrift(tx, c.targetId)
        if (!(await leaseHeld(tx, ctx.operationId, ctx.leaseOwner))) throw new LeaseGone()
        const { now } = await this.#observe(tx, c, false)
        const changed = acceptanceBindings(this.#expectation(c), now)
        if (changed.length > 0) throw new Stale(changed)
        const stored = await persistSnapshot(tx, target, snapshot, 'drift_accept', ctx.operationId)
        const baselineId = await insertBaseline(tx, stored, 'drift_accept', ctx.operationId)
        let resolved = 0
        for (const findingId of c.covered) {
          if (await resolveFinding(tx, findingId, 'accepted', null)) resolved++
        }
        await this.#audit(tx, ctx, target, c, {
          baselineId,
          snapshotId: stored.snapshotId,
          resolved,
        })
      })
      return 'applied'
    } catch (error) {
      if (error instanceof Stale) return stale(error.changed)
      if (error instanceof LeaseGone) return 'unknown'
      const state = error instanceof ControlStoreError ? error.sqlstate : undefined
      if (
        state !== undefined &&
        (state.startsWith('EX') || state === '23505' || state === '23503' || state === '23514')
      ) {
        return 'not_applied'
      }
      return 'unknown'
    }
  }

  async #audit(
    tx: Tx,
    ctx: ExecutionContext,
    target: TargetRecord,
    c: AcceptContent,
    done: { readonly baselineId: string; readonly snapshotId: string; readonly resolved: number },
  ): Promise<void> {
    if (!isId('op', ctx.operationId)) throw new DiagnosticsError('INTERNAL')
    await appendAuditEvent(
      tx,
      {
        action: DRIFT_ACCEPT_KIND,
        phase: 'completed',
        actor: { kind: 'system', identityId: null, label: WORKER_ACTOR.label },
        subject: { targetId: target.targetId, targetPath: target.path, tier: target.tier } as never,
        refs: {
          operationId: ctx.operationId,
          planId: ctx.plan.planId,
          planHash: ctx.plan.planHash,
        },
        ...(c.reason === null ? {} : { reason: c.reason }),
        changes: {
          baselineId: done.baselineId,
          snapshotId: done.snapshotId,
          fingerprint: c.fingerprint,
          previousBaselineId: c.baselineId,
          covered: c.covered.length,
          resolved: done.resolved,
        },
        result: { status: 'succeeded', applyOutcome: 'applied' },
      },
      { clock: this.#deps.clock },
    )
  }

  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    let c: AcceptContent
    try {
      c = contentOf(ctx.plan)
    } catch {
      return 'error'
    }
    const recorded = await baselineOf(this.#deps.store, ctx.operationId)
    if (recorded === undefined || recorded.fingerprint !== c.fingerprint) return 'failed'
    const { rows } = await this.#deps.store.query(
      'observation.findings.still_open',
      `SELECT count(*)::int AS n FROM observation.findings
        WHERE finding_id = ANY($1::text[]) AND state = 'open'`,
      [[...c.covered]],
    )
    if ((rows[0]?.int('n') ?? 0) > 0) return 'failed'
    const target = await findTarget(this.#deps.store, c.targetId)
    if (target === undefined || target.generation !== c.generation) return 'failed'
    try {
      const live = await observeSchema(this.#deps, target, 'drift_accept', c.scope)
      if (!live.complete) return 'error'
      return live.fingerprint === recorded.fingerprint ? 'passed' : 'failed'
    } catch {
      return 'error'
    }
  }

  async reconcile(ctx: ExecutionContext): Promise<'applied' | 'not_applied' | 'unknown'> {
    try {
      return (await baselineOf(this.#deps.store, ctx.operationId)) === undefined
        ? 'not_applied'
        : 'applied'
    } catch {
      return 'unknown'
    }
  }

  /** Counts and fingerprints only (never object names). */
  auditSummary(plan: PlanRecord): JsonObject {
    try {
      const c = contentOf(plan)
      return { targetId: c.targetId, covered: c.covered.length, fingerprint: c.fingerprint }
    } catch {
      return {}
    }
  }
}

/**
 * The kinds this package registers with the Operations Engine (serve: acceptance checks; the
 * worker executes): drift acceptance (Wave 8) and, since Wave 9 Part B, cancel and terminate.
 */
export function diagnosticsKinds(deps: DriftAcceptKindDeps): readonly OperationKind[] {
  return [new DriftAcceptKind(deps), ...connectionKinds(deps)]
}

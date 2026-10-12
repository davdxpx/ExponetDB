import { appendAuditEvent } from '@exponetdb/audit'
import type { ControlStore, Tx } from '@exponetdb/control-store'
import type { Clock, JsonObject } from '@exponetdb/kernel'
import {
  type ChangedBinding,
  type ExecutionContext,
  type ExecutionOutcome,
  leaseHeld,
  type OperationKind,
  type PlanRecord,
  WORKER_ACTOR,
} from '@exponetdb/operations'
import {
  insertVerification,
  LockUnavailable,
  readLedgerMeta,
  readLedgerRows,
  TargetError,
  type TargetSession,
  takeTargetLock,
} from '@exponetdb/postgres'
import { type Connector, findTarget, type TargetRecord } from '@exponetdb/registry'
import { type PlanContent, PlanContentInvalid, type PlanItem, planContent } from './content.ts'
import { MigrationError } from './errors.ts'
import { readEvidenceTarget } from './evidence.ts'
import { executionRolesChanged, runTransactional, type StepResult } from './executor.ts'
import {
  type Fence,
  fenced,
  LeaseLost,
  type Progress,
  readProgress,
  writeMirror,
  writeProgress,
  writeVerificationMirror,
} from './records.ts'
import { readRevision, type StoredRevision } from './store.ts'
import { ledgerHashOf, type ManagedScope, readTargetState } from './target.ts'
import { type VerificationRun, verifyMigration } from './verification.ts'

/**
 * `migration.apply` ([planning-and-apply.md §4](../../../exponetdb-docs/04-migrations/planning-and-apply.md#4-apply-algorithm)),
 * executed by the worker from the stored plan only.
 *
 * - **Bindings** (at acceptance and again under the Control Store locks):
 *   the registry still places the target where the plan saw it, at the same
 *   generation and cluster, the project maps the same execution roles, the
 *   observer reads the same ledger hash, fingerprint, server version and
 *   extensions, the mirror marks no divergence, and the evidence the plan
 *   bound still holds on the evidence target (live).
 * - **Execute**: the dedicated migrator session takes the target's schema
 *   lock (try with backoff, holders shown), re-checks the bindings on that
 *   session under the lock, and runs each migration (§4.3) followed by its
 *   verification; the first failure stops the rest. Every Control Store
 *   write is fenced by the lease; a lost lease stops before the next
 *   migration and before any `COMMIT`.
 * - **Verify**: pending verifications (after reconciliation) run now; the
 *   result is the aggregate of the per-migration outcomes.
 * - **Reconcile**: takes the schema lock (an old executor's session must
 *   have ended), reads the ledger: the row of this operation with the
 *   planned checksum is applied, its absence not applied. Nothing is
 *   executed again.
 */
export interface MigrationKindDeps {
  /** The worker's Control Store login. */
  readonly store: ControlStore
  readonly clock: Clock
  /** The worker's connector (migrator, verifier, observer). */
  readonly connector: Connector
  readonly installationId: string
  /** `<package version>+<commit>`, recorded in each ledger row. */
  readonly engineVersion: string
}

async function projectRegistry(
  store: ControlStore,
  projectId: string,
): Promise<{
  readonly executionRoles: Record<string, string>
  readonly trustedExtensions: string[]
  readonly scope: ManagedScope
}> {
  const { rows } = await store.query(
    'migrations.kind.project',
    'SELECT execution_roles, trusted_extensions, managed_scope FROM registry.projects WHERE project_id = $1',
    [projectId],
  )
  const row = rows[0]
  const roles = row?.json('execution_roles')
  const trusted = row?.json('trusted_extensions')
  const scope = row?.json('managed_scope') as
    | { includeSchemas?: unknown; excludeSchemas?: unknown }
    | undefined
  const executionRoles: Record<string, string> = {}
  if (typeof roles === 'object' && roles !== null && !Array.isArray(roles)) {
    for (const [k, v] of Object.entries(roles)) if (typeof v === 'string') executionRoles[k] = v
  }
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  return {
    executionRoles,
    trustedExtensions: strings(trusted),
    scope: {
      ...(Array.isArray(scope?.includeSchemas)
        ? { includeSchemas: strings(scope?.includeSchemas) }
        : {}),
      excludeSchemas: strings(scope?.excludeSchemas),
    },
  }
}

function errorCodeOf(error: unknown): string {
  if (error instanceof MigrationError || error instanceof TargetError) return error.code
  return 'TARGET_UNAVAILABLE'
}

export class MigrationApplyKind implements OperationKind {
  readonly kind = 'migration.apply'
  readonly version = 1
  readonly actionClass = 'high' as const
  readonly verifies = true
  readonly #deps: MigrationKindDeps

  constructor(deps: MigrationKindDeps) {
    this.#deps = deps
  }

  exclusivity(plan: PlanRecord): readonly string[] {
    try {
      return [`target:${planContent(plan).target.targetId}:schema`]
    } catch {
      return []
    }
  }

  // ----- bindings -----

  async #registryBindings(
    content: PlanContent,
  ): Promise<{ target: TargetRecord | undefined; changed: ChangedBinding[] }> {
    const changed: ChangedBinding[] = []
    const target = await findTarget(this.#deps.store, content.target.targetId)
    if (target === undefined || target.state !== 'active') {
      changed.push({ binding: 'target', actual: target?.state ?? 'missing' })
      return { target, changed }
    }
    if (target.generation !== content.target.generation) {
      changed.push({
        binding: 'generation',
        expected: String(content.target.generation),
        actual: String(target.generation),
      })
    }
    const placement = target.placement
    if (
      placement === null ||
      placement.systemIdentifier !== content.target.clusterSystemIdentifier ||
      (placement.databaseOid !== null && placement.databaseOid !== content.target.databaseOid)
    ) {
      changed.push({ binding: 'placement', actual: 'changed' })
    }
    const project = await projectRegistry(this.#deps.store, content.projectId)
    for (const [alias, role] of Object.entries(content.expectedState.executionRoles)) {
      if (project.executionRoles[alias] !== role) {
        changed.push({ binding: 'execution_roles', actual: 'changed' })
        break
      }
    }
    const { rows } = await this.#deps.store.query(
      'migrations.kind.divergent',
      'SELECT divergent FROM migrations.ledger_state WHERE target_id = $1',
      [content.target.targetId],
    )
    if (rows[0]?.bool('divergent') === true) {
      changed.push({ binding: 'ledger', actual: 'divergent' })
    }
    return { target, changed }
  }

  /** The fast staleness check with a fresh observer session (planning-and-apply.md §4.1 step 3). */
  async #liveBindings(content: PlanContent, target: TargetRecord): Promise<ChangedBinding[]> {
    const project = await projectRegistry(this.#deps.store, content.projectId)
    let opened: Awaited<ReturnType<Connector['forTarget']>>
    try {
      opened = await this.#deps.connector.forTarget(
        target,
        'observer',
        `bindings/${target.targetId}`,
      )
    } catch {
      return [{ binding: 'target', actual: 'unreachable' }]
    }
    try {
      const state = await opened.session.readOnly(
        (tx) =>
          readTargetState(
            tx,
            {
              installationId: this.#deps.installationId,
              targetId: content.target.targetId,
              generation: content.target.generation,
              systemIdentifier: content.target.clusterSystemIdentifier,
            },
            project.scope,
            { sizes: false },
          ),
        { statementTimeoutMs: 60_000 },
      )
      return stateChanges(content, state)
    } catch (error) {
      return [{ binding: 'target', actual: errorCodeOf(error).toLowerCase().slice(0, 64) }]
    } finally {
      await opened.session.close()
    }
  }

  /** The evidence the plan bound, read live from the evidence target. */
  async #evidenceBindings(content: PlanContent): Promise<ChangedBinding[]> {
    if (content.evidence === null) return []
    const evidence = await findTarget(this.#deps.store, content.evidence.targetId)
    if (evidence === undefined || evidence.generation !== content.evidence.generation) {
      return [{ binding: 'evidence', actual: 'evidence_target_changed' }]
    }
    try {
      const read = await readEvidenceTarget(
        this.#deps.connector,
        this.#deps.installationId,
        evidence,
        `evidence/${content.target.targetId}`,
      )
      for (const m of content.migrations) {
        const row = read.ledger.find((r) => r.migrationId === m.migrationId)
        const bound = content.evidence.verifications[m.migrationId]
        const latest = read.verifications
          .filter((v) => v.migrationId === m.migrationId)
          .sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : -1))[0]
        if (
          row === undefined ||
          row.checksum !== m.checksum ||
          row.revertedAt !== null ||
          latest === undefined ||
          latest.status !== 'passed' ||
          latest.verifyDigest !== m.verifyDigest ||
          bound === undefined
        ) {
          return [{ binding: 'evidence', actual: 'no_longer_present' }]
        }
      }
      return []
    } catch {
      return [{ binding: 'evidence', actual: 'unreachable' }]
    }
  }

  async checkBindings(plan: PlanRecord): Promise<readonly ChangedBinding[]> {
    let content: PlanContent
    try {
      content = planContent(plan)
    } catch (error) {
      if (error instanceof PlanContentInvalid) return [{ binding: 'content', actual: 'invalid' }]
      throw error
    }
    const registry = await this.#registryBindings(content)
    if (registry.changed.length > 0 || registry.target === undefined) return registry.changed
    const live = await this.#liveBindings(content, registry.target)
    if (live.length > 0) return live
    return this.#evidenceBindings(content)
  }

  // ----- execution -----

  async execute(ctx: ExecutionContext): Promise<ExecutionOutcome> {
    let content: PlanContent
    try {
      content = planContent(ctx.plan)
    } catch {
      return {
        outcome: 'not_applied',
        errorCode: 'PLAN_STALE',
        detail: { changedBindings: ['content'] },
      }
    }
    const fence: Fence = {
      store: this.#deps.store,
      operationId: ctx.operationId,
      leaseOwner: ctx.leaseOwner,
    }
    const target = await findTarget(this.#deps.store, content.target.targetId)
    if (target === undefined) {
      return { outcome: 'not_applied', errorCode: 'TARGET_NOT_FOUND' }
    }
    const project = await projectRegistry(this.#deps.store, content.projectId)
    // Progress rows first: the operation shows every planned migration from the start.
    await fenced(fence, 'migrations.kind.progress_init', async (tx) => {
      for (const [position, m] of content.migrations.entries()) {
        await writeProgress(tx, ctx.operationId, initial(position, m))
      }
    })
    let opened: Awaited<ReturnType<Connector['forTarget']>>
    try {
      opened = await this.#deps.connector.forTarget(target, 'migrator', ctx.operationId)
    } catch (error) {
      return { outcome: 'not_applied', errorCode: errorCodeOf(error) }
    }
    const session = opened.session
    let release: (() => Promise<void>) | undefined
    try {
      try {
        release = await takeTargetLock(session, target.targetId, 'schema', {
          deadlineMs: content.execution.lockWaitSeconds * 1000,
          signal: ctx.signal,
          onWait: (holders) => {
            void this.#deps.store
              .query(
                'migrations.kind.waiting',
                `INSERT INTO operations.operation_events (operation_id, kind, detail)
                 VALUES ($1, 'step_started', jsonb_build_object('step', 'waiting_for_lock', 'holders', $2::jsonb))`,
                [ctx.operationId, JSON.stringify(holders.slice(0, 4))],
              )
              .catch(() => undefined)
          },
        })
      } catch (error) {
        if (error instanceof LockUnavailable) {
          return { outcome: 'not_applied', errorCode: 'MIGRATION_LOCK_TIMEOUT' }
        }
        throw error
      }
      // Bindings again, on this session, under the lock (planning-and-apply.md §4.2 step 5).
      const state = await session.readOnly(
        (tx) =>
          readTargetState(
            tx,
            {
              installationId: this.#deps.installationId,
              targetId: content.target.targetId,
              generation: content.target.generation,
              systemIdentifier: content.target.clusterSystemIdentifier,
            },
            project.scope,
            { sizes: false },
          ),
        { statementTimeoutMs: 60_000 },
      )
      const changed = stateChanges(content, state)
      if (await executionRolesChanged(session, content, project.executionRoles)) {
        changed.push({ binding: 'execution_roles', actual: 'changed' })
      }
      if (changed.length === 0 && ctx.readmit !== undefined) {
        changed.push(
          ...(await this.#deps.store.transaction(
            'migrations.kind.readmit',
            (tx) => ctx.readmit?.(tx) ?? Promise.resolve([]),
          )),
        )
      }
      if (changed.length > 0) {
        return {
          outcome: 'not_applied',
          errorCode: 'PLAN_STALE',
          detail: { changedBindings: changed.map((b) => b.binding) },
        }
      }
      return await this.#run(ctx, fence, content, target, project, session, state.ledgerStateHash)
    } catch (error) {
      if (error instanceof LeaseLost) return 'unknown'
      throw error
    } finally {
      await release?.().catch(() => undefined)
      await session.close()
    }
  }

  async #run(
    ctx: ExecutionContext,
    fence: Fence,
    content: PlanContent,
    target: TargetRecord,
    project: Awaited<ReturnType<typeof projectRegistry>>,
    session: TargetSession,
    _ledgerHash: string,
  ): Promise<ExecutionOutcome> {
    let applied = 0
    let fingerprint: string | null = content.expectedState.schemaFingerprint
    let firstError: { code: string; detail: JsonObject } | null = null
    for (const [position, item] of content.migrations.entries()) {
      if (
        ctx.signal.aborted ||
        !(await leaseHeld(this.#deps.store, ctx.operationId, ctx.leaseOwner))
      ) {
        break
      }
      const revision = await readRevision(
        this.#deps.store,
        content.projectId,
        item.migrationId,
        item.revision,
      )
      if (
        revision === undefined ||
        revision.bundleDigest !== item.bundleDigest ||
        revision.checksum !== item.checksum
      ) {
        firstError = { code: 'PLAN_STALE', detail: { changedBindings: ['content'] } }
        break
      }
      const step: StepResult = await runTransactional({
        session,
        content,
        item,
        revision,
        operationId: ctx.operationId,
        planId: ctx.plan.planId,
        actorRef: ctx.plan.actor.identityId,
        clientRef: ctx.plan.actor.clientId,
        installationId: this.#deps.installationId,
        engineVersion: this.#deps.engineVersion,
        scope: project.scope,
        trustedExtensions: project.trustedExtensions,
        fingerprintBefore: fingerprint,
        stillHolds: () => leaseHeld(this.#deps.store, ctx.operationId, ctx.leaseOwner),
      })
      if (step.result === 'unknown') {
        await fenced(fence, 'migrations.kind.progress', (tx) =>
          writeProgress(tx, ctx.operationId, {
            ...initial(position, item),
            applyOutcome: 'unknown',
          }),
        ).catch(() => undefined)
        return 'unknown'
      }
      if (step.result === 'failed') {
        await fenced(fence, 'migrations.kind.progress', async (tx) => {
          await writeProgress(tx, ctx.operationId, {
            ...initial(position, item),
            applyOutcome: 'not_applied',
            verificationOutcome:
              step.gate !== null && step.errorCode === 'VERIFICATION_FAILED'
                ? 'failed'
                : 'not_applicable',
            statementIndex: step.statementIndex,
            sqlstate: step.sqlstate,
            errorCode: step.errorCode,
            gate: step.gate,
          })
          await this.#audit(tx, ctx, content, 'migration.failed', [item], {
            status: 'failed',
            errorCode: step.errorCode,
            applyOutcome: 'not_applied',
          })
        })
        firstError = {
          code: step.errorCode,
          detail: {
            migrationId: item.migrationId,
            ...(step.statementIndex === null ? {} : { statementIndex: step.statementIndex }),
            ...(step.sqlstate === null ? {} : { sqlstate: step.sqlstate }),
          },
        }
        break
      }
      applied += 1
      fingerprint = step.fingerprintAfter
      // Mirror the ledger as it now is (read back on the migrator session).
      const rows = await session.readOnly((tx) => readLedgerRows(tx))
      const baseline = (await session.readOnly((tx) => readLedgerMeta(tx)))?.baselineId ?? null
      await fenced(fence, 'migrations.kind.applied', async (tx) => {
        await writeProgress(tx, ctx.operationId, {
          ...initial(position, item),
          applyOutcome: 'applied',
          verificationOutcome: 'pending',
        })
        await writeMirror(tx, {
          targetId: target.targetId,
          generation: content.target.generation,
          rows,
          ledgerStateHash: ledgerHashOf(rows, baseline),
          baselineId: baseline,
        })
        await this.#audit(tx, ctx, content, 'migration.apply', [item], {
          status: 'succeeded',
          applyOutcome: 'applied',
        })
      })
      const run = await this.#verify(
        ctx,
        fence,
        content,
        target,
        project,
        session,
        position,
        item,
        revision,
        step.fingerprintAfter,
      )
      if (run.status !== 'passed') {
        // V1: dependent migrations are not started after a verification that did not pass.
        break
      }
    }
    if (applied === content.migrations.length) return 'applied'
    if (applied > 0) return 'partially_applied'
    return {
      outcome: 'not_applied',
      errorCode: firstError?.code ?? 'OPERATION_CANCELLED',
      ...(firstError === null ? {} : { detail: firstError.detail }),
    }
  }

  async #verify(
    ctx: ExecutionContext,
    fence: Fence,
    content: PlanContent,
    target: TargetRecord,
    project: Awaited<ReturnType<typeof projectRegistry>>,
    session: TargetSession | null,
    position: number,
    item: PlanItem,
    revision: StoredRevision,
    fingerprintAfter: string | null,
  ): Promise<VerificationRun> {
    const run = await verifyMigration(this.#deps.connector, target, {
      operationId: ctx.operationId,
      item,
      revision,
      fingerprintAfter,
      scope: project.scope,
      trustedExtensions: project.trustedExtensions,
      extensions: null,
    })
    // The target's history first (append-only; the ledger row exists), then the mirror.
    const own =
      session ?? (await this.#deps.connector.forTarget(target, 'migrator', ctx.operationId)).session
    try {
      await own.transaction(() =>
        insertVerification(own, {
          verificationId: run.verificationId,
          migrationId: run.migrationId,
          operationId: ctx.operationId,
          verifyDigest: run.verifyDigest,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          status: run.status,
          structural: run.structural as unknown as JsonObject,
          runtime: run.runtime as unknown as JsonObject,
          engine: run.engine as unknown as JsonObject,
          fingerprint: run.fingerprint,
        }),
      )
    } finally {
      if (session === null) await own.close()
    }
    await fenced(fence, 'migrations.kind.verified', async (tx) => {
      await writeVerificationMirror(
        tx,
        {
          targetId: target.targetId,
          generation: content.target.generation,
          operationId: ctx.operationId,
        },
        run,
      )
      await writeProgress(tx, ctx.operationId, {
        ...initial(position, item),
        applyOutcome: 'applied',
        verificationOutcome: run.status,
        errorCode:
          run.status === 'passed'
            ? null
            : run.status === 'error'
              ? 'VERIFICATION_ERROR'
              : 'VERIFICATION_FAILED',
      })
      await this.#audit(tx, ctx, content, 'migration.verification', [item], {
        status: run.status === 'passed' ? 'succeeded' : 'failed',
        verificationOutcome: run.status,
        ...(run.status === 'passed'
          ? {}
          : { errorCode: run.status === 'error' ? 'VERIFICATION_ERROR' : 'VERIFICATION_FAILED' }),
      })
    })
    return run
  }

  async #audit(
    tx: Tx,
    ctx: ExecutionContext,
    content: PlanContent,
    action: string,
    items: readonly PlanItem[],
    result: JsonObject,
  ): Promise<void> {
    await appendAuditEvent(
      tx,
      {
        action,
        phase: 'completed',
        actor: { kind: 'system', identityId: null, label: WORKER_ACTOR.label },
        subject: {
          targetId: content.target.targetId,
          targetPath: content.target.path,
          tier: content.target.tier,
        } as never,
        refs: {
          operationId: ctx.operationId,
          planId: ctx.plan.planId,
          planHash: ctx.plan.planHash,
          migrationIds: items.map((m) => m.migrationId),
          checksums: items.map((m) => m.checksum),
        } as never,
        result: result as never,
      },
      { clock: this.#deps.clock },
    )
  }

  // ----- verification step of the driver -----

  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    const content = planContent(ctx.plan)
    const fence: Fence = {
      store: this.#deps.store,
      operationId: ctx.operationId,
      leaseOwner: ctx.leaseOwner,
    }
    let progress = await readProgress(this.#deps.store, ctx.operationId)
    const pending = progress.filter(
      (p) => p.applyOutcome === 'applied' && p.verificationOutcome === 'pending',
    )
    if (pending.length > 0) {
      const target = await findTarget(this.#deps.store, content.target.targetId)
      if (target === undefined) return 'error'
      const project = await projectRegistry(this.#deps.store, content.projectId)
      for (const p of pending) {
        const item = content.migrations[p.position]
        if (item === undefined) return 'error'
        const revision = await readRevision(
          this.#deps.store,
          content.projectId,
          item.migrationId,
          item.revision,
        )
        if (revision === undefined) return 'error'
        const ledger = await this.#ledgerRow(target, item.migrationId)
        try {
          const run = await this.#verify(
            ctx,
            fence,
            content,
            target,
            project,
            null,
            p.position,
            item,
            revision,
            ledger?.fingerprintAfter ?? null,
          )
          if (run.status !== 'passed') break
        } catch {
          return 'error'
        }
      }
      progress = await readProgress(this.#deps.store, ctx.operationId)
    }
    return aggregate(progress, content.migrations.length)
  }

  async #ledgerRow(target: TargetRecord, migrationId: string) {
    const opened = await this.#deps.connector.forTarget(
      target,
      'observer',
      `ledger/${target.targetId}`,
    )
    try {
      const rows = await opened.session.readOnly((tx) => readLedgerRows(tx))
      return rows.find((r) => r.migrationId === migrationId)
    } finally {
      await opened.session.close()
    }
  }

  // ----- reconciliation -----

  async reconcile(ctx: ExecutionContext): Promise<'applied' | 'not_applied' | 'unknown'> {
    const content = planContent(ctx.plan)
    const fence: Fence = {
      store: this.#deps.store,
      operationId: ctx.operationId,
      leaseOwner: ctx.leaseOwner,
    }
    const target = await findTarget(this.#deps.store, content.target.targetId)
    if (target === undefined) return 'unknown'
    let opened: Awaited<ReturnType<Connector['forTarget']>>
    try {
      opened = await this.#deps.connector.forTarget(
        target,
        'migrator',
        `reconcile/${ctx.operationId}`,
      )
    } catch {
      return 'unknown'
    }
    const session = opened.session
    let release: (() => Promise<void>) | undefined
    try {
      // The schema lock is free only after an earlier executor's session ended:
      // a transaction still running there is never mistaken for "no row".
      release = await takeTargetLock(session, target.targetId, 'schema', {
        deadlineMs: 120_000,
        signal: ctx.signal,
      })
      const rows = await session.readOnly((tx) => readLedgerRows(tx))
      const progress = await readProgress(this.#deps.store, ctx.operationId)
      let anyApplied = false
      for (const [position, item] of content.migrations.entries()) {
        const row = rows.find((r) => r.migrationId === item.migrationId)
        const p = progress.find((x) => x.position === position)
        const mine =
          row !== undefined && row.operationId === ctx.operationId && row.checksum === item.checksum
        if (row !== undefined && !mine) {
          // Another operation recorded this id: not ours to claim.
          continue
        }
        if (mine) {
          anyApplied = true
          if (p?.applyOutcome !== 'applied') {
            await fenced(fence, 'migrations.kind.reconciled', (tx) =>
              writeProgress(tx, ctx.operationId, {
                ...initial(position, item),
                applyOutcome: 'applied',
                verificationOutcome: 'pending',
              }),
            )
          }
        } else if (p?.applyOutcome === 'unknown') {
          await fenced(fence, 'migrations.kind.reconciled', (tx) =>
            writeProgress(tx, ctx.operationId, {
              ...initial(position, item),
              applyOutcome: 'not_applied',
              errorCode: 'OUTCOME_UNKNOWN',
            }),
          )
        }
      }
      const baseline = (await session.readOnly((tx) => readLedgerMeta(tx)))?.baselineId ?? null
      await fenced(fence, 'migrations.kind.reconcile_mirror', (tx) =>
        writeMirror(tx, {
          targetId: target.targetId,
          generation: content.target.generation,
          rows,
          ledgerStateHash: ledgerHashOf(rows, baseline),
          baselineId: baseline,
        }),
      )
      return anyApplied ? 'applied' : 'not_applied'
    } catch {
      return 'unknown'
    } finally {
      await release?.().catch(() => undefined)
      await session.close()
    }
  }

  auditSummary(plan: PlanRecord): JsonObject {
    try {
      const c = planContent(plan)
      return {
        migrations: c.migrations.length,
        mode: c.execution.mode,
        compatibility: c.facts.compatibility,
      }
    } catch {
      return {}
    }
  }
}

function initial(position: number, item: PlanItem): Progress {
  return {
    position,
    migrationId: item.migrationId,
    name: item.name,
    applyOutcome: 'not_started',
    verificationOutcome: 'not_applicable',
    statementIndex: null,
    sqlstate: null,
    errorCode: null,
    gate: null,
  }
}

/** What changed between the plan and the target now (ledger, fingerprint, version, extensions). */
export function stateChanges(
  content: PlanContent,
  state: {
    readonly ledgerStateHash: string
    readonly fingerprint: string
    readonly serverVersionNum: number
    readonly extensions: Readonly<Record<string, string>>
    readonly databaseOid: string
  },
): ChangedBinding[] {
  const changed: ChangedBinding[] = []
  if (state.ledgerStateHash !== content.expectedState.ledgerStateHash) {
    changed.push({
      binding: 'ledger',
      expected: content.expectedState.ledgerStateHash,
      actual: state.ledgerStateHash,
    })
  }
  if (state.fingerprint !== content.expectedState.schemaFingerprint) {
    changed.push({
      binding: 'fingerprint',
      expected: content.expectedState.schemaFingerprint,
      actual: state.fingerprint,
    })
  }
  if (state.serverVersionNum !== content.target.serverVersionNum) {
    changed.push({
      binding: 'server_version',
      expected: String(content.target.serverVersionNum),
      actual: String(state.serverVersionNum),
    })
  }
  if (state.databaseOid !== content.target.databaseOid) {
    changed.push({ binding: 'database', actual: 'changed' })
  }
  const bound = content.expectedState.extensions
  const names = new Set([...Object.keys(bound), ...Object.keys(state.extensions)])
  for (const name of names) {
    if (bound[name] !== state.extensions[name]) {
      changed.push({ binding: 'extensions', actual: name.slice(0, 63) })
      break
    }
  }
  return changed
}

/** The operation's verification outcome from its per-migration rows. */
export function aggregate(
  progress: readonly Progress[],
  planned: number,
): 'passed' | 'failed' | 'partial' | 'error' {
  const applied = progress.filter((p) => p.applyOutcome === 'applied')
  if (applied.some((p) => p.verificationOutcome === 'error' || p.verificationOutcome === 'pending'))
    return 'error'
  if (applied.some((p) => p.verificationOutcome === 'failed')) return 'failed'
  if (applied.length < planned) return 'partial'
  return 'passed'
}

export function migrationKinds(deps: MigrationKindDeps): readonly OperationKind[] {
  return [new MigrationApplyKind(deps)]
}

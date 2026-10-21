import { appendAuditEvent } from '@exponetdb/audit'
import type { Tx } from '@exponetdb/control-store'
import type { JsonObject } from '@exponetdb/kernel'
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
  readMigrationEvents,
  TargetError,
  type TargetSession,
  takeTargetLock,
} from '@exponetdb/postgres'
import { loadParser } from '@exponetdb/postgres/parser'
import { type Connector, findTarget, type TargetRecord } from '@exponetdb/registry'
import {
  type PlanContent,
  PlanContentInvalid,
  type PlanItem,
  planContent,
  type ResumeBinding,
} from './content.ts'
import { type MigrationKindDeps, projectRegistry } from './deps.ts'
import { MigrationError } from './errors.ts'
import { readEvidenceTarget } from './evidence.ts'
import { boundExceptionsHold, executionRolesFor } from './execution-roles.ts'
import {
  executionRolesChanged,
  type NontxResult,
  runNontransactional,
  runTransactional,
  type StepInput,
  type StepResult,
  statementsOf,
} from './executor.ts'
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
import { readBack, resumeLog } from './resume.ts'
import { readRevision, type StoredRevision } from './store.ts'
import { ledgerHashOf, readTargetState } from './target.ts'
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
function errorCodeOf(error: unknown): string {
  if (error instanceof MigrationError || error instanceof TargetError) return error.code
  return 'TARGET_UNAVAILABLE'
}

export class MigrationApplyKind implements OperationKind {
  readonly kind: 'migration.apply' | 'migration.resume'
  readonly version = 1
  readonly actionClass = 'high' as const
  readonly verifies = true
  readonly #deps: MigrationKindDeps

  /**
   * `migration.resume` is the same kind over a plan that also carries a
   * {@link ResumeBinding}: the original bundle continues where the event
   * log and the readback say, after an optional cleanup (resume.ts).
   */
  constructor(
    deps: MigrationKindDeps,
    kind: 'migration.apply' | 'migration.resume' = 'migration.apply',
  ) {
    this.#deps = deps
    this.kind = kind
  }

  /** The plan's content for this kind: a resume plan carries its binding, an apply plan none. */
  #content(plan: Pick<PlanRecord, 'body'>): PlanContent {
    const content = planContent(plan)
    if ((this.kind === 'migration.resume') !== (content.resume !== undefined)) {
      throw new PlanContentInvalid('the plan content does not match its kind')
    }
    return content
  }

  exclusivity(plan: PlanRecord): readonly string[] {
    try {
      return [`target:${this.#content(plan).target.targetId}:schema`]
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
    // The roles of the target's environment and the exceptions the plan relied on (ADR-0034).
    const resolved = await executionRolesFor(this.#deps.store, target)
    for (const [alias, role] of Object.entries(content.expectedState.executionRoles)) {
      if (resolved.roles[alias] !== role) {
        changed.push({ binding: 'execution_roles', actual: 'changed' })
        break
      }
    }
    if (!boundExceptionsHold(content.expectedState.executionRoleExceptions, resolved.exceptions)) {
      changed.push({ binding: 'execution_role_exception', actual: 'changed' })
    }
    // The ledger itself is bound by its state hash, compared live under the lock.
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
      const { state, digest } = await opened.session.readOnly(
        async (tx) => ({
          state: await readTargetState(
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
          digest: await eventLogDigest(tx, content),
        }),
        { statementTimeoutMs: 60_000 },
      )
      const changed = stateChanges(content, state)
      if (content.resume !== undefined && digest !== content.resume.eventLogDigest) {
        changed.push({ binding: 'event_log', actual: 'changed' })
      }
      return changed
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
      content = this.#content(plan)
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
      content = this.#content(ctx.plan)
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
      const roleChange = await executionRolesChanged(
        session,
        content,
        await executionRolesFor(this.#deps.store, target),
      )
      if (roleChange !== null) changed.push({ binding: roleChange, actual: 'changed' })
      if (changed.length === 0 && ctx.readmit !== undefined) {
        changed.push(
          ...(await this.#deps.store.transaction(
            'migrations.kind.readmit',
            (tx) => ctx.readmit?.(tx) ?? Promise.resolve([]),
          )),
        )
      }
      if (changed.length === 0 && content.resume !== undefined) {
        changed.push(...(await this.#resumeChanges(session, content, content.resume, project)))
      }
      if (changed.some((b) => b.binding === 'authorization')) {
        return { outcome: 'not_applied', errorCode: 'GRANT_REVOKED' }
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

  /** The authority of the applying identity, asked again before a further migration starts (E27). */
  async #authorityRevoked(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.readmit === undefined) return false
    const changed = await this.#deps.store.transaction('migrations.kind.authority', (tx) =>
      ctx.readmit === undefined ? Promise.resolve([]) : ctx.readmit(tx),
    )
    return changed.some((b) => b.binding === 'authorization')
  }

  /** The event log and the readback again, on the migrator session under the lock. */
  async #resumeChanges(
    session: TargetSession,
    content: PlanContent,
    resume: ResumeBinding,
    project: Awaited<ReturnType<typeof projectRegistry>>,
  ): Promise<ChangedBinding[]> {
    const item = content.migrations[0]
    if (item === undefined) return [{ binding: 'content', actual: 'invalid' }]
    const revision = await readRevision(
      this.#deps.store,
      content.projectId,
      item.migrationId,
      item.revision,
    )
    if (revision === undefined) return [{ binding: 'content', actual: 'invalid' }]
    await loadParser(session.facts.major)
    const reviewed = statementsOf(session, revision, project.trustedExtensions)
    if (!reviewed.analysis.ok) return [{ binding: 'content', actual: 'invalid' }]
    const statements = reviewed.analysis.statements
    return session.readOnly(async (tx) => {
      const events = await readMigrationEvents(tx, { migrationId: item.migrationId })
      const log = resumeLog(events)
      if (log === null || log.digest !== resume.eventLogDigest) {
        return [{ binding: 'event_log', actual: 'changed' }]
      }
      const back = await readBack(tx, statements, log, item.searchPath)
      if (
        back.state !== resume.readback ||
        (resume.cleanup !== null && back.index?.oid !== resume.cleanup.indexOid)
      ) {
        return [{ binding: 'readback', actual: back.state }]
      }
      return []
    })
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
    const resume = content.resume
    let fingerprint: string | null =
      resume === undefined
        ? content.expectedState.schemaFingerprint
        : resume.fingerprintBeforeMigration
    let firstError: { code: string; detail: JsonObject } | null = null
    for (const [position, item] of content.migrations.entries()) {
      if (
        ctx.signal.aborted ||
        !(await leaseHeld(this.#deps.store, ctx.operationId, ctx.leaseOwner))
      ) {
        break
      }
      if (position > 0 && (await this.#authorityRevoked(ctx))) {
        // E27: what ran stays applied; nothing further starts.
        await fenced(fence, 'migrations.kind.progress', (tx) =>
          writeProgress(tx, ctx.operationId, {
            ...initial(position, item),
            errorCode: 'GRANT_REVOKED',
          }),
        )
        firstError = { code: 'GRANT_REVOKED', detail: { migrationId: item.migrationId } }
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
      const input: StepInput = {
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
      }
      const step: StepResult | NontxResult = item.transactional
        ? await runTransactional(input)
        : await runNontransactional(
            resume === undefined
              ? input
              : {
                  ...input,
                  fromStatement: resume.fromStatement,
                  resume: {
                    of: resume.originalOperationId,
                    doneByReadback: resume.readback === 'present' ? resume.nextStatement : null,
                    cleanup: resume.cleanup === null ? null : { indexOid: resume.cleanup.indexOid },
                  },
                },
          )
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
        const partial = 'partial' in step && step.partial
        await fenced(fence, 'migrations.kind.progress', async (tx) => {
          await writeProgress(tx, ctx.operationId, {
            ...initial(position, item),
            applyOutcome: partial ? 'partially_applied' : 'not_applied',
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
            applyOutcome: partial ? 'partially_applied' : 'not_applied',
          })
        })
        if (partial) {
          // Statements took effect: the target needs an explicit resume (the operation shows it).
          return 'partially_applied'
        }
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
        await this.#audit(tx, ctx, content, this.kind, [item], {
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
    const content = this.#content(ctx.plan)
    const fence: Fence = {
      store: this.#deps.store,
      operationId: ctx.operationId,
      leaseOwner: ctx.leaseOwner,
    }
    let progress = await readProgress(this.#deps.store, ctx.operationId)
    if (ctx.verificationRetry === true) {
      // An operator asked to verify again (needs_attention to verifying): what
      // errored is pending again, so a takeover continues it. Verification is
      // read-only; up.sql never runs again.
      await fenced(fence, 'migrations.kind.retry_verification', async (tx) => {
        for (const p of progress) {
          if (p.applyOutcome === 'applied' && p.verificationOutcome === 'error') {
            await writeProgress(tx, ctx.operationId, {
              ...p,
              verificationOutcome: 'pending',
              errorCode: null,
            })
          }
        }
      })
      progress = await readProgress(this.#deps.store, ctx.operationId)
    }
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
    const result = aggregate(progress, content.migrations.length)
    if (result === 'passed') await this.#recordExpected(ctx, content)
    return result
  }

  /**
   * The schema the operation left, verified, becomes the target's expected
   * state for drift (drift-detection.md §7). Best effort: a snapshot that
   * fails or differs leaves the previous baseline, and the next drift check
   * says so; the operation's outcome stays what verification decided.
   */
  async #recordExpected(ctx: ExecutionContext, content: PlanContent): Promise<void> {
    const expected = this.#deps.expected
    const last = content.migrations.at(-1)
    if (expected === undefined || last === undefined) return
    try {
      const target = await findTarget(this.#deps.store, content.target.targetId)
      if (target === undefined) return
      const row = await this.#ledgerRow(target, last.migrationId)
      if (row?.fingerprintAfter === null || row?.fingerprintAfter === undefined) return
      await expected.record({
        targetId: target.targetId,
        generation: content.target.generation,
        operationId: ctx.operationId,
        fingerprint: row.fingerprintAfter,
      })
    } catch {
      // The drift check reports what the baseline does not explain.
    }
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
    const content = this.#content(ctx.plan)
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
      let incomplete = false
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
        } else if (
          !item.transactional &&
          resumeLog(
            await session.readOnly((tx) =>
              readMigrationEvents(tx, { migrationId: item.migrationId }),
            ),
          ) !== null
        ) {
          // Started in autocommit, never recorded, never closed: a missing done event
          // proves no missing effect. It stays incomplete until an explicit resume.
          incomplete = true
          await fenced(fence, 'migrations.kind.reconciled', (tx) =>
            writeProgress(tx, ctx.operationId, {
              ...initial(position, item),
              applyOutcome: 'unknown',
              errorCode: 'MIGRATION_INCOMPLETE',
            }),
          )
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
      if (incomplete) return 'unknown'
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
      const c = this.#content(plan)
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

/** The digest of the incomplete start's event log a resume plan bound; null for an apply plan. */
async function eventLogDigest(
  reader: Parameters<typeof readMigrationEvents>[0],
  content: PlanContent,
): Promise<string | null> {
  const item = content.migrations[0]
  if (content.resume === undefined || item === undefined) return null
  return (
    resumeLog(await readMigrationEvents(reader, { migrationId: item.migrationId }))?.digest ?? null
  )
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

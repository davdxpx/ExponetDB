import type { Tx } from '@exponetdb/control-store'
import { decodeUtf8, type JsonObject } from '@exponetdb/kernel'
import { normalizeSqlSource, parseStrictYaml } from '@exponetdb/migrations/format'
import {
  type ChangedBinding,
  createPlan,
  type ExecutionContext,
  type ExecutionOutcome,
  leaseHeld,
  type OperationKind,
  type PlanRecord,
} from '@exponetdb/operations'
import type { MigrationFacts } from '@exponetdb/policy'
import {
  insertMigrationEvent,
  insertVerification,
  LockUnavailable,
  markReverted,
  readLedgerMeta,
  readLedgerRows,
  takeTargetLock,
} from '@exponetdb/postgres'
import {
  analyzeMigrationSql,
  type CompatibilityClass,
  loadParser,
  mostSevere,
  worstSeverity,
} from '@exponetdb/postgres/parser'
import {
  type Connector,
  evaluateRegistryPolicy,
  findTarget,
  operationActor,
  type RegistryActor,
  type TargetRecord,
} from '@exponetdb/registry'
import type { PlanContent, PlanItem } from './content.ts'
import { type MigrationKindDeps, projectRegistry } from './deps.ts'
import { MigrationError } from './errors.ts'
import { runTransactional } from './executor.ts'
import type { MigrationPlanContext } from './planner.ts'
import {
  type Fence,
  fenced,
  readProgress,
  writeMirror,
  writeProgress,
  writeVerificationMirror,
} from './records.ts'
import { readRevision, revisionsOf } from './store.ts'
import { ledgerHashOf, readTargetState } from './target.ts'
import { verifyMigration } from './verification.ts'

/**
 * `migration.rollback` ([failure-and-recovery.md](../../../exponetdb-docs/04-migrations/failure-and-recovery.md),
 * G6 order §35): `down.sql` runs only in a new, explicit plan, never on its
 * own. The plan requires the migration to be applied and not reverted, no
 * applied migration to depend on it, the target's fingerprint to equal the
 * one the ledger recorded last (nothing changed beside the ledger), and a
 * stored revision with the same apply checksum and a `down.sql`; it binds
 * the rollback digest. It runs like an apply (§4.3: one transaction, the
 * execution role, the engine guards, L0 on `down.sql`'s expectations) and
 * marks the ledger row reverted once in that transaction, with a `reverted`
 * event. Afterwards L1 (`down.sql`'s expectations) and L3 (the fingerprint
 * equals the one before the migration) run; `verify.sql` does not, since it
 * asserts the forward state. A lossy or unsafe rollback on production is
 * `critical` (a person only) and needs a verified backup (Wave 9) or
 * break-glass.
 */
interface RollbackContent extends Omit<PlanContent, 'migrations' | 'evidence'> {
  readonly migrations: readonly [PlanItem]
  readonly safety: 'safe' | 'lossy' | 'unsafe' | null
  /** The fingerprint the ledger recorded before the migration: the rollback's L3 target. */
  readonly fingerprintBeforeMigration: string | null
  readonly evidence: null
}

function contentOf(plan: Pick<PlanRecord, 'body'>): RollbackContent {
  const c = plan.body['content'] as unknown as RollbackContent | undefined
  if (c === undefined || !Array.isArray(c.migrations) || c.migrations.length !== 1) {
    throw new MigrationError('PLAN_STALE')
  }
  return c
}

export async function planMigrationRollback(
  tx: Tx,
  ctx: MigrationPlanContext,
  actor: RegistryActor,
  targetRef: string,
  migrationId: string,
): Promise<PlanRecord> {
  const target = await findTarget(tx, targetRef)
  if (target === undefined) throw new MigrationError('TARGET_NOT_FOUND')
  if (target.state !== 'active') {
    throw new MigrationError('TARGET_SUSPENDED', { reason: target.stateReason ?? 'administrator' })
  }
  if (target.placement === null) throw new MigrationError('TARGET_UNAVAILABLE')
  const project = await projectRegistry(tx, target.projectId)
  const opened = await ctx.connector.forTarget(
    target,
    'observer',
    `rollback-plan/${target.targetId}`,
  )
  let state: Awaited<ReturnType<typeof readTargetState>>
  try {
    await loadParser(opened.session.facts.major)
    state = await opened.session.readOnly(
      (rtx) =>
        readTargetState(
          rtx,
          {
            installationId: ctx.installationId,
            targetId: target.targetId,
            generation: target.generation,
            systemIdentifier: target.placement?.systemIdentifier ?? null,
          },
          project.scope,
          { sizes: false },
        ),
      { statementTimeoutMs: 60_000 },
    )
  } finally {
    await opened.session.close()
  }
  const row = state.ledger.find((r) => r.migrationId === migrationId)
  if (row === undefined || row.origin !== 'exponetdb') throw new MigrationError('NOT_FOUND')
  if (row.revertedAt !== null) throw new MigrationError('MIGRATION_REVERTED', { migrationId })
  const dependents = state.ledger.filter(
    (r) => r.revertedAt === null && r.dependencies.includes(migrationId),
  )
  if (dependents.length > 0) {
    // Roll back the dependents first, each in its own explicit plan.
    throw new MigrationError('MIGRATION_ROLLBACK_BLOCKED', {
      migrationId,
      reason: 'dependents_applied',
    })
  }
  const latest = [...state.ledger]
    .filter((r) => r.revertedAt === null)
    .sort((a, b) => Number(b.appliedSeq) - Number(a.appliedSeq))[0]
  if (latest?.migrationId !== migrationId) {
    // L3 compares with the migration's fingerprint_before, which only holds for
    // the latest applied migration: later ones are rolled back first.
    throw new MigrationError('MIGRATION_ROLLBACK_BLOCKED', { migrationId, reason: 'not_latest' })
  }
  if (latest.fingerprintAfter !== state.fingerprint) {
    // Something changed the schema beside the ledger: no rollback onto unknown state.
    throw new MigrationError('SCHEMA_FINGERPRINT_MISMATCH')
  }
  const revision = (await revisionsOf(tx, target.projectId, migrationId)).find(
    (r) => r.checksum === row.checksum && r.files['down.sql'] !== null && r.rollbackDigest !== null,
  )
  if (revision === undefined) {
    throw new MigrationError('MIGRATION_ROLLBACK_BLOCKED', { migrationId, reason: 'no_down_sql' })
  }
  const down = normalizeSqlSource(revision.files['down.sql'] as Uint8Array)
  const analysis = down.ok
    ? analyzeMigrationSql(
        state.serverVersionNum >= 180000 ? 18 : state.serverVersionNum >= 170000 ? 17 : 16,
        down.value,
        {
          trustedExtensions: project.trustedExtensions,
        },
      )
    : null
  if (analysis === null || !analysis.ok) throw new MigrationError('MIGRATION_STATEMENT_FORBIDDEN')
  const forbidden = analysis.statements.filter(
    (s) => s.forbidden !== null || s.autocommitOnly,
  ).length
  const rollback = revision.manifest['rollback']
  // The declared safety (R of c1 lives in the manifest file; P does not carry it): read the stored YAML.
  const safety = declaredSafety(revision.files['migration.yaml'], rollback)
  const flags: CompatibilityClass[] = analysis.statements.flatMap((s) => [...s.compatibility])
  const observed: CompatibilityClass =
    safety === 'lossy' || safety === 'unsafe'
      ? 'destructive'
      : flags.length === 0
        ? 'unknown'
        : flags.includes('unknown')
          ? 'unknown'
          : mostSevere(flags)
  const execution = revision.manifest['execution'] as {
    role?: string
    searchPath?: string[]
    lockTimeout?: number
    statementTimeout?: number
  }
  const role = project.executionRoles[execution.role ?? '']
  const item: PlanItem = {
    migrationId,
    name: revision.name,
    revision: revision.revision,
    checksum: revision.checksum,
    verifyDigest: revision.verifyDigest,
    rollbackDigest: revision.rollbackDigest,
    sourceDigest: revision.sourceDigest,
    bundleDigest: revision.bundleDigest,
    transactional: true,
    executionRole: role ?? '',
    searchPath: execution.searchPath ?? [],
    lockTimeoutMs: execution.lockTimeout ?? 5000,
    statementTimeoutMs: execution.statementTimeout ?? 900_000,
    dependsOn: [...revision.dependsOn],
    source: null,
    verifyChecks: 0,
    consumerCode: [],
  }
  const facts: MigrationFacts = {
    compatibility: observed,
    lockSeverity: worstSeverity(analysis.statements.flatMap((s) => s.locks.map((l) => l.severity))),
    nontransactional: false,
    blockingFindings: forbidden,
    consumerCode: 0,
    requirementsUnmet: role === undefined ? ['execution_role'] : [],
    evidence: 'not_required',
    lineage: 'not_required',
    dependenciesVerified: true,
    legacyProject: state.meta.baselineId !== null,
  }
  const content: RollbackContent = {
    projectId: target.projectId,
    migrations: [item],
    execution: { mode: 'transactional', lockWaitSeconds: 30, stopOnVerificationFailure: true },
    target: {
      targetId: target.targetId,
      path: target.path,
      tier: target.tier,
      generation: target.generation,
      clusterSystemIdentifier: state.systemIdentifier,
      databaseOid: state.databaseOid,
      serverVersionNum: state.serverVersionNum,
    },
    expectedState: {
      schemaFingerprint: state.fingerprint,
      ledgerStateHash: state.ledgerStateHash,
      extensions: { ...state.extensions },
      executionRoles: role === undefined ? {} : { [execution.role ?? '']: role },
    },
    evidence: null,
    facts,
    safety,
    fingerprintBeforeMigration: row.fingerprintBefore,
  }
  const policy = await evaluateRegistryPolicy(tx, ctx.policy, {
    kind: 'migration.rollback',
    actor,
    subject: {
      productId: target.productId,
      projectId: target.projectId,
      environmentId: target.environmentId,
      targetId: target.targetId,
      tier: target.tier,
    },
    content: content as unknown as JsonObject,
  })
  return createPlan(
    tx,
    {
      kind: 'migration.rollback',
      kindVersion: 1,
      // critical on prod tier when rollback.safety is lossy or unsafe (actions.ts)
      actionClass: target.tier === 'prod' && safety !== 'safe' ? 'critical' : 'high',
      actor: operationActor(actor),
      subject: {
        targetId: target.targetId,
        targetPath: target.path,
        tier: target.tier,
        generation: target.generation,
        clusterId: target.placement.clusterId,
        productId: target.productId,
        projectId: target.projectId,
        environmentId: target.environmentId,
      },
      content: content as unknown as JsonObject,
      analysis: {
        migrationId,
        safety,
        statements: analysis.statements.length,
        compatibility: observed,
        dependents: 0,
      },
      policy,
    },
    { clock: ctx.policy.clock },
  )
}

function isSafety(v: unknown): v is 'safe' | 'lossy' | 'unsafe' {
  return v === 'safe' || v === 'lossy' || v === 'unsafe'
}

/** `rollback.safety` of the stored manifest (validated at ingestion); null when not declared. */
function declaredSafety(
  yaml: Uint8Array,
  fromProjection: unknown,
): 'safe' | 'lossy' | 'unsafe' | null {
  const projected = (fromProjection as { safety?: unknown } | undefined)?.safety
  if (isSafety(projected)) return projected
  const text = decodeUtf8(yaml)
  if (!text.ok) return null
  const parsed = parseStrictYaml(text.value)
  if (!parsed.ok) return null
  const r = (parsed.value as { rollback?: { safety?: unknown } } | null)?.rollback?.safety
  return isSafety(r) ? r : null
}

export class MigrationRollbackKind implements OperationKind {
  readonly kind = 'migration.rollback'
  readonly version = 1
  readonly actionClass = 'high' as const
  readonly verifies = true
  readonly #deps: MigrationKindDeps

  constructor(deps: MigrationKindDeps) {
    this.#deps = deps
  }

  exclusivity(plan: PlanRecord): readonly string[] {
    try {
      return [`target:${contentOf(plan).target.targetId}:schema`]
    } catch {
      return []
    }
  }

  async #state(
    c: RollbackContent,
    target: TargetRecord,
    connector: Connector,
    role: 'observer' | 'migrator',
    purpose: string,
  ) {
    const project = await projectRegistry(this.#deps.store, c.projectId)
    const opened = await connector.forTarget(target, role, purpose)
    return { opened, project }
  }

  async checkBindings(plan: PlanRecord): Promise<readonly ChangedBinding[]> {
    let c: RollbackContent
    try {
      c = contentOf(plan)
    } catch {
      return [{ binding: 'content', actual: 'invalid' }]
    }
    const target = await findTarget(this.#deps.store, c.target.targetId)
    if (
      target === undefined ||
      target.state !== 'active' ||
      target.generation !== c.target.generation
    ) {
      return [{ binding: 'target', actual: target?.state ?? 'missing' }]
    }
    const { opened, project } = await this.#state(
      c,
      target,
      this.#deps.connector,
      'observer',
      `bindings/${target.targetId}`,
    )
    try {
      const state = await opened.session.readOnly((tx) =>
        readTargetState(
          tx,
          {
            installationId: this.#deps.installationId,
            targetId: target.targetId,
            generation: target.generation,
            systemIdentifier: c.target.clusterSystemIdentifier,
          },
          project.scope,
          { sizes: false },
        ),
      )
      const changed: ChangedBinding[] = []
      if (state.ledgerStateHash !== c.expectedState.ledgerStateHash)
        changed.push({ binding: 'ledger', actual: 'changed' })
      if (state.fingerprint !== c.expectedState.schemaFingerprint)
        changed.push({ binding: 'fingerprint', actual: 'changed' })
      return changed
    } catch {
      return [{ binding: 'target', actual: 'unreachable' }]
    } finally {
      await opened.session.close()
    }
  }

  async execute(ctx: ExecutionContext): Promise<ExecutionOutcome> {
    const c = contentOf(ctx.plan)
    const item = c.migrations[0]
    const fence: Fence = {
      store: this.#deps.store,
      operationId: ctx.operationId,
      leaseOwner: ctx.leaseOwner,
    }
    const target = await findTarget(this.#deps.store, c.target.targetId)
    const revision = await readRevision(
      this.#deps.store,
      c.projectId,
      item.migrationId,
      item.revision,
    )
    if (
      target === undefined ||
      revision === undefined ||
      revision.bundleDigest !== item.bundleDigest
    ) {
      return {
        outcome: 'not_applied',
        errorCode: 'PLAN_STALE',
        detail: { changedBindings: ['content'] },
      }
    }
    await fenced(fence, 'migrations.rollback.progress', (tx) =>
      writeProgress(tx, ctx.operationId, {
        position: 0,
        migrationId: item.migrationId,
        name: item.name,
        applyOutcome: 'not_started',
        verificationOutcome: 'not_applicable',
        statementIndex: null,
        sqlstate: null,
        errorCode: null,
        gate: null,
      }),
    )
    const { opened, project } = await this.#state(
      c,
      target,
      this.#deps.connector,
      'migrator',
      ctx.operationId,
    )
    const session = opened.session
    let release: (() => Promise<void>) | undefined
    try {
      try {
        release = await takeTargetLock(session, target.targetId, 'schema', {
          deadlineMs: c.execution.lockWaitSeconds * 1000,
          signal: ctx.signal,
        })
      } catch (error) {
        if (error instanceof LockUnavailable)
          return { outcome: 'not_applied', errorCode: 'MIGRATION_LOCK_TIMEOUT' }
        throw error
      }
      const state = await session.readOnly((tx) =>
        readTargetState(
          tx,
          {
            installationId: this.#deps.installationId,
            targetId: target.targetId,
            generation: c.target.generation,
            systemIdentifier: c.target.clusterSystemIdentifier,
          },
          project.scope,
          { sizes: false },
        ),
      )
      if (
        state.ledgerStateHash !== c.expectedState.ledgerStateHash ||
        state.fingerprint !== c.expectedState.schemaFingerprint
      ) {
        return {
          outcome: 'not_applied',
          errorCode: 'PLAN_STALE',
          detail: { changedBindings: ['ledger'] },
        }
      }
      const step = await runTransactional({
        session,
        content: { ...c, evidence: null } as unknown as PlanContent,
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
        fingerprintBefore: state.fingerprint,
        stillHolds: () => leaseHeld(this.#deps.store, ctx.operationId, ctx.leaseOwner),
        file: 'down.sql',
        record: async (fingerprintAfter, durationMs, statements) => {
          if (!(await markReverted(session, item.migrationId, ctx.operationId))) {
            throw new MigrationError('MIGRATION_ALREADY_APPLIED')
          }
          await insertMigrationEvent(session, {
            migrationId: item.migrationId,
            operationId: ctx.operationId,
            event: 'reverted',
            detail: { revision: item.revision, statements, durationMs, fingerprintAfter },
          })
        },
      })
      if (step.result === 'unknown') return 'unknown'
      if (step.result === 'failed') {
        await fenced(fence, 'migrations.rollback.failed', (tx) =>
          writeProgress(tx, ctx.operationId, {
            position: 0,
            migrationId: item.migrationId,
            name: item.name,
            applyOutcome: 'not_applied',
            verificationOutcome:
              step.errorCode === 'VERIFICATION_FAILED' ? 'failed' : 'not_applicable',
            statementIndex: step.statementIndex,
            sqlstate: step.sqlstate,
            errorCode: step.errorCode,
            gate: step.gate,
          }),
        )
        return { outcome: 'not_applied', errorCode: step.errorCode }
      }
      const rows = await session.readOnly((tx) => readLedgerRows(tx))
      const baseline = (await session.readOnly((tx) => readLedgerMeta(tx)))?.baselineId ?? null
      await fenced(fence, 'migrations.rollback.applied', async (tx) => {
        await writeProgress(tx, ctx.operationId, {
          position: 0,
          migrationId: item.migrationId,
          name: item.name,
          applyOutcome: 'applied',
          verificationOutcome: 'pending',
          statementIndex: null,
          sqlstate: null,
          errorCode: null,
          gate: null,
        })
        await writeMirror(tx, {
          targetId: target.targetId,
          generation: c.target.generation,
          rows,
          ledgerStateHash: ledgerHashOf(rows, baseline),
          baselineId: baseline,
        })
      })
      return 'applied'
    } finally {
      await release?.().catch(() => undefined)
      await session.close()
    }
  }

  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    const c = contentOf(ctx.plan)
    const item = c.migrations[0]
    const progress = (await readProgress(this.#deps.store, ctx.operationId))[0]
    if (progress !== undefined && progress.verificationOutcome !== 'pending') {
      return progress.verificationOutcome === 'not_applicable'
        ? 'error'
        : progress.verificationOutcome
    }
    const target = await findTarget(this.#deps.store, c.target.targetId)
    const revision = await readRevision(
      this.#deps.store,
      c.projectId,
      item.migrationId,
      item.revision,
    )
    if (target === undefined || revision === undefined) return 'error'
    const project = await projectRegistry(this.#deps.store, c.projectId)
    const run = await verifyMigration(this.#deps.connector, target, {
      operationId: ctx.operationId,
      item,
      revision,
      fingerprintAfter: c.fingerprintBeforeMigration,
      scope: project.scope,
      trustedExtensions: project.trustedExtensions,
      extensions: null,
      file: 'down.sql',
    })
    const opened = await this.#deps.connector.forTarget(target, 'migrator', ctx.operationId)
    try {
      await opened.session.transaction(() =>
        insertVerification(opened.session, {
          verificationId: run.verificationId,
          migrationId: run.migrationId,
          operationId: ctx.operationId,
          verifyDigest: null,
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
      await opened.session.close()
    }
    await fenced(
      { store: this.#deps.store, operationId: ctx.operationId, leaseOwner: ctx.leaseOwner },
      'migrations.rollback.verified',
      async (tx) => {
        await writeVerificationMirror(
          tx,
          {
            targetId: c.target.targetId,
            generation: c.target.generation,
            operationId: ctx.operationId,
          },
          { ...run, verifyDigest: null },
        )
        await writeProgress(tx, ctx.operationId, {
          position: 0,
          migrationId: item.migrationId,
          name: item.name,
          applyOutcome: 'applied',
          verificationOutcome: run.status,
          statementIndex: null,
          sqlstate: null,
          errorCode:
            run.status === 'passed'
              ? null
              : run.status === 'error'
                ? 'VERIFICATION_ERROR'
                : 'VERIFICATION_FAILED',
          gate: null,
        })
      },
    )
    return run.status
  }

  async reconcile(ctx: ExecutionContext): Promise<'applied' | 'not_applied' | 'unknown'> {
    const c = contentOf(ctx.plan)
    const item = c.migrations[0]
    const target = await findTarget(this.#deps.store, c.target.targetId)
    if (target === undefined) return 'unknown'
    try {
      const opened = await this.#deps.connector.forTarget(
        target,
        'migrator',
        `reconcile/${ctx.operationId}`,
      )
      let release: (() => Promise<void>) | undefined
      try {
        release = await takeTargetLock(opened.session, target.targetId, 'schema', {
          deadlineMs: 120_000,
          signal: ctx.signal,
        })
        const rows = await opened.session.readOnly((tx) => readLedgerRows(tx))
        const row = rows.find((r) => r.migrationId === item.migrationId)
        if (row === undefined) return 'unknown'
        return row.revertedByOp === ctx.operationId ? 'applied' : 'not_applied'
      } finally {
        await release?.().catch(() => undefined)
        await opened.session.close()
      }
    } catch {
      return 'unknown'
    }
  }
}

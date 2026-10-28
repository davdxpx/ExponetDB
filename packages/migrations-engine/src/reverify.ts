import type { Tx } from '@exponetdb/control-store'
import type { JsonObject } from '@exponetdb/kernel'
import { normalizeSqlSource } from '@exponetdb/migrations/format'
import { isBaselineRef } from '@exponetdb/migrations/graph'
import {
  type ChangedBinding,
  createPlan,
  type ExecutionContext,
  type ExecutionOutcome,
  type OperationKind,
  type PlanRecord,
} from '@exponetdb/operations'
import type { MigrationFacts } from '@exponetdb/policy'
import { insertVerification, readLedgerRows, resolveVerifyCatalog } from '@exponetdb/postgres'
import { analyzeVerifyFile, loadParser } from '@exponetdb/postgres/parser'
import {
  type Connector,
  evaluateRegistryPolicy,
  findTarget,
  operationActor,
  type RegistryActor,
  RegistryError,
  type TargetRecord,
} from '@exponetdb/registry'
import type { PlanItem } from './content.ts'
import type { MigrationKindDeps } from './deps.ts'
import { MigrationError } from './errors.ts'
import { executionRolesFor } from './execution-roles.ts'
import { type BaselineVerifyContent, baselineToVerify, verifyBaselineAgain } from './legacy.ts'
import type { MigrationPlanContext } from './planner.ts'
import {
  type Fence,
  fenced,
  readProgress,
  writeProgress,
  writeVerificationMirror,
} from './records.ts'
import { stuckOperationOf } from './recovery.ts'
import { readRevision, revisionsOf, type StoredRevision } from './store.ts'
import { verifyMigration } from './verification.ts'

/**
 * `migration.verify` ([verification.md §5](../../../exponetdb-docs/04-migrations/verification.md#retrying-verification)):
 * runs L1 to L3 again for an applied migration with the verify.sql of a
 * stored revision of the same apply checksum (by default the newest one),
 * appends a verification run to the target's history and the mirror. It
 * never runs `up.sql`. Low class: planned and accepted in one request; a
 * declared consumer check still requires its approval.
 */
interface VerifyContent {
  readonly projectId: string
  readonly targetId: string
  readonly path: string
  readonly tier: 'prod' | 'nonprod'
  readonly generation: number
  readonly migrationId: string
  readonly checksum: string
  readonly revision: number
  readonly bundleDigest: string
  readonly verifyDigest: string | null
  readonly item: PlanItem
  readonly facts: MigrationFacts
  /** The operation in needs_attention this plan recovers and closes (recovery.ts, TC-005). */
  readonly supersedes?: string
}

/** The content of a re-verification of a baseline ref (follow-up 3, F3), or `undefined`. */
function baselineVariantOf(plan: Pick<PlanRecord, 'body'>): BaselineVerifyContent | undefined {
  const c = plan.body['content'] as unknown as BaselineVerifyContent | undefined
  if (c?.baseline !== true) return undefined
  if (
    typeof c.targetId !== 'string' ||
    typeof c.migrationId !== 'string' ||
    typeof c.baselinePlanId !== 'string' ||
    typeof c.generation !== 'number'
  ) {
    throw new MigrationError('PLAN_STALE')
  }
  return c
}

function contentOf(plan: Pick<PlanRecord, 'body'>): VerifyContent {
  const c = plan.body['content'] as unknown as VerifyContent | undefined
  if (
    c === undefined ||
    typeof c.targetId !== 'string' ||
    typeof c.migrationId !== 'string' ||
    typeof c.revision !== 'number' ||
    typeof c.item !== 'object'
  ) {
    throw new MigrationError('PLAN_STALE')
  }
  return c
}

async function ledgerRowOf(connector: Connector, target: TargetRecord, migrationId: string) {
  const opened = await connector.forTarget(target, 'observer', `verify-plan/${target.targetId}`)
  try {
    const rows = await opened.session.readOnly((tx) => readLedgerRows(tx))
    return {
      row: rows.find((r) => r.migrationId === migrationId),
      major: opened.session.facts.major,
      rows,
    }
  } finally {
    await opened.session.close()
  }
}

/** The plan of a re-verification. */
export async function planMigrationVerify(
  tx: Tx,
  ctx: MigrationPlanContext,
  actor: RegistryActor,
  targetRef: string,
  migrationId: string,
  request: { readonly revision?: number | undefined },
): Promise<PlanRecord> {
  const target = await findTarget(tx, targetRef)
  if (target === undefined) throw new MigrationError('TARGET_NOT_FOUND')
  if (target.placement === null) throw new MigrationError('TARGET_UNAVAILABLE')
  if (isBaselineRef(migrationId)) {
    if (request.revision !== undefined) {
      throw new RegistryError('VALIDATION_FAILED', {
        errors: [
          { path: '/revision', code: 'not_a_bundle', message: 'A baseline has no revisions.' },
        ],
      })
    }
    return planBaselineReverify(tx, ctx, actor, target, migrationId)
  }
  const { row, major } = await ledgerRowOf(ctx.connector, target, migrationId)
  if (row === undefined || row.origin !== 'exponetdb') {
    throw new MigrationError('NOT_FOUND')
  }
  if (row.revertedAt !== null) {
    throw new MigrationError('MIGRATION_REVERTED', { migrationId })
  }
  const revisions = (await revisionsOf(tx, target.projectId, migrationId)).filter(
    (r) => r.checksum === row.checksum,
  )
  const revision: StoredRevision | undefined =
    request.revision === undefined
      ? revisions[0]
      : revisions.find((r) => r.revision === request.revision)
  if (revision === undefined) {
    throw new MigrationError('NOT_FOUND')
  }
  // The consumer code the verify.sql declares, bound by definition digest.
  await loadParser(major)
  const verifyBytes = revision.files['verify.sql']
  let consumerCode: PlanItem['consumerCode'] = []
  let checks = 0
  if (verifyBytes !== null) {
    const text = normalizeSqlSource(verifyBytes)
    const file = text.ok ? analyzeVerifyFile(major, text.value) : null
    if (file === null || !file.ok) {
      const construct =
        file !== null && !file.ok ? (file.refusal.construct ?? file.refusal.reason) : 'encoding'
      const check = file !== null && !file.ok && file.check !== null ? file.check.name : 'file'
      // A statement form is MIGRATION_STATEMENT_FORBIDDEN, anything else the admission cannot
      // classify VERIFY_CONSTRUCT_UNSUPPORTED (verification.md §4.2).
      throw new MigrationError(
        file !== null && !file.ok && file.refusal.code === 'MIGRATION_STATEMENT_FORBIDDEN'
          ? 'MIGRATION_STATEMENT_FORBIDDEN'
          : 'VERIFY_CONSTRUCT_UNSUPPORTED',
        { construct, check },
      )
    }
    checks = file.checks.length
    const opened = await ctx.connector.forTarget(
      target,
      'observer',
      `verify-plan/${target.targetId}`,
    )
    try {
      const resolution = await opened.session.readOnly((rtx) =>
        resolveVerifyCatalog(rtx, file.checks),
      )
      if (!resolution.ok) {
        throw new MigrationError('VERIFY_CONSTRUCT_UNSUPPORTED', {
          construct: resolution.construct.slice(0, 256),
          check: resolution.check === null ? 'file' : String(resolution.check),
        })
      }
      consumerCode = resolution.consumer
    } finally {
      await opened.session.close()
    }
  }
  const execution = revision.manifest['execution'] as
    | { searchPath?: string[]; role?: string }
    | undefined
  // Recorded for the plan view: verify.sql runs as the verifier, never as this role.
  const { roles } = await executionRolesFor(tx, target)
  const item: PlanItem = {
    migrationId,
    name: revision.name,
    revision: revision.revision,
    checksum: revision.checksum,
    verifyDigest: revision.verifyDigest,
    rollbackDigest: revision.rollbackDigest,
    sourceDigest: revision.sourceDigest,
    bundleDigest: revision.bundleDigest,
    transactional: revision.transactional,
    executionRole: roles[execution?.role ?? ''] ?? '',
    searchPath: execution?.searchPath ?? [],
    lockTimeoutMs: 0,
    statementTimeoutMs: 0,
    dependsOn: [...revision.dependsOn],
    source: null,
    verifyChecks: checks,
    consumerCode,
  }
  const facts: MigrationFacts = {
    compatibility: 'additive',
    lockSeverity: 'none',
    nontransactional: false,
    blockingFindings: 0,
    consumerCode: consumerCode.length,
    requirementsUnmet: [],
    evidence: 'not_required',
    lineage: 'not_required',
    dependenciesVerified: true,
    legacyProject: false,
  }
  const stuck = await stuckOperationOf(tx, target.targetId, migrationId)
  const content: VerifyContent = {
    projectId: target.projectId,
    targetId: target.targetId,
    path: target.path,
    tier: target.tier,
    generation: target.generation,
    migrationId,
    checksum: row.checksum,
    revision: revision.revision,
    bundleDigest: revision.bundleDigest,
    verifyDigest: revision.verifyDigest,
    item,
    facts,
    ...(stuck === undefined ? {} : { supersedes: stuck }),
  }
  const subject = {
    productId: target.productId,
    projectId: target.projectId,
    environmentId: target.environmentId,
    targetId: target.targetId,
    tier: target.tier,
  }
  const policy = await evaluateRegistryPolicy(tx, ctx.policy, {
    kind: 'migration.verify',
    actor,
    subject,
    content: content as unknown as JsonObject,
  })
  return createPlan(
    tx,
    {
      kind: 'migration.verify',
      kindVersion: 1,
      actionClass: 'low',
      actor: operationActor(actor),
      subject: {
        targetId: target.targetId,
        targetPath: target.path,
        tier: target.tier,
        generation: target.generation,
        productId: target.productId,
        projectId: target.projectId,
        environmentId: target.environmentId,
      },
      content: content as unknown as JsonObject,
      analysis: {
        migrationId,
        revision: revision.revision,
        verifyChecks: checks,
        ...(stuck === undefined ? {} : { supersedes: stuck }),
      },
      policy,
    },
    { clock: ctx.policy.clock },
  )
}

/**
 * The plan of a re-verification of a recorded baseline (legacy-import.md §2
 * step 7, follow-up 3 F3): the same check the baseline's own verification
 * ran, with the review decisions that excuse failing expectations. A
 * baseline whose verification failed (an engine that read it wrongly) gets
 * a new run this way; when it passes, its schema becomes the drift
 * reference. The baseline operation keeps its outcome (operations never
 * change after they end); the target's verification history and the
 * mirror carry the new run.
 */
async function planBaselineReverify(
  tx: Tx,
  ctx: MigrationPlanContext,
  actor: RegistryActor,
  target: TargetRecord,
  migrationId: string,
): Promise<PlanRecord> {
  const found = await baselineToVerify(tx, ctx.connector, target, migrationId)
  const content: BaselineVerifyContent = {
    baseline: true,
    projectId: target.projectId,
    targetId: target.targetId,
    path: target.path,
    tier: target.tier,
    generation: target.generation,
    ...found,
  }
  const facts: MigrationFacts = {
    compatibility: 'additive',
    lockSeverity: 'none',
    nontransactional: false,
    blockingFindings: 0,
    consumerCode: 0,
    requirementsUnmet: [],
    evidence: 'not_required',
    lineage: 'not_required',
    dependenciesVerified: true,
    legacyProject: true,
  }
  const subject = {
    productId: target.productId,
    projectId: target.projectId,
    environmentId: target.environmentId,
    targetId: target.targetId,
    tier: target.tier,
  }
  const policy = await evaluateRegistryPolicy(tx, ctx.policy, {
    kind: 'migration.verify',
    actor,
    subject,
    content: { ...content, facts } as unknown as JsonObject,
  })
  return createPlan(
    tx,
    {
      kind: 'migration.verify',
      kindVersion: 1,
      actionClass: 'low',
      actor: operationActor(actor),
      subject: {
        targetId: target.targetId,
        targetPath: target.path,
        tier: target.tier,
        generation: target.generation,
        productId: target.productId,
        projectId: target.projectId,
        environmentId: target.environmentId,
      },
      content: { ...content, facts } as unknown as JsonObject,
      analysis: { migrationId, baselinePlanId: found.baselinePlanId, reportId: found.reportId },
      policy,
    },
    { clock: ctx.policy.clock },
  )
}

export class MigrationVerifyKind implements OperationKind {
  readonly kind = 'migration.verify'
  readonly version = 1
  readonly actionClass = 'low' as const
  readonly verifies = true
  readonly #deps: MigrationKindDeps

  constructor(deps: MigrationKindDeps) {
    this.#deps = deps
  }

  exclusivity(plan: PlanRecord): readonly string[] {
    try {
      return [`target:${(baselineVariantOf(plan) ?? contentOf(plan)).targetId}:schema`]
    } catch {
      return []
    }
  }

  supersedes(plan: PlanRecord): readonly string[] {
    try {
      const named = baselineVariantOf(plan) === undefined ? contentOf(plan).supersedes : undefined
      return named === undefined ? [] : [named]
    } catch {
      return []
    }
  }

  async checkBindings(plan: PlanRecord): Promise<readonly ChangedBinding[]> {
    let baseline: BaselineVerifyContent | undefined
    try {
      baseline = baselineVariantOf(plan)
    } catch {
      return [{ binding: 'content', actual: 'invalid' }]
    }
    if (baseline !== undefined) return this.#baselineBindings(baseline)
    let c: VerifyContent
    try {
      c = contentOf(plan)
    } catch {
      return [{ binding: 'content', actual: 'invalid' }]
    }
    const target = await findTarget(this.#deps.store, c.targetId)
    if (target === undefined || target.generation !== c.generation) {
      return [{ binding: 'target', actual: target === undefined ? 'missing' : 'generation' }]
    }
    try {
      const { row } = await ledgerRowOf(this.#deps.connector, target, c.migrationId)
      if (row === undefined || row.checksum !== c.checksum || row.revertedAt !== null) {
        return [{ binding: 'ledger', actual: 'changed' }]
      }
    } catch {
      return [{ binding: 'target', actual: 'unreachable' }]
    }
    // The operation this plan recovers still needs attention: retried or closed since, the plan is stale.
    // (Read on its own connection, so the worker's closing of it, not yet committed, is not seen.)
    if (c.supersedes !== undefined) {
      const state = await this.#deps.store.query(
        'migrations.reverify.stuck_state',
        'SELECT state FROM operations.operations WHERE operation_id = $1',
        [c.supersedes],
      )
      if (state.rows[0]?.text('state') !== 'needs_attention') {
        return [{ binding: 'operation', actual: state.rows[0]?.text('state') ?? 'missing' }]
      }
    }
    return []
  }

  /** The baseline's ledger row still stands, written by the plan the content names. */
  async #baselineBindings(c: BaselineVerifyContent): Promise<readonly ChangedBinding[]> {
    const target = await findTarget(this.#deps.store, c.targetId)
    if (target === undefined || target.generation !== c.generation) {
      return [{ binding: 'target', actual: target === undefined ? 'missing' : 'generation' }]
    }
    try {
      const { row } = await ledgerRowOf(this.#deps.connector, target, c.migrationId)
      if (row === undefined || row.planId !== c.baselinePlanId || row.revertedAt !== null) {
        return [{ binding: 'ledger', actual: 'changed' }]
      }
    } catch {
      return [{ binding: 'target', actual: 'unreachable' }]
    }
    return []
  }

  async #run(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    const c = contentOf(ctx.plan)
    const fence: Fence = {
      store: this.#deps.store,
      operationId: ctx.operationId,
      leaseOwner: ctx.leaseOwner,
    }
    const target = await findTarget(this.#deps.store, c.targetId)
    const revision = await readRevision(this.#deps.store, c.projectId, c.migrationId, c.revision)
    if (
      target === undefined ||
      revision === undefined ||
      revision.bundleDigest !== c.bundleDigest
    ) {
      return 'error'
    }
    const { rows: scopeRows } = await this.#deps.store.query(
      'migrations.verify.scope',
      'SELECT managed_scope, trusted_extensions FROM registry.projects WHERE project_id = $1',
      [c.projectId],
    )
    const scope = (scopeRows[0]?.json('managed_scope') ?? {}) as {
      includeSchemas?: string[]
      excludeSchemas?: string[]
    }
    const trusted = (scopeRows[0]?.json('trusted_extensions') ?? []) as string[]
    // L3 compares with the fingerprint the latest applied migration recorded.
    const { rows } = await ledgerRowOf(this.#deps.connector, target, c.migrationId)
    const latest = [...rows]
      .filter((r) => r.revertedAt === null && r.fingerprintAfter !== null)
      .sort((a, b) => Number(b.appliedSeq) - Number(a.appliedSeq))[0]
    const run = await verifyMigration(this.#deps.connector, target, {
      operationId: ctx.operationId,
      item: c.item,
      revision,
      fingerprintAfter: latest?.fingerprintAfter ?? null,
      scope: {
        ...(scope.includeSchemas === undefined ? {} : { includeSchemas: scope.includeSchemas }),
        excludeSchemas: scope.excludeSchemas ?? [],
      },
      trustedExtensions: trusted,
      extensions: null,
    })
    const opened = await this.#deps.connector.forTarget(target, 'migrator', ctx.operationId)
    try {
      await opened.session.transaction(() =>
        insertVerification(opened.session, {
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
      await opened.session.close()
    }
    await fenced(fence, 'migrations.verify.recorded', async (tx) => {
      await writeVerificationMirror(
        tx,
        { targetId: c.targetId, generation: c.generation, operationId: ctx.operationId },
        run,
      )
      await writeProgress(tx, ctx.operationId, {
        position: 0,
        migrationId: c.migrationId,
        name: c.item.name,
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
    })
    return run.status
  }

  /** The request is carried out by recording a verification run; its result is the verification outcome. */
  async execute(ctx: ExecutionContext): Promise<ExecutionOutcome> {
    // A baseline's run is recorded in the verify step only (the per-migration progress names
    // bundle migrations, never a baseline).
    if (baselineVariantOf(ctx.plan) !== undefined) return 'applied'
    const c = contentOf(ctx.plan)
    await fenced(
      { store: this.#deps.store, operationId: ctx.operationId, leaseOwner: ctx.leaseOwner },
      'migrations.verify.start',
      (tx) =>
        writeProgress(tx, ctx.operationId, {
          position: 0,
          migrationId: c.migrationId,
          name: c.item.name,
          applyOutcome: 'applied',
          verificationOutcome: 'pending',
          statementIndex: null,
          sqlstate: null,
          errorCode: null,
          gate: null,
        }),
    )
    return 'applied'
  }

  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    try {
      const baseline = baselineVariantOf(ctx.plan)
      if (baseline !== undefined)
        return await verifyBaselineAgain(this.#deps, baseline, {
          store: this.#deps.store,
          operationId: ctx.operationId,
          leaseOwner: ctx.leaseOwner,
        })
    } catch {
      return 'error'
    }
    const fence: Fence = {
      store: this.#deps.store,
      operationId: ctx.operationId,
      leaseOwner: ctx.leaseOwner,
    }
    if (ctx.verificationRetry === true) {
      // An operator asked to verify again: a run that errored is pending again, so a takeover
      // continues it (read-only; nothing ran on the target in execute).
      await fenced(fence, 'migrations.verify.retry', async (tx) => {
        const [p] = await readProgress(tx, ctx.operationId)
        if (p !== undefined && p.verificationOutcome === 'error') {
          await writeProgress(tx, ctx.operationId, {
            ...p,
            verificationOutcome: 'pending',
            errorCode: null,
          })
        }
      })
    }
    const progress = await readProgress(this.#deps.store, ctx.operationId)
    const done = progress[0]
    if (
      done !== undefined &&
      done.verificationOutcome !== 'pending' &&
      done.verificationOutcome !== 'not_applicable'
    ) {
      return done.verificationOutcome
    }
    try {
      return await this.#run(ctx)
    } catch {
      return 'error'
    }
  }

  async reconcile(_ctx: ExecutionContext): Promise<'applied' | 'not_applied' | 'unknown'> {
    // Nothing on the target depends on execute: verification runs (again) in the verify step.
    return 'applied'
  }
}

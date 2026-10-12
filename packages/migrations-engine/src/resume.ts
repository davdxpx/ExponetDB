import type { Tx } from '@exponetdb/control-store'
import { canonicalBytes, isJsonObject, type JsonObject } from '@exponetdb/kernel'
import { sha256Hex } from '@exponetdb/kernel/hash'
import { normalizeSqlSource } from '@exponetdb/migrations/format'
import { createPlan, type PlanRecord, readOperation, readPlan } from '@exponetdb/operations'
import type { MigrationFacts } from '@exponetdb/policy'
import {
  type CatalogReader,
  checkExpectations,
  executionRoleFacts,
  executionRoleProblem,
  type IndexState,
  type MigrationEventRecord,
  pinSearchPath,
  readIndexState,
  readLedgerRows,
  readMigrationEvents,
} from '@exponetdb/postgres'
import {
  analyzeMigrationSql,
  type CompatibilityClass,
  loadParser,
  mostSevere,
  type StatementFacts,
  worstSeverity,
} from '@exponetdb/postgres/parser'
import {
  evaluateRegistryPolicy,
  findTarget,
  operationActor,
  type RegistryActor,
} from '@exponetdb/registry'
import {
  type PlanContent,
  type PlanItem,
  planContent,
  type Readback,
  type ResumeBinding,
} from './content.ts'
import { projectRegistry } from './deps.ts'
import { MigrationError } from './errors.ts'
import type { MigrationPlanContext } from './planner.ts'
import { readRevision } from './store.ts'
import { readTargetState } from './target.ts'

/**
 * `migration.resume` ([failure-and-recovery.md §2](../../../exponetdb-docs/04-migrations/failure-and-recovery.md#2-non-transactional-migrations),
 * G6 order §27): a non-transactional bundle that stopped part-way continues
 * only in a new, explicit plan. Nothing resumes on its own, and a missing
 * done event never proves a missing effect: the plan reads the target's
 * event log since the start, finds the first statement without a done
 * event and reads the catalog back for it:
 *
 * - `failed_without_effect`: the statement failed in autocommit (an SQLSTATE,
 *   or it never ran), so nothing of it took effect: it runs again;
 * - `present` / `absent`: after a crash gap the statement's structural
 *   expectations all hold (it took effect: recorded as done, the next one
 *   runs) or none does (it runs again);
 * - `invalid_index`: a `CREATE INDEX CONCURRENTLY` left an INVALID index;
 *   the plan continues only with an explicit cleanup (`DROP INDEX
 *   CONCURRENTLY` of exactly that index, by OID, as the execution role);
 * - `ambiguous` / `unreadable`: neither provable; a blocking finding, a
 *   person decides on the target.
 *
 * The plan binds the apply content of the original plan (checksum, bundle
 * digest, execution role, settings), the live partial fingerprint and
 * ledger hash, the event-log digest, the statement index, the readback and
 * the cleanup; apply re-reads all of them under the target lock.
 */
export type { Readback, ResumeBinding }

export interface ResumeLog {
  readonly originalOperationId: string
  readonly startedSeq: string
  readonly digest: string
  readonly next: number
  /** The failure recorded for `next` after its last attempt, if any. */
  readonly failed: { readonly sqlstate: string | null; readonly gate: JsonObject | null } | null
}

/**
 * The log of an incomplete start: the latest `nontx_started` of the
 * migration not closed by `ledger_reconciled` (callers check that the
 * ledger has no row). Null when there is nothing to resume.
 */
export function resumeLog(events: readonly MigrationEventRecord[]): ResumeLog | null {
  const ordered = [...events].sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1))
  let start = -1
  for (const [i, e] of ordered.entries()) if (e.event === 'nontx_started') start = i
  const started = ordered[start]
  if (started === undefined) return null
  const since = ordered.slice(start)
  if (since.some((e) => e.event === 'ledger_reconciled' || e.event === 'applied')) return null
  let next = 0
  let failed: ResumeLog['failed'] = null
  for (const e of since) {
    const index = e.detail['statementIndex']
    if (typeof index !== 'number') continue
    if (e.event === 'nontx_statement_done' && index + 1 > next) {
      next = index + 1
      failed = null
    } else if (e.event === 'nontx_failed' && index === next) {
      const sqlstate = e.detail['sqlstate']
      const gate = e.detail['gate']
      failed = {
        sqlstate: typeof sqlstate === 'string' ? sqlstate : null,
        gate: isJsonObject(gate) ? gate : null,
      }
    }
  }
  const bytes = canonicalBytes(
    since.map((e) => ({
      seq: e.seq,
      event: e.event,
      operationId: e.operationId,
      detail: e.detail,
    })),
  )
  // Ledger details are JSON objects read from jsonb: canonical form always exists.
  const digest = bytes.ok ? `sha256:${sha256Hex(bytes.value)}` : 'sha256:unreadable'
  return {
    originalOperationId: started.operationId,
    startedSeq: started.seq,
    digest,
    next,
    failed,
  }
}

/** The catalog readback of the first unfinished statement (runs inside a read-only transaction). */
export async function readBack(
  reader: CatalogReader,
  statements: readonly StatementFacts[],
  log: ResumeLog,
  searchPath: readonly string[],
): Promise<{ readonly state: Readback; readonly index: IndexState | null }> {
  const s = statements[log.next]
  if (s === undefined) return { state: 'all_done', index: null }
  await pinSearchPath(reader, searchPath)
  const indexExpectation = s.expectations.find((e) => e.kind === 'index')
  if (s.autocommitOnly && s.type === 'IndexStmt') {
    if (indexExpectation?.kind !== 'index') return { state: 'ambiguous', index: null }
    const index = await readIndexState(
      reader,
      indexExpectation.schema,
      indexExpectation.name,
      searchPath,
    )
    if (index === null) return { state: 'absent', index: null }
    if (!index.valid || !index.ready) return { state: 'invalid_index', index }
    return { state: 'present', index }
  }
  if (s.autocommitOnly && s.type === 'DropStmt' && indexExpectation?.kind === 'index') {
    const index = await readIndexState(
      reader,
      indexExpectation.schema,
      indexExpectation.name,
      searchPath,
    )
    // Gone: it took effect. Still there (also INVALID): DROP INDEX CONCURRENTLY runs again.
    return { state: index === null ? 'present' : 'absent', index }
  }
  const f = log.failed
  if (f !== null) {
    const guard = f.gate?.['guard']
    // An SQLSTATE: the autocommit statement rolled back. Neither SQLSTATE nor
    // guard: it never ran (cancelled before). A current_user guard: refused before it ran.
    if (f.sqlstate !== null || guard === undefined || guard === 'current_user') {
      return { state: 'failed_without_effect', index: null }
    }
  }
  // A crash gap (or a statement that ran with changed guards): only the catalog can tell.
  if (s.expectations.length === 0 || s.procedural) return { state: 'ambiguous', index: null }
  try {
    const results = await checkExpectations(
      reader,
      s.expectations.map((expectation) => ({ statement: s.index, expectation })),
    )
    const ok = results.filter((r) => r.ok).length
    if (ok === results.length) return { state: 'present', index: null }
    if (ok === 0) return { state: 'absent', index: null }
    return { state: 'ambiguous', index: null }
  } catch {
    return { state: 'unreadable', index: null }
  }
}

/** Where a resume continues for a readback; null when it cannot. */
export function resumeStart(
  log: ResumeLog,
  readback: Readback,
  statements: number,
  cleanup: boolean,
): number | null {
  switch (readback) {
    case 'all_done':
      return statements
    case 'present':
      return log.next + 1
    case 'absent':
    case 'failed_without_effect':
      return log.next
    case 'invalid_index':
      return cleanup ? log.next : null
    default:
      return null
  }
}

/** The plan of a resume. */
export async function planMigrationResume(
  tx: Tx,
  ctx: MigrationPlanContext,
  actor: RegistryActor,
  targetRef: string,
  migrationId: string,
  request: { readonly cleanup?: boolean | undefined },
): Promise<PlanRecord> {
  const target = await findTarget(tx, targetRef)
  if (target === undefined) throw new MigrationError('TARGET_NOT_FOUND')
  if (target.state !== 'active') {
    throw new MigrationError('TARGET_SUSPENDED', { reason: target.stateReason ?? 'administrator' })
  }
  if (target.placement === null) throw new MigrationError('TARGET_UNAVAILABLE')
  const project = await projectRegistry(tx, target.projectId)
  const opened = await ctx.connector.forTarget(target, 'observer', `resume-plan/${target.targetId}`)
  try {
    const major = opened.session.facts.major
    await loadParser(major)
    const read = await opened.session.readOnly(
      async (rtx) => {
        const state = await readTargetState(
          rtx,
          {
            installationId: ctx.installationId,
            targetId: target.targetId,
            generation: target.generation,
            systemIdentifier: target.placement?.systemIdentifier ?? null,
          },
          project.scope,
          { sizes: false },
        )
        const rows = await readLedgerRows(rtx)
        const events = await readMigrationEvents(rtx, { migrationId })
        return { state, rows, events }
      },
      { statementTimeoutMs: 60_000 },
    )
    if (read.rows.some((r) => r.migrationId === migrationId)) {
      throw new MigrationError('MIGRATION_ALREADY_APPLIED')
    }
    const log = resumeLog(read.events)
    if (log === null) throw new MigrationError('NOT_FOUND')
    // The original plan: its item (checksum, bundle digest, role, settings) and the fingerprint before.
    const original = await readOperation(tx, log.originalOperationId)
    const originalPlan =
      original === undefined ? undefined : await readPlan(tx, original.planId as string)
    if (originalPlan === undefined || originalPlan.kind !== 'migration.apply') {
      throw new MigrationError('NOT_FOUND')
    }
    const before = planContent(originalPlan)
    const item = before.migrations.find((m) => m.migrationId === migrationId)
    if (item === undefined || item.transactional) throw new MigrationError('NOT_FOUND')
    const revision = await readRevision(tx, target.projectId, migrationId, item.revision)
    if (
      revision === undefined ||
      revision.bundleDigest !== item.bundleDigest ||
      revision.checksum !== item.checksum
    ) {
      throw new MigrationError('PLAN_STALE')
    }
    const up = normalizeSqlSource(revision.files['up.sql'])
    const analysis = up.ok
      ? analyzeMigrationSql(major, up.value, { trustedExtensions: project.trustedExtensions })
      : null
    if (analysis === null || !analysis.ok) {
      throw new MigrationError('MIGRATION_STATEMENT_FORBIDDEN')
    }
    const back = await opened.session.readOnly(
      (rtx) => readBack(rtx, analysis.statements, log, item.searchPath),
      { statementTimeoutMs: 60_000 },
    )
    const wantsCleanup = request.cleanup === true && back.state === 'invalid_index'
    const from = resumeStart(log, back.state, analysis.statements.length, wantsCleanup)
    const remaining = analysis.statements.slice(from ?? log.next)
    const findings: JsonObject[] = []
    if (back.state === 'invalid_index' && !wantsCleanup) {
      findings.push({
        rule: 'resume_cleanup_required',
        statementIndex: log.next,
        message: 'An INVALID concurrent index is left; plan the resume with cleanup.',
      })
    }
    if (back.state === 'ambiguous' || back.state === 'unreadable') {
      findings.push({
        rule: 'resume_readback_ambiguous',
        statementIndex: log.next,
        message: 'The catalog cannot prove whether the statement took effect.',
      })
    }
    for (const s of remaining) {
      if (s.forbidden !== null) {
        findings.push({ rule: 'statement_forbidden', statementIndex: s.index, message: s.kind })
      }
    }
    // The execution role is still mapped the same way and still usable.
    const alias = (revision.manifest['execution'] as { role?: string } | undefined)?.role ?? ''
    const roleFacts = await opened.session.readOnly((rtx) =>
      executionRoleFacts(rtx, [item.executionRole], 'exponetdb_migrator'),
    )
    const roleUsable =
      project.executionRoles[alias] === item.executionRole &&
      roleFacts.every((f) => executionRoleProblem(f) === null)
    const flags: CompatibilityClass[] = remaining.flatMap((s) => [...s.compatibility])
    const facts: MigrationFacts = {
      // Dropping an INVALID index loses no data; the remaining statements decide.
      compatibility:
        flags.length === 0 ? 'additive' : flags.includes('unknown') ? 'unknown' : mostSevere(flags),
      lockSeverity: worstSeverity(remaining.flatMap((s) => s.locks.map((l) => l.severity))),
      nontransactional: true,
      blockingFindings: findings.length,
      consumerCode: 0,
      requirementsUnmet: roleUsable ? [] : ['execution_role'],
      evidence: 'not_required',
      lineage: 'not_required',
      dependenciesVerified: true,
      legacyProject: read.state.meta.baselineId !== null,
    }
    const resume: ResumeBinding = {
      originalOperationId: log.originalOperationId,
      startedSeq: log.startedSeq,
      eventLogDigest: log.digest,
      nextStatement: log.next,
      fromStatement: from ?? log.next,
      statements: analysis.statements.length,
      readback: back.state,
      cleanup:
        wantsCleanup && back.index !== null
          ? { indexOid: back.index.oid, schema: back.index.schema, name: back.index.name }
          : null,
      fingerprintBeforeMigration: before.expectedState.schemaFingerprint,
    }
    const content: PlanContent & { readonly resume: ResumeBinding } = {
      projectId: target.projectId,
      migrations: [item] as readonly PlanItem[],
      execution: { mode: 'nontransactional', lockWaitSeconds: 30, stopOnVerificationFailure: true },
      target: {
        targetId: target.targetId,
        path: target.path,
        tier: target.tier,
        generation: target.generation,
        clusterSystemIdentifier: read.state.systemIdentifier,
        databaseOid: read.state.databaseOid,
        serverVersionNum: read.state.serverVersionNum,
      },
      expectedState: {
        schemaFingerprint: read.state.fingerprint,
        ledgerStateHash: read.state.ledgerStateHash,
        extensions: { ...read.state.extensions },
        executionRoles: { ...before.expectedState.executionRoles },
      },
      evidence: null,
      facts,
      resume,
    }
    const policy = await evaluateRegistryPolicy(tx, ctx.policy, {
      kind: 'migration.resume',
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
        kind: 'migration.resume',
        kindVersion: 1,
        actionClass: 'high',
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
          nextStatement: log.next,
          fromStatement: resume.fromStatement,
          statements: analysis.statements.length,
          readback: back.state,
          cleanup:
            resume.cleanup === null ? null : `${resume.cleanup.schema}.${resume.cleanup.name}`,
          findings,
        },
        policy,
      },
      { clock: ctx.policy.clock },
    )
  } finally {
    await opened.session.close()
  }
}

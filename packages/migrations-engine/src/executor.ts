import type { JsonObject } from '@exponetdb/kernel'
import { normalizeSqlSource } from '@exponetdb/migrations/format'
import {
  changedGuards,
  checkExpectations,
  type EngineGuards,
  executionRoleFacts,
  executionRoleProblem,
  ident,
  insertLedgerRow,
  insertMigrationEvent,
  lockMarker,
  pinSearchPath,
  type ReviewedStatement,
  ReviewRefused,
  readEngineGuards,
  reviewedStatements,
  snapshotWithin,
  sql,
  TargetError,
  type TargetSession,
} from '@exponetdb/postgres'
import { analyzeMigrationSql, survivingExpectations } from '@exponetdb/postgres/parser'
import type { PlanContent, PlanItem } from './content.ts'
import type { StoredRevision } from './store.ts'
import type { ManagedScope } from './target.ts'

/**
 * One transactional migration on the operation's dedicated migrator
 * session ([planning-and-apply.md §4.3](../../../exponetdb-docs/04-migrations/planning-and-apply.md#43-transactional-migration)):
 *
 * ```text
 * BEGIN; SET LOCAL timeouts and search_path; identity marker FOR SHARE;
 * SET LOCAL ROLE <execution role>; statement 0 … n, one message each,
 * engine guards read around each; RESET ROLE; L0 (engine catalog
 * assertions); fingerprint after (in the transaction); ledger row and
 * `applied` event; the lease checked; COMMIT
 * ```
 *
 * DDL, ledger row and event commit together. Anything before `COMMIT`
 * rolls back (`not_applied`). `COMMIT` sent without an answer is `unknown`:
 * nothing is executed again; reconciliation reads the ledger.
 */
export type StepResult =
  | { readonly result: 'applied'; readonly fingerprintAfter: string; readonly durationMs: number }
  | {
      readonly result: 'failed'
      readonly errorCode: string
      readonly statementIndex: number | null
      readonly sqlstate: string | null
      readonly position: number | null
      /** L0: the gate's summary (never target data). */
      readonly gate: JsonObject | null
    }
  | { readonly result: 'unknown' }

export interface StepInput {
  readonly session: TargetSession
  readonly content: PlanContent
  readonly item: PlanItem
  readonly revision: StoredRevision
  readonly operationId: string
  readonly planId: string
  readonly actorRef: string | null
  readonly clientRef: string | null
  readonly installationId: string
  readonly engineVersion: string
  readonly scope: ManagedScope
  readonly trustedExtensions: readonly string[]
  readonly fingerprintBefore: string | null
  /** Checked right before COMMIT: a worker that lost its lease rolls back instead. */
  readonly stillHolds: () => Promise<boolean>
}

function failed(
  errorCode: string,
  options: {
    readonly statementIndex?: number | null
    readonly sqlstate?: string | null
    readonly position?: number | null
    readonly gate?: JsonObject | null
  } = {},
): StepResult {
  return {
    result: 'failed',
    errorCode,
    statementIndex: options.statementIndex ?? null,
    sqlstate: options.sqlstate ?? null,
    position: options.position ?? null,
    gate: options.gate ?? null,
  }
}

/** The reviewed statements of a stored revision for the session's major (the analyzer is the only door). */
export function statementsOf(
  session: TargetSession,
  revision: StoredRevision,
  trustedExtensions: readonly string[],
): {
  readonly statements: ReviewedStatement[]
  readonly analysis: ReturnType<typeof analyzeMigrationSql>
} {
  const text = normalizeSqlSource(revision.files['up.sql'])
  if (!text.ok) throw new ReviewRefused('parse_failed')
  const analysis = analyzeMigrationSql(session.facts.major, text.value, { trustedExtensions })
  return { statements: reviewedStatements(text.value, analysis), analysis }
}

function sqlstateOf(error: unknown): string | null {
  return error instanceof TargetError && error.sqlstate !== undefined ? error.sqlstate : null
}

export async function runTransactional(input: StepInput): Promise<StepResult> {
  const { session, item } = input
  let reviewed: ReturnType<typeof statementsOf>
  try {
    reviewed = statementsOf(session, input.revision, input.trustedExtensions)
  } catch (error) {
    if (error instanceof ReviewRefused) {
      return failed('MIGRATION_STATEMENT_FORBIDDEN', { statementIndex: error.statementIndex })
    }
    throw error
  }
  if (!reviewed.analysis.ok || reviewed.statements.some((s) => s.autocommitOnly)) {
    return failed('MIGRATION_STATEMENT_FORBIDDEN')
  }
  const started = Date.now()
  const reader = session.reader()
  await session.query(sql`BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE`)
  let commitSent = false
  let committed = false
  try {
    await session.query(sql`SELECT pg_catalog.set_config('lock_timeout', $1, true)`, [
      `${item.lockTimeoutMs}ms`,
    ])
    await session.query(sql`SELECT pg_catalog.set_config('statement_timeout', $1, true)`, [
      `${item.statementTimeoutMs}ms`,
    ])
    await lockMarker(session, {
      installationId: input.installationId,
      targetId: input.content.target.targetId,
      generation: input.content.target.generation,
      systemIdentifier: input.content.target.clusterSystemIdentifier,
    })
    await pinSearchPath(reader, item.searchPath)
    await session.query(sql`SET LOCAL ROLE ${ident(item.executionRole)}`)
    const before: EngineGuards = await readEngineGuards(reader)
    if (before.currentUser !== item.executionRole) {
      return failed('MIGRATION_EXECUTION_FAILED', { gate: { guard: 'current_user' } })
    }
    for (const statement of reviewed.statements) {
      try {
        await session.executeReviewed(statement, { timeoutMs: item.statementTimeoutMs + 5000 })
      } catch (error) {
        if (error instanceof TargetError && error.code === 'TARGET_UNAVAILABLE') throw error
        return failed(
          error instanceof TargetError && error.code === 'MIGRATION_LOCK_TIMEOUT'
            ? 'MIGRATION_LOCK_TIMEOUT'
            : 'MIGRATION_EXECUTION_FAILED',
          {
            statementIndex: statement.index,
            sqlstate: sqlstateOf(error),
            position: error instanceof TargetError ? (error.server.position ?? null) : null,
          },
        )
      }
      const changed = changedGuards(before, await readEngineGuards(reader))
      if (changed.length > 0) {
        // Defense in depth: a function the statement called changed a guarded setting.
        return failed('MIGRATION_EXECUTION_FAILED', {
          statementIndex: statement.index,
          gate: { guard: changed.join(',').slice(0, 200) },
        })
      }
    }
    await session.query(sql`RESET ROLE`)
    // L0: engine catalog assertions in the transaction, under the migration's search path.
    if (reviewed.analysis.ok) {
      const results = await checkExpectations(
        reader,
        survivingExpectations(reviewed.analysis.statements),
      )
      const failing = results.filter((r) => !r.ok)
      if (failing.length > 0) {
        return failed('VERIFICATION_FAILED', {
          gate: {
            layer: 'L0',
            checks: results.length,
            failed: failing.length,
            first: (failing[0]?.description ?? '').slice(0, 200),
          },
        })
      }
    }
    const snapshot = await snapshotWithin(reader, {
      ...(input.scope.includeSchemas === undefined
        ? {}
        : { includeSchemas: [...input.scope.includeSchemas] }),
      excludeSchemas: [...(input.scope.excludeSchemas ?? [])],
    })
    await insertLedgerRow(session, {
      migrationId: item.migrationId,
      origin: 'exponetdb',
      name: item.name,
      checksum: item.checksum,
      checksumProvenance: 'computed_at_apply',
      sourceDigest: item.sourceDigest,
      verifyDigest: item.verifyDigest,
      rollbackDigest: item.rollbackDigest,
      manifest: input.revision.manifest,
      dependencies: item.dependsOn,
      transactional: true,
      source: item.source === null ? null : { ...item.source },
      applyDurationMs: Date.now() - started,
      planId: input.planId,
      operationId: input.operationId,
      actorRef: input.actorRef,
      clientRef: input.clientRef,
      engineVersion: input.engineVersion,
      pgVersionNum: session.facts.serverVersionNum,
      fingerprintBefore: input.fingerprintBefore,
      fingerprintAfter: snapshot.fingerprint,
    })
    await insertMigrationEvent(session, {
      migrationId: item.migrationId,
      operationId: input.operationId,
      event: 'applied',
      detail: { revision: item.revision, statements: reviewed.statements.length },
    })
    if (!(await input.stillHolds())) {
      return failed('OPERATION_CANCELLED')
    }
    commitSent = true
    await session.query(sql`COMMIT`)
    committed = true
    return {
      result: 'applied',
      fingerprintAfter: snapshot.fingerprint,
      durationMs: Date.now() - started,
    }
  } catch (error) {
    if (commitSent && !committed) {
      // COMMIT was sent and no answer came: the outcome is unknown; the ledger decides.
      return { result: 'unknown' }
    }
    if (error instanceof TargetError && error.code === 'TARGET_IDENTITY_MISMATCH') {
      return failed('TARGET_IDENTITY_MISMATCH')
    }
    if (error instanceof TargetError && error.code === 'CLUSTER_IDENTITY_MISMATCH') {
      return failed('CLUSTER_IDENTITY_MISMATCH')
    }
    if (error instanceof TargetError && error.code === 'TARGET_UNAVAILABLE') {
      // Before COMMIT the server rolls back when the session ends.
      return failed('TARGET_UNAVAILABLE', { sqlstate: sqlstateOf(error) })
    }
    throw error
  } finally {
    if (!committed && !commitSent && session.usable) {
      await session.query(sql`ROLLBACK`).catch(() => undefined)
    }
  }
}

/**
 * The execution roles the plan bound, read again on the migrator session
 * under the lock: still mapped the same way and still usable.
 */
export async function executionRolesChanged(
  session: TargetSession,
  content: PlanContent,
  current: Readonly<Record<string, string>>,
): Promise<boolean> {
  for (const [alias, role] of Object.entries(content.expectedState.executionRoles)) {
    if (current[alias] !== role) return true
  }
  const roles = [...new Set(content.migrations.map((m) => m.executionRole))]
  const facts = await executionRoleFacts(session.reader(), roles)
  return facts.some((f) => executionRoleProblem(f) !== null)
}

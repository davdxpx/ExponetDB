import type { JsonObject } from '@exponetdb/kernel'
import { normalizeSqlSource } from '@exponetdb/migrations/format'
import {
  changedGuards,
  checkExpectations,
  type EngineGuards,
  executionRoleFacts,
  ident,
  insertLedgerRow,
  insertMigrationEvent,
  lockMarker,
  pinSearchPath,
  type ReviewedStatement,
  ReviewRefused,
  readEngineGuards,
  readIndexByOid,
  reviewedStatements,
  snapshotWithin,
  sql,
  TargetError,
  type TargetSession,
} from '@exponetdb/postgres'
import { analyzeMigrationSql, loadParser, survivingExpectations } from '@exponetdb/postgres/parser'
import type { PlanContent, PlanItem } from './content.ts'
import {
  boundExceptionsHold,
  type ResolvedExecutionRoles,
  rolesStillUsable,
} from './execution-roles.ts'
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
  /** Which file runs: `up.sql` (apply, the default) or `down.sql` (an explicit rollback plan). */
  readonly file?: 'up.sql' | 'down.sql'
  /**
   * The ledger write in the migration's own transaction, after L0 and the
   * fingerprint: the ledger row and its `applied` event by default; a
   * rollback marks the row reverted (once) and appends `reverted`.
   */
  readonly record?: (
    fingerprintAfter: string,
    durationMs: number,
    statements: number,
  ) => Promise<void>
  /**
   * A legacy replay on a scratch target (legacy-import.md §2): the same
   * admission, role and guards, but no L0 gate (a legacy chain may rely on
   * later files), no fingerprint per file and no ledger write.
   */
  readonly replay?: true
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
  file: 'up.sql' | 'down.sql' = 'up.sql',
): {
  readonly statements: ReviewedStatement[]
  readonly analysis: ReturnType<typeof analyzeMigrationSql>
} {
  const bytes = revision.files[file]
  if (bytes === null) throw new ReviewRefused('no_statements')
  const text = normalizeSqlSource(bytes)
  if (!text.ok) throw new ReviewRefused('parse_failed')
  const analysis = analyzeMigrationSql(session.facts.major, text.value, { trustedExtensions })
  return { statements: reviewedStatements(text.value, analysis), analysis }
}

function sqlstateOf(error: unknown): string | null {
  return error instanceof TargetError && error.sqlstate !== undefined ? error.sqlstate : null
}

export async function runTransactional(input: StepInput): Promise<StepResult> {
  const { session, item } = input
  // The worker is its own process: it loads the grammar of this server's major itself.
  await loadParser(session.facts.major)
  let reviewed: ReturnType<typeof statementsOf>
  try {
    reviewed = statementsOf(
      session,
      input.revision,
      input.trustedExtensions,
      input.file ?? 'up.sql',
    )
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
    if (reviewed.analysis.ok && input.replay !== true) {
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
    const snapshot =
      input.replay === true
        ? { fingerprint: '' }
        : await snapshotWithin(reader, {
            ...(input.scope.includeSchemas === undefined
              ? {}
              : { includeSchemas: [...input.scope.includeSchemas] }),
            excludeSchemas: [...(input.scope.excludeSchemas ?? [])],
          })
    if (input.replay === true) {
      // Nothing is recorded on a scratch target.
    } else if (input.record !== undefined) {
      await input.record(snapshot.fingerprint, Date.now() - started, reviewed.statements.length)
    } else {
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
    }
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
 * One statement of a legacy file that only runs outside a transaction
 * (`CONCURRENTLY`), replayed on the scratch target
 * ([`legacy-import.md` §2.4](../../../exponetdb-docs/04-migrations/legacy-import.md#24-files-with-cluster-global-effects)):
 * the identity marker checked first, session-level timeouts and search
 * path, an engine-controlled `SET ROLE` to the execution role, the
 * statement in autocommit with the engine guards read around it, `RESET
 * ROLE`. Nothing is recorded on the scratch target (no event, no ledger
 * row); a failure stops the replay like a failed transactional file.
 */
export async function runReplayAutocommit(input: StepInput): Promise<StepResult> {
  const { session, item } = input
  await loadParser(session.facts.major)
  let reviewed: ReturnType<typeof statementsOf>
  try {
    reviewed = statementsOf(session, input.revision, input.trustedExtensions)
  } catch (error) {
    if (error instanceof ReviewRefused) {
      return failed('MIGRATION_STATEMENT_FORBIDDEN', { statementIndex: error.statementIndex })
    }
    throw error
  }
  const [statement, ...others] = reviewed.statements
  if (statement === undefined || others.length > 0 || !statement.autocommitOnly) {
    return failed('MIGRATION_STATEMENT_FORBIDDEN')
  }
  const started = Date.now()
  const reader = session.reader()
  try {
    await session.transaction(() =>
      lockMarker(session, {
        installationId: input.installationId,
        targetId: input.content.target.targetId,
        generation: input.content.target.generation,
        systemIdentifier: input.content.target.clusterSystemIdentifier,
      }),
    )
    await session.query(sql`SELECT pg_catalog.set_config('lock_timeout', $1, false)`, [
      `${item.lockTimeoutMs}ms`,
    ])
    await session.query(sql`SELECT pg_catalog.set_config('statement_timeout', $1, false)`, [
      `${item.statementTimeoutMs}ms`,
    ])
    const searchPath = item.searchPath.map((p) => `"${p.replaceAll('"', '""')}"`).join(', ')
    await session.query(sql`SELECT pg_catalog.set_config('search_path', $1, false)`, [searchPath])
    if (!(await input.stillHolds())) return failed('OPERATION_CANCELLED')
    await session.query(sql`SET ROLE ${ident(item.executionRole)}`)
    const before = await readEngineGuards(reader)
    if (before.currentUser !== item.executionRole) {
      await session.query(sql`RESET ROLE`)
      return failed('MIGRATION_EXECUTION_FAILED', { gate: { guard: 'current_user' } })
    }
    try {
      await session.executeReviewed(statement, { timeoutMs: item.statementTimeoutMs + 5000 })
    } catch (error) {
      // A lost connection during an autocommit statement: its effect is not known.
      if (error instanceof TargetError && error.code === 'TARGET_UNAVAILABLE') {
        return { result: 'unknown' }
      }
      await session.query(sql`RESET ROLE`).catch(() => undefined)
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
    await session.query(sql`RESET ROLE`)
    if (changed.length > 0) {
      return failed('MIGRATION_EXECUTION_FAILED', {
        statementIndex: statement.index,
        gate: { guard: changed.join(',').slice(0, 200) },
      })
    }
    return { result: 'applied', fingerprintAfter: '', durationMs: Date.now() - started }
  } catch (error) {
    if (error instanceof TargetError && error.code === 'TARGET_IDENTITY_MISMATCH') {
      return failed('TARGET_IDENTITY_MISMATCH')
    }
    if (error instanceof TargetError && error.code === 'CLUSTER_IDENTITY_MISMATCH') {
      return failed('CLUSTER_IDENTITY_MISMATCH')
    }
    if (error instanceof TargetError && error.code === 'TARGET_UNAVAILABLE') {
      return failed('TARGET_UNAVAILABLE', { sqlstate: sqlstateOf(error) })
    }
    throw error
  }
}

/**
 * One non-transactional migration ([planning-and-apply.md §4.4](../../../exponetdb-docs/04-migrations/planning-and-apply.md#44-non-transactional-migration),
 * G6 order §27), alone in its plan, on the operation's dedicated migrator
 * session:
 *
 * 1. `nontx_started`, committed (in a transaction that checks the marker);
 * 2. per statement `k`: session-level timeouts and search path, an
 *    engine-controlled `SET ROLE` to the execution role, the statement in
 *    autocommit, the engine guards read around it, `RESET ROLE`, then
 *    `nontx_statement_done(k)` as the migrator;
 * 3. one transaction with the marker, L0, the fingerprint, the ledger row
 *    (`transactional = false`) and `applied`.
 *
 * A failure at `k` records `nontx_failed(k)`; it is `partially_applied`
 * when an earlier statement took effect or the failed one can leave an
 * artifact (an INVALID index of `CONCURRENTLY`), and blocks further schema
 * plans until an explicit `migration.resume`. Otherwise nothing took
 * effect: the start is closed with `ledger_reconciled` (`not_applied`) so it
 * blocks nothing. A lost connection during a statement is `unknown`: a
 * missing done event never proves a missing effect.
 */
export type NontxResult =
  | { readonly result: 'applied'; readonly fingerprintAfter: string }
  | {
      readonly result: 'failed'
      readonly errorCode: string
      readonly statementIndex: number | null
      readonly sqlstate: string | null
      readonly position: number | null
      readonly partial: boolean
      readonly gate: JsonObject | null
    }
  | { readonly result: 'unknown'; readonly statementIndex: number | null }

const ARTIFACT = /\bCONCURRENTLY\b/

/** What a `migration.resume` plan adds before the statements continue. */
export interface ResumeStep {
  /** The operation that started the bundle. */
  readonly of: string
  /** The statement the readback proved done (recorded as done, not run). */
  readonly doneByReadback: number | null
  /** The INVALID index the plan saw, dropped by OID before the failed statement runs again. */
  readonly cleanup: { readonly indexOid: string } | null
}

export async function runNontransactional(
  input: StepInput & { readonly fromStatement?: number; readonly resume?: ResumeStep },
): Promise<NontxResult> {
  const { session, item } = input
  const from = input.fromStatement ?? 0
  await loadParser(session.facts.major)
  let reviewed: ReturnType<typeof statementsOf>
  try {
    reviewed = statementsOf(session, input.revision, input.trustedExtensions)
  } catch (error) {
    if (error instanceof ReviewRefused) {
      return {
        result: 'failed',
        errorCode: 'MIGRATION_STATEMENT_FORBIDDEN',
        statementIndex: error.statementIndex,
        sqlstate: null,
        position: null,
        partial: false,
        gate: null,
      }
    }
    throw error
  }
  const marker = {
    installationId: input.installationId,
    targetId: input.content.target.targetId,
    generation: input.content.target.generation,
    systemIdentifier: input.content.target.clusterSystemIdentifier,
  }
  // A resume names itself (and its cleanup) on the first event it writes.
  let note: JsonObject | null = input.resume === undefined ? null : { of: input.resume.of }
  const event = (
    name: 'nontx_started' | 'nontx_statement_done' | 'nontx_failed' | 'ledger_reconciled',
    detail: JsonObject,
  ) => {
    const full = note === null ? detail : { ...detail, resume: note }
    note = null
    return session.transaction(async () => {
      await lockMarker(session, marker)
      await insertMigrationEvent(session, {
        migrationId: item.migrationId,
        operationId: input.operationId,
        event: name,
        detail: full,
      })
    })
  }
  const fail = async (
    k: number,
    errorCode: string,
    sqlstate: string | null,
    position: number | null,
    gate: JsonObject | null,
    leftArtifact: boolean,
  ): Promise<NontxResult> => {
    const partial = k > from || from > 0 || leftArtifact
    if (session.usable) {
      await session.query(sql`RESET ROLE`).catch(() => undefined)
      await event('nontx_failed', {
        statementIndex: k,
        ...(sqlstate === null ? {} : { sqlstate }),
        ...(gate === null ? {} : { gate }),
      })
      if (!partial) {
        await event('ledger_reconciled', { resolution: 'not_applied', statementIndex: k })
      }
    }
    return { result: 'failed', errorCode, statementIndex: k, sqlstate, position, partial, gate }
  }
  if (from === 0) {
    await event('nontx_started', {
      revision: item.revision,
      statements: reviewed.statements.length,
    })
  }
  await session.query(sql`SELECT pg_catalog.set_config('lock_timeout', $1, false)`, [
    `${item.lockTimeoutMs}ms`,
  ])
  await session.query(sql`SELECT pg_catalog.set_config('statement_timeout', $1, false)`, [
    `${item.statementTimeoutMs}ms`,
  ])
  const searchPath =
    item.searchPath.length === 0
      ? ''
      : item.searchPath.map((p) => `"${p.replaceAll('"', '""')}"`).join(', ')
  await session.query(sql`SELECT pg_catalog.set_config('search_path', $1, false)`, [searchPath])
  const reader = session.reader()
  const cleanup = input.resume?.cleanup ?? null
  if (cleanup !== null) {
    // Exactly the index the plan saw, still INVALID; dropped as its owner (the execution role).
    await session.query(sql`SET ROLE ${ident(item.executionRole)}`)
    const index = await readIndexByOid(reader, cleanup.indexOid)
    if (index?.valid === true) {
      await session.query(sql`RESET ROLE`)
      return fail(from, 'PLAN_STALE', null, null, { cleanup: 'index_changed' }, true)
    }
    if (index !== null) {
      try {
        await session.query(
          sql`DROP INDEX CONCURRENTLY IF EXISTS ${ident(index.schema)}.${ident(index.name)}`,
        )
      } catch (error) {
        if (error instanceof TargetError && error.code === 'TARGET_UNAVAILABLE') {
          return { result: 'unknown', statementIndex: from }
        }
        await session.query(sql`RESET ROLE`).catch(() => undefined)
        return fail(
          from,
          error instanceof TargetError && error.code === 'MIGRATION_LOCK_TIMEOUT'
            ? 'MIGRATION_LOCK_TIMEOUT'
            : 'MIGRATION_EXECUTION_FAILED',
          sqlstateOf(error),
          null,
          { cleanup: 'drop_invalid_index' },
          true,
        )
      }
      note = { ...(note ?? {}), cleanup: `${index.schema}.${index.name}`.slice(0, 200) }
    }
    await session.query(sql`RESET ROLE`)
  }
  const proven = input.resume?.doneByReadback ?? null
  if (proven !== null) {
    await event('nontx_statement_done', { statementIndex: proven, readback: 'present' })
  }
  for (const statement of reviewed.statements) {
    if (statement.index < from) continue
    if (!(await input.stillHolds())) {
      return fail(statement.index, 'OPERATION_CANCELLED', null, null, null, false)
    }
    await session.query(sql`SET ROLE ${ident(item.executionRole)}`)
    const before = await readEngineGuards(reader)
    if (before.currentUser !== item.executionRole) {
      return fail(
        statement.index,
        'MIGRATION_EXECUTION_FAILED',
        null,
        null,
        { guard: 'current_user' },
        false,
      )
    }
    try {
      await session.executeReviewed(statement, { timeoutMs: item.statementTimeoutMs + 5000 })
    } catch (error) {
      if (error instanceof TargetError && error.code === 'TARGET_UNAVAILABLE') {
        return { result: 'unknown', statementIndex: statement.index }
      }
      return fail(
        statement.index,
        error instanceof TargetError && error.code === 'MIGRATION_LOCK_TIMEOUT'
          ? 'MIGRATION_LOCK_TIMEOUT'
          : 'MIGRATION_EXECUTION_FAILED',
        sqlstateOf(error),
        error instanceof TargetError ? (error.server.position ?? null) : null,
        null,
        statement.autocommitOnly && ARTIFACT.test(statement.text),
      )
    }
    const changed = changedGuards(before, await readEngineGuards(reader))
    await session.query(sql`RESET ROLE`)
    if (changed.length > 0) {
      // The statement took effect; the guard change makes the rest untrustworthy.
      return fail(
        statement.index,
        'MIGRATION_EXECUTION_FAILED',
        null,
        null,
        { guard: changed.join(',').slice(0, 200) },
        true,
      )
    }
    await event('nontx_statement_done', { statementIndex: statement.index })
  }
  // The record: L0, fingerprint, ledger row and applied, in one transaction.
  await session.query(sql`BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE`)
  let commitSent = false
  let committed = false
  try {
    await lockMarker(session, marker)
    await pinSearchPath(reader, item.searchPath)
    if (reviewed.analysis.ok) {
      const results = await checkExpectations(
        reader,
        survivingExpectations(reviewed.analysis.statements),
      )
      const failing = results.filter((r) => !r.ok)
      if (failing.length > 0) {
        await session.query(sql`ROLLBACK`)
        return fail(
          reviewed.statements.length,
          'VERIFICATION_FAILED',
          null,
          null,
          {
            layer: 'L0',
            checks: results.length,
            failed: failing.length,
            first: (failing[0]?.description ?? '').slice(0, 200),
          },
          true,
        )
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
      transactional: false,
      source: item.source === null ? null : { ...item.source },
      applyDurationMs: null,
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
      detail: {
        revision: item.revision,
        statements: reviewed.statements.length,
        transactional: false,
      },
    })
    if (!(await input.stillHolds())) {
      await session.query(sql`ROLLBACK`)
      return { result: 'unknown', statementIndex: null }
    }
    commitSent = true
    await session.query(sql`COMMIT`)
    committed = true
    return { result: 'applied', fingerprintAfter: snapshot.fingerprint }
  } catch (error) {
    if (commitSent && !committed) return { result: 'unknown', statementIndex: null }
    if (error instanceof TargetError && error.code === 'TARGET_UNAVAILABLE') {
      return { result: 'unknown', statementIndex: null }
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
 * under the lock (ADR-0034 §3): still resolved the same way for the
 * target's environment, every exception the plan relied on still the same
 * (id, revision, active, not past review), and every role still usable,
 * with `BYPASSRLS` excused only where the plan bound an exception. The
 * changed binding, or null.
 */
export async function executionRolesChanged(
  session: TargetSession,
  content: PlanContent,
  current: ResolvedExecutionRoles,
): Promise<'execution_roles' | 'execution_role_exception' | null> {
  for (const [alias, role] of Object.entries(content.expectedState.executionRoles)) {
    if (current.roles[alias] !== role) return 'execution_roles'
  }
  const bound = content.expectedState.executionRoleExceptions
  if (!boundExceptionsHold(bound, current.exceptions)) return 'execution_role_exception'
  const roles = [...new Set(content.migrations.map((m) => m.executionRole))]
  const facts = await executionRoleFacts(session.reader(), roles)
  return rolesStillUsable(facts, bound) ? null : 'execution_roles'
}

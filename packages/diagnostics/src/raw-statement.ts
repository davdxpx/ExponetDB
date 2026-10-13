import { RAW_STATEMENT_MAX_LENGTH, type RawStatement } from '@exponetdb/contracts'
import {
  qualified,
  requireActivityVisibility,
  sql,
  TargetError,
  type TargetRow,
  type TargetSession,
  type TrustedSql,
} from '@exponetdb/postgres'
import {
  loadParser,
  redactStatementSync,
  revealStatementSync,
  type SupportedMajor,
} from '@exponetdb/postgres/parser'
import { brand, RegistryError, type TargetRecord } from '@exponetdb/registry'
import { DiagnosticsError } from './errors.ts'
import { requireIdentity } from './identity.ts'
import type { SnapshotDeps } from './snapshots.ts'

/**
 * The raw statement view (owner decision S2, Wave 8;
 * [statement-redaction.md §4](../../../exponetdb-docs/03-database-model/statement-redaction.md#4-raw-text-access)):
 * a **live lookup** on the target at request time, through the same
 * observer session the session list reads with (identity checked first,
 * `pg_read_all_stats` required, never a write path, never a superuser). The
 * statement text is searched where PostgreSQL still holds it, its digest
 * is recomputed from the text read (the redacted form's `sha256`, exactly
 * as the session list computes it) and only a text whose digest matches is
 * revealed, with its secrets removed (`revealStatementSync`).
 *
 * Nothing is stored: the text exists in this function's memory and in the
 * answer only. A statement the target no longer holds, or a target that
 * cannot be read, is `STATEMENT_NOT_AVAILABLE` with a reason, never stale
 * or invented text.
 *
 * Sources, in order:
 *
 * 1. `pg_stat_activity` of the target's database (client backends, the
 *    observer's own session excluded), newest query first, at most
 *    {@link ACTIVITY_SCAN} rows; with `pid` (and `backendStart`) only that
 *    session: another start time is `not_held`, another statement is
 *    `digest_mismatch`.
 * 2. Without a named session and without a match: `pg_stat_statements`
 *    when the extension is installed in the database and loaded, the
 *    database's rows by calls, at most {@link STATEMENTS_SCAN}. Not
 *    installed, or installed but not in `shared_preload_libraries`
 *    (SQLSTATE 55000), is `extension_missing`.
 */
export const ACTIVITY_SCAN = 1000
export const STATEMENTS_SCAN = 5000

export type StatementUnavailableReason =
  | 'not_held'
  | 'target_unreachable'
  | 'digest_mismatch'
  | 'extension_missing'

export interface RawStatementLookup {
  readonly digest: string
  /** A session from the session list: look only there. */
  readonly session?: { readonly pid: number; readonly backendStart: string | undefined } | undefined
}

function unavailable(reason: StatementUnavailableReason): DiagnosticsError {
  return new DiagnosticsError('STATEMENT_NOT_AVAILABLE', { reason })
}

/** Failures that mean the target could not be read: no connection, credential, TLS or time. */
const UNREACHABLE: ReadonlySet<string> = new Set([
  'TARGET_UNAVAILABLE',
  'TARGET_CREDENTIAL_INVALID',
  'TARGET_TLS_FAILED',
  'QUERY_TIMEOUT',
])

function unreachable(error: unknown): boolean {
  return (
    (error instanceof TargetError ||
      error instanceof RegistryError ||
      error instanceof DiagnosticsError) &&
    UNREACHABLE.has(error.code)
  )
}

const TS = (column: TrustedSql) =>
  sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

const ACTIVITY = sql`SELECT s.pid, ${TS(sql`s.backend_start`)} AS backend_start, ${TS(sql`s.query_start`)} AS query_start, s.query
  FROM pg_catalog.pg_stat_activity s
 WHERE s.backend_type = 'client backend' AND s.pid <> pg_catalog.pg_backend_pid()
   AND s.datname = pg_catalog.current_database()
   AND s.query IS NOT NULL AND s.query <> ''
   AND ($1::int IS NULL OR s.pid = $1)
 ORDER BY s.query_start DESC NULLS LAST, s.pid
 LIMIT $2`

const EXTENSION = sql`SELECT n.nspname
  FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
 WHERE e.extname = 'pg_stat_statements'`

const statementsOf = (schema: string) =>
  sql`SELECT s.query, s.calls::text AS calls, s.total_exec_time::text AS total_ms,
       s.mean_exec_time::text AS mean_ms, s.rows::text AS rows
  FROM ${qualified(schema, 'pg_stat_statements')} s
 WHERE s.dbid = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())
   AND s.query IS NOT NULL
 ORDER BY s.calls DESC, s.queryid
 LIMIT $1`

const count = (row: TargetRow, column: string): number => {
  const n = Number(row.textOrNull(column) ?? '0')
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/** Whether `text` is the statement the digest names (the digest of its redacted form). */
export function matchesDigest(text: string, digest: string, major: SupportedMajor): boolean {
  return redactStatementSync(text, { major, maxLength: 1 }).digest === digest
}

type Found =
  | { readonly text: string; readonly origin: RawStatement['origin'] }
  | { readonly missing: StatementUnavailableReason }

/** The live search on an opened, identity-checked observer session (exposed for tests). */
export async function findStatement(
  session: TargetSession,
  lookup: RawStatementLookup,
): Promise<Found> {
  const major = session.facts.major as SupportedMajor
  await loadParser(major)
  const named = lookup.session
  const rows = await session.query(ACTIVITY, [named?.pid ?? null, ACTIVITY_SCAN])
  if (named !== undefined) {
    const row = rows[0]
    if (
      row === undefined ||
      (named.backendStart !== undefined && row.text('backend_start') !== named.backendStart)
    ) {
      return { missing: 'not_held' }
    }
    const text = row.text('query')
    if (!matchesDigest(text, lookup.digest, major)) return { missing: 'digest_mismatch' }
    return { text, origin: activityOrigin(row) }
  }
  for (const row of rows) {
    const text = row.text('query')
    if (matchesDigest(text, lookup.digest, major)) return { text, origin: activityOrigin(row) }
  }
  const schema = (await session.query(EXTENSION))[0]?.textOrNull('nspname') ?? null
  if (schema === null) return { missing: 'extension_missing' }
  let statements: TargetRow[]
  try {
    statements = await session.query(statementsOf(schema), [STATEMENTS_SCAN])
  } catch (error) {
    // Installed but not loaded: "pg_stat_statements must be loaded via shared_preload_libraries".
    if (error instanceof TargetError && error.sqlstate === '55000') {
      return { missing: 'extension_missing' }
    }
    throw error
  }
  for (const row of statements) {
    const text = row.textOrNull('query')
    if (text === null || text.length === 0) continue
    if (matchesDigest(text, lookup.digest, major)) {
      const calls = Math.trunc(count(row, 'calls'))
      return {
        text,
        origin: {
          view: 'pg_stat_statements',
          calls,
          totalExecTimeMs: count(row, 'total_ms'),
          meanExecTimeMs: count(row, 'mean_ms'),
          rows: Math.trunc(count(row, 'rows')),
        },
      }
    }
  }
  return { missing: 'not_held' }
}

function activityOrigin(row: TargetRow): RawStatement['origin'] {
  return {
    view: 'pg_stat_activity',
    pid: row.int('pid'),
    backendStart: row.text('backend_start'),
    queryStart: row.textOrNull('query_start'),
  }
}

/**
 * Reads one statement live and reveals it with its secrets removed, or
 * throws `STATEMENT_NOT_AVAILABLE`. A target that is not the registered one
 * (`TARGET_IDENTITY_MISMATCH`) or a role that lost `pg_read_all_stats`
 * (`PERMISSION_DENIED`) keeps its own refusal: those are not an absent
 * statement.
 */
export async function readRawStatement(
  deps: SnapshotDeps,
  target: TargetRecord,
  lookup: RawStatementLookup,
): Promise<RawStatement> {
  if (target.state === 'decommissioned') throw new DiagnosticsError('TARGET_NOT_FOUND')
  if (target.state !== 'active' && target.state !== 'suspended') {
    throw unavailable('target_unreachable')
  }
  let found: Found
  try {
    const opened = await deps.connector.forTarget(
      target,
      'observer',
      `raw-statement/${target.targetId}`,
    )
    try {
      await requireIdentity(opened.session, target, deps.installationId)
      await requireActivityVisibility(opened.session)
      found = await findStatement(opened.session, lookup)
      if ('text' in found) {
        const major = opened.session.facts.major as SupportedMajor
        const revealed = revealStatementSync(found.text, {
          major,
          maxLength: RAW_STATEMENT_MAX_LENGTH,
        })
        // The digest was matched on this very text; checked again on what is answered.
        if (revealed.digest !== lookup.digest) throw unavailable('digest_mismatch')
        return {
          targetId: brand('tgt', target.targetId),
          digest: revealed.digest as RawStatement['digest'],
          text: revealed.text,
          untrusted: true,
          truncated: revealed.truncated,
          redaction: { mode: revealed.mode, removed: revealed.removed },
          origin: found.origin,
          source: 'live',
          observedAt: new Date().toISOString(),
        }
      }
    } finally {
      await opened.session.close()
    }
  } catch (error) {
    if (unreachable(error)) throw unavailable('target_unreachable')
    throw error
  }
  throw unavailable(found.missing)
}

import type { ErrorCode } from '@exponetdb/contracts'
import type { JsonValue } from '@exponetdb/kernel'
import {
  type AdmittedRead,
  admitReadOn,
  type RawRead,
  sql,
  TargetError,
  type TargetSession,
} from '@exponetdb/postgres'
import { redactPlan, summarizePlan } from './explain.ts'
import {
  admissionRefusal,
  type DataReadOutcome,
  type DataReadRequest,
  dataReadText,
  type QueryColumn,
  refused,
} from './outcome.ts'
import { jsonBytes, typedValue } from './values.ts'

/**
 * The worker's executor of one data read
 * ([sql-execution-security.md §2](../../../../exponetdb-docs/03-database-model/sql-execution-security.md#2-data-queries-dataread),
 * ADR-0028 §1 step 3): on a fresh reader session that nothing else uses,
 *
 * 1. admission again on this target (`admitReadOn`: parser, relation
 *    kinds, user code; `serve` admitted the text with the parser only);
 * 2. `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, `SELECT 1`, then
 *    `SET LOCAL` limits (statement, lock, idle in transaction, and on
 *    PostgreSQL 17 and 18 `transaction_timeout`) and
 *    `application_name = 'exponetdb/query/<request id>'`;
 * 3. the statement with bind parameters through a cursor, `FETCH FORWARD
 *    <cap + 1>`, then `ROLLBACK`;
 * 4. typed values, the byte cap, masked columns, the relations with RLS.
 *
 * It returns an outcome, never throws a server message: a runtime error is
 * its SQLSTATE only. It logs nothing; no value leaves it except in the
 * outcome, which the lane seals to the caller.
 */
const MASKED = null
const IDLE_IN_TRANSACTION_MS = 30_000
const LOCK_TIMEOUT_MS = 1_000

/** `schema.table.column` against a pattern of three parts, `*` matching a whole part or a run within it. */
export function matchesColumn(
  pattern: string,
  schema: string,
  table: string,
  column: string,
): boolean {
  const parts = pattern.split('.')
  const names = [schema, table, column]
  return (
    parts.length === 3 &&
    parts.every((p, i) => {
      const re = new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
      return re.test(names[i] ?? '')
    })
  )
}

/** Where each result column comes from (schema, table, column), for masking. */
async function origins(
  session: TargetSession,
  raw: RawRead,
): Promise<Map<string, { schema: string; table: string; column: string }>> {
  const refs = raw.fields
    .filter((f) => f.tableOid !== 0 && f.columnNumber > 0)
    .map((f) => ({ rel: f.tableOid, att: f.columnNumber }))
  if (refs.length === 0) return new Map()
  const rows = await session.query(
    sql`SELECT r.rel::text || ':' || r.att::text AS key, n.nspname AS schema, c.relname AS "table", a.attname AS "column"
          FROM pg_catalog.json_to_recordset($1::json) AS r(rel oid, att int2)
          JOIN pg_catalog.pg_attribute a ON a.attrelid = r.rel AND a.attnum = r.att
          JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace`,
    [JSON.stringify(refs)],
  )
  return new Map(
    rows.map((r) => [
      r.text('key'),
      { schema: r.text('schema'), table: r.text('table'), column: r.text('column') },
    ]),
  )
}

/** Whether any relation the statement reads has a column a pattern names (an expression column may derive from it). */
async function readsSensitive(
  session: TargetSession,
  read: AdmittedRead,
  patterns: readonly string[],
): Promise<boolean> {
  if (patterns.length === 0 || read.relations.length === 0) return false
  const rows = await session.query(
    sql`SELECT n.nspname AS schema, c.relname AS "table", a.attname AS "column"
          FROM pg_catalog.json_to_recordset($1::json) AS r(schema text, name text)
          JOIN pg_catalog.pg_namespace n ON n.nspname = r.schema
          JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = r.name
          JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped`,
    [JSON.stringify(read.relations.map((r) => ({ schema: r.schema ?? 'public', name: r.name })))],
  )
  return rows.some((r) =>
    patterns.some((p) => matchesColumn(p, r.text('schema'), r.text('table'), r.text('column'))),
  )
}

async function rlsRelations(session: TargetSession, read: AdmittedRead): Promise<string[]> {
  if (read.relations.length === 0) return []
  const rows = await session.query(
    sql`SELECT n.nspname || '.' || c.relname AS name
          FROM pg_catalog.json_to_recordset($1::json) AS r(schema text, name text)
          JOIN pg_catalog.pg_namespace n ON n.nspname = r.schema
          JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = r.name
         WHERE c.relrowsecurity
         ORDER BY 1`,
    [JSON.stringify(read.relations.map((r) => ({ schema: r.schema ?? 'public', name: r.name })))],
  )
  return rows.map((r) => r.text('name').slice(0, 127))
}

async function typeNames(
  session: TargetSession,
  raw: RawRead,
): Promise<Map<number, { readonly name: string; readonly typname: string }>> {
  const oids = [...new Set(raw.fields.map((f) => f.typeOid))]
  if (oids.length === 0) return new Map()
  const rows = await session.query(
    sql`SELECT t.oid::int8 AS oid, pg_catalog.format_type(t.oid, NULL) AS name, t.typname
          FROM pg_catalog.pg_type t WHERE t.oid = ANY ($1::oid[])`,
    [`{${oids.join(',')}}`],
  )
  return new Map(
    rows.map((r) => [
      Number(r.text('oid')),
      { name: r.text('name').slice(0, 256), typname: r.text('typname') },
    ]),
  )
}

/** Maps a server error of the read to the catalog: never its message. */
function failure(error: unknown, canceled: boolean): DataReadOutcome {
  if (!(error instanceof TargetError)) throw error
  if (error.sqlstate === '57014') {
    return refused(canceled ? 'QUERY_CANCELED' : 'QUERY_TIMEOUT')
  }
  switch (error.code) {
    case 'QUERY_TIMEOUT':
    case 'QUERY_NOT_READ_ONLY':
      return refused(error.code)
    case 'QUERY_PARSE_ERROR':
    case 'TARGET_SQL_ERROR':
    case 'PERMISSION_DENIED':
      return refused('QUERY_FAILED', { sqlstate: error.sqlstate ?? 'XX000' })
    default:
      // TARGET_UNAVAILABLE and the other connection codes are the target's state: as they are.
      return refused(error.code as ErrorCode)
  }
}

/**
 * Runs one data read on `session` (a fresh reader session). `signal`
 * aborts it: the protocol cancel reaches exactly this session's backend.
 */
export async function executeDataRead(
  session: TargetSession,
  request: DataReadRequest,
  signal?: AbortSignal,
): Promise<DataReadOutcome> {
  const text = dataReadText(request.kind, request.sql, request.analyze)
  const admitted = await admitReadOn(session, text)
  if (!admitted.ok) {
    return admissionRefusal(admitted)
  }
  const read = admitted.read
  if (request.kind === 'query' && read.statementClass === 'explain') {
    return refused('QUERY_CONSTRUCT_UNSUPPORTED', { construct: 'EXPLAIN' }, 'statement_class')
  }
  if (read.analyze && request.callerClass === 'agent') {
    // EXPLAIN ANALYZE executes the statement (ADR-0028 §4): never for an agent.
    return refused('QUERY_NOT_READ_ONLY', undefined, 'explain_analyze')
  }
  let canceled = false
  const onAbort = () => {
    canceled = true
    void session.cancel().catch(() => undefined)
  }
  if (signal?.aborted === true) return refused('QUERY_CANCELED')
  signal?.addEventListener('abort', onAbort, { once: true })
  const started = Date.now()
  try {
    return await session.readOnly(
      async () => {
        await session.query(
          sql`SELECT pg_catalog.set_config('application_name', $1, true),
                     pg_catalog.set_config('idle_in_transaction_session_timeout', $2, true)`,
          [`exponetdb/query/${request.requestId}`, `${IDLE_IN_TRANSACTION_MS}ms`],
        )
        if (session.facts.major >= 17) {
          await session.query(sql`SELECT pg_catalog.set_config('transaction_timeout', $1, true)`, [
            `${request.statementTimeoutMs + 5_000}ms`,
          ])
        }
        const raw = await session.runAdmittedRead(
          read,
          request.params,
          request.kind === 'explain' ? 1 : request.maxRows,
        )
        if (request.kind === 'explain') {
          const output = raw.rows[0]?.[0]
          const plan =
            output === null || output === undefined ? null : (JSON.parse(output) as JsonValue)
          const summary = plan === null ? undefined : summarizePlan(plan)
          if (plan === null || summary === undefined)
            return refused('QUERY_FAILED', { sqlstate: 'XX000' })
          return {
            kind: 'explain',
            plan: redactPlan(plan),
            summary,
            durationMs: Date.now() - started,
          } satisfies DataReadOutcome
        }
        const names = await typeNames(session, raw)
        const from = await origins(session, raw)
        const patterns = request.sensitiveColumns
        const expressionsMasked = await readsSensitive(session, read, patterns)
        const columns: QueryColumn[] = raw.fields.map((f) => {
          const origin = from.get(`${f.tableOid}:${f.columnNumber}`)
          const masked =
            patterns.length > 0 &&
            (origin === undefined
              ? expressionsMasked
              : patterns.some((p) => matchesColumn(p, origin.schema, origin.table, origin.column)))
          return {
            name: f.name.slice(0, 63),
            type: names.get(f.typeOid)?.name ?? 'unknown',
            masked,
          }
        })
        const rows: JsonValue[][] = []
        let bytes = 2
        let byBytes = false
        for (const row of raw.rows) {
          const typed = row.map((v, i) => {
            const field = raw.fields[i]
            const column = columns[i]
            if (field === undefined || column === undefined) return null
            return column.masked
              ? MASKED
              : typedValue(v, field.typeOid, names.get(field.typeOid)?.typname ?? '')
          })
          const size = jsonBytes(typed) + 1
          if (bytes + size > request.maxBytes) {
            byBytes = true
            break
          }
          bytes += size
          rows.push(typed)
        }
        if (byBytes && rows.length === 0) {
          return refused('QUERY_RESULT_TOO_LARGE', {
            cap: { kind: 'bytes', limit: request.maxBytes },
          })
        }
        const truncated = byBytes || raw.truncated
        return {
          kind: 'query',
          columns,
          rows,
          rowCount: rows.length,
          truncated,
          truncation: byBytes
            ? { reason: 'bytes', cap: request.maxBytes }
            : raw.truncated
              ? { reason: 'rows', cap: request.maxRows }
              : null,
          rlsRelations: await rlsRelations(session, read),
          durationMs: Date.now() - started,
        } satisfies DataReadOutcome
      },
      { statementTimeoutMs: request.statementTimeoutMs, lockTimeoutMs: LOCK_TIMEOUT_MS },
    )
  } catch (error) {
    return failure(error, canceled)
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

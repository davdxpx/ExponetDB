import type { LockGraph, SessionList } from '@exponetdb/contracts'
import { isJsonArray } from '@exponetdb/kernel'
import { sql, type TargetRow, type TrustedSql } from '@exponetdb/postgres'
import { DEFAULT_MAX_LENGTH, redactStatement } from '@exponetdb/postgres/parser'
import { brand, type TargetRecord } from '@exponetdb/registry'
import { DiagnosticsError } from './errors.ts'
import { clip } from './findings.ts'
import { requireIdentity } from './identity.ts'
import type { SnapshotDeps } from './snapshots.ts'

/**
 * Live session and lock reads of a target ([health.md §5, §6, §7](../../../exponetdb-docs/10-observability/health.md),
 * order §185 to §188): one parameterized query on an observer session
 * whose identity was checked first, client backends of this database
 * only, capped with an explicit `truncated`. Statements are always
 * redacted ([statement-redaction.md](../../../exponetdb-docs/03-database-model/statement-redaction.md));
 * role and application names are untrusted text, bounded. A failed read is
 * an error, never an empty list. Nothing here terminates anything.
 */
export interface SessionFilter {
  readonly state?: string | undefined
  readonly minAgeSeconds?: number | undefined
  readonly application?: string | undefined
  readonly limit?: number | undefined
}

const TS = (column: TrustedSql) =>
  sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

const SESSIONS = sql`SELECT s.pid, ${TS(sql`s.backend_start`)} AS backend_start, ${TS(sql`s.query_start`)} AS query_start,
       s.usename::text AS role, s.application_name, s.state, s.wait_event_type, s.wait_event,
       (extract(epoch FROM (clock_timestamp() - s.xact_start)) * 1000)::bigint AS xact_ms,
       (extract(epoch FROM (clock_timestamp() - s.query_start)) * 1000)::bigint AS query_ms,
       (extract(epoch FROM (clock_timestamp() - s.state_change)) * 1000)::bigint AS state_ms,
       s.query
  FROM pg_catalog.pg_stat_activity s
 WHERE s.backend_type = 'client backend' AND s.pid <> pg_catalog.pg_backend_pid()
   AND s.datname = pg_catalog.current_database()
   AND ($1::text IS NULL OR s.state = $1)
   AND ($2::int IS NULL OR clock_timestamp() - coalesce(s.query_start, s.backend_start) >= make_interval(secs => $2))
   AND ($3::text IS NULL OR s.application_name = $3)
 ORDER BY s.query_start NULLS LAST, s.pid
 LIMIT $4`

const LOCKS = sql`SELECT w.pid, pg_catalog.to_json(pg_catalog.pg_blocking_pids(w.pid)) AS blocking, l.mode,
       (SELECT n.nspname || '.' || c.relname FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = l.relation) AS relation,
       ${TS(sql`w.state_change`)} AS waiting_since, w.application_name
  FROM pg_catalog.pg_stat_activity w
  JOIN pg_catalog.pg_locks l ON l.pid = w.pid AND NOT l.granted
 WHERE w.backend_type = 'client backend' AND w.datname = pg_catalog.current_database()
   AND cardinality(pg_catalog.pg_blocking_pids(w.pid)) > 0
 ORDER BY w.pid
 LIMIT $1`

const OPERATION_IN_NAME = /\bop_[0-7][0-9A-HJKMNP-TV-Z]{25}\b/

function operationOf(
  applicationName: string | null,
): SessionList['sessions'][number]['exponetdbOperationId'] {
  if (applicationName === null || !applicationName.startsWith('exponetdb/')) return null
  const match = OPERATION_IN_NAME.exec(applicationName)
  return match === null ? null : brand('op', match[0])
}

const ms = (row: TargetRow, column: string): number | null => {
  const v = row.textOrNull(column)
  if (v === null) return null
  const n = Number(v)
  return Number.isSafeInteger(n) && n >= 0 ? n : 0
}

async function onTarget<T>(
  deps: SnapshotDeps,
  target: TargetRecord,
  purpose: string,
  read: (
    session: Awaited<ReturnType<SnapshotDeps['connector']['forTarget']>>['session'],
  ) => Promise<T>,
): Promise<T> {
  if (target.state !== 'active' && target.state !== 'suspended') {
    throw new DiagnosticsError(
      target.state === 'decommissioned' ? 'TARGET_NOT_FOUND' : 'TARGET_UNAVAILABLE',
    )
  }
  const opened = await deps.connector.forTarget(target, 'observer', `${purpose}/${target.targetId}`)
  try {
    await requireIdentity(opened.session, target, deps.installationId)
    return await read(opened.session)
  } finally {
    await opened.session.close()
  }
}

export async function listSessions(
  deps: SnapshotDeps,
  target: TargetRecord,
  filter: SessionFilter = {},
): Promise<SessionList> {
  const cap = Math.min(Math.max(1, Math.trunc(filter.limit ?? 200)), 1000)
  return onTarget(deps, target, 'sessions', async (session) => {
    const rows = await session.query(SESSIONS, [
      filter.state ?? null,
      filter.minAgeSeconds ?? null,
      filter.application ?? null,
      cap + 1,
    ])
    const major = session.facts.major
    const sessions: SessionList['sessions'] = []
    for (const r of rows.slice(0, cap)) {
      const query = r.textOrNull('query')
      const waitType = r.textOrNull('wait_event_type')
      const waitEvent = r.textOrNull('wait_event')
      const statement =
        query === null || query.length === 0
          ? null
          : await redactStatement(query, { major, maxLength: DEFAULT_MAX_LENGTH })
      sessions.push({
        pid: r.int('pid'),
        backendStart: r.text('backend_start'),
        queryStart: r.textOrNull('query_start'),
        role: clip(r.textOrNull('role') ?? '', 63),
        applicationName: clip(r.textOrNull('application_name') ?? '', 128),
        state: clip(r.textOrNull('state') ?? '', 64),
        waitEvent:
          waitType === null || waitEvent === null
            ? null
            : { type: clip(waitType, 64), event: clip(waitEvent, 64) },
        transactionAgeMs: ms(r, 'xact_ms'),
        queryAgeMs: ms(r, 'query_ms'),
        stateAgeMs: ms(r, 'state_ms'),
        statement:
          statement === null
            ? null
            : {
                redacted: clip(statement.text, 16_384),
                digest: statement.digest as NonNullable<
                  SessionList['sessions'][number]['statement']
                >['digest'],
              },
        exponetdbOperationId: operationOf(r.textOrNull('application_name')),
      })
    }
    return {
      targetId: brand('tgt', target.targetId),
      sessions,
      truncated: rows.length > cap,
      cap,
      source: 'live',
      observedAt: new Date().toISOString(),
    }
  })
}

/** Waiting sessions with the pids that block them (`pg_blocking_pids`); never terminates anything. */
export async function lockGraph(deps: SnapshotDeps, target: TargetRecord): Promise<LockGraph> {
  const cap = 500
  return onTarget(deps, target, 'locks', async (session) => {
    const rows = await session.query(LOCKS, [cap + 1])
    const waits: LockGraph['waits'] = []
    for (const r of rows.slice(0, cap)) {
      const blocking = r.json('blocking')
      const pids = (isJsonArray(blocking) ? blocking : []).filter(
        (p): p is number => typeof p === 'number' && Number.isSafeInteger(p) && p > 0,
      )
      if (pids.length === 0) continue
      const relation = r.textOrNull('relation')
      waits.push({
        waitingPid: r.int('pid'),
        blockingPids: pids,
        lockMode: clip(r.textOrNull('mode') ?? '', 64),
        relation: relation === null ? null : clip(relation, 127),
        waitingSince: r.textOrNull('waiting_since'),
        exponetdbOperationId: operationOf(r.textOrNull('application_name')),
      })
    }
    return {
      targetId: brand('tgt', target.targetId),
      waits,
      truncated: rows.length > cap,
      source: 'live',
      observedAt: new Date().toISOString(),
    }
  })
}

import { isJsonArray, isJsonObject, type JsonObject } from '@exponetdb/kernel'
import { TargetError } from './errors.ts'
import { type MarkerState, readMarker } from './ledger.ts'
import type { TargetSession } from './session.ts'
import { sql } from './sql.ts'

/**
 * Health probes ([health.md §2](../../../exponetdb-docs/10-observability/health.md#2-probes),
 * [postgres-adapter.md §3 "Connectivity probe"](../../../exponetdb-docs/03-database-model/postgres-adapter.md#connectivity-probe)).
 *
 * Each probe has its own deadline and is reported separately with its
 * duration; a probe that runs out of time is `timeout`, not a slow success,
 * and a failure carries its error class. Nothing here turns a failed read
 * into an empty or zero result (C-28).
 */
export type ProbeOutcome =
  | { readonly status: 'ok'; readonly durationMs: number }
  | { readonly status: 'timeout'; readonly durationMs: number }
  | {
      readonly status: 'failed'
      readonly durationMs: number
      readonly code: TargetError['code']
      readonly reason: TargetError['reason']
    }

async function timed(deadlineMs: number, run: () => Promise<boolean>): Promise<ProbeOutcome> {
  const started = performance.now()
  const elapsed = () => Math.round(performance.now() - started)
  try {
    const ok = await run()
    return ok
      ? { status: 'ok', durationMs: elapsed() }
      : { status: 'failed', durationMs: elapsed(), code: 'TARGET_SQL_ERROR', reason: 'protocol' }
  } catch (error) {
    const e =
      error instanceof TargetError ? error : new TargetError('TARGET_UNAVAILABLE', 'protocol')
    if (
      e.reason === 'query_timeout' ||
      (elapsed() >= deadlineMs && e.code === 'TARGET_UNAVAILABLE')
    ) {
      return { status: 'timeout', durationMs: elapsed() }
    }
    return { status: 'failed', durationMs: elapsed(), code: e.code, reason: e.reason }
  }
}

const SIMPLE = sql`SELECT 1`
const EXTENDED = sql`SELECT $1::int AS one`

/** `SELECT 1` over the simple query protocol. */
export function probeSimple(session: TargetSession, deadlineMs = 5000): Promise<ProbeOutcome> {
  return timed(deadlineMs, async () => {
    const rows = await session.query(SIMPLE, [], { protocol: 'simple', timeoutMs: deadlineMs })
    return rows.length === 1
  })
}

/** `SELECT $1::int` with a bound parameter: Parse, Bind, Execute. */
export function probeExtended(session: TargetSession, deadlineMs = 5000): Promise<ProbeOutcome> {
  return timed(deadlineMs, async () => {
    const rows = await session.query(EXTENDED, [1], { timeoutMs: deadlineMs })
    return rows[0]?.int('one') === 1
  })
}

export interface IdentityProbe {
  readonly outcome: ProbeOutcome
  readonly marker: MarkerState | undefined
}

export async function probeIdentity(
  session: TargetSession,
  deadlineMs = 5000,
): Promise<IdentityProbe> {
  let marker: MarkerState | undefined
  const outcome = await timed(deadlineMs, async () => {
    marker = await readMarker(session)
    return true
  })
  return { outcome, marker }
}

export interface CapacitySettings {
  readonly maxConnections: number
  readonly superuserReserved: number
  /** `reserved_connections` (PostgreSQL 16+). */
  readonly reserved: number
  readonly serverVersionNum: number
  /** `max_connections − superuser_reserved_connections − reserved_connections`, never below 0. */
  readonly usableSlots: number
}

const SETTINGS = sql`SELECT current_setting('max_connections') AS max_connections,
       current_setting('superuser_reserved_connections') AS superuser_reserved,
       current_setting('reserved_connections') AS reserved,
       current_setting('server_version_num') AS version_num`

export async function readCapacity(session: TargetSession): Promise<CapacitySettings> {
  const row = (await session.query(SETTINGS, [], { protocol: 'simple' }))[0]
  if (row === undefined) {
    throw new TargetError('TARGET_SQL_ERROR', 'protocol')
  }
  const maxConnections = row.int('max_connections')
  const superuserReserved = row.int('superuser_reserved')
  const reserved = row.int('reserved')
  return {
    maxConnections,
    superuserReserved,
    reserved,
    serverVersionNum: row.int('version_num'),
    usableSlots: Math.max(0, maxConnections - superuserReserved - reserved),
  }
}

/** One stuck or notable session; `pid` and `backendStart` together identify the backend. */
export interface SessionNote {
  readonly pid: number
  readonly backendStart: string
  /** Untrusted: role and application names come from the target. */
  readonly user: string | null
  readonly applicationName: string | null
  readonly state: string | null
  readonly waitEventType: string | null
  readonly waitEvent: string | null
  readonly queryAgeSeconds: number | null
  readonly transactionAgeSeconds: number | null
  readonly stateAgeSeconds: number | null
  readonly blockedBy: readonly number[]
}

export interface ActivitySummary {
  readonly clientBackends: number
  readonly active: number
  readonly idleInTransaction: number
  /** `state = active`, `wait_event = ClientRead`, query age ≥ 60 s. */
  readonly stalled: readonly SessionNote[]
  /** idle in transaction (incl. aborted) for ≥ 10 s. */
  readonly idleInTransactionLong: readonly SessionNote[]
  /** active, not ClientRead, query age ≥ 30 s. */
  readonly longRunning: readonly SessionNote[]
  /** waiting on a lock for ≥ 10 s, with the blocking pids. */
  readonly lockWaits: readonly SessionNote[]
  /** Client backends from a non-local address without TLS. */
  readonly plaintextRemote: number
  /** `age(datfrozenxid)` of this database. */
  readonly xidAge: number
  /** Exact counts per condition (the lists above are capped at 50 sessions per flag combination). */
  readonly counts: {
    readonly stalled: number
    readonly idleInTransactionLong: number
    readonly longRunning: number
    readonly lockWaits: number
  }
  /** Oldest state age of an idle transaction and oldest query age of a long query, over all sessions. */
  readonly oldestIdleInTransactionSeconds: number | null
  readonly oldestLongRunningSeconds: number | null
  /** The lists are capped; `truncated` says that more sessions matched than are listed. */
  readonly truncated: boolean
}

/**
 * One parameter-free read of `pg_stat_activity` (client backends only),
 * `pg_stat_ssl` and `pg_database` (the observer has `pg_monitor`). The
 * rules here are the condition rules of health.md §3; the same function
 * decides "stalled" for display and for a later terminate plan.
 */
const ACTIVITY = sql`WITH a AS (
  SELECT s.pid, s.backend_start, s.usename, s.application_name, s.state, s.wait_event_type, s.wait_event,
         s.client_addr, s.query_start, s.xact_start, s.state_change,
         extract(epoch FROM (clock_timestamp() - s.query_start))::bigint AS query_age,
         extract(epoch FROM (clock_timestamp() - s.xact_start))::bigint AS xact_age,
         extract(epoch FROM (clock_timestamp() - s.state_change))::bigint AS state_age,
         (SELECT l.ssl FROM pg_catalog.pg_stat_ssl l WHERE l.pid = s.pid) AS ssl
    FROM pg_catalog.pg_stat_activity s
   WHERE s.backend_type = 'client backend' AND s.pid <> pg_catalog.pg_backend_pid()
), marked AS (
  SELECT a.*,
         (a.state = 'active' AND a.wait_event = 'ClientRead' AND a.query_age >= 60) AS is_stalled,
         (a.state IN ('idle in transaction', 'idle in transaction (aborted)') AND a.state_age >= 10) AS is_idle_tx,
         (a.state = 'active' AND a.wait_event IS DISTINCT FROM 'ClientRead' AND a.query_age >= 30) AS is_long,
         (a.wait_event_type = 'Lock' AND a.state_age >= 10) AS is_lock_wait
    FROM a
), notes AS (
  SELECT m.*, row_number() OVER (PARTITION BY m.is_stalled, m.is_idle_tx, m.is_long, m.is_lock_wait
                                 ORDER BY m.query_start NULLS LAST, m.pid) AS rank
    FROM marked m
   WHERE m.is_stalled OR m.is_idle_tx OR m.is_long OR m.is_lock_wait
)
SELECT
  (SELECT count(*) FROM a) AS client_backends,
  (SELECT count(*) FROM a WHERE a.state = 'active') AS active,
  (SELECT count(*) FROM a WHERE a.state IN ('idle in transaction', 'idle in transaction (aborted)')) AS idle_in_transaction,
  (SELECT count(*) FROM a WHERE a.ssl IS DISTINCT FROM true AND a.client_addr IS NOT NULL
      AND NOT (a.client_addr << inet '127.0.0.0/8' OR a.client_addr = inet '::1')) AS plaintext_remote,
  (SELECT pg_catalog.age(d.datfrozenxid) FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()) AS xid_age,
  (SELECT count(*) FROM marked WHERE marked.is_stalled) AS stalled_count,
  (SELECT count(*) FROM marked WHERE marked.is_idle_tx) AS idle_tx_count,
  (SELECT count(*) FROM marked WHERE marked.is_long) AS long_count,
  (SELECT count(*) FROM marked WHERE marked.is_lock_wait) AS lock_wait_count,
  (SELECT max(marked.state_age) FROM marked WHERE marked.is_idle_tx) AS idle_tx_oldest,
  (SELECT max(marked.query_age) FROM marked WHERE marked.is_long) AS long_oldest,
  EXISTS (SELECT 1 FROM notes WHERE notes.rank > 50) AS truncated,
  (SELECT pg_catalog.json_agg(pg_catalog.json_build_object(
      'pid', n.pid, 'backendStart', n.backend_start::text, 'user', n.usename::text,
      'applicationName', n.application_name, 'state', n.state, 'waitEventType', n.wait_event_type,
      'waitEvent', n.wait_event, 'queryAge', n.query_age, 'xactAge', n.xact_age, 'stateAge', n.state_age,
      'stalled', n.is_stalled, 'idleTx', n.is_idle_tx, 'long', n.is_long, 'lockWait', n.is_lock_wait,
      'blockedBy', CASE WHEN n.is_lock_wait THEN pg_catalog.to_json(pg_catalog.pg_blocking_pids(n.pid)) ELSE '[]'::json END)
      ORDER BY n.pid)
     FROM notes n WHERE n.rank <= 50) AS notes`

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value.slice(0, 256) : null
}

const STATS_VISIBLE = sql`SELECT pg_catalog.pg_has_role('pg_read_all_stats', 'USAGE') AS visible`

/**
 * Activity of other roles is visible only through `pg_read_all_stats` (part
 * of `pg_monitor`); without it PostgreSQL shows their rows with NULL state
 * and backend type, and a count would read as zero sessions. A role that
 * lost it gets an error, never a partial picture.
 */
export async function requireActivityVisibility(session: TargetSession): Promise<void> {
  const row = (await session.query(STATS_VISIBLE, [], { protocol: 'simple' }))[0]
  if (row?.bool('visible') !== true) {
    throw new TargetError('PERMISSION_DENIED', 'insufficient_privilege')
  }
}

export async function readActivity(session: TargetSession): Promise<ActivitySummary> {
  await requireActivityVisibility(session)
  const row = (await session.query(ACTIVITY, [], { protocol: 'simple' }))[0]
  if (row === undefined) {
    throw new TargetError('TARGET_SQL_ERROR', 'protocol')
  }
  const notes = row.jsonArray('notes').filter(isJsonObject)
  const note = (n: JsonObject): SessionNote => ({
    pid: num(n['pid']) ?? 0,
    backendStart: str(n['backendStart']) ?? '',
    user: str(n['user']),
    applicationName: str(n['applicationName']),
    state: str(n['state']),
    waitEventType: str(n['waitEventType']),
    waitEvent: str(n['waitEvent']),
    queryAgeSeconds: num(n['queryAge']),
    transactionAgeSeconds: num(n['xactAge']),
    stateAgeSeconds: num(n['stateAge']),
    blockedBy: (isJsonArray(n['blockedBy']) ? n['blockedBy'] : []).filter(
      (p): p is number => typeof p === 'number',
    ),
  })
  const pick = (flag: string) => notes.filter((n) => n[flag] === true).map(note)
  return {
    clientBackends: row.int('client_backends'),
    active: row.int('active'),
    idleInTransaction: row.int('idle_in_transaction'),
    stalled: pick('stalled'),
    idleInTransactionLong: pick('idleTx'),
    longRunning: pick('long'),
    lockWaits: pick('lockWait'),
    plaintextRemote: row.int('plaintext_remote'),
    xidAge: row.int('xid_age'),
    counts: {
      stalled: row.int('stalled_count'),
      idleInTransactionLong: row.int('idle_tx_count'),
      longRunning: row.int('long_count'),
      lockWaits: row.int('lock_wait_count'),
    },
    oldestIdleInTransactionSeconds: row.intOrNull('idle_tx_oldest'),
    oldestLongRunningSeconds: row.intOrNull('long_oldest'),
    truncated: row.bool('truncated'),
  }
}

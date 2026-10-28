import {
  type ControlStore,
  EXDB_LOCK_NAMESPACE,
  lockKey2,
  type Queryable,
  type Row,
  type Tx,
} from '@exponetdb/control-store'
import { newId } from '@exponetdb/kernel'
import { sha256Hex } from '@exponetdb/kernel/hash'
import {
  qualified,
  sql,
  TargetError,
  type TargetRow,
  type TargetSession,
  type TrustedSql,
} from '@exponetdb/postgres'
import {
  DEFAULT_MAX_LENGTH,
  loadParser,
  MCP_MAX_LENGTH,
  redactStatementSync,
  type SupportedMajor,
} from '@exponetdb/postgres/parser'
import { brand, type TargetRecord } from '@exponetdb/registry'
import type { QueryStats } from './contract-types.ts'
import { DiagnosticsError, failureCodeOf } from './errors.ts'
import { clip } from './findings.ts'
import { isoOf, msOf, onObserver, statsVisible, usText } from './live.ts'
import type { SnapshotDeps } from './snapshots.ts'
import {
  type Counters,
  type Discontinuity,
  deltaOf,
  deltasAllowed,
  discontinuityOf,
  gapsOf,
  type LatestCounters,
  REGRESSION,
  type Regression,
  regressionOf,
  type SampleMarks,
  STATEMENT_GAP_SECONDS,
  STATEMENT_SAMPLE_INTERVAL_SECONDS,
  STATEMENT_TOP,
  textReplaced,
} from './statement-math.ts'
import {
  openSubjectFindings,
  resolveSubjectFinding,
  upsertSubjectFinding,
} from './subject-findings.ts'

/**
 * Statement statistics ([performance.md §2](../../../exponetdb-docs/10-observability/performance.md#2-pg_stat_statements),
 * bundle `statement-statistics`).
 *
 * **Sampling** (the worker, every 5 minutes per active or suspended target):
 * on an identity-checked observer session with the diagnostic limits, the
 * sampler checks that the observer may read other roles' statistics
 * (`pg_read_all_stats`, else `not_permitted`) and that `pg_stat_statements`
 * is installed in the target's database and loaded (else
 * `extension_missing`), reads `pg_stat_statements_info.stats_reset` and
 * `dealloc`, `pg_postmaster_start_time()` and the top 200 statements of the
 * target's database by total execution time. The columns are read from the
 * view's own catalog entry, not from the server version: the installed
 * extension version decides them (`toplevel` from 1.9, `stats_since` from
 * 1.11, the PostgreSQL 17 version). The statement key is
 * `sha256:<hex of dbid:userid:queryid>`; with `toplevel` only top-level
 * statements are read (nested ones share the key).
 *
 * Every text goes through the redactor before it is stored; a statement the
 * redactor replaces with a fixed summary (role passwords, user mappings,
 * server options and the other sensitive classes) is stored as that summary
 * with `text_redacted`. One Control Store transaction per sample writes the
 * sample, its reset event, the deltas against the previous counters and
 * the new counters; deltas follow `deltaOf` (never negative, never across a
 * reset, a restart or a recreated entry).
 */
export interface StatementDeps {
  readonly store: ControlStore
  readonly connector: SnapshotDeps['connector']
  readonly installationId: string
}

const US = (column: TrustedSql) =>
  sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

const EXTENSION = sql`SELECT n.nspname::text AS schema
  FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
 WHERE e.extname = 'pg_stat_statements'`

const COLUMNS = sql`SELECT a.attname::text AS name
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = $1 AND c.relname = 'pg_stat_statements' AND a.attnum > 0 AND NOT a.attisdropped`

const REQUIRED_COLUMNS = [
  'userid',
  'dbid',
  'queryid',
  'query',
  'calls',
  'total_exec_time',
  'rows',
  'shared_blks_hit',
  'shared_blks_read',
] as const

const infoOf = (schema: string) =>
  sql`SELECT ${US(sql`i.stats_reset`)} AS stats_reset, i.dealloc::text AS dealloc,
       ${US(sql`pg_catalog.pg_postmaster_start_time()`)} AS postmaster_start
  FROM ${qualified(schema, 'pg_stat_statements_info')} i`

function statementsOf(schema: string, columns: ReadonlySet<string>): TrustedSql {
  const since = columns.has('stats_since') ? US(sql`s.stats_since`) : sql`NULL::text`
  const toplevel = columns.has('toplevel') ? sql`AND s.toplevel` : sql``
  return sql`SELECT s.queryid::text AS queryid, s.userid::text AS userid, s.dbid::text AS dbid, s.query,
       s.calls::text AS calls, s.total_exec_time::text AS total_ms, s.rows::text AS rows,
       s.shared_blks_hit::text AS blks_hit, s.shared_blks_read::text AS blks_read,
       ${since} AS stats_since,
       coalesce(r.rolname::text, 'oid ' || s.userid::text) AS role_name,
       pg_catalog.current_database()::text AS database_name
  FROM ${qualified(schema, 'pg_stat_statements')} s
  LEFT JOIN pg_catalog.pg_roles r ON r.oid = s.userid
 WHERE s.dbid = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())
   AND s.queryid IS NOT NULL ${toplevel}
 ORDER BY s.total_exec_time DESC, s.queryid
 LIMIT $1`
}

/** One statement as a sample read it (redacted text, cumulative counters). */
export interface SampledStatement {
  readonly key: string
  readonly queryId: string
  readonly database: string
  readonly role: string
  readonly text: string
  readonly textRedacted: boolean
  readonly counters: Counters
  readonly statsSinceMs: number | null
}

export type SampleRead =
  | {
      readonly outcome: 'ok'
      readonly marks: SampleMarks
      readonly statements: readonly SampledStatement[]
    }
  | {
      readonly outcome: 'extension_missing' | 'not_permitted' | 'failed'
      readonly errorCode: string
    }

/** `sha256:<hex>` of `dbid:userid:queryid` (performance.md §2). */
export function statementKey(dbid: string, userid: string, queryid: string): string {
  return `sha256:${sha256Hex(`${dbid}:${userid}:${queryid}`)}`
}

const UNAVAILABLE_TEXT = '<statement text not available>'
/** The longest normalized text stored (the column's bound). */
export const STORED_TEXT_MAX = 16_384

/** The stored form of a statement text: redacted, a fixed summary for the sensitive classes. */
export function storedText(
  query: string | null,
  major: SupportedMajor,
): { readonly text: string; readonly textRedacted: boolean } {
  if (query === null || query.trim().length === 0) {
    return { text: UNAVAILABLE_TEXT, textRedacted: false }
  }
  const redacted = redactStatementSync(query, { major, maxLength: STORED_TEXT_MAX })
  const text = redacted.text.length === 0 ? UNAVAILABLE_TEXT : redacted.text
  return { text, textRedacted: textReplaced(redacted.mode) }
}

const big = (row: TargetRow, column: string): bigint => {
  const v = row.textOrNull(column) ?? '0'
  if (!/^-?\d{1,20}$/.test(v)) throw new TargetError('TARGET_SQL_ERROR', 'protocol')
  const n = BigInt(v)
  return n < 0n ? 0n : n
}

const float = (row: TargetRow, column: string): number => {
  const n = Number(row.textOrNull(column) ?? '0')
  return Number.isFinite(n) && n >= 0 ? n : 0
}

const loadedFailure = (error: unknown) =>
  // "pg_stat_statements must be loaded via shared_preload_libraries".
  error instanceof TargetError && error.sqlstate === '55000'

/** Reads one sample on an opened observer session (exposed for tests). */
export async function readStatementSample(session: TargetSession): Promise<SampleRead> {
  if (!(await statsVisible(session))) {
    return { outcome: 'not_permitted', errorCode: 'PERMISSION_DENIED' }
  }
  const schema = (await session.query(EXTENSION))[0]?.textOrNull('schema') ?? null
  if (schema === null) return { outcome: 'extension_missing', errorCode: 'CAPABILITY_UNAVAILABLE' }
  const columns = new Set((await session.query(COLUMNS, [schema])).map((r) => r.text('name')))
  if (!REQUIRED_COLUMNS.every((c) => columns.has(c))) {
    // An extension older than 1.8 (PostgreSQL 13) has none of these columns.
    return { outcome: 'failed', errorCode: 'CAPABILITY_UNAVAILABLE' }
  }
  let info: TargetRow | undefined
  let rows: TargetRow[]
  try {
    info = (await session.query(infoOf(schema)))[0]
    rows = await session.query(statementsOf(schema, columns), [STATEMENT_TOP])
  } catch (error) {
    if (loadedFailure(error)) {
      return { outcome: 'extension_missing', errorCode: 'CAPABILITY_UNAVAILABLE' }
    }
    throw error
  }
  if (info === undefined) throw new TargetError('TARGET_SQL_ERROR', 'protocol')
  const major = session.facts.major as SupportedMajor
  await loadParser(major)
  const dealloc = info.textOrNull('dealloc')
  return {
    outcome: 'ok',
    marks: {
      statsReset: info.textOrNull('stats_reset'),
      dealloc: dealloc === null ? null : BigInt(dealloc),
      postmasterStart: info.textOrNull('postmaster_start'),
    },
    statements: rows.map((r) => {
      const { text, textRedacted } = storedText(r.textOrNull('query'), major)
      const since = r.textOrNull('stats_since')
      return {
        key: statementKey(r.text('dbid'), r.text('userid'), r.text('queryid')),
        queryId: r.text('queryid'),
        database: clip(r.text('database_name'), 63),
        role: clip(r.text('role_name'), 63),
        text,
        textRedacted,
        counters: {
          calls: big(r, 'calls'),
          totalTimeMs: float(r, 'total_ms'),
          rows: big(r, 'rows'),
          blksHit: big(r, 'blks_hit'),
          blksRead: big(r, 'blks_read'),
        },
        statsSinceMs: since === null ? null : msOf(since),
      }
    }),
  }
}

export interface StatementSampleResult {
  readonly sampleId: string
  readonly outcome: 'ok' | 'extension_missing' | 'not_permitted' | 'failed'
  readonly discontinuity: Discontinuity
  readonly statements: number
  readonly deltas: number
  readonly sampledAt: string
}

function lockStatements(tx: Tx, targetId: string) {
  return tx.query('observation.statements.lock', 'SELECT pg_advisory_xact_lock($1::int, $2::int)', [
    EXDB_LOCK_NAMESPACE,
    lockKey2(`observation/statements/${targetId}`),
  ])
}

/**
 * Takes and records one statement sample of a target (the worker). A target
 * that cannot be read is recorded as a `failed` sample with its code: never
 * as a sample without statements that looks fine.
 */
export async function sampleStatements(
  deps: StatementDeps,
  target: TargetRecord,
): Promise<StatementSampleResult> {
  const started = performance.now()
  let read: SampleRead
  try {
    read = await onObserver(deps, target, 'statements', readStatementSample)
  } catch (error) {
    read = { outcome: 'failed', errorCode: failureCodeOf(error) }
  }
  const durationMs = Math.max(0, Math.round(performance.now() - started))
  const result = await deps.store.transaction('observation.statements.sample', (tx) =>
    recordSample(tx, target, read, durationMs),
  )
  if (result.outcome === 'ok' && result.firstOfHour) {
    // Regressions are judged once an hour per target (an 8-day aggregate), not every sample.
    await evaluateRegressions(deps.store, target, msOf(result.sampledAtUs))
  }
  return result
}

const isoUs = usText

async function recordSample(
  tx: Tx,
  target: TargetRecord,
  read: SampleRead,
  durationMs: number,
): Promise<
  StatementSampleResult & { readonly firstOfHour: boolean; readonly sampledAtUs: string }
> {
  await lockStatements(tx, target.targetId)
  const previous = (
    await tx.query(
      'observation.statements.previous',
      `SELECT ${isoUs('stats_reset')} AS stats_reset, dealloc::text AS dealloc,
              ${isoUs('postmaster_start')} AS postmaster_start, ${isoUs('sampled_at')} AS sampled_at,
              date_trunc('hour', sampled_at) = date_trunc('hour', clock_timestamp()) AS same_hour
         FROM observation.statement_samples
        WHERE target_id = $1 AND outcome = 'ok' ORDER BY sampled_at DESC LIMIT 1`,
      [target.targetId],
    )
  ).rows[0]
  const prevMarks: SampleMarks | undefined =
    previous === undefined
      ? undefined
      : {
          statsReset: previous.textOrNull('stats_reset'),
          dealloc:
            previous.textOrNull('dealloc') === null ? null : BigInt(previous.text('dealloc')),
          postmasterStart: previous.textOrNull('postmaster_start'),
        }
  const ok = read.outcome === 'ok'
  const discontinuity: Discontinuity = ok ? discontinuityOf(prevMarks, read.marks) : 'none'
  const sampleId = newId('smp', Date.now())
  const inserted = await tx.query(
    'observation.statements.sample_insert',
    `INSERT INTO observation.statement_samples
       (sample_id, target_id, generation, outcome, error_code, stats_reset, dealloc, postmaster_start,
        discontinuity, statements, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::bigint, $8::timestamptz, $9, $10, $11)
     RETURNING ${isoUs('sampled_at')} AS sampled_at`,
    [
      sampleId,
      target.targetId,
      target.generation,
      read.outcome,
      ok ? null : read.errorCode,
      ok ? read.marks.statsReset : null,
      ok && read.marks.dealloc !== null ? read.marks.dealloc.toString() : null,
      ok ? read.marks.postmasterStart : null,
      discontinuity,
      ok ? read.statements.length : 0,
      durationMs,
    ],
  )
  const sampledAtUs = inserted.rows[0]?.text('sampled_at')
  if (sampledAtUs === undefined) throw new DiagnosticsError('INTERNAL')
  const base = {
    sampleId,
    outcome: read.outcome,
    discontinuity,
    sampledAt: isoOf(sampledAtUs),
    sampledAtUs,
    firstOfHour: previous === undefined || !previous.bool('same_hour'),
  }
  if (!ok) return { ...base, statements: 0, deltas: 0 }
  if (discontinuity !== 'none' && discontinuity !== 'first') {
    const at =
      discontinuity === 'stats_reset'
        ? (read.marks.statsReset ?? sampledAtUs)
        : discontinuity === 'server_restart'
          ? (read.marks.postmasterStart ?? sampledAtUs)
          : sampledAtUs
    await tx.query(
      'observation.statements.reset_event',
      `INSERT INTO observation.stats_reset_events (sample_id, target_id, kind, at)
       VALUES ($1, $2, $3, $4::timestamptz)`,
      [sampleId, target.targetId, discontinuity, at],
    )
  }
  const keys = read.statements.map((s) => s.key)
  const latest = new Map<string, LatestCounters>()
  if (keys.length > 0) {
    const { rows } = await tx.query(
      'observation.statements.latest',
      `SELECT statement_key, calls::text AS calls, total_time_ms::text AS total_ms, rows::text AS rows,
              blks_hit::text AS blks_hit, blks_read::text AS blks_read,
              ${isoUs('stats_reset')} AS stats_reset, ${isoUs('postmaster_start')} AS postmaster_start,
              ${isoUs('sampled_at')} AS sampled_at
         FROM observation.statement_latest
        WHERE target_id = $1 AND statement_key = ANY($2::text[])
        FOR UPDATE`,
      [target.targetId, keys],
    )
    for (const r of rows) latest.set(r.text('statement_key'), latestFrom(r))
  }
  const ctx = {
    discontinuity,
    statsReset: read.marks.statsReset,
    postmasterStart: read.marks.postmasterStart,
    sampledAtMs: msOf(sampledAtUs),
  }
  const deltas: { s: SampledStatement; d: Counters; fromUs: string }[] = []
  if (deltasAllowed(discontinuity)) {
    for (const s of read.statements) {
      const prev = latest.get(s.key)
      const d = deltaOf(prev, { ...s.counters, statsSinceMs: s.statsSinceMs }, ctx)
      if (d !== null && prev !== undefined) {
        deltas.push({ s, d, fromUs: latestSampledAt.get(prev) ?? sampledAtUs })
      }
    }
  }
  if (deltas.length > 0) {
    await tx.query(
      'observation.statements.deltas_insert',
      `INSERT INTO observation.statement_deltas
         (sample_id, target_id, statement_key, sampled_at, from_at, queryid, database_name, role_name,
          normalized_text, text_redacted, calls, total_time_ms, rows, blks_hit, blks_read)
       SELECT $1, $2, u.k, $3::timestamptz, u.f::timestamptz, u.q, u.d, u.r, u.t, u.x,
              u.c::bigint, u.tt::double precision, u.rr::bigint, u.h::bigint, u.b::bigint
         FROM unnest($4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[],
                     $10::boolean[], $11::text[], $12::text[], $13::text[], $14::text[], $15::text[])
              AS u(k, f, q, d, r, t, x, c, tt, rr, h, b)`,
      [
        sampleId,
        target.targetId,
        sampledAtUs,
        deltas.map((e) => e.s.key),
        deltas.map((e) => e.fromUs),
        deltas.map((e) => e.s.queryId),
        deltas.map((e) => e.s.database),
        deltas.map((e) => e.s.role),
        deltas.map((e) => e.s.text),
        deltas.map((e) => e.s.textRedacted),
        deltas.map((e) => e.d.calls.toString()),
        deltas.map((e) => String(e.d.totalTimeMs)),
        deltas.map((e) => e.d.rows.toString()),
        deltas.map((e) => e.d.blksHit.toString()),
        deltas.map((e) => e.d.blksRead.toString()),
      ],
    )
  }
  if (read.statements.length > 0) {
    const s = read.statements
    await tx.query(
      'observation.statements.latest_upsert',
      `INSERT INTO observation.statement_latest AS l
         (target_id, statement_key, sample_id, stats_reset, postmaster_start, calls, total_time_ms, rows,
          blks_hit, blks_read, sampled_at)
       SELECT $1, u.k, $2, $3::timestamptz, $4::timestamptz, u.c::bigint, u.tt::double precision,
              u.rr::bigint, u.h::bigint, u.b::bigint, $5::timestamptz
         FROM unnest($6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[])
              AS u(k, c, tt, rr, h, b)
       ON CONFLICT (target_id, statement_key) DO UPDATE SET
         sample_id = EXCLUDED.sample_id, stats_reset = EXCLUDED.stats_reset,
         postmaster_start = EXCLUDED.postmaster_start, calls = EXCLUDED.calls,
         total_time_ms = EXCLUDED.total_time_ms, rows = EXCLUDED.rows, blks_hit = EXCLUDED.blks_hit,
         blks_read = EXCLUDED.blks_read, sampled_at = EXCLUDED.sampled_at`,
      [
        target.targetId,
        sampleId,
        read.marks.statsReset,
        read.marks.postmasterStart,
        sampledAtUs,
        s.map((e) => e.key),
        s.map((e) => e.counters.calls.toString()),
        s.map((e) => String(e.counters.totalTimeMs)),
        s.map((e) => e.counters.rows.toString()),
        s.map((e) => e.counters.blksHit.toString()),
        s.map((e) => e.counters.blksRead.toString()),
      ],
    )
  }
  return { ...base, statements: read.statements.length, deltas: deltas.length }
}

/** The microsecond text each latest row was sampled at (the `from_at` of its delta). */
const latestSampledAt = new WeakMap<LatestCounters, string>()

function latestFrom(r: Row): LatestCounters {
  const sampledAt = r.text('sampled_at')
  const value: LatestCounters = {
    calls: BigInt(r.text('calls')),
    totalTimeMs: Number(r.text('total_ms')),
    rows: BigInt(r.text('rows')),
    blksHit: BigInt(r.text('blks_hit')),
    blksRead: BigInt(r.text('blks_read')),
    statsReset: r.textOrNull('stats_reset'),
    postmasterStart: r.textOrNull('postmaster_start'),
    sampledAtMs: msOf(sampledAt),
  }
  latestSampledAt.set(value, sampledAt)
  return value
}

// ----- regressions (performance.md §2) -----

interface RegressionStats {
  readonly key: string
  readonly queryId: string
  readonly calls24h: number
  readonly timeMs24h: number
  readonly calls7d: number
  readonly timeMs7d: number
}

/**
 * The two windows of each statement ending at `toUs`: the last 24 hours and
 * the 7 days before them, from the deltas (attributed to the sample that
 * measured them) of the target's current generation whose interval starts
 * inside the windows (`from_at`). `keys` limits the statements;
 * `minCalls24h` keeps only those that ran at least that often in the last
 * 24 hours (or `include`).
 */
async function regressionStats(
  q: Queryable,
  target: Pick<TargetRecord, 'targetId' | 'generation'>,
  toIso: string,
  filter: {
    readonly keys?: readonly string[]
    readonly minCalls24h?: number
    readonly include?: readonly string[]
  },
): Promise<Map<string, RegressionStats>> {
  const { rows } = await q.query(
    'observation.statements.regression_stats',
    `SELECT d.statement_key,
            (array_agg(d.queryid ORDER BY d.sampled_at DESC))[1] AS queryid,
            coalesce(sum(d.calls) FILTER (WHERE d.sampled_at > $3::timestamptz - interval '${REGRESSION.windowHours} hours'), 0)::text AS c24,
            coalesce(sum(d.total_time_ms) FILTER (WHERE d.sampled_at > $3::timestamptz - interval '${REGRESSION.windowHours} hours'), 0)::text AS t24,
            coalesce(sum(d.calls) FILTER (WHERE d.sampled_at <= $3::timestamptz - interval '${REGRESSION.windowHours} hours'), 0)::text AS c7,
            coalesce(sum(d.total_time_ms) FILTER (WHERE d.sampled_at <= $3::timestamptz - interval '${REGRESSION.windowHours} hours'), 0)::text AS t7
       FROM observation.statement_deltas d
       JOIN observation.statement_samples s ON s.sample_id = d.sample_id AND s.generation = $6
      WHERE d.target_id = $1
        AND ($2::text[] IS NULL OR d.statement_key = ANY($2::text[]))
        AND d.sampled_at > $3::timestamptz - interval '${REGRESSION.windowHours} hours' - interval '${REGRESSION.baselineDays} days'
        AND d.from_at >= $3::timestamptz - interval '${REGRESSION.windowHours} hours' - interval '${REGRESSION.baselineDays} days'
        AND d.sampled_at <= $3::timestamptz
      GROUP BY d.statement_key
     HAVING $4::bigint IS NULL
         OR coalesce(sum(d.calls) FILTER (WHERE d.sampled_at > $3::timestamptz - interval '${REGRESSION.windowHours} hours'), 0) >= $4::bigint
         OR d.statement_key = ANY($5::text[])`,
    [
      target.targetId,
      filter.keys === undefined ? null : [...filter.keys],
      toIso,
      filter.minCalls24h ?? null,
      [...(filter.include ?? [])],
      target.generation,
    ],
  )
  const out = new Map<string, RegressionStats>()
  for (const r of rows) {
    out.set(r.text('statement_key'), {
      key: r.text('statement_key'),
      queryId: r.text('queryid'),
      calls24h: Number(r.text('c24')),
      timeMs24h: Number(r.text('t24')),
      calls7d: Number(r.text('c7')),
      timeMs7d: Number(r.text('t7')),
    })
  }
  return out
}

/**
 * Migrations applied to the target (its current generation) inside the
 * 24-hour window, from the Control Store's ledger mirror; `null` when the
 * mirror never observed the target's ledger (no `ledger_state`), so a
 * count of 0 is a measured 0. A time coincidence, never a cause.
 */
async function migrationsBetween(
  q: Queryable,
  target: TargetRecord,
  toIso: string,
): Promise<number | null> {
  const { rows } = await q.query(
    'observation.statements.migrations_between',
    `SELECT EXISTS (SELECT 1 FROM migrations.ledger_state s
                     WHERE s.target_id = $1 AND s.generation = $2) AS mirrored,
            (SELECT count(*) FROM migrations.ledger_mirror m
              WHERE m.target_id = $1 AND m.generation = $2 AND m.origin = 'exponetdb'
                AND m.applied_at > $3::timestamptz - interval '${REGRESSION.windowHours} hours'
                AND m.applied_at <= $3::timestamptz)::int AS n`,
    [target.targetId, target.generation, toIso],
  )
  const row = rows[0]
  return row === undefined || !row.bool('mirrored') ? null : row.int('n')
}

export const REGRESSION_FINDING_CODE = 'statement_regression'

/**
 * Opens, counts and resolves the statement regression findings of a target
 * (kind `statements`, code `statement_regression`, one per statement key):
 * a regressed statement opens or counts its finding; one that is no longer
 * regressed, or did not run in the last 24 hours, resolves it as `cleared`.
 * A statement with too few calls to judge keeps an open finding as it is.
 */
export async function evaluateRegressions(
  store: ControlStore,
  target: TargetRecord,
  toMs: number,
): Promise<{ readonly opened: number; readonly resolved: number }> {
  const toIso = new Date(toMs).toISOString()
  const open = await openSubjectFindings(store, target.targetId, 'statements', [
    REGRESSION_FINDING_CODE,
  ])
  const stats = await regressionStats(store, target, toIso, {
    minCalls24h: REGRESSION.minCalls,
    include: open.map((f) => f.dedupKey),
  })
  const migrations = await migrationsBetween(store, target, toIso)
  let opened = 0
  let resolved = 0
  await store.transaction('observation.statements.regressions', async (tx) => {
    await lockStatements(tx, target.targetId)
    const openByKey = new Map(open.map((f) => [f.dedupKey, f.findingId]))
    for (const s of stats.values()) {
      const r = regressionOf({ ...s, migrationsBetween: migrations })
      if (r.state === 'regressed') {
        const recorded = await upsertSubjectFinding(tx, {
          subject: { targetId: target.targetId },
          kind: 'statements',
          code: REGRESSION_FINDING_CODE,
          category: null,
          severity: 'warning',
          securityRelevant: false,
          dedupKey: s.key,
          summary: `A statement got slower: mean ${r.meanTimeMs24h} ms over the last 24 hours against ${r.meanTimeMs7d} ms over the 7 days before (factor ${r.factor}).`,
          object: `statement queryid ${s.queryId}`,
          remediation:
            'Compare the statement plan before and after; check the migrations applied in the window (a time coincidence, not a proven cause), indexes, statistics and data growth.',
          details: {
            statementKey: s.key,
            queryId: s.queryId,
            meanTimeMs24h: r.meanTimeMs24h,
            meanTimeMs7d: r.meanTimeMs7d,
            factor: r.factor,
            calls24h: s.calls24h,
            calls7d: s.calls7d,
            migrationsBetween: r.migrationsBetween,
          },
        })
        if (recorded.opened) opened++
      } else {
        const findingId = openByKey.get(s.key)
        if (findingId !== undefined && (r.state === 'none' || s.calls24h === 0)) {
          if (await resolveSubjectFinding(tx, findingId, 'cleared')) resolved++
        }
      }
    }
    for (const f of open) {
      // No delta at all in the eight days: the statement no longer runs.
      if (!stats.has(f.dedupKey) && (await resolveSubjectFinding(tx, f.findingId, 'cleared'))) {
        resolved++
      }
    }
  })
  return { opened, resolved }
}

// ----- the worker's maintenance -----

/** Delta partitions ahead and expired ones dropped (data-retention.md §2: 30 days, 7 to 90). */
export async function maintainStatementPartitions(
  worker: Queryable,
  retentionDays = 30,
): Promise<{ readonly created: number; readonly dropped: number }> {
  const days = Math.min(90, Math.max(7, Math.trunc(retentionDays)))
  const created = await worker.query(
    'observation.statements.partitions.ensure',
    'SELECT observation.ensure_statement_partitions(2) AS n',
  )
  const dropped = await worker.query(
    'observation.statements.partitions.drop',
    'SELECT observation.drop_expired_statement_partitions($1) AS n',
    [days],
  )
  return { created: created.rows[0]?.int('n') ?? 0, dropped: dropped.rows[0]?.int('n') ?? 0 }
}

/**
 * The daily aggregates (400 days, data-retention.md §2) of the finished UTC
 * days of the last `lookbackDays`: recomputed from the deltas, so a run
 * that is repeated, or that comes late, writes the same rows.
 */
export async function rollupStatements(
  worker: Queryable,
  lookbackDays = 3,
): Promise<{ readonly rows: number }> {
  const days = Math.min(28, Math.max(1, Math.trunc(lookbackDays)))
  const { rowCount } = await worker.query(
    'observation.statements.rollup',
    `INSERT INTO observation.statement_daily AS s
       (target_id, day, statement_key, queryid, normalized_text, text_redacted, calls, total_time_ms, rows, samples)
     SELECT d.target_id, (d.sampled_at AT TIME ZONE 'UTC')::date, d.statement_key,
            (array_agg(d.queryid ORDER BY d.sampled_at DESC))[1],
            (array_agg(d.normalized_text ORDER BY d.sampled_at DESC))[1],
            (array_agg(d.text_redacted ORDER BY d.sampled_at DESC))[1],
            sum(d.calls), sum(d.total_time_ms), sum(d.rows), count(*)::int
       FROM observation.statement_deltas d
      WHERE d.sampled_at >= (date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') - make_interval(days => $1)) AT TIME ZONE 'UTC'
        AND d.sampled_at < date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      GROUP BY d.target_id, (d.sampled_at AT TIME ZONE 'UTC')::date, d.statement_key
     ON CONFLICT (target_id, day, statement_key) DO UPDATE SET
       queryid = EXCLUDED.queryid, normalized_text = EXCLUDED.normalized_text,
       text_redacted = EXCLUDED.text_redacted, calls = EXCLUDED.calls,
       total_time_ms = EXCLUDED.total_time_ms, rows = EXCLUDED.rows, samples = EXCLUDED.samples`,
    [days],
  )
  return { rows: rowCount }
}

/** Targets the statement sampler covers (the health sampler's: active and suspended, placed). */
export { targetsToSample as statementTargets } from './health.ts'

// ----- reads (serve) -----

export const QUERY_STATS_DEFAULT_WINDOW_MS = 24 * 3600_000
export const QUERY_STATS_MAX_WINDOW_MS = 7 * 24 * 3600_000
export const QUERY_STATS_MAX_LIMIT = 500

export interface QueryStatsRequest {
  readonly from?: string | undefined
  readonly to?: string | undefined
  readonly order?: 'total_time' | 'mean_time' | 'calls' | 'io' | undefined
  readonly limit?: number | undefined
  /** Who reads the texts: 2,000 characters for people, 500 for agents (RED-2). */
  readonly reader?: 'human' | 'agent' | undefined
}

const ORDER: Readonly<Record<NonNullable<QueryStatsRequest['order']>, string>> = {
  total_time: 'sum(d.total_time_ms)',
  mean_time: 'sum(d.total_time_ms) / nullif(sum(d.calls), 0)',
  calls: 'sum(d.calls)',
  io: 'sum(d.blks_read)',
}

function invalid(path: string, message: string): DiagnosticsError {
  return new DiagnosticsError('VALIDATION_FAILED', {
    errors: [{ path, code: 'invalid_window', message }],
  })
}

const safe = (text: string): number => Math.min(Number(text), Number.MAX_SAFE_INTEGER)

type SamplingState = NonNullable<QueryStats['sampling']>['state']

const STATE_OF: Readonly<Record<string, SamplingState>> = {
  ok: 'active',
  extension_missing: 'extension_missing',
  not_permitted: 'not_permitted',
  failed: 'failing',
}

/**
 * `GET /targets/{id}/query-stats`: the sampled deltas of the window (by
 * default the last 24 hours, at most 7 days), by the statement's sum, with
 * the sampler's state, the resets and gaps of the window, and each
 * statement's regression verdict. Nothing is read live; a target whose
 * latest sample found no `pg_stat_statements` is `CAPABILITY_UNAVAILABLE`.
 */
export async function queryStats(
  q: Queryable,
  target: TargetRecord,
  request: QueryStatsRequest,
  nowMs: number = Date.now(),
): Promise<QueryStats> {
  const toMs = request.to === undefined ? nowMs : Date.parse(request.to)
  const fromMs =
    request.from === undefined ? toMs - QUERY_STATS_DEFAULT_WINDOW_MS : Date.parse(request.from)
  if (!Number.isFinite(toMs) || !Number.isFinite(fromMs) || fromMs >= toMs) {
    throw invalid('/from', 'from must be before to.')
  }
  if (toMs - fromMs > QUERY_STATS_MAX_WINDOW_MS) {
    throw invalid('/from', 'The window is at most 7 days.')
  }
  const limit = Math.min(Math.max(1, Math.trunc(request.limit ?? 50)), QUERY_STATS_MAX_LIMIT)
  const fromIso = new Date(fromMs).toISOString()
  const toIso = new Date(toMs).toISOString()
  const last = (
    await q.query(
      'observation.statements.last_sample',
      `SELECT outcome, error_code, ${isoUs('sampled_at')} AS sampled_at,
              (SELECT ${isoUs('o.sampled_at')} FROM observation.statement_samples o
                WHERE o.target_id = $1 AND o.outcome = 'ok' ORDER BY o.sampled_at DESC LIMIT 1) AS last_ok
         FROM observation.statement_samples WHERE target_id = $1 ORDER BY sampled_at DESC LIMIT 1`,
      [target.targetId],
    )
  ).rows[0]
  if (last?.text('outcome') === 'extension_missing') {
    throw new DiagnosticsError('CAPABILITY_UNAVAILABLE', {
      reason: 'extension_missing',
      extension: 'pg_stat_statements',
    })
  }
  const order = ORDER[request.order ?? 'total_time']
  const { rows } = await q.query(
    'observation.statements.window',
    `SELECT d.statement_key,
            sum(d.calls)::text AS calls, sum(d.total_time_ms)::text AS total_ms, sum(d.rows)::text AS rows,
            sum(d.blks_hit)::text AS blks_hit, sum(d.blks_read)::text AS blks_read,
            (array_agg(d.normalized_text ORDER BY d.sampled_at DESC))[1] AS text,
            (array_agg(d.text_redacted ORDER BY d.sampled_at DESC))[1] AS redacted,
            (array_agg(d.queryid ORDER BY d.sampled_at DESC))[1] AS queryid,
            (array_agg(d.database_name ORDER BY d.sampled_at DESC))[1] AS database_name,
            (array_agg(d.role_name ORDER BY d.sampled_at DESC))[1] AS role_name
       FROM observation.statement_deltas d
       JOIN observation.statement_samples s ON s.sample_id = d.sample_id AND s.generation = $5
      WHERE d.target_id = $1 AND d.sampled_at > $2::timestamptz AND d.sampled_at <= $3::timestamptz
        AND d.from_at >= $2::timestamptz
      GROUP BY d.statement_key
      ORDER BY ${order} DESC NULLS LAST, d.statement_key
      LIMIT $4`,
    [target.targetId, fromIso, toIso, limit + 1, target.generation],
  )
  const page = rows.slice(0, limit)
  const keys = page.map((r) => r.text('statement_key'))
  const stats = keys.length === 0 ? new Map() : await regressionStats(q, target, toIso, { keys })
  const migrations = keys.length === 0 ? null : await migrationsBetween(q, target, toIso)
  const cap = request.reader === 'agent' ? MCP_MAX_LENGTH : DEFAULT_MAX_LENGTH
  const statements: QueryStats['statements'] = page.map((r) => {
    const calls = safe(r.text('calls'))
    const totalTimeMs = Math.max(0, Number(r.text('total_ms')))
    const text = r.text('text')
    const s = stats.get(r.text('statement_key'))
    const regression: Regression | undefined =
      s === undefined ? undefined : regressionOf({ ...s, migrationsBetween: migrations })
    return {
      // The digest every surface shows: of the redacted text (statement-redaction.md §4).
      digest: `sha256:${sha256Hex(text)}` as QueryStats['statements'][number]['digest'],
      normalizedText: clip(text, cap),
      calls,
      totalTimeMs,
      meanTimeMs: calls > 0 ? totalTimeMs / calls : 0,
      rows: safe(r.text('rows')),
      sharedBlocksHit: safe(r.text('blks_hit')),
      sharedBlocksRead: safe(r.text('blks_read')),
      queryId: r.text('queryid'),
      database: clip(r.text('database_name'), 63),
      role: clip(r.text('role_name'), 63),
      textRedacted: r.bool('redacted'),
      ...(regression === undefined ? {} : { regression }),
    }
  })
  const sampling = await samplingOf(q, target, { fromMs, toMs, fromIso, toIso }, last, nowMs)
  const lastOk = last?.textOrNull('last_ok') ?? null
  return {
    targetId: brand('tgt', target.targetId),
    window: { from: fromIso, to: toIso },
    statements,
    truncated: rows.length > limit,
    source: 'sampled',
    observedAt: lastOk === null ? new Date(nowMs).toISOString() : isoOf(lastOk),
    sampling,
  }
}

async function samplingOf(
  q: Queryable,
  target: TargetRecord,
  window: { fromMs: number; toMs: number; fromIso: string; toIso: string },
  last: Row | undefined,
  nowMs: number,
): Promise<NonNullable<QueryStats['sampling']>> {
  const okRows = await q.query(
    'observation.statements.window_samples',
    `SELECT ${isoUs('sampled_at')} AS sampled_at FROM observation.statement_samples
      WHERE target_id = $1 AND outcome = 'ok'
        AND sampled_at >= $2::timestamptz - make_interval(secs => $4) AND sampled_at <= $3::timestamptz
      ORDER BY sampled_at
      LIMIT 5000`,
    [target.targetId, window.fromIso, window.toIso, STATEMENT_GAP_SECONDS],
  )
  const points = okRows.rows.map((r) => msOf(r.text('sampled_at')))
  // A successful sample shortly before the window covers its start.
  if (points.some((t) => t < window.fromMs)) points.push(window.fromMs)
  const gaps =
    last === undefined
      ? []
      : gapsOf(points, { fromMs: window.fromMs, toMs: window.toMs }, nowMs).map((g) => ({
          from: new Date(g.fromMs).toISOString(),
          to: new Date(g.toMs).toISOString(),
        }))
  const events = await q.query(
    'observation.statements.window_resets',
    `SELECT e.kind, ${isoUs('e.at')} AS at FROM observation.stats_reset_events e
       JOIN observation.statement_samples s ON s.sample_id = e.sample_id
      WHERE e.target_id = $1 AND s.sampled_at > $2::timestamptz AND s.sampled_at <= $3::timestamptz
      ORDER BY s.sampled_at LIMIT 64`,
    [target.targetId, window.fromIso, window.toIso],
  )
  const outcome = last?.text('outcome')
  const lastOk = last?.textOrNull('last_ok') ?? null
  return {
    state: outcome === undefined ? 'not_sampled_yet' : (STATE_OF[outcome] ?? 'failing'),
    intervalSeconds: STATEMENT_SAMPLE_INTERVAL_SECONDS,
    lastSampleAt: lastOk === null ? null : isoOf(lastOk),
    lastErrorCode:
      outcome === undefined || outcome === 'ok' ? null : (last?.textOrNull('error_code') ?? null),
    resets: events.rows.map((r) => {
      const kind = r.text('kind')
      return {
        at: isoOf(r.text('at')),
        kind:
          kind === 'server_restart' || kind === 'entries_deallocated'
            ? kind
            : ('stats_reset' as const),
      }
    }),
    gaps,
  }
}

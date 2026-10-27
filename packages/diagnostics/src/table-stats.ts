import {
  ALWAYS_EXCLUDED_SCHEMAS,
  sql,
  type TargetSession,
  type TrustedSql,
} from '@exponetdb/postgres'
import { brand, type TargetRecord } from '@exponetdb/registry'
import type { TableStats } from './contract-types.ts'
import { clip } from './findings.ts'
import { arrayParam, isoOf, onObserver } from './live.ts'
import type { SnapshotDeps } from './snapshots.ts'

/**
 * Table and index statistics, read live (`GET /targets/{id}/table-stats`,
 * [performance.md §1](../../../exponetdb-docs/10-observability/performance.md#1-diagnostic-areas)).
 *
 * Bounded cost: the tables are chosen by the catalog's page count
 * (`relpages`, no I/O) before any size is computed, so `pg_table_size` and
 * `pg_indexes_size` run for at most `limit` tables, and the indexes listed
 * are those of the chosen tables (at most four per table on average, with
 * `truncated` when more exist). Tables of ExponetDB's ledger schema and the
 * system schemas are not listed. Partitioned parents are left out (their
 * leaves are tables with their own numbers).
 *
 * Duplicate indexes: two valid or invalid indexes of the same table are
 * duplicates when they have the same access method, the same key columns
 * (`indkey`), operator classes (`indclass`), collations (`indcollation`),
 * per-column options (`indoption`), expression text and predicate text
 * (`pg_get_expr` of `indexprs` and `indpred`); uniqueness does not count.
 * Of a group, the primary key is kept, else a unique index, else the oldest
 * (lowest oid); every other member names it as `duplicateOf`.
 *
 * Bloat is an estimate (`estimateMethod: heuristic_page_estimate`): the heap
 * bytes times the dead share of its tuples, `table_bytes × n_dead_tup /
 * (n_live_tup + n_dead_tup)`, i.e. the space dead row versions take until a
 * vacuum. It is `null` when nothing was counted yet (no live or dead tuples,
 * or an empty heap). The free space a vacuum leaves behind is not measured:
 * the observer has no access to `pg_stats` widths or `pgstattuple`.
 *
 * `statsSince` is when the database's statistics count from
 * (`pg_stat_database.stats_reset`, else the server start): an index without
 * scans is unused since then, never "unused" in general.
 */
export interface TableStatsRequest {
  readonly schema?: string | undefined
  readonly limit?: number | undefined
}

export const TABLE_STATS_DEFAULT_LIMIT = 200
export const TABLE_STATS_MAX_LIMIT = 1000

const US = (column: TrustedSql) =>
  sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

/** Tables, chosen by catalog page count, then measured. */
const TABLES = sql`WITH chosen AS (
  SELECT c.oid, n.nspname::text AS schema, c.relname::text AS name, c.reltoastrelid, c.relfrozenxid
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'm')
     AND NOT (n.nspname = ANY($1::text[]))
     AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'
     AND ($2::text IS NULL OR n.nspname = $2)
   ORDER BY c.relpages DESC, c.oid
   LIMIT $3
)
SELECT ch.schema, ch.name,
       pg_catalog.pg_table_size(ch.oid)::text AS size_bytes,
       pg_catalog.pg_indexes_size(ch.oid)::text AS index_size_bytes,
       coalesce(st.seq_scan, 0)::text AS seq_scan, coalesce(st.idx_scan, 0)::text AS idx_scan,
       coalesce(st.n_live_tup, 0)::text AS live, coalesce(st.n_dead_tup, 0)::text AS dead,
       ${US(sql`st.last_vacuum`)} AS last_vacuum, ${US(sql`st.last_autovacuum`)} AS last_autovacuum,
       ${US(sql`st.last_analyze`)} AS last_analyze, ${US(sql`st.last_autoanalyze`)} AS last_autoanalyze,
       greatest(pg_catalog.age(ch.relfrozenxid),
                coalesce((SELECT pg_catalog.age(t.relfrozenxid) FROM pg_catalog.pg_class t
                           WHERE t.oid = ch.reltoastrelid AND ch.reltoastrelid <> 0), 0))::text AS xid_age,
       ch.oid::text AS oid
  FROM chosen ch
  LEFT JOIN pg_catalog.pg_stat_all_tables st ON st.relid = ch.oid
 ORDER BY pg_catalog.pg_table_size(ch.oid) DESC, ch.schema, ch.name`

/** Indexes of the chosen tables, with the duplicate signature. */
const INDEXES = sql`WITH ix AS (
  SELECT i.indexrelid, i.indrelid, n.nspname::text AS schema, t.relname::text AS table_name,
         c.relname::text AS name, i.indisvalid AS valid, i.indisunique AS is_unique,
         i.indisprimary AS is_primary,
         pg_catalog.pg_relation_size(i.indexrelid)::text AS size_bytes,
         coalesce(s.idx_scan, 0)::text AS scans,
         pg_catalog.md5(c.relam::text || '|' || i.indkey::text || '|' || i.indclass::text || '|'
           || i.indcollation::text || '|' || i.indoption::text || '|'
           || coalesce(pg_catalog.pg_get_expr(i.indexprs, i.indrelid), '') || '|'
           || coalesce(pg_catalog.pg_get_expr(i.indpred, i.indrelid), '')) AS signature
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
    JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    LEFT JOIN pg_catalog.pg_stat_all_indexes s ON s.indexrelid = i.indexrelid
   WHERE i.indrelid = ANY($1::oid[])
), keeper AS (
  SELECT DISTINCT ON (ix.indrelid, ix.signature) ix.indrelid, ix.signature, ix.indexrelid AS keep, ix.name AS keep_name
    FROM ix ORDER BY ix.indrelid, ix.signature, ix.is_primary DESC, ix.is_unique DESC, ix.indexrelid
)
SELECT ix.schema, ix.table_name, ix.name, ix.size_bytes, ix.scans, ix.valid, ix.is_unique, ix.is_primary,
       CASE WHEN k.keep <> ix.indexrelid THEN k.keep_name END AS duplicate_of
  FROM ix JOIN keeper k ON k.indrelid = ix.indrelid AND k.signature = ix.signature
 ORDER BY ix.schema, ix.table_name, ix.name
 LIMIT $2`

const STATS_SINCE = sql`SELECT ${US(sql`coalesce((SELECT d.stats_reset FROM pg_catalog.pg_stat_database d
                                  WHERE d.datname = pg_catalog.current_database()),
                                 pg_catalog.pg_postmaster_start_time())`)} AS since`

const n = (text: string | null): number => {
  const v = Number(text ?? '0')
  return Number.isFinite(v) && v >= 0 ? Math.min(Math.trunc(v), Number.MAX_SAFE_INTEGER) : 0
}

const at = (text: string | null): string | null => (text === null ? null : isoOf(text))

/** Reads the statistics on an opened observer session (exposed for the advisors and tests). */
export async function readTableStats(
  session: TargetSession,
  request: TableStatsRequest,
): Promise<Omit<TableStats, 'targetId'>> {
  const limit = Math.min(
    Math.max(1, Math.trunc(request.limit ?? TABLE_STATS_DEFAULT_LIMIT)),
    TABLE_STATS_MAX_LIMIT,
  )
  const tableRows = await session.query(TABLES, [
    arrayParam(ALWAYS_EXCLUDED_SCHEMAS),
    request.schema ?? null,
    limit + 1,
  ])
  const chosen = tableRows.slice(0, limit)
  const indexCap = limit * 4
  const indexRows =
    chosen.length === 0
      ? []
      : await session.query(INDEXES, [arrayParam(chosen.map((r) => r.text('oid'))), indexCap + 1])
  const since = (await session.query(STATS_SINCE))[0]?.textOrNull('since') ?? null
  const tables: TableStats['tables'] = chosen.map((r) => {
    const size = n(r.text('size_bytes'))
    const live = n(r.text('live'))
    const dead = n(r.text('dead'))
    return {
      schema: clip(r.text('schema'), 63),
      name: clip(r.text('name'), 63),
      sizeBytes: size,
      indexSizeBytes: n(r.text('index_size_bytes')),
      sequentialScans: n(r.text('seq_scan')),
      indexScans: n(r.text('idx_scan')),
      liveTuples: live,
      deadTuples: dead,
      lastVacuumAt: at(r.textOrNull('last_vacuum')),
      lastAutovacuumAt: at(r.textOrNull('last_autovacuum')),
      lastAnalyzeAt: at(r.textOrNull('last_analyze')),
      lastAutoanalyzeAt: at(r.textOrNull('last_autoanalyze')),
      bloatEstimateBytes: bloatEstimate(size, live, dead),
      xidAge: n(r.text('xid_age')),
    }
  })
  const indexes: TableStats['indexes'] = indexRows.slice(0, indexCap).map((r) => {
    const duplicate = r.textOrNull('duplicate_of')
    return {
      schema: clip(r.text('schema'), 63),
      table: clip(r.text('table_name'), 63),
      name: clip(r.text('name'), 63),
      sizeBytes: n(r.text('size_bytes')),
      scans: n(r.text('scans')),
      valid: r.bool('valid'),
      duplicateOf: duplicate === null ? null : clip(duplicate, 63),
      unique: r.bool('is_unique'),
      primary: r.bool('is_primary'),
    }
  })
  return {
    tables,
    indexes,
    truncated: tableRows.length > limit || indexRows.length > indexCap,
    source: 'live',
    observedAt: new Date().toISOString(),
    statsSince: at(since),
    estimateMethod: 'heuristic_page_estimate',
  }
}

/** The dead share of the heap (see the module note); `null` when nothing was counted. */
export function bloatEstimate(tableBytes: number, live: number, dead: number): number | null {
  if (tableBytes <= 0 || live + dead <= 0) return null
  return Math.round((tableBytes * dead) / (live + dead))
}

export async function tableStats(
  deps: SnapshotDeps,
  target: TargetRecord,
  request: TableStatsRequest,
): Promise<TableStats> {
  const read = await onObserver(deps, target, 'table-stats', (session) =>
    readTableStats(session, request),
  )
  return { targetId: brand('tgt', target.targetId), ...read }
}

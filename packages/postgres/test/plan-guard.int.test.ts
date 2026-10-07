import { isJsonArray, isJsonObject, type JsonValue, parseJson } from '@exponetdb/kernel'
import {
  dropDatabase,
  type Fixture,
  LARGE_CATALOG,
  LARGE_SCHEMA,
  largeCatalogStatements,
  matrix,
} from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql, type TargetSession, type TrustedSql, takeSnapshot } from '../src/index.ts'
import * as Q from '../src/introspection/queries.ts'
import { open, prepareDatabase } from './targets.ts'

/**
 * G4 item 3: the plan guard on the synthetic catalog (≥ 2,000 tables with
 * indexes and row security, 1,000 policies, partitioned tables, pgvector HNSW
 * indexes, views, functions). Every introspection query runs under
 * `EXPLAIN (ANALYZE, FORMAT JSON)`; a sequential scan of a large catalog
 * fails the test unless it is listed below with a written reason. The full
 * snapshot's time is measured and bounded.
 */
const LARGE_CATALOGS = new Set([
  'pg_class',
  'pg_attribute',
  'pg_constraint',
  'pg_index',
  'pg_proc',
  'pg_type',
  'pg_depend',
  'pg_trigger',
  'pg_policy',
  'pg_rewrite',
  'pg_inherits',
  'pg_attrdef',
  'pg_description',
  'pg_namespace',
])

/**
 * Tolerated sequential scans, with the reason. `pg_namespace` is small
 * (one row per schema) and is joined for every row: a hash of it is the
 * cheapest plan, whatever the size of the rest of the catalog.
 */
const TOLERATED: Readonly<Record<string, string>> = {
  pg_namespace: 'one row per schema; hashed once per query, independent of the number of objects',
}

/**
 * A catalog with fewer live rows than this is read faster by a sequential
 * scan than by an index, and the planner (correctly) does so; the guard is
 * about catalogs that grow with the schema. The synthetic catalog makes the
 * guarded ones large (pg_trigger and pg_policy hold 1,000 rows each).
 */
const SMALL_CATALOG_ROWS = 1000

const LARGE: Fixture = { name: 'plan_guard', cluster: [], database: largeCatalogStatements() }

interface PlanNode {
  readonly type: string
  readonly relation: string | undefined
}

function planNodes(value: JsonValue | undefined, out: PlanNode[] = []): PlanNode[] {
  if (isJsonArray(value)) {
    for (const v of value) planNodes(v, out)
  } else if (isJsonObject(value)) {
    const type = value['Node Type']
    if (typeof type === 'string') {
      const relation = value['Relation Name']
      out.push({ type, relation: typeof relation === 'string' ? relation : undefined })
    }
    for (const [k, v] of Object.entries(value)) {
      if (k === 'Plan' || k === 'Plans' || k === 'Plan Rows') planNodes(v, out)
      else if (isJsonArray(v) || isJsonObject(v)) planNodes(v, out)
    }
  }
  return out
}

async function explain(s: TargetSession, query: TrustedSql, params: readonly (string | number)[]) {
  const rows = await s.query(sql`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`, params)
  const text = rows[0]?.text('QUERY PLAN') ?? '[]'
  const parsed = parseJson(text)
  return parsed.ok ? planNodes(parsed.value) : []
}

describe.each(matrix().map((s) => [s.major, s] as const))(
  'plan guard on PostgreSQL %i',
  (_m, server) => {
    let db = ''
    let session: TargetSession | undefined

    beforeAll(async () => {
      db = await prepareDatabase(server, `plan_${server.major}`, LARGE)
      session = await open(server, db, 'observer', { limits: { statementTimeoutMs: 120_000 } })
    }, 600_000)

    afterAll(async () => {
      await session?.close()
      await dropDatabase(server, db)
    })

    it('has the shape of the synthetic catalog', async () => {
      const s = session as TargetSession
      const rows = await s.query(
        sql`SELECT count(*) FILTER (WHERE c.relkind = 'r') AS tables, count(*) FILTER (WHERE c.relkind = 'p') AS partitioned,
                 (SELECT count(*) FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class pc ON pc.oid = p.polrelid
                   WHERE pc.relnamespace = (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $1)) AS policies
            FROM pg_catalog.pg_class c WHERE c.relnamespace = (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $1)`,
        [LARGE_SCHEMA],
      )
      expect(rows[0]?.int('tables')).toBeGreaterThanOrEqual(LARGE_CATALOG.tables)
      expect(rows[0]?.int('partitioned')).toBe(LARGE_CATALOG.partitionedParents)
      expect(rows[0]?.int('policies')).toBe(LARGE_CATALOG.tables / 2)
    })

    it('reads every introspection query without an untolerated sequential catalog scan', async () => {
      const s = session as TargetSession
      const ns = await s.query(sql`SELECT '{' || pg_catalog.string_agg(oid::text, ',') || '}' AS a
                                  FROM pg_catalog.pg_namespace WHERE nspname = 'big' OR nspname = 'public'`)
      const namespaces = ns[0]?.text('a') ?? '{}'
      const page = await s.query(
        sql`SELECT '{' || pg_catalog.string_agg(oid::text, ',') || '}' AS a FROM (
                                    SELECT c.oid FROM pg_catalog.pg_class c WHERE c.oid >= 16384
                                       AND c.relnamespace = ANY ($1::oid[]) ORDER BY c.oid LIMIT 500) x`,
        [namespaces],
      )
      const oids = page[0]?.text('a') ?? '{}'
      const queries: readonly (readonly [string, TrustedSql, readonly (string | number)[]])[] = [
        ['schemas', Q.SCHEMAS, []],
        ['relations', Q.RELATIONS, ['0', namespaces, 500]],
        ['columns', Q.COLUMNS, [oids]],
        ['constraints', Q.constraints(server.major), [oids]],
        ['indexes', Q.INDEXES, [oids]],
        ['triggers', Q.TRIGGERS, [oids]],
        ['policies', Q.POLICIES, [oids]],
        ['rules', Q.RULES, [oids]],
        ['parents', Q.PARENTS, [oids]],
        ['functions', Q.FUNCTIONS, ['0', namespaces, 500]],
        ['types', Q.TYPES, ['0', namespaces, 500]],
        ['extensions', Q.EXTENSIONS, []],
        ['event triggers', Q.EVENT_TRIGGERS, []],
        ['publications', Q.publications(server.major), []],
        ['default privileges', Q.DEFAULT_ACLS, [namespaces]],
        ['statistics', Q.STATISTICS, [namespaces]],
        ['collations', Q.collations(server.major), [namespaces]],
        ['casts', Q.CASTS, []],
        ['operators', Q.OPERATORS, [namespaces]],
        ['operator classes', Q.OPCLASSES, [namespaces]],
        ['text search', Q.TS_CONFIGS, [namespaces]],
      ]
      const sizes =
        await s.query(sql`SELECT c.relname::text AS name, c.reltuples::bigint::text AS tuples
                                      FROM pg_catalog.pg_class c WHERE c.relnamespace = 'pg_catalog'::regnamespace AND c.relkind = 'r'`)
      const rowsOf = new Map(sizes.map((r) => [r.text('name'), Number(r.text('tuples'))]))
      const violations: string[] = []
      for (const [name, query, params] of queries) {
        const nodes = await explain(s, query, params)
        expect(nodes.length).toBeGreaterThan(0)
        for (const node of nodes) {
          if (
            node.type === 'Seq Scan' &&
            node.relation !== undefined &&
            LARGE_CATALOGS.has(node.relation) &&
            !Object.hasOwn(TOLERATED, node.relation) &&
            (rowsOf.get(node.relation) ?? Number.POSITIVE_INFINITY) >= SMALL_CATALOG_ROWS
          ) {
            violations.push(`${name}: Seq Scan on ${node.relation}`)
          }
        }
      }
      expect(violations).toEqual([])
    })

    it('takes the full snapshot within its budget', async () => {
      const s = session as TargetSession
      const snap = await takeSnapshot(s, {}, { statementTimeoutMs: 120_000 })
      expect(snap.complete).toBe(true)
      expect(snap.stats.entries).toBeGreaterThan(LARGE_CATALOG.tables * 5)
      // Budget for 2,000+ tables (about five times the consumer's size, whose
      // target is 2 s); measured values are recorded in the G4 gate record.
      expect(snap.stats.durationMs).toBeLessThan(30_000)
      console.info(
        `plan-guard PG${server.major}: ${snap.stats.entries} entries, ${snap.stats.queries} queries, ${snap.stats.durationMs} ms`,
      )
    }, 120_000)
  },
)

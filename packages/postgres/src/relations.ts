import type { RelationRef } from './parser/admission.ts'
import type { TargetSession } from './session.ts'
import { sql } from './sql.ts'

/**
 * The relation-kind step of `data.read` admission
 * ([sql-execution-security.md §2.1](../../../exponetdb-docs/03-database-model/sql-execution-security.md#21-admission) item 4):
 * the kinds of the statement's relations, read from the target's catalog by
 * name (an unknown relation has no kind and is refused). Keys are
 * `schema.name` as the admission reports them.
 *
 * A table read also scans its inheritance children and partitions, so a
 * table or partitioned table with a foreign table anywhere below it reads
 * through a foreign-data wrapper: its kind is reported as foreign (`f`).
 */
const KINDS = sql`SELECT r.key,
       CASE WHEN c.relkind IN ('r', 'p') AND EXISTS (
              WITH RECURSIVE below(oid) AS (
                SELECT i.inhrelid FROM pg_catalog.pg_inherits i WHERE i.inhparent = c.oid
                UNION
                SELECT i.inhrelid FROM pg_catalog.pg_inherits i JOIN below b ON i.inhparent = b.oid)
              SELECT 1 FROM below b JOIN pg_catalog.pg_class d ON d.oid = b.oid WHERE d.relkind = 'f')
            THEN 'f' ELSE c.relkind::text END AS relkind
  FROM pg_catalog.json_to_recordset($1::json) AS r(key text, schema text, name text)
  LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = r.schema
  LEFT JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = r.name
 ORDER BY r.key`

export async function resolveRelationKinds(
  session: TargetSession,
  relations: readonly RelationRef[],
): Promise<Map<string, string | null>> {
  const refs = relations.map((r) => ({
    key: `${r.schema ?? ''}.${r.name}`,
    schema: r.schema ?? '',
    name: r.name,
  }))
  const rows = await session.query(KINDS, [JSON.stringify(refs)])
  return new Map(rows.map((r) => [r.text('key'), r.textOrNull('relkind')]))
}

/**
 * Casts that run user code: a cast whose function was created in this
 * database (`oid >= 16384`) in a language a role that is not a superuser may
 * use (anything but C and `internal`, which need a superuser). Such a cast
 * runs implicitly, or through `::`, on a column of a user type, and the
 * admission cannot see column types (G4 correction: a tenant's implicit cast
 * from its enum to `text` ran its SQL function from `lower(c)`). The
 * target-side step of `data.read` admission refuses a database that has one.
 */
const USER_CASTS = sql`SELECT u.source, u.target
  FROM (SELECT pg_catalog.format_type(c.castsource, NULL) AS source,
               pg_catalog.format_type(c.casttarget, NULL) AS target
          FROM pg_catalog.pg_cast c
          JOIN pg_catalog.pg_proc p ON p.oid = c.castfunc
          JOIN pg_catalog.pg_language l ON l.oid = p.prolang
         WHERE p.oid >= 16384 AND l.lanname NOT IN ('c', 'internal')) u
 ORDER BY u.source COLLATE "C", u.target COLLATE "C"
 LIMIT 5`

/** The user-code casts of the target's database (`source AS target`), at most five. */
export async function resolveUserCasts(session: TargetSession): Promise<string[]> {
  const rows = await session.query(USER_CASTS)
  return rows.map((r) => `${r.text('source')} AS ${r.text('target')}`)
}

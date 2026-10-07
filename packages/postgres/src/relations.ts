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
 * Objects through which a read runs user code it does not name: code is a
 * function created in this database (`oid >= 16384`) in a language a role
 * that is not a superuser may use (anything but C and `internal`, which need
 * a superuser), or an operator whose function is such code. A read runs it
 * through
 * - a cast (implicitly, or through `::`, on a column of a user type);
 * - an index expression or predicate, a partition key or an extended
 *   statistics expression: the planner folds their constant calls when it
 *   loads them, for any statement that reads the table;
 * - a range type's `subtype_diff`, which the planner calls to estimate `&&`.
 *
 * Admission cannot see any of this (G4 correction reviews: an implicit cast
 * from a tenant's enum ran from `lower(c)`; an index `WHERE x > f(1)` ran
 * `f` from `SELECT count(*) FROM t WHERE x = 1`). The target-side step of
 * `data.read` admission refuses a database that has one; table `CHECK`
 * constraints run only under constraint exclusion, which read-only sessions
 * pin off. Column defaults, generated columns and domain constraints run on
 * writes, not reads.
 */
const USER_CODE = sql`WITH code AS (
  SELECT p.oid FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_language l ON l.oid = p.prolang
   WHERE p.oid >= 16384 AND l.lanname NOT IN ('c', 'internal')
), callers(classid, oid) AS (
  SELECT 'pg_catalog.pg_proc'::pg_catalog.regclass::pg_catalog.oid, c.oid FROM code c
  UNION ALL
  SELECT 'pg_catalog.pg_operator'::pg_catalog.regclass::pg_catalog.oid, o.oid
    FROM pg_catalog.pg_operator o JOIN code c ON c.oid = o.oprcode::pg_catalog.oid
), reached AS (
  SELECT DISTINCT d.classid, d.objid
    FROM callers r
    JOIN pg_catalog.pg_depend d ON d.refclassid = r.classid AND d.refobjid = r.oid
   WHERE d.classid IN ('pg_catalog.pg_cast'::pg_catalog.regclass, 'pg_catalog.pg_statistic_ext'::pg_catalog.regclass)
      -- an index (expression, predicate) or a partitioned table (key); columns are not here
      OR (d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.objsubid = 0)
      OR (d.classid = 'pg_catalog.pg_type'::pg_catalog.regclass AND EXISTS (
            SELECT 1 FROM pg_catalog.pg_type t WHERE t.oid = d.objid AND t.typtype = 'r'))
)
SELECT o.type, o.identity
  FROM reached x CROSS JOIN LATERAL pg_catalog.pg_identify_object(x.classid, x.objid, 0) o
 ORDER BY o.type COLLATE "C", o.identity COLLATE "C"
 LIMIT 10`

/** The objects through which a read runs user code (`type identity`), at most ten. */
export async function resolveUserCode(session: TargetSession): Promise<string[]> {
  const rows = await session.query(USER_CODE)
  return rows.map((r) => `${r.text('type')} ${r.text('identity')}`)
}

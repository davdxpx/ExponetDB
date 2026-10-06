import type { RelationRef } from './parser/admission.ts'
import type { TargetSession } from './session.ts'
import { sql } from './sql.ts'

/**
 * The relation-kind step of `data.read` admission
 * ([sql-execution-security.md §2.1](../../../exponetdb-docs/03-database-model/sql-execution-security.md#21-admission) item 4):
 * the kinds of the statement's relations, read from the target's catalog by
 * name (an unknown relation has no kind and is refused). Keys are
 * `schema.name` as the admission reports them.
 */
const KINDS = sql`SELECT r.key, c.relkind::text AS relkind
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

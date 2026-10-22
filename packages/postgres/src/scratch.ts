import type { CatalogReader } from './session.ts'
import { sql } from './sql.ts'

/**
 * Catalog reads of the scratch preflight
 * ([`legacy-import.md` §2.5](../../../exponetdb-docs/04-migrations/legacy-import.md#25-scratch-targets),
 * Wave 9 order A7), read-only on observer sessions.
 *
 * - On the imported target: the objects **outside** the project's managed
 *   scope that managed objects depend on (a foreign key to an identity
 *   service's table, a policy calling its function, a column of its type),
 *   found through `pg_depend`; system schemas and extension members are
 *   not counted (the extension check covers those).
 * - On the scratch target: which of them are missing, so a replay would
 *   fail on the first file that needs one (the scratch target must hold a
 *   schema-only copy of each).
 */
export interface OutsideScopeObject {
  /** `schema`: the schema itself (`schema` and `name` both name it). */
  readonly kind: 'relation' | 'function' | 'type' | 'schema'
  readonly schema: string
  readonly name: string
  /** A function's argument types (`oidvectortypes`); null: any (a call names no types). */
  readonly args: string | null
}

/** At most this many objects are read (the query's LIMIT is one more); the caller says when the list is cut. */
export const MAX_OUTSIDE_SCOPE = 1000

const REFERENCED = sql`WITH managed AS (
  SELECT n.oid FROM pg_catalog.pg_namespace n
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'exponetdb') AND n.nspname NOT LIKE 'pg\\_%'
     AND ($1::jsonb IS NULL OR n.nspname = ANY (ARRAY(SELECT pg_catalog.jsonb_array_elements_text($1::jsonb))))
     AND NOT (n.nspname = ANY (ARRAY(SELECT pg_catalog.jsonb_array_elements_text($2::jsonb))))
), dep AS (
  SELECT d.refclassid, d.refobjid,
         CASE d.classid
           WHEN 'pg_catalog.pg_class'::regclass THEN (SELECT c.relnamespace FROM pg_catalog.pg_class c WHERE c.oid = d.objid)
           WHEN 'pg_catalog.pg_constraint'::regclass THEN (SELECT k.connamespace FROM pg_catalog.pg_constraint k WHERE k.oid = d.objid)
           WHEN 'pg_catalog.pg_rewrite'::regclass THEN (SELECT c.relnamespace FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid = r.ev_class WHERE r.oid = d.objid)
           WHEN 'pg_catalog.pg_policy'::regclass THEN (SELECT c.relnamespace FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid WHERE p.oid = d.objid)
           WHEN 'pg_catalog.pg_attrdef'::regclass THEN (SELECT c.relnamespace FROM pg_catalog.pg_attrdef a JOIN pg_catalog.pg_class c ON c.oid = a.adrelid WHERE a.oid = d.objid)
           WHEN 'pg_catalog.pg_trigger'::regclass THEN (SELECT c.relnamespace FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid WHERE t.oid = d.objid)
           WHEN 'pg_catalog.pg_proc'::regclass THEN (SELECT p.pronamespace FROM pg_catalog.pg_proc p WHERE p.oid = d.objid)
           WHEN 'pg_catalog.pg_type'::regclass THEN (SELECT t.typnamespace FROM pg_catalog.pg_type t WHERE t.oid = d.objid)
         END AS dep_ns
    FROM pg_catalog.pg_depend d
   WHERE d.deptype IN ('n', 'a')
), outside AS (
  SELECT n.oid FROM pg_catalog.pg_namespace n
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
     AND n.oid NOT IN (SELECT oid FROM managed)
), member AS (
  SELECT e.classid, e.objid FROM pg_catalog.pg_depend e WHERE e.deptype = 'e'
)
SELECT kind, schema, name, args FROM (
  SELECT DISTINCT 'relation' AS kind, n.nspname::text AS schema, c.relname::text AS name, NULL::text AS args
    FROM dep JOIN pg_catalog.pg_class c ON dep.refclassid = 'pg_catalog.pg_class'::regclass AND c.oid = dep.refobjid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE dep.dep_ns IN (SELECT oid FROM managed) AND c.relnamespace IN (SELECT oid FROM outside)
     AND NOT EXISTS (SELECT FROM member m WHERE m.classid = 'pg_catalog.pg_class'::regclass AND m.objid = c.oid)
  UNION
  SELECT DISTINCT 'function', n.nspname::text, p.proname::text, pg_catalog.oidvectortypes(p.proargtypes)
    FROM dep JOIN pg_catalog.pg_proc p ON dep.refclassid = 'pg_catalog.pg_proc'::regclass AND p.oid = dep.refobjid
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE dep.dep_ns IN (SELECT oid FROM managed) AND p.pronamespace IN (SELECT oid FROM outside)
     AND NOT EXISTS (SELECT FROM member m WHERE m.classid = 'pg_catalog.pg_proc'::regclass AND m.objid = p.oid)
  UNION
  SELECT DISTINCT 'type', n.nspname::text, t.typname::text, NULL::text
    FROM dep JOIN pg_catalog.pg_type t ON dep.refclassid = 'pg_catalog.pg_type'::regclass AND t.oid = dep.refobjid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
   WHERE dep.dep_ns IN (SELECT oid FROM managed) AND t.typnamespace IN (SELECT oid FROM outside)
     AND t.typrelid = 0
     AND NOT EXISTS (SELECT FROM member m WHERE m.classid = 'pg_catalog.pg_type'::regclass AND m.objid = t.oid)
) x
ORDER BY kind, schema, name, args
LIMIT 1001`

// Catalog lookups, never to_regclass and its kin: they raise for a schema the observer may
// not use, and the scratch target's copies are often owned by another role.
const PRESENT = sql`SELECT r.kind, r.schema, r.name, r.args,
       CASE r.kind
         WHEN 'relation' THEN EXISTS (SELECT FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                                       WHERE n.nspname = r.schema AND c.relname = r.name)
         WHEN 'function' THEN EXISTS (SELECT FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                                       WHERE n.nspname = r.schema AND p.proname = r.name
                                         AND (r.args IS NULL OR pg_catalog.oidvectortypes(p.proargtypes) = r.args))
         WHEN 'type' THEN EXISTS (SELECT FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
                                   WHERE n.nspname = r.schema AND t.typname = r.name)
         WHEN 'schema' THEN EXISTS (SELECT FROM pg_catalog.pg_namespace n WHERE n.nspname = r.name)
       END AS present
  FROM pg_catalog.jsonb_to_recordset($1::jsonb) AS r(kind text, schema text, name text, args text)`

export interface ManagedScopeFilter {
  readonly includeSchemas?: readonly string[]
  readonly excludeSchemas?: readonly string[]
}

/** The objects outside the scope that managed objects depend on, and whether the list was cut. */
export async function referencedOutsideScope(
  reader: CatalogReader,
  scope: ManagedScopeFilter,
): Promise<{ readonly objects: OutsideScopeObject[]; readonly truncated: boolean }> {
  const rows = await reader.query(REFERENCED, [
    scope.includeSchemas === undefined ? null : JSON.stringify(scope.includeSchemas),
    JSON.stringify(scope.excludeSchemas ?? []),
  ])
  const objects = rows.slice(0, MAX_OUTSIDE_SCOPE).map((r) => ({
    kind: r.text('kind') as OutsideScopeObject['kind'],
    schema: r.text('schema'),
    name: r.text('name'),
    args: r.textOrNull('args'),
  }))
  return { objects, truncated: rows.length > MAX_OUTSIDE_SCOPE }
}

/** Those of `objects` this database does not have. */
export async function missingObjects(
  reader: CatalogReader,
  objects: readonly OutsideScopeObject[],
): Promise<OutsideScopeObject[]> {
  if (objects.length === 0) return []
  const rows = await reader.query(PRESENT, [JSON.stringify(objects)])
  return rows
    .filter((r) => r.boolOrNull('present') !== true)
    .map((r) => ({
      kind: r.text('kind') as OutsideScopeObject['kind'],
      schema: r.text('schema'),
      name: r.text('name'),
      args: r.textOrNull('args'),
    }))
}

// Which of the objects belong to an extension (pg_depend 'e'): a schema-only copy never holds
// them; the extension is installed instead.
const MEMBERS = sql`SELECT r.kind, r.schema, r.name,
       (SELECT x.extname::text FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_extension x ON x.oid = d.refobjid
         WHERE d.deptype = 'e' AND d.refclassid = 'pg_catalog.pg_extension'::regclass
           AND d.classid = CASE r.kind WHEN 'relation' THEN 'pg_catalog.pg_class'::regclass
                                       WHEN 'function' THEN 'pg_catalog.pg_proc'::regclass
                                       ELSE 'pg_catalog.pg_type'::regclass END
           AND d.objid IN (SELECT c.oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                            WHERE r.kind = 'relation' AND n.nspname = r.schema AND c.relname = r.name
                           UNION ALL
                           SELECT p.oid FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                            WHERE r.kind = 'function' AND n.nspname = r.schema AND p.proname = r.name
                           UNION ALL
                           SELECT t.oid FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
                            WHERE r.kind = 'type' AND n.nspname = r.schema AND t.typname = r.name)
         LIMIT 1) AS extension
  FROM pg_catalog.jsonb_to_recordset($1::jsonb) AS r(kind text, schema text, name text)`

/** The objects that are members of an extension here, with the extension's name. */
export async function extensionMembers(
  reader: CatalogReader,
  objects: readonly Pick<OutsideScopeObject, 'kind' | 'schema' | 'name'>[],
): Promise<Map<string, string>> {
  const wanted = objects.filter((o) => o.kind !== 'schema')
  if (wanted.length === 0) return new Map()
  const rows = await reader.query(MEMBERS, [JSON.stringify(wanted)])
  const out = new Map<string, string>()
  for (const r of rows) {
    const extension = r.textOrNull('extension')
    if (extension !== null) {
      out.set(`${r.text('kind')} ${r.text('schema')}.${r.text('name')}`, extension)
    }
  }
  return out
}

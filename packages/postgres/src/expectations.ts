import type { Expectation } from './parser/migration.ts'
import type { TargetRow } from './rows.ts'
import type { CatalogReader } from './session.ts'
import { quoteIdent, sql } from './sql.ts'

/**
 * Structural expectations of a migration, checked against the catalogs
 * ([verification.md §2, §3](../../../exponetdb-docs/04-migrations/verification.md#3-automatic-structural-expectations)):
 * L0 runs them in the migration's own transaction before its commit, L1
 * again from a fresh read-only session. Each is one engine query with bind
 * parameters; names are passed as quoted text to PostgreSQL's own lookup
 * functions (`to_regclass`, `to_regprocedure`, `to_regtype`,
 * `to_regnamespace`), so an unqualified name resolves exactly as the
 * migration's `search_path` resolved it. The caller sets that path in the
 * transaction first ({@link pinSearchPath}).
 *
 * Results carry descriptions built from names only, never row data.
 */

export interface ExpectationResult {
  readonly statement: number
  readonly kind: Expectation['kind']
  readonly ok: boolean
  /** What was expected, by object name (no data). */
  readonly description: string
}

/** `SET LOCAL search_path` to the migration's materialized path (inside a transaction). */
export async function pinSearchPath(
  tx: CatalogReader,
  searchPath: readonly string[],
): Promise<void> {
  const value = searchPath.length === 0 ? '' : searchPath.map((s) => quoteIdent(s)).join(', ')
  await tx.query(sql`SELECT pg_catalog.set_config('search_path', $1, true)`, [value])
}

const name = (schema: string | null, n: string): string =>
  schema === null ? quoteIdent(n) : `${quoteIdent(schema)}.${quoteIdent(n)}`

const REL = sql`SELECT c.relkind::text AS relkind, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
       pg_catalog.obj_description(c.oid, 'pg_class') AS comment
  FROM pg_catalog.pg_class c WHERE c.oid = pg_catalog.to_regclass($1)`

// An identity column has no pg_attrdef entry; for the analyzer it has a default all the same.
const COLUMN = sql`SELECT a.attnotnull AS not_null, (a.atthasdef OR a.attidentity <> '') AS has_default, a.atttypid::text AS type_oid,
       a.atttypmod AS typmod, pg_catalog.to_regtype($3)::oid::text AS expected_oid,
       pg_catalog.col_description(a.attrelid, a.attnum) AS comment
  FROM pg_catalog.pg_attribute a
 WHERE a.attrelid = pg_catalog.to_regclass($1) AND a.attname = $2 AND a.attnum > 0 AND NOT a.attisdropped`

const COLUMN_NAMES = sql`SELECT coalesce(pg_catalog.jsonb_agg(a.attname::text ORDER BY a.attnum), '[]'::jsonb) AS names
  FROM pg_catalog.pg_attribute a
 WHERE a.attrelid = pg_catalog.to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped`

const INDEX = sql`SELECT i.indisunique AS is_unique, i.indisvalid AS valid, i.indisready AS ready,
       am.amname::text AS method, i.indnkeyatts AS keys, (i.indpred IS NOT NULL) AS partial,
       (i.indrelid = pg_catalog.to_regclass($2)) AS on_table
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
  JOIN pg_catalog.pg_am am ON am.oid = c.relam
 WHERE i.indexrelid = pg_catalog.to_regclass($1)`

const CONSTRAINT = sql`SELECT con.contype::text AS contype, con.convalidated AS validated
  FROM pg_catalog.pg_constraint con
 WHERE con.conrelid = pg_catalog.to_regclass($1) AND con.conname = $2`

const POLICY = sql`SELECT p.polcmd::text AS cmd, p.polpermissive AS permissive,
       coalesce((SELECT pg_catalog.jsonb_agg(CASE WHEN r = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(r)::text END)
                   FROM pg_catalog.unnest(p.polroles) AS r), '[]'::jsonb) AS roles
  FROM pg_catalog.pg_policy p
 WHERE p.polrelid = pg_catalog.to_regclass($1) AND p.polname = $2`

const TABLE_PRIVILEGES = sql`SELECT pg_catalog.to_regclass($1) IS NOT NULL AS present,
       (SELECT coalesce(pg_catalog.jsonb_agg(DISTINCT a.privilege_type::text), '[]'::jsonb)
          FROM pg_catalog.pg_class c,
               pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
         WHERE c.oid = pg_catalog.to_regclass($1)
           AND a.grantee = CASE WHEN $2 = 'public' THEN 0::oid
                                ELSE (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = $2) END) AS privileges`

const FUNCTION = sql`SELECT p.prosecdef AS secdef, l.lanname::text AS language, p.prosrc AS body,
       coalesce(pg_catalog.array_to_string(p.proconfig, chr(10)), '') LIKE '%search_path=%' AS path_set,
       (p.prosqlbody IS NOT NULL) AS sql_body
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid = p.prolang
 WHERE p.oid = pg_catalog.to_regprocedure($1)`

const TRIGGER = sql`SELECT 1 AS present FROM pg_catalog.pg_trigger t
 WHERE t.tgrelid = pg_catalog.to_regclass($1) AND t.tgname = $2 AND NOT t.tgisinternal`

const ENUM_LABELS = sql`SELECT coalesce(pg_catalog.jsonb_agg(e.enumlabel::text ORDER BY e.enumsortorder), '[]'::jsonb) AS labels,
       pg_catalog.to_regtype($1) IS NOT NULL AS present
  FROM pg_catalog.pg_enum e WHERE e.enumtypid = pg_catalog.to_regtype($1)`

const SCHEMA = sql`SELECT pg_catalog.to_regnamespace($1) IS NOT NULL AS present`
const EXTENSION = sql`SELECT e.extversion AS version FROM pg_catalog.pg_extension e WHERE e.extname = $1`
const TYPE = sql`SELECT pg_catalog.to_regtype($1) IS NOT NULL AS present`

/** PostgreSQL's polcmd letters. */
const COMMANDS: Readonly<Record<string, string>> = {
  '*': 'ALL',
  r: 'SELECT',
  a: 'INSERT',
  w: 'UPDATE',
  d: 'DELETE',
}

/**
 * The type modifier PostgreSQL stores for a type written with modifiers, for
 * the families whose rule is known (character and bit lengths, numeric
 * precision and scale, temporal precision); null when not checked.
 */
export function expectedTypmod(type: string, typmods: string | null | undefined): number | null {
  if (typmods === null || typmods === undefined) {
    return null
  }
  const parts = typmods.split(',').map((p) => Number(p.trim()))
  if (parts.some((p) => !Number.isInteger(p) || p < 0)) {
    return null
  }
  const base = type
    .replace(/\[\]$/g, '')
    .toLowerCase()
    .replace(/^pg_catalog\./, '')
  const [a, b] = parts
  if (a === undefined) {
    return null
  }
  if (['varchar', 'character varying', 'bpchar', 'char', 'character'].includes(base)) {
    return a + 4
  }
  if (base === 'numeric' || base === 'decimal') {
    return ((a << 16) | (b ?? 0)) + 4
  }
  if (['bit', 'varbit', 'bit varying'].includes(base)) {
    return a
  }
  if (
    ['timestamp', 'timestamptz', 'time', 'timetz', 'timestamp without time zone'].includes(base) ||
    base.startsWith('timestamp') ||
    base.startsWith('time')
  ) {
    return a
  }
  return null
}

async function first(
  tx: CatalogReader,
  statement: ReturnType<typeof sql>,
  params: readonly (string | number | boolean | null)[],
): Promise<TargetRow | undefined> {
  return (await tx.query(statement, params))[0]
}

/** Checks one expectation; never throws for a missing object (that is a result). */
export async function checkExpectation(
  tx: CatalogReader,
  statement: number,
  e: Expectation,
): Promise<ExpectationResult> {
  const result = (ok: boolean, description: string): ExpectationResult => ({
    statement,
    kind: e.kind,
    ok,
    description,
  })
  switch (e.kind) {
    case 'relation': {
      const row = await first(tx, REL, [name(e.schema, e.name)])
      const what = `${e.present ? 'relation' : 'no relation'} ${name(e.schema, e.name)}`
      return result(
        e.present
          ? row !== undefined && e.relkinds.includes(row.text('relkind'))
          : row === undefined,
        what,
      )
    }
    case 'column': {
      const typeName = e.type ?? null
      const row = await first(tx, COLUMN, [name(e.schema, e.table), e.column, typeName ?? 'text'])
      const what = `${e.present ? 'column' : 'no column'} ${name(e.schema, e.table)}.${quoteIdent(e.column)}`
      if (!e.present) {
        return result(row === undefined, what)
      }
      if (row === undefined) {
        return result(false, what)
      }
      let ok = true
      if (typeName !== null) {
        ok &&=
          row.textOrNull('expected_oid') !== null &&
          row.text('type_oid') === row.text('expected_oid')
        const typmod = expectedTypmod(typeName, e.typmods)
        if (typmod !== null) {
          ok &&= row.int('typmod') === typmod
        }
      }
      if (e.notNull !== undefined && e.notNull !== null) {
        ok &&= row.bool('not_null') === e.notNull
      }
      if (e.hasDefault !== undefined && e.hasDefault !== null) {
        ok &&= row.bool('has_default') === e.hasDefault
      }
      return result(ok, what)
    }
    case 'columns_exactly': {
      const row = await first(tx, COLUMN_NAMES, [name(e.schema, e.table)])
      const names = row?.jsonArray('names') ?? []
      return result(
        names.length === e.columns.length && names.every((n, i) => n === e.columns[i]),
        `columns of ${name(e.schema, e.table)} exactly as created`,
      )
    }
    case 'index': {
      const table = e.table === undefined ? null : name(e.table.schema, e.table.name)
      const row = await first(tx, INDEX, [name(e.schema, e.name), table])
      const what = `${e.present ? 'valid index' : 'no index'} ${name(e.schema, e.name)}`
      if (!e.present) {
        return result(row === undefined, what)
      }
      if (row === undefined) {
        return result(false, what)
      }
      let ok = row.bool('valid') && row.bool('ready')
      if (table !== null) ok &&= row.bool('on_table')
      if (e.unique !== undefined) ok &&= row.bool('is_unique') === e.unique
      if (e.method !== undefined) ok &&= row.text('method') === e.method
      if (e.partial !== undefined) ok &&= row.bool('partial') === e.partial
      if (e.keyCount !== undefined) ok &&= row.int('keys') === e.keyCount
      return result(ok, what)
    }
    case 'constraint': {
      const row = await first(tx, CONSTRAINT, [name(e.schema, e.table), e.name])
      const what = `${e.present ? 'constraint' : 'no constraint'} ${quoteIdent(e.name)} on ${name(e.schema, e.table)}`
      if (!e.present) {
        return result(row === undefined, what)
      }
      if (row === undefined) {
        return result(false, what)
      }
      let ok = true
      if (e.contype !== undefined) ok &&= row.text('contype') === e.contype
      if (e.validated !== undefined) ok &&= row.bool('validated') === e.validated
      return result(ok, what)
    }
    case 'not_null': {
      const row = await first(tx, COLUMN, [name(e.schema, e.table), e.column, 'text'])
      return result(
        row !== undefined && row.bool('not_null') === e.notNull,
        `${name(e.schema, e.table)}.${quoteIdent(e.column)} ${e.notNull ? 'NOT NULL' : 'nullable'}`,
      )
    }
    case 'row_security': {
      const row = await first(tx, REL, [name(e.schema, e.table)])
      let ok = row !== undefined
      if (row !== undefined && e.enabled !== undefined) ok &&= row.bool('rls') === e.enabled
      if (row !== undefined && e.forced !== undefined) ok &&= row.bool('forced') === e.forced
      return result(ok, `row security of ${name(e.schema, e.table)}`)
    }
    case 'policy': {
      const row = await first(tx, POLICY, [name(e.schema, e.table), e.name])
      const what = `${e.present ? 'policy' : 'no policy'} ${quoteIdent(e.name)} on ${name(e.schema, e.table)}`
      if (!e.present) {
        return result(row === undefined, what)
      }
      if (row === undefined) {
        return result(false, what)
      }
      let ok = true
      if (e.command !== undefined) ok &&= COMMANDS[row.text('cmd')] === e.command.toUpperCase()
      if (e.permissive !== undefined) ok &&= row.bool('permissive') === e.permissive
      if (e.roles !== undefined) {
        const roles = row.jsonArray('roles').map(String).sort()
        const expected = [...e.roles].map((r) => r.toLowerCase()).sort()
        ok &&= roles.length === expected.length && roles.every((r, i) => r === expected[i])
      }
      return result(ok, what)
    }
    case 'table_privilege': {
      const row = await first(tx, TABLE_PRIVILEGES, [
        name(e.schema, e.table),
        e.grantee.toLowerCase(),
      ])
      const held = new Set((row?.jsonArray('privileges') ?? []).map(String))
      const ok = e.privileges.every((p) => held.has(p.toUpperCase()) === e.granted)
      return result(
        row?.bool('present') === true && ok,
        `${e.granted ? 'grant' : 'no grant'} of ${e.privileges.join(', ')} on ${name(e.schema, e.table)} to ${e.grantee}`,
      )
    }
    case 'function': {
      const signature = `${name(e.schema, e.name)}(${e.args.join(', ')})`
      const row = await first(tx, FUNCTION, [signature])
      const what = `${e.present ? 'function' : 'no function'} ${signature}`
      if (!e.present) {
        return result(row === undefined, what)
      }
      if (row === undefined) {
        return result(false, what)
      }
      let ok = true
      if (e.securityDefiner !== undefined) ok &&= row.bool('secdef') === e.securityDefiner
      if (e.searchPathSet === true) ok &&= row.bool('path_set')
      if (e.language !== undefined) ok &&= row.text('language') === e.language.toLowerCase()
      if (e.body !== undefined && e.body !== null && !row.bool('sql_body')) {
        ok &&= row.text('body') === e.body
      }
      return result(ok, what)
    }
    case 'trigger': {
      const row = await first(tx, TRIGGER, [name(e.schema, e.table), e.name])
      return result(
        e.present ? row !== undefined : row === undefined,
        `${e.present ? 'trigger' : 'no trigger'} ${quoteIdent(e.name)} on ${name(e.schema, e.table)}`,
      )
    }
    case 'enum_labels': {
      const row = await first(tx, ENUM_LABELS, [name(e.schema, e.name)])
      const labels = (row?.jsonArray('labels') ?? []).map(String)
      const ok =
        row?.bool('present') === true &&
        (e.exact
          ? labels.length === e.labels.length && labels.every((l, i) => l === e.labels[i])
          : e.labels.every((l) => labels.includes(l)))
      return result(ok, `labels of ${name(e.schema, e.name)}`)
    }
    case 'schema': {
      const row = await first(tx, SCHEMA, [quoteIdent(e.name)])
      return result(
        row !== undefined && row.bool('present') === e.present,
        `${e.present ? 'schema' : 'no schema'} ${quoteIdent(e.name)}`,
      )
    }
    case 'extension': {
      const row = await first(tx, EXTENSION, [e.name])
      if (!e.present) {
        return result(row === undefined, `no extension ${e.name}`)
      }
      const ok =
        row !== undefined &&
        (e.version === undefined || e.version === null || row.text('version') === e.version)
      return result(ok, `extension ${e.name}`)
    }
    case 'type': {
      const row = await first(tx, TYPE, [name(e.schema, e.name)])
      return result(
        row !== undefined && row.bool('present') === e.present,
        `${e.present ? 'type' : 'no type'} ${name(e.schema, e.name)}`,
      )
    }
    case 'comment': {
      if (e.target === 'table') {
        const row = await first(tx, REL, [name(e.schema, e.table)])
        return result(
          row !== undefined && row.textOrNull('comment') === e.text,
          `comment on ${name(e.schema, e.table)}`,
        )
      }
      const row = await first(tx, COLUMN, [name(e.schema, e.table), e.column ?? '', 'text'])
      return result(
        row !== undefined && row.textOrNull('comment') === e.text,
        `comment on ${name(e.schema, e.table)}.${quoteIdent(e.column ?? '')}`,
      )
    }
  }
}

/** Checks every expectation in order; the results in the same order. */
export async function checkExpectations(
  tx: CatalogReader,
  expectations: readonly { readonly statement: number; readonly expectation: Expectation }[],
): Promise<ExpectationResult[]> {
  const out: ExpectationResult[] = []
  for (const { statement, expectation } of expectations) {
    out.push(await checkExpectation(tx, statement, expectation))
  }
  return out
}

/** An index found by name, and whether a concurrent build left it unusable. */
export interface IndexState {
  readonly oid: string
  readonly schema: string
  readonly name: string
  readonly valid: boolean
  readonly ready: boolean
}

// By catalog names along the given path (no to_regclass: the observer may lack USAGE).
const INDEX_BY_NAME = sql`SELECT c.oid::text AS oid, n.nspname::text AS schema, c.relname::text AS name,
       i.indisvalid AS valid, i.indisready AS ready
  FROM pg_catalog.jsonb_array_elements_text($2::jsonb) WITH ORDINALITY AS p(nsp, pos)
  JOIN pg_catalog.pg_namespace n ON n.nspname = p.nsp
  JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = $1
  JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid
 ORDER BY p.pos
 LIMIT 1`

const INDEX_BY_OID = sql`SELECT c.oid::text AS oid, n.nspname::text AS schema, c.relname::text AS name,
       i.indisvalid AS valid, i.indisready AS ready
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid
 WHERE c.oid = $1::oid`

function indexState(row: { text(k: string): string; bool(k: string): boolean }): IndexState {
  return {
    oid: row.text('oid'),
    schema: row.text('schema'),
    name: row.text('name'),
    valid: row.bool('valid'),
    ready: row.bool('ready'),
  }
}

/**
 * The index a statement names: in its schema, or the first one along the
 * migration's materialized search path ([failure-and-recovery.md §2](../../../exponetdb-docs/04-migrations/failure-and-recovery.md#2-non-transactional-migrations)).
 */
export async function readIndexState(
  reader: CatalogReader,
  schema: string | null,
  indexName: string,
  searchPath: readonly string[],
): Promise<IndexState | null> {
  const path = schema === null ? [...searchPath] : [schema]
  const rows = await reader.query(INDEX_BY_NAME, [indexName, JSON.stringify(path)])
  const row = rows[0]
  return row === undefined ? null : indexState(row)
}

/** The same index again by its OID (a cleanup acts on exactly what the plan saw). */
export async function readIndexByOid(
  reader: CatalogReader,
  oid: string,
): Promise<IndexState | null> {
  const rows = await reader.query(INDEX_BY_OID, [oid])
  const row = rows[0]
  return row === undefined ? null : indexState(row)
}

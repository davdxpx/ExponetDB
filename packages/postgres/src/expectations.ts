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
  /**
   * When it does not hold, which aspects differ, as fixed codes (`missing`,
   * `present`, `type`, `not_null`, `order`, `body`, …): how it fails, never a
   * value read from the catalog (Part A follow-up 3, F1 and F2).
   */
  readonly failed?: readonly ExpectationAspect[]
  /**
   * OD-56 (a): when it does not hold and a value aspect differs, the keyed
   * digest of the observed values of those aspects (only with
   * {@link CheckOptions.valueDigest}). Never the value; kept out of every
   * record but the excused-value comparison.
   */
  readonly observedDigest?: string
}

/** The aspects an expectation's check compares; a failed result names those that differ. */
export type ExpectationAspect =
  | 'missing'
  | 'present'
  | 'relkind'
  | 'type'
  | 'typmod'
  | 'not_null'
  | 'default'
  | 'columns'
  | 'order'
  | 'valid'
  | 'table'
  | 'unique'
  | 'method'
  | 'partial'
  | 'keys'
  | 'contype'
  | 'validated'
  | 'enabled'
  | 'forced'
  | 'command'
  | 'permissive'
  | 'roles'
  | 'privileges'
  | 'security_definer'
  | 'search_path'
  | 'language'
  | 'body'
  | 'labels'
  | 'version'
  | 'text'

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

/** A value the check observed for an aspect, before it is digested (never kept or returned). */
type Observed = string | number | boolean | null | readonly string[]

/**
 * Keys what a failing check observed (OD-56 (a)): called with the failure
 * (no value) and the canonical text of the observed values of its failing
 * value aspects; returns the keyed digest the result carries. The engine
 * passes it with the installation's excused-value key; without it no
 * digest is made.
 */
export type ObservedValueDigest = (
  failure: {
    readonly statement: number
    readonly kind: Expectation['kind']
    readonly description: string
    readonly failed: readonly ExpectationAspect[]
  },
  observation: string,
) => string

export interface CheckOptions {
  readonly valueDigest?: ObservedValueDigest
}

/** Aspects that state existence only: what they observe is the aspect itself. */
const EXISTENCE: ReadonlySet<ExpectationAspect> = new Set(['missing', 'present'])

/** `{"aspect":value,…}` with sorted members (arrays as observed, in their order). */
function observation(values: ReadonlyMap<ExpectationAspect, Observed>): string {
  return JSON.stringify(Object.fromEntries([...values].sort(([a], [b]) => (a < b ? -1 : 1))))
}

/** Checks one expectation; never throws for a missing object (that is a result). */
export async function checkExpectation(
  tx: CatalogReader,
  statement: number,
  e: Expectation,
  options: CheckOptions = {},
): Promise<ExpectationResult> {
  const result = (
    ok: boolean,
    description: string,
    failed: readonly ExpectationAspect[] = [],
    observed: ReadonlyMap<ExpectationAspect, Observed> = new Map(),
  ): ExpectationResult => {
    if (ok) return { statement, kind: e.kind, ok, description }
    const aspects = failed.length > 0 ? failed : (['missing'] as const)
    // OD-56 (a): the values of the failing value aspects, as a keyed digest only.
    const values = new Map(
      aspects
        .filter((a) => !EXISTENCE.has(a) && observed.has(a))
        .map((a) => [a, observed.get(a) ?? null]),
    )
    const digest =
      options.valueDigest === undefined || values.size === 0
        ? undefined
        : options.valueDigest(
            { statement, kind: e.kind, description, failed: aspects },
            observation(values),
          )
    return {
      statement,
      kind: e.kind,
      ok,
      description,
      failed: aspects,
      ...(digest === undefined ? {} : { observedDigest: digest }),
    }
  }
  type Check = readonly [boolean, ExpectationAspect, Observed]
  /** The aspects of `checks` that do not hold, and what each observed. */
  const differing = (checks: readonly Check[]) =>
    checks.filter(([holds]) => !holds).map(([, a]) => a)
  const observedOf = (checks: readonly Check[]) =>
    new Map<ExpectationAspect, Observed>(checks.map(([, a, v]) => [a, v]))
  const one = (aspect: ExpectationAspect, value: Observed) =>
    new Map<ExpectationAspect, Observed>([[aspect, value]])
  switch (e.kind) {
    case 'relation': {
      const row = await first(tx, REL, [name(e.schema, e.name)])
      const what = `${e.present ? 'relation' : 'no relation'} ${name(e.schema, e.name)}`
      if (!e.present) return result(row === undefined, what, ['present'])
      if (row === undefined) return result(false, what, ['missing'])
      return result(
        e.relkinds.includes(row.text('relkind')),
        what,
        ['relkind'],
        one('relkind', row.text('relkind')),
      )
    }
    case 'column': {
      const typeName = e.type ?? null
      const row = await first(tx, COLUMN, [name(e.schema, e.table), e.column, typeName ?? 'text'])
      const what = `${e.present ? 'column' : 'no column'} ${name(e.schema, e.table)}.${quoteIdent(e.column)}`
      if (!e.present) {
        return result(row === undefined, what, ['present'])
      }
      if (row === undefined) {
        return result(false, what, ['missing'])
      }
      const checks: Check[] = []
      if (typeName !== null) {
        checks.push([
          row.textOrNull('expected_oid') !== null &&
            row.text('type_oid') === row.text('expected_oid'),
          'type',
          row.text('type_oid'),
        ])
        const typmod = expectedTypmod(typeName, e.typmods)
        if (typmod !== null) {
          checks.push([row.int('typmod') === typmod, 'typmod', row.int('typmod')])
        }
      }
      if (e.notNull !== undefined && e.notNull !== null) {
        checks.push([row.bool('not_null') === e.notNull, 'not_null', row.bool('not_null')])
      }
      if (e.hasDefault !== undefined && e.hasDefault !== null) {
        checks.push([row.bool('has_default') === e.hasDefault, 'default', row.bool('has_default')])
      }
      const failed = differing(checks)
      return result(failed.length === 0, what, failed, observedOf(checks))
    }
    case 'columns_exactly': {
      const row = await first(tx, COLUMN_NAMES, [name(e.schema, e.table)])
      const names = (row?.jsonArray('names') ?? []).map(String)
      const what = `columns of ${name(e.schema, e.table)} exactly as created`
      if (row === undefined) return result(false, what, ['missing'])
      const same = (a: readonly string[], b: readonly string[]) =>
        a.length === b.length && a.every((n, i) => n === b[i])
      if (same(names, e.columns)) return result(true, what)
      // The same columns in another order (an ADD COLUMN replayed elsewhere), or other columns.
      const aspect = same([...names].sort(), [...e.columns].sort()) ? 'order' : 'columns'
      return result(false, what, [aspect], one(aspect, names))
    }
    case 'index': {
      const table = e.table === undefined ? null : name(e.table.schema, e.table.name)
      const row = await first(tx, INDEX, [name(e.schema, e.name), table])
      const what = `${e.present ? 'valid index' : 'no index'} ${name(e.schema, e.name)}`
      if (!e.present) {
        return result(row === undefined, what, ['present'])
      }
      if (row === undefined) {
        return result(false, what, ['missing'])
      }
      const usable = row.bool('valid') && row.bool('ready')
      const checks: Check[] = [[usable, 'valid', usable]]
      if (table !== null) checks.push([row.bool('on_table'), 'table', row.bool('on_table')])
      if (e.unique !== undefined) {
        checks.push([row.bool('is_unique') === e.unique, 'unique', row.bool('is_unique')])
      }
      if (e.method !== undefined) {
        checks.push([row.text('method') === e.method, 'method', row.text('method')])
      }
      if (e.partial !== undefined) {
        checks.push([row.bool('partial') === e.partial, 'partial', row.bool('partial')])
      }
      if (e.keyCount !== undefined) {
        checks.push([row.int('keys') === e.keyCount, 'keys', row.int('keys')])
      }
      const failed = differing(checks)
      return result(failed.length === 0, what, failed, observedOf(checks))
    }
    case 'constraint': {
      const row = await first(tx, CONSTRAINT, [name(e.schema, e.table), e.name])
      const what = `${e.present ? 'constraint' : 'no constraint'} ${quoteIdent(e.name)} on ${name(e.schema, e.table)}`
      if (!e.present) {
        return result(row === undefined, what, ['present'])
      }
      if (row === undefined) {
        return result(false, what, ['missing'])
      }
      const checks: Check[] = []
      if (e.contype !== undefined) {
        checks.push([row.text('contype') === e.contype, 'contype', row.text('contype')])
      }
      if (e.validated !== undefined) {
        checks.push([row.bool('validated') === e.validated, 'validated', row.bool('validated')])
      }
      const failed = differing(checks)
      return result(failed.length === 0, what, failed, observedOf(checks))
    }
    case 'not_null': {
      const row = await first(tx, COLUMN, [name(e.schema, e.table), e.column, 'text'])
      return result(
        row !== undefined && row.bool('not_null') === e.notNull,
        `${name(e.schema, e.table)}.${quoteIdent(e.column)} ${e.notNull ? 'NOT NULL' : 'nullable'}`,
        [row === undefined ? 'missing' : 'not_null'],
        row === undefined ? new Map() : one('not_null', row.bool('not_null')),
      )
    }
    case 'row_security': {
      const row = await first(tx, REL, [name(e.schema, e.table)])
      const what = `row security of ${name(e.schema, e.table)}`
      if (row === undefined) return result(false, what, ['missing'])
      const checks: Check[] = []
      if (e.enabled !== undefined)
        checks.push([row.bool('rls') === e.enabled, 'enabled', row.bool('rls')])
      if (e.forced !== undefined) {
        checks.push([row.bool('forced') === e.forced, 'forced', row.bool('forced')])
      }
      const failed = differing(checks)
      return result(failed.length === 0, what, failed, observedOf(checks))
    }
    case 'policy': {
      const row = await first(tx, POLICY, [name(e.schema, e.table), e.name])
      const what = `${e.present ? 'policy' : 'no policy'} ${quoteIdent(e.name)} on ${name(e.schema, e.table)}`
      if (!e.present) {
        return result(row === undefined, what, ['present'])
      }
      if (row === undefined) {
        return result(false, what, ['missing'])
      }
      const checks: Check[] = []
      if (e.command !== undefined) {
        checks.push([
          COMMANDS[row.text('cmd')] === e.command.toUpperCase(),
          'command',
          row.text('cmd'),
        ])
      }
      if (e.permissive !== undefined) {
        checks.push([row.bool('permissive') === e.permissive, 'permissive', row.bool('permissive')])
      }
      if (e.roles !== undefined) {
        const roles = row.jsonArray('roles').map(String).sort()
        const expected = [...e.roles].map((r) => r.toLowerCase()).sort()
        checks.push([
          roles.length === expected.length && roles.every((r, i) => r === expected[i]),
          'roles',
          roles,
        ])
      }
      const failed = differing(checks)
      return result(failed.length === 0, what, failed, observedOf(checks))
    }
    case 'table_privilege': {
      const row = await first(tx, TABLE_PRIVILEGES, [
        name(e.schema, e.table),
        e.grantee.toLowerCase(),
      ])
      const held = new Set((row?.jsonArray('privileges') ?? []).map(String))
      const ok = e.privileges.every((p) => held.has(p.toUpperCase()) === e.granted)
      const present = row?.bool('present') === true
      return result(
        present && ok,
        `${e.granted ? 'grant' : 'no grant'} of ${e.privileges.join(', ')} on ${name(e.schema, e.table)} to ${e.grantee}`,
        [present ? 'privileges' : 'missing'],
        present ? one('privileges', [...held].sort()) : new Map(),
      )
    }
    case 'function': {
      const signature = `${name(e.schema, e.name)}(${e.args.join(', ')})`
      const row = await first(tx, FUNCTION, [signature])
      const what = `${e.present ? 'function' : 'no function'} ${signature}`
      if (!e.present) {
        return result(row === undefined, what, ['present'])
      }
      if (row === undefined) {
        return result(false, what, ['missing'])
      }
      const checks: Check[] = []
      if (e.securityDefiner !== undefined) {
        checks.push([
          row.bool('secdef') === e.securityDefiner,
          'security_definer',
          row.bool('secdef'),
        ])
      }
      if (e.searchPathSet === true)
        checks.push([row.bool('path_set'), 'search_path', row.bool('path_set')])
      if (e.language !== undefined) {
        checks.push([
          row.text('language') === e.language.toLowerCase(),
          'language',
          row.text('language'),
        ])
      }
      if (e.body !== undefined && e.body !== null && !row.bool('sql_body')) {
        checks.push([row.text('body') === e.body, 'body', row.text('body')])
      }
      const failed = differing(checks)
      return result(failed.length === 0, what, failed, observedOf(checks))
    }
    case 'trigger': {
      const row = await first(tx, TRIGGER, [name(e.schema, e.table), e.name])
      return result(
        e.present ? row !== undefined : row === undefined,
        `${e.present ? 'trigger' : 'no trigger'} ${quoteIdent(e.name)} on ${name(e.schema, e.table)}`,
        [e.present ? 'missing' : 'present'],
      )
    }
    case 'enum_labels': {
      const row = await first(tx, ENUM_LABELS, [name(e.schema, e.name)])
      const labels = (row?.jsonArray('labels') ?? []).map(String)
      const present = row?.bool('present') === true
      const ok =
        present &&
        (e.exact
          ? labels.length === e.labels.length && labels.every((l, i) => l === e.labels[i])
          : e.labels.every((l) => labels.includes(l)))
      return result(
        ok,
        `labels of ${name(e.schema, e.name)}`,
        [present ? 'labels' : 'missing'],
        present ? one('labels', labels) : new Map(),
      )
    }
    case 'schema': {
      const row = await first(tx, SCHEMA, [quoteIdent(e.name)])
      return result(
        row !== undefined && row.bool('present') === e.present,
        `${e.present ? 'schema' : 'no schema'} ${quoteIdent(e.name)}`,
        [e.present ? 'missing' : 'present'],
      )
    }
    case 'extension': {
      const row = await first(tx, EXTENSION, [e.name])
      if (!e.present) {
        return result(row === undefined, `no extension ${e.name}`, ['present'])
      }
      const ok =
        row !== undefined &&
        (e.version === undefined || e.version === null || row.text('version') === e.version)
      return result(
        ok,
        `extension ${e.name}`,
        [row === undefined ? 'missing' : 'version'],
        row === undefined ? new Map() : one('version', row.text('version')),
      )
    }
    case 'type': {
      const row = await first(tx, TYPE, [name(e.schema, e.name)])
      return result(
        row !== undefined && row.bool('present') === e.present,
        `${e.present ? 'type' : 'no type'} ${name(e.schema, e.name)}`,
        [e.present ? 'missing' : 'present'],
      )
    }
    case 'comment': {
      if (e.target === 'table') {
        const row = await first(tx, REL, [name(e.schema, e.table)])
        return result(
          row !== undefined && row.textOrNull('comment') === e.text,
          `comment on ${name(e.schema, e.table)}`,
          [row === undefined ? 'missing' : 'text'],
          row === undefined ? new Map() : one('text', row.textOrNull('comment')),
        )
      }
      const row = await first(tx, COLUMN, [name(e.schema, e.table), e.column ?? '', 'text'])
      return result(
        row !== undefined && row.textOrNull('comment') === e.text,
        `comment on ${name(e.schema, e.table)}.${quoteIdent(e.column ?? '')}`,
        [row === undefined ? 'missing' : 'text'],
        row === undefined ? new Map() : one('text', row.textOrNull('comment')),
      )
    }
  }
}

/** Checks every expectation in order; the results in the same order. */
export async function checkExpectations(
  tx: CatalogReader,
  expectations: readonly { readonly statement: number; readonly expectation: Expectation }[],
  options: CheckOptions = {},
): Promise<ExpectationResult[]> {
  const out: ExpectationResult[] = []
  for (const { statement, expectation } of expectations) {
    out.push(await checkExpectation(tx, statement, expectation, options))
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

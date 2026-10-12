import { type AdmittedCheck, registerAdmittedCheck } from './checks.ts'
import { declaredFunction, type VerifyCheckSpec } from './parser/verify-checks.ts'
import type { CatalogReader } from './session.ts'
import { sql } from './sql.ts'

/**
 * The target side of `verify.sql` admission and execution
 * ([verification.md §4.2, §4.3](../../../exponetdb-docs/04-migrations/verification.md#42-admission-plan-time)).
 *
 * The parser admitted each check by its form and by an explicit allowlist
 * of built-in names. Names alone prove nothing on a target: an extension
 * installed into `pg_catalog`, a cast or operator added there after
 * `initdb`, or a view where a table was expected would make an admitted
 * name run code. The catalog resolution here therefore checks, against the
 * target's catalogs at plan time and again before a run:
 *
 * - every `pg_catalog` function a check calls exists there and every
 *   function of that name is a built-in (`oid < 16384`, from `initdb`);
 * - `pg_catalog` holds no operator, and no cast between built-in types
 *   exists, that was added after `initdb` (unqualified operators and casts
 *   resolve there under `search_path = ''`);
 * - every relation exists and is a table, partitioned table, materialized
 *   view or sequence; a plain view only where the check declared it
 *   (`-- reads-view:`), a foreign table never;
 * - a declared consumer function (`-- calls:`) resolves to exactly the
 *   declared signature, has no other overload of its name in its schema,
 *   is a plain function, not `SECURITY DEFINER` and not an extension's;
 *   a declared consumer view is a plain view, not an extension's.
 *
 * The identities and definition digests of consumer code are part of the
 * plan; a changed definition makes the run refuse (and the plan stale).
 * This is admission, not a sandbox: consumer code stays a reviewed trust
 * boundary, accepted by an explicit approval.
 */
export interface ConsumerCode {
  readonly check: number
  readonly kind: 'function' | 'view'
  /** As declared: `schema.function(argtypes)` or `schema.view`. */
  readonly declared: string
  readonly oid: string
  readonly owner: string
  /** SHA-256 of the definition (function: definition and settings; view: definition and options). */
  readonly digest: string
}

export type VerifyResolution =
  | { readonly ok: true; readonly checks: number; readonly consumer: readonly ConsumerCode[] }
  | {
      readonly ok: false
      readonly reason:
        | 'function'
        | 'operator'
        | 'cast'
        | 'relation_kind'
        | 'consumer_missing'
        | 'consumer_overloaded'
        | 'consumer_security_definer'
        | 'consumer_not_plain'
        | 'consumer_extension'
      readonly construct: string
      readonly check: number | null
    }

const BUILTIN_FUNCTIONS = sql`SELECT p.proname::text AS name, bool_and(p.oid < 16384) AS builtin
  FROM pg_catalog.pg_proc p
 WHERE p.pronamespace = 'pg_catalog'::regnamespace
   AND p.proname = ANY (ARRAY(SELECT pg_catalog.jsonb_array_elements_text($1::jsonb)))
 GROUP BY p.proname`

const ADDED_OPERATORS_AND_CASTS = sql`SELECT
  (SELECT count(*) FROM pg_catalog.pg_operator o
    WHERE o.oprnamespace = 'pg_catalog'::regnamespace AND o.oid >= 16384)::int AS operators,
  (SELECT count(*) FROM pg_catalog.pg_cast c
    WHERE c.oid >= 16384 AND c.castsource < 16384 AND c.casttarget < 16384)::int AS casts`

// By catalog names, not `to_regclass`: a name lookup needs USAGE on the schema, the observer has none.
const RELATION_KINDS = sql`SELECT r.ord::int AS ord,
       (SELECT c.relkind::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = r.item->>0 AND c.relname = r.item->>1) AS relkind
  FROM pg_catalog.jsonb_array_elements($1::jsonb) WITH ORDINALITY AS r(item, ord)`

const TYPE_NAME = sql`SELECT pg_catalog.format_type(pg_catalog.to_regtype($1), NULL) AS name`

const CONSUMER_FUNCTION = sql`SELECT p.oid::text AS oid, p.prosecdef AS secdef, p.prokind::text AS prokind,
       pg_catalog.pg_get_userbyid(p.proowner)::text AS owner,
       (SELECT count(*) FROM pg_catalog.pg_proc q
         WHERE q.pronamespace = p.pronamespace AND q.proname = p.proname)::int AS overloads,
       EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e') AS extension,
       CASE WHEN p.prokind = 'f' THEN pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
         pg_catalog.pg_get_functiondef(p.oid) || E'\\n' || coalesce(pg_catalog.array_to_string(p.proconfig, E'\\n'), ''),
         'UTF8')), 'hex') END AS digest
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = $1 AND p.proname = $2 AND pg_catalog.oidvectortypes(p.proargtypes) = $3`

const CONSUMER_VIEW = sql`SELECT c.oid::text AS oid, c.relkind::text AS relkind,
       pg_catalog.pg_get_userbyid(c.relowner)::text AS owner,
       EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e') AS extension,
       pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
         coalesce(pg_catalog.pg_get_viewdef(c.oid), '') || E'\\n' || coalesce(pg_catalog.array_to_string(c.reloptions, E'\\n'), ''),
         'UTF8')), 'hex') AS digest
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = $1 AND c.relname = $2`

const READABLE: ReadonlySet<string> = new Set(['r', 'p', 'm', 'S'])
const CATALOG_SCHEMAS: ReadonlySet<string> = new Set(['pg_catalog', 'information_schema'])

/**
 * The declared signature with each argument type as PostgreSQL names it
 * (`int` → `integer`), or null when a type does not resolve (also when
 * the session may not look into the type's schema).
 */
async function declaredSignature(
  reader: CatalogReader,
  calls: string,
): Promise<{ schema: string; name: string; argtypes: string } | null> {
  const qualified = declaredFunction(calls)
  const open = calls.indexOf('(')
  if (qualified === null || open < 0) return null
  const [schema = '', name = ''] = qualified.split('.')
  const args = calls
    .slice(open + 1, -1)
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a !== '')
  const types: string[] = []
  for (const arg of args) {
    const r = (await reader.query(TYPE_NAME, [arg]).catch(() => []))[0]
    const t = r?.textOrNull('name') ?? null
    if (t === null) return null
    types.push(t)
  }
  return { schema, name, argtypes: types.join(', ') }
}

/** Resolves the checks of a verify.sql against the target's catalogs (any read session). */
export async function resolveVerifyCatalog(
  reader: CatalogReader,
  checks: readonly VerifyCheckSpec[],
): Promise<VerifyResolution> {
  const builtinNames = new Map<string, number>()
  for (const c of checks) {
    for (const f of c.functions) {
      if (f.startsWith('pg_catalog.')) {
        const name = f.slice('pg_catalog.'.length)
        if (!builtinNames.has(name)) builtinNames.set(name, c.index)
      }
    }
  }
  if (builtinNames.size > 0) {
    const rows = await reader.query(BUILTIN_FUNCTIONS, [JSON.stringify([...builtinNames.keys()])])
    const found = new Map(rows.map((r) => [r.text('name'), r.bool('builtin')]))
    for (const [name, check] of builtinNames) {
      if (found.get(name) !== true) {
        return { ok: false, reason: 'function', construct: `pg_catalog.${name}`, check }
      }
    }
  }
  const added = (await reader.query(ADDED_OPERATORS_AND_CASTS))[0]
  if (added !== undefined && added.int('operators') > 0) {
    return {
      ok: false,
      reason: 'operator',
      construct: 'pg_catalog operator added after initdb',
      check: null,
    }
  }
  if (added !== undefined && added.int('casts') > 0) {
    return {
      ok: false,
      reason: 'cast',
      construct: 'cast between built-in types added after initdb',
      check: null,
    }
  }
  const relations: { check: VerifyCheckSpec; schema: string; name: string }[] = []
  for (const c of checks) {
    for (const r of c.relations) {
      if (r.schema === null) {
        return { ok: false, reason: 'relation_kind', construct: r.name, check: c.index }
      }
      if (!CATALOG_SCHEMAS.has(r.schema))
        relations.push({ check: c, schema: r.schema, name: r.name })
    }
  }
  if (relations.length > 0) {
    const rows = await reader.query(RELATION_KINDS, [
      JSON.stringify(relations.map((r) => [r.schema, r.name])),
    ])
    const kinds = new Map(rows.map((r) => [r.int('ord'), r.textOrNull('relkind')]))
    for (const [i, r] of relations.entries()) {
      const kind = kinds.get(i + 1) ?? null
      const declaredView = r.check.readsView === `${r.schema}.${r.name}` && kind === 'v'
      if (kind === null || (!READABLE.has(kind) && !declaredView)) {
        return {
          ok: false,
          reason: 'relation_kind',
          construct: `${r.schema}.${r.name}`,
          check: r.check.index,
        }
      }
    }
  }
  const consumer: ConsumerCode[] = []
  for (const c of checks) {
    if (c.calls !== null) {
      const fn = await declaredSignature(reader, c.calls)
      const r =
        fn === null
          ? undefined
          : (await reader.query(CONSUMER_FUNCTION, [fn.schema, fn.name, fn.argtypes]))[0]
      if (r === undefined) {
        return { ok: false, reason: 'consumer_missing', construct: c.calls, check: c.index }
      }
      if (r.int('overloads') !== 1) {
        return { ok: false, reason: 'consumer_overloaded', construct: c.calls, check: c.index }
      }
      if (r.text('prokind') !== 'f' || r.textOrNull('digest') === null) {
        return { ok: false, reason: 'consumer_not_plain', construct: c.calls, check: c.index }
      }
      if (r.bool('secdef')) {
        return {
          ok: false,
          reason: 'consumer_security_definer',
          construct: c.calls,
          check: c.index,
        }
      }
      if (r.bool('extension')) {
        return { ok: false, reason: 'consumer_extension', construct: c.calls, check: c.index }
      }
      consumer.push({
        check: c.index,
        kind: 'function',
        declared: c.calls,
        oid: r.text('oid'),
        owner: r.text('owner'),
        digest: `sha256:${r.text('digest')}`,
      })
    }
    if (c.readsView !== null) {
      const [schema = '', view = ''] = c.readsView.split('.')
      const r = (await reader.query(CONSUMER_VIEW, [schema, view]))[0]
      if (r === undefined) {
        return { ok: false, reason: 'consumer_missing', construct: c.readsView, check: c.index }
      }
      if (r.text('relkind') !== 'v') {
        return { ok: false, reason: 'consumer_not_plain', construct: c.readsView, check: c.index }
      }
      if (r.bool('extension')) {
        return { ok: false, reason: 'consumer_extension', construct: c.readsView, check: c.index }
      }
      consumer.push({
        check: c.index,
        kind: 'view',
        declared: c.readsView,
        oid: r.text('oid'),
        owner: r.text('owner'),
        digest: `sha256:${r.text('digest')}`,
      })
    }
  }
  return { ok: true, checks: checks.length, consumer }
}

/** Consumer code that differs from what a plan bound (by declaration): the run refuses. */
export function changedConsumerCode(
  bound: readonly ConsumerCode[],
  now: readonly ConsumerCode[],
): string[] {
  const current = new Map(now.map((c) => [`${c.check}:${c.declared}`, c]))
  const changed: string[] = []
  for (const b of bound) {
    const c = current.get(`${b.check}:${b.declared}`)
    if (c === undefined || c.oid !== b.oid || c.digest !== b.digest || c.owner !== b.owner) {
      changed.push(b.declared)
    }
  }
  if (now.length !== bound.length) changed.push('declarations')
  return changed
}

/**
 * The checks that may run, after a passing resolution of exactly these
 * checks. Nothing else creates an {@link AdmittedCheck}.
 */
export function admitChecks(
  checks: readonly VerifyCheckSpec[],
  resolution: VerifyResolution,
): AdmittedCheck[] {
  if (!resolution.ok || resolution.checks !== checks.length) {
    throw new TypeError('checks run only after their catalog resolution passed')
  }
  return checks.map(registerAdmittedCheck)
}

export type VerifierProblem =
  | 'superuser'
  | 'privileged_attribute'
  | 'dangerous_membership'
  | 'no_bypassrls'
  | 'not_read_only'
  | 'search_path'
  | 'write_privilege'
  | 'remote_functions'

const VERIFIER_FACTS = sql`SELECT r.rolsuper AS superuser,
       (r.rolcreaterole OR r.rolcreatedb OR r.rolreplication) AS privileged,
       r.rolbypassrls AS bypassrls,
       EXISTS (SELECT 1 FROM pg_catalog.pg_roles m
                WHERE m.rolname IN ('pg_write_all_data', 'pg_signal_backend', 'pg_read_server_files',
                                    'pg_write_server_files', 'pg_execute_server_program', 'pg_checkpoint',
                                    'pg_create_subscription', 'pg_use_reserved_connections', 'pg_maintain')
                  AND pg_catalog.pg_has_role(current_user, m.oid, 'MEMBER')) AS dangerous,
       pg_catalog.current_setting('default_transaction_read_only') AS read_only,
       pg_catalog.current_setting('search_path') AS search_path,
       EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                  AND n.nspname NOT LIKE 'pg\\_%'
                  AND pg_catalog.has_table_privilege(current_user, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')
                LIMIT 1) AS writes,
       EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                 JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
                WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.refclassid = 'pg_catalog.pg_extension'::regclass
                  AND d.deptype = 'e' AND e.extname IN ('dblink', 'postgres_fdw')
                  AND pg_catalog.has_function_privilege(current_user, d.objid, 'EXECUTE')) AS remote
  FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`

/**
 * Drift of the verifier role (verification.md §4.3; credentials-and-roles.md),
 * read on the verifier session itself before any check runs: any problem
 * refuses the run.
 */
export async function verifierProblems(reader: CatalogReader): Promise<VerifierProblem[]> {
  const r = (await reader.query(VERIFIER_FACTS))[0]
  if (r === undefined) return ['superuser']
  const out: VerifierProblem[] = []
  if (r.bool('superuser')) out.push('superuser')
  if (r.bool('privileged')) out.push('privileged_attribute')
  if (r.bool('dangerous')) out.push('dangerous_membership')
  if (!r.bool('bypassrls')) out.push('no_bypassrls')
  if (r.text('read_only') !== 'on') out.push('not_read_only')
  if (r.text('search_path').replace(/["\s]/g, '') !== '') out.push('search_path')
  if (r.bool('writes')) out.push('write_privilege')
  if (r.bool('remote')) out.push('remote_functions')
  return out
}

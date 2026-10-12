import { type CatalogReader, LEDGER_OWNER_ROLE, ROLE_NAMES } from './session.ts'
import { sql } from './sql.ts'

/**
 * Catalog facts the migration engine binds into a plan and checks again
 * under the lock ([planning-and-apply.md §2, §5](../../../exponetdb-docs/04-migrations/planning-and-apply.md#2-plan-content),
 * [credentials-and-roles.md](../../../exponetdb-docs/03-database-model/credentials-and-roles.md)).
 */

/** What an execution role must be for the migrator to `SET ROLE` into it. */
export interface ExecutionRoleFacts {
  readonly role: string
  readonly exists: boolean
  readonly canLogin: boolean
  readonly superuser: boolean
  readonly createRole: boolean
  readonly createDb: boolean
  readonly replication: boolean
  readonly bypassRls: boolean
  /** The role reaches (is a member of) a superuser, a predefined `pg_` role or an ExponetDB role. */
  readonly reachesProtected: boolean
  /** Direct membership of the migrator: `SET` option, `INHERIT` option (PostgreSQL 16+). */
  readonly membership: { readonly set: boolean; readonly inherit: boolean } | null
}

export type ExecutionRoleProblem =
  | 'missing'
  | 'can_login'
  | 'privileged_attribute'
  | 'exponetdb_role'
  | 'predefined_role'
  | 'not_a_member'
  | 'membership_inherits'
  | 'membership_without_set'
  | 'reaches_protected_role'

const EXPONETDB_ROLES: ReadonlySet<string> = new Set([
  ...Object.values(ROLE_NAMES),
  LEDGER_OWNER_ROLE,
])

const ROLE_FACTS = sql`SELECT r.rolname::text AS role, r.rolcanlogin AS can_login, r.rolsuper AS superuser,
       r.rolcreaterole AS create_role, r.rolcreatedb AS create_db, r.rolreplication AS replication,
       r.rolbypassrls AS bypass_rls,
       EXISTS (SELECT 1 FROM pg_catalog.pg_roles x
                WHERE x.oid <> r.oid AND pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
                  AND (x.rolsuper OR x.rolname LIKE 'pg\\_%' OR x.rolname LIKE 'exponetdb\\_%')) AS reaches_protected,
       (SELECT m.set_option FROM pg_catalog.pg_auth_members m
         WHERE m.roleid = r.oid AND m.member = (SELECT u.oid FROM pg_catalog.pg_roles u WHERE u.rolname = coalesce($2, current_user))
         ORDER BY m.set_option DESC LIMIT 1) AS member_set,
       (SELECT bool_or(m.inherit_option) FROM pg_catalog.pg_auth_members m
         WHERE m.roleid = r.oid AND m.member = (SELECT u.oid FROM pg_catalog.pg_roles u WHERE u.rolname = coalesce($2, current_user))) AS member_inherit
  FROM pg_catalog.pg_roles r WHERE r.rolname = ANY (ARRAY(SELECT pg_catalog.jsonb_array_elements_text($1::jsonb)))`

/**
 * Facts of the named roles and the membership of `member` in each (default:
 * the session's own role; the planner, on an observer session, asks for
 * `exponetdb_migrator`). Read from the catalogs, so any role may read them.
 */
export async function executionRoleFacts(
  reader: CatalogReader,
  roles: readonly string[],
  member: string | null = null,
): Promise<ExecutionRoleFacts[]> {
  const rows = await reader.query(ROLE_FACTS, [JSON.stringify(roles), member])
  const byName = new Map(rows.map((r) => [r.text('role'), r]))
  return roles.map((role) => {
    const r = byName.get(role)
    if (r === undefined) {
      return {
        role,
        exists: false,
        canLogin: false,
        superuser: false,
        createRole: false,
        createDb: false,
        replication: false,
        bypassRls: false,
        reachesProtected: false,
        membership: null,
      }
    }
    const set = r.boolOrNull('member_set')
    return {
      role,
      exists: true,
      canLogin: r.bool('can_login'),
      superuser: r.bool('superuser'),
      createRole: r.bool('create_role'),
      createDb: r.bool('create_db'),
      replication: r.bool('replication'),
      bypassRls: r.bool('bypass_rls'),
      reachesProtected: r.bool('reaches_protected'),
      membership: set === null ? null : { set, inherit: r.bool('member_inherit') },
    }
  })
}

/**
 * Why the migrator must not `SET ROLE` into this role, or null: a declared
 * `NOLOGIN` owner without privileged attributes, never an ExponetDB or a
 * predefined role and reaching none of them, of which the migrator is a
 * direct member with `SET TRUE` and `INHERIT FALSE` (the migrator never
 * gains its privileges implicitly, and consumer SQL never runs as the
 * ledger owner).
 */
export function executionRoleProblem(facts: ExecutionRoleFacts): ExecutionRoleProblem | null {
  if (EXPONETDB_ROLES.has(facts.role)) return 'exponetdb_role'
  if (facts.role.startsWith('pg_')) return 'predefined_role'
  if (!facts.exists) return 'missing'
  if (facts.canLogin) return 'can_login'
  if (
    facts.superuser ||
    facts.createRole ||
    facts.createDb ||
    facts.replication ||
    facts.bypassRls
  ) {
    return 'privileged_attribute'
  }
  // SET ROLE into it would reach the ledger owner or a predefined role's powers.
  if (facts.reachesProtected) return 'reaches_protected_role'
  if (facts.membership === null) return 'not_a_member'
  if (!facts.membership.set) return 'membership_without_set'
  if (facts.membership.inherit) return 'membership_inherits'
  return null
}

export interface ExtensionFacts {
  readonly name: string
  readonly installed: string | null
  /** The default version's `trusted` flag, or null when not available. */
  readonly trusted: boolean | null
  readonly defaultVersion: string | null
}

const EXTENSION_FACTS = sql`SELECT n.name, e.extversion AS installed, a.default_version,
       (SELECT v.trusted FROM pg_catalog.pg_available_extension_versions v
         WHERE v.name = n.name AND v.version = a.default_version) AS trusted
  FROM (SELECT pg_catalog.jsonb_array_elements_text($1::jsonb) AS name) n
  LEFT JOIN pg_catalog.pg_extension e ON e.extname = n.name
  LEFT JOIN pg_catalog.pg_available_extensions a ON a.name = n.name`

const INSTALLED_EXTENSIONS = sql`SELECT coalesce(pg_catalog.jsonb_object_agg(e.extname, e.extversion), '{}'::jsonb) AS versions
  FROM pg_catalog.pg_extension e`

export async function extensionFacts(
  reader: CatalogReader,
  names: readonly string[],
): Promise<ExtensionFacts[]> {
  const rows = await reader.query(EXTENSION_FACTS, [JSON.stringify(names)])
  return rows.map((r) => ({
    name: r.text('name'),
    installed: r.textOrNull('installed'),
    trusted: r.boolOrNull('trusted'),
    defaultVersion: r.textOrNull('default_version'),
  }))
}

/** Every installed extension and its version (bound into a migration plan). */
export async function installedExtensions(reader: CatalogReader): Promise<Record<string, string>> {
  const row = (await reader.query(INSTALLED_EXTENSIONS))[0]
  const out: Record<string, string> = {}
  if (row === undefined) return out
  const versions = row.jsonObject('versions')
  for (const [name, version] of Object.entries(versions)) {
    if (typeof version === 'string') out[name] = version
  }
  return out
}

/**
 * The settings and identity the executor holds a migration's statements to
 * (planning-and-apply.md §5): read before the first statement and after
 * each one; any difference stops the migration (defense in depth behind
 * the parser's refusal of SET ROLE, session-level SET and RESET).
 */
export interface EngineGuards {
  readonly currentUser: string
  readonly sessionUser: string
  readonly searchPath: string
  readonly lockTimeout: string
  readonly statementTimeout: string
  readonly idleInTransaction: string
  readonly standardConformingStrings: string
  readonly timeZone: string
  readonly dateStyle: string
  readonly intervalStyle: string
  readonly clientEncoding: string
  readonly checkFunctionBodies: string
  readonly readOnly: string
}

const GUARDS = sql`SELECT current_user::text AS current_user, session_user::text AS session_user,
       pg_catalog.current_setting('search_path') AS search_path,
       pg_catalog.current_setting('lock_timeout') AS lock_timeout,
       pg_catalog.current_setting('statement_timeout') AS statement_timeout,
       pg_catalog.current_setting('idle_in_transaction_session_timeout') AS idle,
       pg_catalog.current_setting('standard_conforming_strings') AS scs,
       pg_catalog.current_setting('TimeZone') AS tz,
       pg_catalog.current_setting('DateStyle') AS date_style,
       pg_catalog.current_setting('IntervalStyle') AS interval_style,
       pg_catalog.current_setting('client_encoding') AS client_encoding,
       pg_catalog.current_setting('check_function_bodies') AS check_bodies,
       pg_catalog.current_setting('transaction_read_only') AS read_only`

export async function readEngineGuards(reader: CatalogReader): Promise<EngineGuards> {
  const r = (await reader.query(GUARDS))[0]
  if (r === undefined) {
    throw new TypeError('the guard query returned no row')
  }
  return {
    currentUser: r.text('current_user'),
    sessionUser: r.text('session_user'),
    searchPath: r.text('search_path'),
    lockTimeout: r.text('lock_timeout'),
    statementTimeout: r.text('statement_timeout'),
    idleInTransaction: r.text('idle'),
    standardConformingStrings: r.text('scs'),
    timeZone: r.text('tz'),
    dateStyle: r.text('date_style'),
    intervalStyle: r.text('interval_style'),
    clientEncoding: r.text('client_encoding'),
    checkFunctionBodies: r.text('check_bodies'),
    readOnly: r.text('read_only'),
  }
}

/** The guard fields that differ (by name), or an empty list. */
export function changedGuards(before: EngineGuards, after: EngineGuards): string[] {
  return (Object.keys(before) as (keyof EngineGuards)[]).filter((k) => before[k] !== after[k])
}

export interface RelationSize {
  readonly relkind: string
  /** Heap and TOAST bytes; null when unknown. */
  readonly bytes: number | null
  /** The planner's row estimate; null when the table was never analyzed. */
  readonly rows: number | null
}

const RELATION_SIZES = sql`SELECT n.nspname::text AS schema, c.relname::text AS name, c.relkind::text AS relkind,
       pg_catalog.pg_table_size(c.oid)::text AS bytes,
       CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint::text END AS rows
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'p', 'm') AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
   AND n.nspname <> 'exponetdb'
 ORDER BY 1, 2 LIMIT 50000`

/**
 * Sizes and row estimates of the tables, partitioned tables and
 * materialized views (`schema.name` → facts), for the analysis of rewrite
 * and lock risk ([analysis.md §3](../../../exponetdb-docs/04-migrations/analysis.md)).
 * Estimates, labeled as such where shown; never a duration.
 */
export async function relationSizes(reader: CatalogReader): Promise<Map<string, RelationSize>> {
  const rows = await reader.query(RELATION_SIZES)
  const out = new Map<string, RelationSize>()
  for (const r of rows) {
    const bytes = r.textOrNull('bytes')
    const estimate = r.textOrNull('rows')
    out.set(`${r.text('schema')}.${r.text('name')}`, {
      relkind: r.text('relkind'),
      bytes: bytes === null ? null : Number(bytes),
      rows: estimate === null ? null : Number(estimate),
    })
  }
  return out
}

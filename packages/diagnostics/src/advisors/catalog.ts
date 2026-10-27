import type { Queryable } from '@exponetdb/control-store'
import {
  ALWAYS_EXCLUDED_SCHEMAS,
  sql,
  type TargetSession,
  type TrustedSql,
} from '@exponetdb/postgres'
import { getEnvironment, liveTargetOf, type TargetRecord } from '@exponetdb/registry'
import { clip } from '../findings.ts'
import { arrayParam, isoOf, msOf, statsVisible } from '../live.ts'
import { displayIdent } from '../objects.ts'

/**
 * The advisor catalog ([performance.md §4](../../../../exponetdb-docs/10-observability/performance.md#4-advisors)),
 * version 1: a clean-room set of rules written from the PostgreSQL
 * documentation of the catalogs and statistics views they read (no
 * third-party lint SQL is copied; ADR-0017). Each rule reads its facts with
 * one engine-authored, read-only query on the observer session (or from the
 * Control Store) and turns them into findings with a pure `evaluate`.
 *
 * A rule that cannot read its facts is **skipped** with a reason, never a
 * pass: its open findings stay as they are. No rule changes anything;
 * `draft: migration_draft` only says that a fix can be drafted as a
 * migration bundle for review.
 *
 * Catalog text (names, arguments, settings' names) is untrusted data: it is
 * quoted for display, bounded and never interpreted.
 */
export const ADVISOR_CATALOG_VERSION = 1

export type AdvisorCategory = 'security' | 'performance' | 'operations' | 'change_safety'
export type AdvisorLevel = 'info' | 'warning' | 'critical'
export type Evidence = Record<string, string | number | boolean | null>

export interface AdvisorFinding {
  readonly rule: string
  readonly category: AdvisorCategory
  readonly level: AdvisorLevel
  readonly object: string | null
  readonly message: string
  readonly remediation: string
  readonly evidence: Evidence
  readonly draft: 'none' | 'migration_draft'
}

/**
 * Why a rule did not run. The API's reasons are the contract's
 * (`needs_node`, `version_unsupported`, `not_permitted`, `timeout`,
 * `error`); `stats_window_short` (the unused-index rule before the
 * statistics count 7 days) is recorded as such in the Control Store and
 * answered as `error`, the contract having no closer reason.
 */
export type SkipReason =
  | 'needs_node'
  | 'version_unsupported'
  | 'not_permitted'
  | 'timeout'
  | 'error'
  | 'stats_window_short'

export interface RuleEnv {
  readonly session: TargetSession
  readonly store: Queryable
  readonly target: TargetRecord
  /** The project's managed scope: `null` includes every non-system schema. */
  readonly include: readonly string[] | null
  /** Excluded schemas, ExponetDB's and the system's always among them. */
  readonly exclude: readonly string[]
  readonly nowMs: number
}

export type FactsResult<F> =
  | { readonly facts: F; readonly complete: boolean }
  | { readonly skipped: SkipReason }

export interface AdvisorRule<F = unknown> {
  readonly id: string
  readonly category: AdvisorCategory
  /** Findings at most per run; more are cut (`complete: false`: open findings are not cleared). */
  readonly cap: number
  facts(env: RuleEnv): Promise<FactsResult<F>>
  evaluate(facts: F, env: Pick<RuleEnv, 'nowMs'>): AdvisorFinding[]
}

/** Findings of one rule at most per run. */
export const RULE_FINDING_CAP = 100

// ----- shared helpers -----

const SCOPE = (ns: TrustedSql) =>
  sql`(($1::text[] IS NULL OR ${ns}.nspname = ANY($1::text[]))
     AND NOT (${ns}.nspname = ANY($2::text[])) AND ${ns}.nspname NOT LIKE 'pg\\_%')`

function scopeParams(env: RuleEnv): [string | null, string] {
  return [
    env.include === null ? null : arrayParam(env.include),
    arrayParam([...new Set([...env.exclude, ...ALWAYS_EXCLUDED_SCHEMAS])]),
  ]
}

/** `schema.name`, each part quoted when it is not a plain lower-case name. */
export const qualifiedLabel = (schema: string, name: string): string =>
  `${displayIdent(clip(schema, 63))}.${displayIdent(clip(name, 63))}`

const text = (v: string, max = 256) => clip(v, max)

async function rows<T>(
  env: RuleEnv,
  statement: TrustedSql,
  params: readonly (string | number | boolean | null)[],
  map: (r: Awaited<ReturnType<TargetSession['query']>>[number]) => T,
  cap: number,
): Promise<FactsResult<T[]>> {
  const result = await env.session.query(statement, [...params, cap + 1])
  return { facts: result.slice(0, cap).map(map), complete: result.length <= cap }
}

const finding = (
  rule: { readonly id: string; readonly category: AdvisorCategory },
  level: AdvisorLevel,
  object: string | null,
  message: string,
  remediation: string,
  evidence: Evidence,
  draft: 'none' | 'migration_draft' = 'none',
): AdvisorFinding => ({
  rule: rule.id,
  category: rule.category,
  level,
  object: object === null ? null : clip(object, 512),
  message: clip(message, 1024),
  remediation: clip(remediation, 2048),
  evidence,
  draft,
})

// ----- security -----

interface RelationFact {
  readonly schema: string
  readonly name: string
}

const GRANTS_TO_OTHERS = sql`pg_catalog.aclexplode(c.relacl) a
   LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
  WHERE a.grantee <> c.relowner AND a.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
    AND coalesce(g.rolname::text, '') NOT LIKE 'exponetdb\\_%'`

const RLS_DISABLED = sql`SELECT n.nspname::text AS schema, c.relname::text AS name,
       (SELECT string_agg(DISTINCT a.privilege_type, ',' ORDER BY a.privilege_type) FROM ${GRANTS_TO_OTHERS}) AS privileges,
       (SELECT count(DISTINCT a.grantee) FROM ${GRANTS_TO_OTHERS})::int AS grantees,
       EXISTS (SELECT 1 FROM ${GRANTS_TO_OTHERS} AND a.grantee = 0) AS to_public
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'p') AND NOT c.relrowsecurity AND c.relacl IS NOT NULL
   AND ${SCOPE(sql`n`)}
   AND EXISTS (SELECT 1 FROM ${GRANTS_TO_OTHERS})
 ORDER BY 1, 2 LIMIT $3`

export const rlsDisabledWithGrants: AdvisorRule<
  (RelationFact & { privileges: string; grantees: number; toPublic: boolean })[]
> = {
  id: 'rls_disabled_with_grants',
  category: 'security',
  cap: RULE_FINDING_CAP,
  facts: (env) =>
    rows(
      env,
      RLS_DISABLED,
      scopeParams(env),
      (r) => ({
        schema: r.text('schema'),
        name: r.text('name'),
        privileges: r.textOrNull('privileges') ?? '',
        grantees: r.int('grantees'),
        toPublic: r.bool('to_public'),
      }),
      RULE_FINDING_CAP,
    ),
  evaluate: (facts) =>
    facts.map((f) =>
      finding(
        rlsDisabledWithGrants,
        'warning',
        `table ${qualifiedLabel(f.schema, f.name)}`,
        `Row level security is disabled on a table that other roles may read or change (${f.privileges}).`,
        'Enable row level security and add policies through a migration, or revoke the privileges of the roles that must not reach every row.',
        { privileges: text(f.privileges), grantees: f.grantees, toPublic: f.toPublic },
      ),
    ),
}

const RLS_NO_POLICY = sql`SELECT n.nspname::text AS schema, c.relname::text AS name, c.relforcerowsecurity AS forced
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'p') AND c.relrowsecurity AND ${SCOPE(sql`n`)}
   AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid)
 ORDER BY 1, 2 LIMIT $3`

export const rlsEnabledWithoutPolicy: AdvisorRule<(RelationFact & { forced: boolean })[]> = {
  id: 'rls_enabled_without_policy',
  category: 'security',
  cap: RULE_FINDING_CAP,
  facts: (env) =>
    rows(
      env,
      RLS_NO_POLICY,
      scopeParams(env),
      (r) => ({ schema: r.text('schema'), name: r.text('name'), forced: r.bool('forced') }),
      RULE_FINDING_CAP,
    ),
  evaluate: (facts) =>
    facts.map((f) =>
      finding(
        rlsEnabledWithoutPolicy,
        'info',
        `table ${qualifiedLabel(f.schema, f.name)}`,
        'Row level security is enabled but the table has no policy: every role except the owner (and roles that bypass row security) reads no rows and changes none.',
        'Add the policies the table needs through a migration, or disable row level security if no role should be restricted.',
        { forced: f.forced },
      ),
    ),
}

const SECDEF = sql`SELECT n.nspname::text AS schema, p.proname::text AS name,
       pg_catalog.pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
 WHERE p.prosecdef AND ${SCOPE(sql`n`)}
   AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(coalesce(p.proconfig, '{}'::text[])) cfg
                    WHERE cfg LIKE 'search\\_path=%')
   AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                    WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
 ORDER BY 1, 2, 3 LIMIT $3`

export const securityDefinerWithoutSearchPath: AdvisorRule<(RelationFact & { args: string })[]> = {
  id: 'security_definer_without_search_path',
  category: 'security',
  cap: RULE_FINDING_CAP,
  facts: (env) =>
    rows(
      env,
      SECDEF,
      scopeParams(env),
      (r) => ({ schema: r.text('schema'), name: r.text('name'), args: r.textOrNull('args') ?? '' }),
      RULE_FINDING_CAP,
    ),
  evaluate: (facts) =>
    facts.map((f) =>
      finding(
        securityDefinerWithoutSearchPath,
        'warning',
        `function ${qualifiedLabel(f.schema, f.name)}(${clip(f.args, 256)})`,
        "A SECURITY DEFINER function runs with its owner's rights but takes the caller's search_path: a caller can put objects of its own in front of the ones it uses.",
        'Set a fixed search_path on the function (ALTER FUNCTION … SET search_path = …) through a migration, and qualify the objects it uses.',
        { arguments: text(f.args) },
        'migration_draft',
      ),
    ),
}

const BYPASS = sql`SELECT r.rolname::text AS name FROM pg_catalog.pg_roles r
 WHERE r.rolcanlogin AND r.rolbypassrls AND NOT r.rolsuper AND r.rolname::text NOT LIKE 'exponetdb\\_%'
 ORDER BY 1 LIMIT $1`

export const bypassrlsLoginRole: AdvisorRule<{ name: string }[]> = {
  id: 'bypassrls_login_role',
  category: 'security',
  cap: RULE_FINDING_CAP,
  facts: (env) => rows(env, BYPASS, [], (r) => ({ name: r.text('name') }), RULE_FINDING_CAP),
  evaluate: (facts) =>
    facts.map((f) =>
      finding(
        bypassrlsLoginRole,
        'warning',
        `role ${displayIdent(clip(f.name, 63))}`,
        'A role that can log in bypasses row level security: an application using it reads and changes every row of every table with policies.',
        'Remove BYPASSRLS from the role, or keep it only for a role that is not used by an application; declare an execution-role exception if a migration role needs it.',
        {},
      ),
    ),
}

const EXT_PUBLIC = sql`SELECT e.extname::text AS name, e.extversion AS version
  FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
 WHERE n.nspname = 'public' ORDER BY 1 LIMIT $1`

export const extensionInPublic: AdvisorRule<{ name: string; version: string }[]> = {
  id: 'extension_in_public',
  category: 'security',
  cap: RULE_FINDING_CAP,
  facts: (env) =>
    rows(
      env,
      EXT_PUBLIC,
      [],
      (r) => ({ name: r.text('name'), version: r.textOrNull('version') ?? '' }),
      RULE_FINDING_CAP,
    ),
  evaluate: (facts) =>
    facts.map((f) =>
      finding(
        extensionInPublic,
        'warning',
        `extension ${displayIdent(clip(f.name, 63))}`,
        'An extension is installed in the public schema: its objects share the schema every role may create objects in and that is on the default search_path.',
        'Install the extension in a schema of its own (CREATE EXTENSION … SCHEMA … or ALTER EXTENSION … SET SCHEMA … where the extension allows it) through a migration.',
        { version: text(f.version, 64) },
      ),
    ),
}

const PLAINTEXT = sql`SELECT
  count(*) FILTER (WHERE NOT (a.client_addr << inet '127.0.0.0/8' OR a.client_addr = inet '::1'))::int AS remote,
  count(*) FILTER (WHERE a.client_addr << inet '127.0.0.0/8' OR a.client_addr = inet '::1')::int AS loopback
  FROM pg_catalog.pg_stat_activity a
  LEFT JOIN pg_catalog.pg_stat_ssl l ON l.pid = a.pid
 WHERE a.backend_type = 'client backend' AND a.client_addr IS NOT NULL AND l.ssl IS DISTINCT FROM true`

export const plaintextClientConnections: AdvisorRule<{ remote: number; loopback: number }> = {
  id: 'plaintext_client_connections',
  category: 'security',
  cap: 1,
  async facts(env) {
    // Without pg_read_all_stats the other roles' sessions are not visible: no count is true.
    if (!(await statsVisible(env.session))) return { skipped: 'not_permitted' }
    const r = (await env.session.query(PLAINTEXT))[0]
    if (r === undefined) return { skipped: 'error' }
    return { facts: { remote: r.int('remote'), loopback: r.int('loopback') }, complete: true }
  },
  evaluate: (f) =>
    f.remote + f.loopback === 0
      ? []
      : [
          finding(
            plaintextClientConnections,
            f.remote > 0 ? 'warning' : 'info',
            null,
            `Client sessions over TCP without TLS: ${f.remote} from other hosts, ${f.loopback} over the loopback address (all databases of the cluster).`,
            'Require TLS for client connections (hostssl lines in pg_hba.conf, sslmode=verify-full in the clients).',
            { remote: f.remote, loopback: f.loopback },
          ),
        ],
}

// ----- performance -----

const FK_UNINDEXED = sql`SELECT n.nspname::text AS schema, c.relname::text AS name, con.conname::text AS constraint_name,
       (SELECT string_agg(a.attname::text, ', ' ORDER BY k.ord)
          FROM pg_catalog.unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columns
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE con.contype = 'f' AND con.conparentid = 0 AND c.relkind IN ('r', 'p') AND ${SCOPE(sql`n`)}
   AND NOT EXISTS (
     SELECT 1 FROM pg_catalog.pg_index i
      WHERE i.indrelid = con.conrelid AND i.indpred IS NULL
        AND (SELECT array_agg(x ORDER BY x)
               FROM pg_catalog.unnest((pg_catalog.string_to_array(i.indkey::text, ' ')::int2[])[1:pg_catalog.cardinality(con.conkey)]) x)
          = (SELECT array_agg(y ORDER BY y) FROM pg_catalog.unnest(con.conkey) y))
 ORDER BY 1, 2, 3 LIMIT $3`

export const unindexedForeignKey: AdvisorRule<
  (RelationFact & { constraint: string; columns: string })[]
> = {
  id: 'unindexed_foreign_key',
  category: 'performance',
  cap: RULE_FINDING_CAP,
  facts: (env) =>
    rows(
      env,
      FK_UNINDEXED,
      scopeParams(env),
      (r) => ({
        schema: r.text('schema'),
        name: r.text('name'),
        constraint: r.text('constraint_name'),
        columns: r.textOrNull('columns') ?? '',
      }),
      RULE_FINDING_CAP,
    ),
  evaluate: (facts) =>
    facts.map((f) =>
      finding(
        unindexedForeignKey,
        'info',
        `constraint ${displayIdent(clip(f.constraint, 63))} on ${qualifiedLabel(f.schema, f.name)}`,
        `No index starts with the columns of a foreign key (${clip(f.columns, 256)}): a delete or key change in the referenced table scans this table, and joins on it are slow.`,
        `Create an index on ${qualifiedLabel(f.schema, f.name)} (${clip(f.columns, 512)}) through a migration (CREATE INDEX CONCURRENTLY in a non-transactional bundle).`,
        { constraint: text(f.constraint, 63), columns: text(f.columns) },
        'migration_draft',
      ),
    ),
}

/** The duplicate signature of `table-stats.ts`, over the managed scope. */
const DUPLICATES = sql`WITH ix AS (
  SELECT i.indexrelid, i.indrelid, n.nspname::text AS schema, t.relname::text AS table_name,
         c.relname::text AS name, i.indisunique AS is_unique, i.indisprimary AS is_primary,
         pg_catalog.pg_relation_size(i.indexrelid)::text AS size_bytes,
         pg_catalog.md5(c.relam::text || '|' || i.indkey::text || '|' || i.indclass::text || '|'
           || i.indcollation::text || '|' || i.indoption::text || '|'
           || coalesce(pg_catalog.pg_get_expr(i.indexprs, i.indrelid), '') || '|'
           || coalesce(pg_catalog.pg_get_expr(i.indpred, i.indrelid), '')) AS signature
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
    JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
   WHERE ${SCOPE(sql`n`)}
), keeper AS (
  SELECT DISTINCT ON (ix.indrelid, ix.signature) ix.indrelid, ix.signature, ix.indexrelid AS keep, ix.name AS keep_name
    FROM ix ORDER BY ix.indrelid, ix.signature, ix.is_primary DESC, ix.is_unique DESC, ix.indexrelid
)
SELECT ix.schema, ix.table_name, ix.name, ix.size_bytes, k.keep_name AS duplicate_of,
       (ix.is_unique OR ix.is_primary) AS constraint_like
  FROM ix JOIN keeper k ON k.indrelid = ix.indrelid AND k.signature = ix.signature
 WHERE k.keep <> ix.indexrelid
 ORDER BY 1, 2, 3 LIMIT $3`

export const duplicateIndex: AdvisorRule<
  {
    schema: string
    table: string
    name: string
    sizeBytes: number
    duplicateOf: string
    unique: boolean
  }[]
> = {
  id: 'duplicate_index',
  category: 'performance',
  cap: RULE_FINDING_CAP,
  facts: (env) =>
    rows(
      env,
      DUPLICATES,
      scopeParams(env),
      (r) => ({
        schema: r.text('schema'),
        table: r.text('table_name'),
        name: r.text('name'),
        sizeBytes: Number(r.text('size_bytes')),
        duplicateOf: r.text('duplicate_of'),
        unique: r.bool('constraint_like'),
      }),
      RULE_FINDING_CAP,
    ),
  evaluate: (facts) =>
    facts.map((f) =>
      finding(
        duplicateIndex,
        'warning',
        `index ${qualifiedLabel(f.schema, f.name)}`,
        `The index has the same definition as ${displayIdent(clip(f.duplicateOf, 63))} on ${qualifiedLabel(f.schema, f.table)}: every write maintains both.`,
        f.unique
          ? 'Drop the duplicate through a migration; it is unique, so drop the constraint it backs if one does (DROP INDEX CONCURRENTLY or ALTER TABLE … DROP CONSTRAINT).'
          : 'Drop the duplicate through a migration (DROP INDEX CONCURRENTLY in a non-transactional bundle).',
        {
          table: text(f.table, 63),
          duplicateOf: text(f.duplicateOf, 63),
          sizeBytes: f.sizeBytes,
          unique: f.unique,
        },
        'migration_draft',
      ),
    ),
}

/** The statistics window an unused index needs before it is called unused. */
export const UNUSED_INDEX_MIN_DAYS = 7

const STATS_SINCE = sql`SELECT to_char(coalesce((SELECT d.stats_reset FROM pg_catalog.pg_stat_database d
                                  WHERE d.datname = pg_catalog.current_database()),
                                 pg_catalog.pg_postmaster_start_time()) AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS since`

const UNUSED = sql`SELECT n.nspname::text AS schema, t.relname::text AS table_name, c.relname::text AS name,
       pg_catalog.pg_relation_size(i.indexrelid)::text AS size_bytes
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
  JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_catalog.pg_stat_all_indexes s ON s.indexrelid = i.indexrelid
 WHERE s.idx_scan = 0 AND i.indisvalid AND NOT i.indisunique AND NOT i.indisprimary
   AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conindid = i.indexrelid)
   AND ${SCOPE(sql`n`)}
 ORDER BY pg_catalog.pg_relation_size(i.indexrelid) DESC, 1, 2, 3 LIMIT $3`

export const unusedIndex: AdvisorRule<{
  statsSince: string
  indexes: { schema: string; table: string; name: string; sizeBytes: number }[]
}> = {
  id: 'unused_index',
  category: 'performance',
  cap: RULE_FINDING_CAP,
  async facts(env) {
    const since = (await env.session.query(STATS_SINCE))[0]?.textOrNull('since') ?? null
    if (since === null) return { skipped: 'error' }
    if (env.nowMs - msOf(since) < UNUSED_INDEX_MIN_DAYS * 86_400_000) {
      return { skipped: 'stats_window_short' }
    }
    const r = await rows(
      env,
      UNUSED,
      scopeParams(env),
      (row) => ({
        schema: row.text('schema'),
        table: row.text('table_name'),
        name: row.text('name'),
        sizeBytes: Number(row.text('size_bytes')),
      }),
      RULE_FINDING_CAP,
    )
    if ('skipped' in r) return r
    return { facts: { statsSince: isoOf(since), indexes: r.facts }, complete: r.complete }
  },
  evaluate: (f) =>
    f.indexes.map((i) =>
      finding(
        unusedIndex,
        'info',
        `index ${qualifiedLabel(i.schema, i.name)}`,
        `The index was not scanned since ${f.statsSince} (when the database's statistics were last reset or the server started); every write still maintains it.`,
        'Check that no rare job or a standby uses it, then drop it through a migration (DROP INDEX CONCURRENTLY in a non-transactional bundle).',
        { table: text(i.table, 63), sizeBytes: i.sizeBytes, statsSince: f.statsSince },
        'migration_draft',
      ),
    ),
}

const NO_PK = sql`SELECT n.nspname::text AS schema, c.relname::text AS name
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND ${SCOPE(sql`n`)}
   AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'p')
 ORDER BY 1, 2 LIMIT $3`

export const tableWithoutPrimaryKey: AdvisorRule<RelationFact[]> = {
  id: 'table_without_primary_key',
  category: 'performance',
  cap: RULE_FINDING_CAP,
  facts: (env) =>
    rows(
      env,
      NO_PK,
      scopeParams(env),
      (r) => ({ schema: r.text('schema'), name: r.text('name') }),
      RULE_FINDING_CAP,
    ),
  evaluate: (facts) =>
    facts.map((f) =>
      finding(
        tableWithoutPrimaryKey,
        'info',
        `table ${qualifiedLabel(f.schema, f.name)}`,
        'The table has no primary key: rows cannot be addressed reliably, and logical replication of updates and deletes needs one.',
        'Add a primary key through a migration (a unique index built concurrently, then ALTER TABLE … ADD PRIMARY KEY USING INDEX).',
        {},
        'migration_draft',
      ),
    ),
}

const PERMISSIVE = sql`WITH p AS (
  SELECT pol.polrelid, r.role, cmd.cmd, pol.polname::text AS policy
    FROM pg_catalog.pg_policy pol
    CROSS JOIN LATERAL pg_catalog.unnest(pol.polroles) AS r(role)
    CROSS JOIN LATERAL pg_catalog.unnest(CASE WHEN pol.polcmd = '*' THEN ARRAY['r', 'a', 'w', 'd']
                                              ELSE ARRAY[pol.polcmd::text] END) AS cmd(cmd)
   WHERE pol.polpermissive
)
SELECT n.nspname::text AS schema, c.relname::text AS name,
       CASE WHEN p.role = 0 THEN 'public' ELSE coalesce(g.rolname::text, p.role::text) END AS role,
       p.cmd, count(*)::int AS policies, string_agg(p.policy, ', ' ORDER BY p.policy) AS names
  FROM p
  JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_catalog.pg_roles g ON g.oid = p.role
 WHERE ${SCOPE(sql`n`)}
 GROUP BY 1, 2, 3, 4
HAVING count(*) > 1
 ORDER BY 1, 2, 3, 4 LIMIT $3`

const COMMANDS: Readonly<Record<string, string>> = {
  r: 'SELECT',
  a: 'INSERT',
  w: 'UPDATE',
  d: 'DELETE',
}

export const multiplePermissivePolicies: AdvisorRule<
  (RelationFact & { role: string; command: string; policies: number; names: string })[]
> = {
  id: 'multiple_permissive_policies',
  category: 'performance',
  cap: RULE_FINDING_CAP,
  facts: (env) =>
    rows(
      env,
      PERMISSIVE,
      scopeParams(env),
      (r) => ({
        schema: r.text('schema'),
        name: r.text('name'),
        role: r.text('role'),
        command: COMMANDS[r.text('cmd')] ?? r.text('cmd'),
        policies: r.int('policies'),
        names: r.textOrNull('names') ?? '',
      }),
      RULE_FINDING_CAP,
    ),
  evaluate: (facts) =>
    facts.map((f) =>
      finding(
        multiplePermissivePolicies,
        'warning',
        `table ${qualifiedLabel(f.schema, f.name)} role ${displayIdent(clip(f.role, 63))} ${f.command}`,
        `${f.policies} permissive policies apply to the same role and command: each is evaluated for every row, and any one of them admits it.`,
        'Combine the policies into one through a migration, or make the ones that must all hold restrictive.',
        { role: text(f.role, 63), command: f.command, policies: f.policies, names: text(f.names) },
      ),
    ),
}

// ----- operations -----

/**
 * Wraparound thresholds of `xid_age_high`, from the database's
 * `age(datfrozenxid)`: a warning once the age is 1.5 × the server's
 * `autovacuum_freeze_max_age` (the anti-wraparound vacuum, due at 1 ×, is
 * half an interval overdue), critical from 1.5 billion transactions (about
 * 70 % of the 2^31 limit at which PostgreSQL stops assigning ids).
 */
export const XID_WARNING_FACTOR = 1.5
export const XID_CRITICAL_AGE = 1_500_000_000

const XID = sql`SELECT d.datname::text AS database, pg_catalog.age(d.datfrozenxid)::text AS age,
       pg_catalog.current_setting('autovacuum_freeze_max_age') AS freeze_max,
       (SELECT n.nspname::text || '.' || c.relname::text FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r', 'm', 't') ORDER BY pg_catalog.age(c.relfrozenxid) DESC LIMIT 1) AS oldest
  FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()`

export const xidAgeHigh: AdvisorRule<{
  database: string
  age: number
  freezeMaxAge: number
  oldest: string | null
}> = {
  id: 'xid_age_high',
  category: 'operations',
  cap: 1,
  async facts(env) {
    const r = (await env.session.query(XID))[0]
    if (r === undefined) return { skipped: 'error' }
    return {
      facts: {
        database: r.text('database'),
        age: Number(r.text('age')),
        freezeMaxAge: Number(r.text('freeze_max')),
        oldest: r.textOrNull('oldest'),
      },
      complete: true,
    }
  },
  evaluate(f) {
    const critical = f.age >= XID_CRITICAL_AGE
    const warning = f.age >= XID_WARNING_FACTOR * f.freezeMaxAge
    if (!critical && !warning) return []
    return [
      finding(
        xidAgeHigh,
        critical ? 'critical' : 'warning',
        `database ${displayIdent(clip(f.database, 63))}`,
        `The oldest unfrozen transaction id of the database is ${f.age} transactions old (autovacuum_freeze_max_age is ${f.freezeMaxAge}); PostgreSQL stops writes before 2^31.`,
        'Find what holds vacuum back (long transactions, prepared transactions, replication slots, failing autovacuum) and vacuum the oldest tables.',
        {
          age: f.age,
          freezeMaxAge: f.freezeMaxAge,
          oldestTable: f.oldest === null ? null : text(f.oldest),
        },
      ),
    ]
  },
}

const SLOTS = sql`SELECT s.slot_name::text AS name, s.slot_type::text AS type, s.database::text AS database,
       CASE WHEN pg_catalog.pg_is_in_recovery() OR s.restart_lsn IS NULL THEN NULL
            ELSE pg_catalog.pg_wal_lsn_diff(pg_catalog.pg_current_wal_lsn(), s.restart_lsn)::bigint::text END AS retained
  FROM pg_catalog.pg_replication_slots s WHERE NOT s.active ORDER BY 1 LIMIT $1`

export const inactiveReplicationSlot: AdvisorRule<
  { name: string; type: string; database: string | null; retainedBytes: number | null }[]
> = {
  id: 'inactive_replication_slot',
  category: 'operations',
  cap: RULE_FINDING_CAP,
  facts: (env) =>
    rows(
      env,
      SLOTS,
      [],
      (r) => {
        const retained = r.textOrNull('retained')
        return {
          name: r.text('name'),
          type: r.text('type'),
          database: r.textOrNull('database'),
          retainedBytes: retained === null ? null : Number(retained),
        }
      },
      RULE_FINDING_CAP,
    ),
  evaluate: (facts) =>
    facts.map((f) =>
      finding(
        inactiveReplicationSlot,
        'warning',
        `replication slot ${displayIdent(clip(f.name, 63))}`,
        `A ${f.type} replication slot has no consumer: the server keeps the WAL it still needs${f.retainedBytes === null ? '' : ` (${f.retainedBytes} bytes now)`} and, for a logical slot, holds back vacuum.`,
        'Reconnect its consumer, or drop the slot when nothing will read from it again (pg_drop_replication_slot, run by a person).',
        {
          type: text(f.type, 32),
          database: f.database === null ? null : text(f.database, 63),
          retainedBytes: f.retainedBytes,
        },
      ),
    ),
}

const ARCHIVER = sql`SELECT pg_catalog.current_setting('archive_mode') AS mode, a.failed_count::text AS failed,
       to_char(a.last_failed_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_failed,
       to_char(a.last_archived_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_archived
  FROM pg_catalog.pg_stat_archiver a`

export const walArchiveFailing: AdvisorRule<{
  mode: string
  failedCount: number
  lastFailed: string | null
  lastArchived: string | null
}> = {
  id: 'wal_archive_failing',
  category: 'operations',
  cap: 1,
  async facts(env) {
    const r = (await env.session.query(ARCHIVER))[0]
    if (r === undefined) return { skipped: 'error' }
    return {
      facts: {
        mode: r.text('mode'),
        failedCount: Number(r.text('failed')),
        lastFailed: r.textOrNull('last_failed'),
        lastArchived: r.textOrNull('last_archived'),
      },
      complete: true,
    }
  },
  evaluate(f) {
    if (f.mode === 'off' || f.failedCount === 0 || f.lastFailed === null) return []
    if (f.lastArchived !== null && msOf(f.lastArchived) >= msOf(f.lastFailed)) return []
    return [
      finding(
        walArchiveFailing,
        'warning',
        null,
        `WAL archiving fails: the last attempt failed at ${isoOf(f.lastFailed)}${f.lastArchived === null ? ', and no segment was ever archived' : ` after the last success at ${isoOf(f.lastArchived)}`}. Backups and point-in-time recovery depend on it, and WAL piles up.`,
        "Read the server log for the archive command's error and fix the archive destination or its credentials.",
        {
          failedCount: f.failedCount,
          lastFailedAt: isoOf(f.lastFailed),
          lastArchivedAt: f.lastArchived === null ? null : isoOf(f.lastArchived),
        },
      ),
    ]
  },
}

const PENDING = sql`SELECT s.name::text AS name FROM pg_catalog.pg_settings s WHERE s.pending_restart ORDER BY 1 LIMIT $1`

export const settingsPendingRestart: AdvisorRule<{ name: string }[]> = {
  id: 'settings_pending_restart',
  category: 'operations',
  cap: RULE_FINDING_CAP,
  facts: (env) => rows(env, PENDING, [], (r) => ({ name: r.text('name') }), RULE_FINDING_CAP),
  evaluate: (facts) =>
    facts.map((f) =>
      finding(
        settingsPendingRestart,
        'info',
        `setting ${clip(f.name, 128)}`,
        'A changed setting takes effect only after a server restart; until then the server runs with the old value.',
        'Restart the server in a maintenance window (a planned postgres.restart on an agent-managed cluster), or revert the change.',
        {},
      ),
    ),
}

// ----- change safety (Control Store facts) -----

export const driftOpen: AdvisorRule<{ open: number; critical: number }> = {
  id: 'drift_open',
  category: 'change_safety',
  cap: 1,
  async facts(env) {
    const { rows: r } = await env.store.query(
      'observation.advisors.drift_open',
      `SELECT count(*)::int AS open, count(*) FILTER (WHERE severity = 'critical')::int AS critical
         FROM observation.findings WHERE target_id = $1 AND kind = 'drift' AND state = 'open'`,
      [env.target.targetId],
    )
    const row = r[0]
    if (row === undefined) return { skipped: 'error' }
    return { facts: { open: row.int('open'), critical: row.int('critical') }, complete: true }
  },
  evaluate: (f) =>
    f.open === 0
      ? []
      : [
          finding(
            driftOpen,
            f.critical > 0 ? 'critical' : 'warning',
            null,
            `The schema differs from what ExponetDB expects: ${f.open} open drift findings (${f.critical} critical), changes made outside the migration engine.`,
            'Review the drift findings; turn wanted changes into migrations or accept the drift, and revert the others through a migration.',
            { open: f.open, critical: f.critical },
          ),
        ],
}

export const stagingBehindProduction: AdvisorRule<{
  applicable: boolean
  evidencePath: string | null
  missing: number
  examples: string
}> = {
  id: 'staging_behind_production',
  category: 'change_safety',
  cap: 1,
  async facts(env) {
    const none = {
      facts: { applicable: false, evidencePath: null, missing: 0, examples: '' },
      complete: true,
    }
    if (env.target.tier !== 'prod') return none
    const environment = await getEnvironment(env.store, env.target.environmentId)
    if (environment === undefined) return { skipped: 'error' }
    if (environment.evidenceFrom === null) return none
    const evidence = await liveTargetOf(env.store, env.target.projectId, environment.evidenceFrom)
    if (evidence === undefined) return none
    // Comparable only when the mirror observed both ledgers and neither diverged.
    const { rows: r } = await env.store.query(
      'observation.advisors.staging_behind',
      `SELECT (SELECT count(*) FROM migrations.ledger_state s
                WHERE (s.target_id, s.generation) IN (($1, $2), ($3, $4)) AND NOT s.divergent)::int AS mirrored,
              (SELECT count(*) FROM migrations.ledger_mirror p
                WHERE p.target_id = $1 AND p.generation = $2 AND p.origin = 'exponetdb' AND p.reverted_at IS NULL
                  AND NOT EXISTS (SELECT 1 FROM migrations.ledger_mirror e
                                   WHERE e.target_id = $3 AND e.generation = $4 AND e.migration_id = p.migration_id
                                     AND e.reverted_at IS NULL))::int AS missing,
              (SELECT string_agg(x.migration_id, ', ') FROM (
                 SELECT p.migration_id FROM migrations.ledger_mirror p
                  WHERE p.target_id = $1 AND p.generation = $2 AND p.origin = 'exponetdb' AND p.reverted_at IS NULL
                    AND NOT EXISTS (SELECT 1 FROM migrations.ledger_mirror e
                                     WHERE e.target_id = $3 AND e.generation = $4 AND e.migration_id = p.migration_id
                                       AND e.reverted_at IS NULL)
                  ORDER BY p.applied_seq LIMIT 3) x) AS examples`,
      [env.target.targetId, env.target.generation, evidence.targetId, evidence.generation],
    )
    const row = r[0]
    if (row === undefined || row.int('mirrored') !== 2) return { skipped: 'error' }
    return {
      facts: {
        applicable: true,
        evidencePath: evidence.path,
        missing: row.int('missing'),
        examples: row.textOrNull('examples') ?? '',
      },
      complete: true,
    }
  },
  evaluate: (f) =>
    !f.applicable || f.missing === 0
      ? []
      : [
          finding(
            stagingBehindProduction,
            'warning',
            f.evidencePath === null ? null : `evidence target ${clip(f.evidencePath, 256)}`,
            `${f.missing} migrations applied on production are not applied on its evidence environment: the next migrations are tested on a schema production does not have.`,
            'Apply the missing migrations on the evidence environment (or reconcile its ledger) before the next production plan.',
            { missing: f.missing, examples: text(f.examples) },
          ),
        ],
}

/** The catalog, in evaluation order. */
export const ADVISOR_RULES: readonly AdvisorRule<never>[] = [
  rlsDisabledWithGrants,
  rlsEnabledWithoutPolicy,
  securityDefinerWithoutSearchPath,
  bypassrlsLoginRole,
  extensionInPublic,
  plaintextClientConnections,
  unindexedForeignKey,
  duplicateIndex,
  unusedIndex,
  tableWithoutPrimaryKey,
  multiplePermissivePolicies,
  xidAgeHigh,
  inactiveReplicationSlot,
  walArchiveFailing,
  settingsPendingRestart,
  driftOpen,
  stagingBehindProduction,
] as unknown as readonly AdvisorRule<never>[]

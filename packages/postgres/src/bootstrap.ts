import { SCRAM_VERIFIER } from '@exponetdb/kernel/hash'
import { type AccessRole, LEDGER_OWNER_ROLE, ROLE_NAMES } from './session.ts'
import { quoteIdent, quoteLiteral } from './sql.ts'

/**
 * Bootstrap SQL for ExponetDB's roles on a managed cluster
 * ([credentials-and-roles.md §2, §8](../../../exponetdb-docs/03-database-model/credentials-and-roles.md#2-exponetdbs-roles-on-a-managed-cluster),
 * [registry.md §2.2](../../../exponetdb-docs/02-control-plane/registry.md#22-external-cluster-no-agent)).
 *
 * The text is run by a person with the cluster's administrative tools (an
 * external cluster) or, later, by the node agent's role capability. It never
 * contains a password: either a SCRAM verifier the caller computed, or no
 * password at all, in which case the person sets it with psql's `\password`
 * (which sends a client-side verifier) and submits the same password once
 * through the write-only credential endpoint. ExponetDB never asks for, and
 * never needs, a superuser credential over the network (C-21).
 *
 * The roles carry no table privileges of their own:
 *
 * - observer: `pg_monitor`; reads catalogs and statistics; never rows;
 * - reader, verifier: `pg_read_all_data` and `BYPASSRLS` (complete reads,
 *   never writes); the verifier is read-only by role setting as well;
 * - operator: `pg_signal_backend`, `pg_monitor`;
 * - migrator: `SET`-only membership in the ledger owner (`INHERIT FALSE`),
 *   so it can create the `exponetdb` schema owned by the ledger owner and
 *   write the ledger, and nothing else; the same membership in each fit
 *   execution role of the projects on the cluster ({@link bootstrapScript},
 *   Wave 9);
 * - ledger owner: `NOLOGIN`, owns the `exponetdb` schema.
 */
export const LOGIN_ROLES: readonly AccessRole[] = [
  'observer',
  'reader',
  'verifier',
  'operator',
  'migrator',
]

export type RoleVerifiers = Partial<Readonly<Record<AccessRole, string>>>

const SETTINGS: Readonly<Record<AccessRole, readonly (readonly [string, string])[]>> = {
  observer: [
    ['default_transaction_read_only', 'on'],
    ['statement_timeout', '30s'],
    ['idle_in_transaction_session_timeout', '30s'],
  ],
  reader: [
    ['default_transaction_read_only', 'on'],
    ['idle_in_transaction_session_timeout', '30s'],
  ],
  verifier: [
    ['default_transaction_read_only', 'on'],
    ['search_path', ''],
    ['idle_in_transaction_session_timeout', '30s'],
  ],
  operator: [
    ['statement_timeout', '30s'],
    ['idle_in_transaction_session_timeout', '30s'],
  ],
  migrator: [['idle_in_transaction_session_timeout', '120s']],
}

const MEMBERSHIPS: Readonly<Record<AccessRole, readonly string[]>> = {
  observer: ['pg_monitor'],
  reader: ['pg_read_all_data'],
  verifier: ['pg_read_all_data'],
  operator: ['pg_signal_backend', 'pg_monitor'],
  migrator: [],
}

const CONNECTION_LIMITS: Readonly<Record<AccessRole, number>> = {
  observer: 8,
  reader: 8,
  verifier: 4,
  operator: 2,
  migrator: 2,
}

function verifierClause(role: AccessRole, verifiers: RoleVerifiers): string {
  const verifier = verifiers[role]
  if (verifier === undefined) {
    return ''
  }
  if (!SCRAM_VERIFIER.test(verifier)) {
    throw new Error('only SCRAM-SHA-256 verifiers are accepted, never a password')
  }
  return ` PASSWORD ${quoteLiteral(verifier)}`
}

/**
 * Cluster-level statements (roles, memberships, role settings), in order.
 * Each role is created with explicit attributes so that nothing is
 * inherited from a server default.
 */
export function clusterBootstrapStatements(verifiers: RoleVerifiers = {}): string[] {
  const out = [
    `CREATE ROLE ${quoteIdent(LEDGER_OWNER_ROLE)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
  ]
  for (const role of LOGIN_ROLES) {
    const name = quoteIdent(ROLE_NAMES[role])
    const bypass = role === 'reader' || role === 'verifier' ? 'BYPASSRLS' : 'NOBYPASSRLS'
    out.push(
      `CREATE ROLE ${name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION ${bypass} INHERIT CONNECTION LIMIT ${CONNECTION_LIMITS[role]}${verifierClause(role, verifiers)}`,
    )
    for (const member of MEMBERSHIPS[role]) {
      out.push(`GRANT ${quoteIdent(member)} TO ${name} WITH INHERIT TRUE, SET FALSE`)
    }
    for (const [setting, value] of SETTINGS[role]) {
      out.push(`ALTER ROLE ${name} SET ${setting} = ${quoteLiteral(value)}`)
    }
  }
  out.push(
    `GRANT ${quoteIdent(LEDGER_OWNER_ROLE)} TO ${quoteIdent(ROLE_NAMES.migrator)} WITH INHERIT FALSE, SET TRUE`,
  )
  return out
}

/** Statements that set or rotate the passwords of the login roles from verifiers only. */
export function passwordStatements(verifiers: RoleVerifiers): string[] {
  return LOGIN_ROLES.filter((r) => verifiers[r] !== undefined).map(
    (role) => `ALTER ROLE ${quoteIdent(ROLE_NAMES[role])}${verifierClause(role, verifiers)}`,
  )
}

/**
 * Per-database statements for one managed database: `CONNECT` for every
 * login role and `CREATE` for the ledger owner (it creates and owns the
 * `exponetdb` schema during `target.register`).
 */
export function databaseBootstrapStatements(database: string): string[] {
  const db = quoteIdent(database)
  return [
    `GRANT CONNECT ON DATABASE ${db} TO ${LOGIN_ROLES.map((r) => quoteIdent(ROLE_NAMES[r])).join(', ')}`,
    `GRANT CREATE ON DATABASE ${db} TO ${quoteIdent(LEDGER_OWNER_ROLE)}`,
  ]
}

/** Legacy ledgers whose tables the observer reads during an import (legacy-import.md §2). */
export type LegacyLedgerKind = 'supabase' | 'drizzle' | 'applied_migrations'

export const LEGACY_LEDGER_TABLES: Readonly<
  Record<LegacyLedgerKind, readonly [schema: string, table: string]>
> = {
  supabase: ['supabase_migrations', 'schema_migrations'],
  drizzle: ['drizzle', '__drizzle_migrations'],
  applied_migrations: ['public', 'applied_migrations'],
}

/** An execution role the migrator may `SET ROLE` into, from the registry. */
export interface BootstrapExecutionRole {
  readonly name: string
  /** A declared exception (ADR-0034) excuses its `BYPASSRLS` in an environment on this cluster. */
  readonly bypassRlsExcused: boolean
}

export interface BootstrapScriptOptions {
  /**
   * Execution roles of the projects on this cluster (alias maps and
   * environment bindings): granted to the migrator `WITH INHERIT FALSE,
   * SET TRUE`, each only if the role exists and is fit to be one.
   */
  readonly executionRoles?: readonly BootstrapExecutionRole[]
  /** Legacy ledgers the observer reads in each database, where they exist. */
  readonly legacyLedgers?: readonly LegacyLedgerKind[]
}

/** A DO block whose dollar-quote tag cannot occur in its body. */
function doBlock(body: string): string {
  let tag = 'exdb'
  for (let i = 1; body.includes(`$${tag}$`); i++) tag = `exdb${i}`
  return `DO $${tag}$\nBEGIN\n${body}\nEND\n$${tag}$;`
}

/** `CREATE ROLE` when the role is missing, else `ALTER ROLE` to the same attributes (never a password). */
function ensureRole(name: string, attributes: string): string {
  return doBlock(
    `  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = ${quoteLiteral(name)}) THEN
    CREATE ROLE ${quoteIdent(name)} ${attributes};
  ELSE
    ALTER ROLE ${quoteIdent(name)} ${attributes};
  END IF;`,
  )
}

/**
 * The grant of one execution role to the migrator, guarded by the checks
 * the planner applies to an execution role
 * ([credentials-and-roles.md §3](../../../exponetdb-docs/03-database-model/credentials-and-roles.md#3-execution-roles)):
 * a role that can log in, holds a privileged attribute (`BYPASSRLS` only
 * where a declared exception excuses it) or reaches a privileged,
 * predefined or ExponetDB role is never granted, so the script cannot give
 * the migrator a way into such a role outside a plan.
 */
function executionRoleGrant(role: BootstrapExecutionRole): string {
  const name = quoteLiteral(role.name)
  const bypass = role.bypassRlsExcused ? '' : ' OR r.rolbypassrls'
  return doBlock(
    `  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = ${name}) THEN
    RAISE NOTICE 'execution role % does not exist yet: create it, then run this script again', ${name};
  ELSIF EXISTS (SELECT FROM pg_catalog.pg_roles r WHERE r.rolname = ${name}
                   AND (r.rolcanlogin OR r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication${bypass}
                        OR EXISTS (SELECT FROM pg_catalog.pg_roles x
                                    WHERE x.oid <> r.oid AND pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
                                      AND (x.rolsuper OR x.rolcreaterole OR x.rolcreatedb OR x.rolreplication OR x.rolbypassrls
                                           OR x.rolname LIKE 'pg\\_%' OR x.rolname LIKE 'exponetdb\\_%')))) THEN
    RAISE WARNING 'execution role % is not granted: it can log in, holds a privileged attribute or reaches a protected role', ${name};
  ELSE
    GRANT ${quoteIdent(role.name)} TO ${quoteIdent(ROLE_NAMES.migrator)} WITH INHERIT FALSE, SET TRUE;
  END IF;`,
  )
}

/** A name as one psql argument (single quotes: no variable, no backquote command). */
function psqlArgument(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`
}

/**
 * psql's `\connect` to a database by name only: a conninfo string, so a name
 * with `=` or a URI prefix is never read as a connection string, and the
 * host, port and user of the current connection are reused.
 */
function connectTo(database: string): string {
  const conninfo = `dbname='${database.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
  return `\\connect -reuse-previous=on ${psqlArgument(conninfo)}`
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused on purpose
const NAME_REFUSED = /[\u0000-\u001f\u007f]/u

/**
 * The whole script for a person, with comments, for one cluster and its
 * managed databases. Idempotent (Wave 9 order A8): every statement is
 * guarded or converges, so the script is run again after a database is
 * added or an execution role is created, and leaves the same state.
 */
export function bootstrapScript(
  databases: readonly string[],
  options: BootstrapScriptOptions = {},
): string {
  for (const name of [...databases, ...(options.executionRoles ?? []).map((r) => r.name)]) {
    if (name === '' || NAME_REFUSED.test(name)) {
      throw new Error('a database or role name is not empty and has no control character')
    }
  }
  const lines = [
    '-- ExponetDB bootstrap for an external cluster. Run it with psql as an administrator;',
    '-- running it again is safe and converges (guarded statements).',
    '-- No password is in this script. After it ran, set each login password with',
    '-- psql \\password <role> (psql sends a SCRAM verifier, never the password) and',
    "-- submit the same password once through ExponetDB's write-only credential endpoint.",
    ensureRole(
      LEDGER_OWNER_ROLE,
      'NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
    ),
  ]
  for (const role of LOGIN_ROLES) {
    const name = ROLE_NAMES[role]
    const bypass = role === 'reader' || role === 'verifier' ? 'BYPASSRLS' : 'NOBYPASSRLS'
    lines.push(
      ensureRole(
        name,
        `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION ${bypass} INHERIT CONNECTION LIMIT ${CONNECTION_LIMITS[role]}`,
      ),
    )
    // A grant run again converges to the stated options (PostgreSQL 16+).
    for (const member of MEMBERSHIPS[role]) {
      lines.push(`GRANT ${quoteIdent(member)} TO ${quoteIdent(name)} WITH INHERIT TRUE, SET FALSE;`)
    }
    for (const [setting, value] of SETTINGS[role]) {
      lines.push(`ALTER ROLE ${quoteIdent(name)} SET ${setting} = ${quoteLiteral(value)};`)
    }
  }
  lines.push(
    `GRANT ${quoteIdent(LEDGER_OWNER_ROLE)} TO ${quoteIdent(ROLE_NAMES.migrator)} WITH INHERIT FALSE, SET TRUE;`,
  )
  const roles = [
    ...new Map((options.executionRoles ?? []).map((r) => [r.name, r] as const)).values(),
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  if (roles.length > 0) {
    lines.push(
      '-- Execution roles of the projects on this cluster (registry): the migrator may SET ROLE',
      '-- into each, never inherit it. A missing role is skipped with a notice, an unfit one',
      '-- with a warning; neither is granted.',
    )
    for (const role of roles) {
      if (role.name.startsWith('pg_') || role.name.startsWith('exponetdb_')) {
        throw new Error('a predefined or ExponetDB role is never an execution role')
      }
      lines.push(executionRoleGrant(role))
    }
  }
  for (const database of databases) {
    lines.push(`-- database ${database}`)
    lines.push(
      doBlock(
        `  IF EXISTS (SELECT FROM pg_catalog.pg_database WHERE datname = ${quoteLiteral(database)}) THEN
${databaseBootstrapStatements(database)
  .map((s) => `    ${s};`)
  .join('\n')}
  ELSE
    RAISE NOTICE 'database % does not exist yet: create it, then run this script again', ${quoteLiteral(database)};
  END IF;`,
      ),
    )
  }
  const ledgers = [...new Set(options.legacyLedgers ?? [])].sort()
  if (ledgers.length > 0 && databases.length > 0) {
    lines.push(
      '-- Legacy ledger read (psql only: it connects to each database). The observer reads',
      '-- the declared legacy ledgers during an import, where they exist; nothing else.',
    )
    for (const database of databases) {
      // psql drops double quotes from a \connect argument, whatever the quoting: such a name
      // would reach another database. Its ledger grants are left to a person, named here.
      if (database.includes('"')) {
        lines.push(
          `\\echo ${psqlArgument(`database ${database}: its name holds a double quote, which psql cannot connect to; grant the observer the ledger reads there by hand`)}`,
        )
        continue
      }
      // psql stops at a \connect that fails: a database that does not exist yet is skipped
      // with a message, like the database grants above, and the next one is handled.
      lines.push(
        `SELECT EXISTS (SELECT FROM pg_catalog.pg_database WHERE datname = ${quoteLiteral(database)}) AS exdb_database_exists \\gset`,
        '\\if :exdb_database_exists',
        connectTo(database),
      )
      // The grants run only in the database named: never in one a \connect reached instead.
      const here = `  IF pg_catalog.current_database() OPERATOR(pg_catalog.<>) ${quoteLiteral(database)} THEN
    RAISE EXCEPTION 'connected to database % instead of %: no ledger read granted', pg_catalog.current_database(), ${quoteLiteral(database)};
  END IF;`
      lines.push(
        doBlock(
          [
            here,
            ...ledgers.map((l) => {
              const [schema, table] = LEGACY_LEDGER_TABLES[l]
              const qualified = `${quoteIdent(schema)}.${quoteIdent(table)}`
              return `  IF pg_catalog.to_regclass(${quoteLiteral(qualified)}) IS NOT NULL THEN
    GRANT USAGE ON SCHEMA ${quoteIdent(schema)} TO ${quoteIdent(ROLE_NAMES.observer)};
    GRANT SELECT ON ${qualified} TO ${quoteIdent(ROLE_NAMES.observer)};
  END IF;`
            }),
          ].join('\n'),
        ),
        '\\else',
        `\\echo ${psqlArgument(`database ${database} does not exist yet: create it, then run this script again`)}`,
        '\\endif',
      )
    }
  }
  return `${lines.join('\n')}\n`
}

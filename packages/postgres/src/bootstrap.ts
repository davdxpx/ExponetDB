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
 *   write the ledger, and nothing else; execution roles are added per
 *   project in Wave 6;
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

/** The whole script for a person, with comments, for one cluster and its managed databases. */
export function bootstrapScript(databases: readonly string[]): string {
  const lines = [
    '-- ExponetDB bootstrap for an external cluster (run once as an administrator).',
    '-- No password is in this script. After it ran, set each login password with',
    '-- psql \\password <role> (psql sends a SCRAM verifier, never the password) and',
    "-- submit the same password once through ExponetDB's write-only credential endpoint.",
    ...clusterBootstrapStatements().map((s) => `${s};`),
  ]
  for (const database of databases) {
    lines.push(`-- database ${database.replace(/[\r\n]/g, ' ')}`)
    lines.push(...databaseBootstrapStatements(database).map((s) => `${s};`))
  }
  return `${lines.join('\n')}\n`
}

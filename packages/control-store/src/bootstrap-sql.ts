import {
  CONTROL_STORE_ROLES,
  type ControlStoreRole,
  ROLE_CONNECTION_LIMITS,
  RUNTIME_ROLES,
} from './roles.ts'
import { SCRAM_VERIFIER } from './scram.ts'

/**
 * Bootstrap SQL for an empty PostgreSQL 17 server
 * ([bootstrap.md §2](../../../exponetdb-docs/12-operations/bootstrap.md#2-control-store)).
 *
 * Run once by the bootstrap superuser (only during bootstrap, never by an
 * ExponetDB process). It creates the five login roles with SCRAM verifiers
 * (never passwords), the Control Store database owned by the superuser (so no
 * ExponetDB login can drop it), and the database-level grants. Everything
 * else (schemas, tables, grants on them) is the Control Store's own migration
 * bundles, applied by `exdb_migrate`.
 *
 * Re-running it is safe: existing roles keep their identity and get the new
 * verifier (password rotation), an existing database is kept.
 */
const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/

function checkDatabase(name: string): string {
  if (!DATABASE_NAME.test(name)) {
    throw new Error('database names are lowercase identifiers')
  }
  return `"${name}"`
}

export type RoleVerifiers = Readonly<Record<ControlStoreRole, string>>

/** Statements to run connected to the maintenance database (`postgres`): roles. */
export function rolesSql(verifiers: RoleVerifiers): string[] {
  const out: string[] = []
  for (const role of CONTROL_STORE_ROLES) {
    const verifier = verifiers[role]
    if (!SCRAM_VERIFIER.test(verifier)) {
      throw new Error(`not a SCRAM-SHA-256 verifier for ${role}`)
    }
    out.push(
      `DO $exdb$ BEGIN IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role}; END IF; END $exdb$`,
      `ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${ROLE_CONNECTION_LIMITS[role]} PASSWORD '${verifier}'`,
    )
  }
  return out
}

/** `CREATE DATABASE` (outside any transaction block). */
export function createDatabaseSql(database: string): string {
  return `CREATE DATABASE ${checkDatabase(database)} WITH TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`
}

/** Database-level privileges and per-role settings, run connected to the maintenance database. */
export function databaseGrantsSql(database: string): string[] {
  const db = checkDatabase(database)
  const out = [
    // PUBLIC gets nothing: no CONNECT, no TEMP, no CREATE.
    `REVOKE ALL ON DATABASE ${db} FROM PUBLIC`,
    `GRANT CONNECT, CREATE ON DATABASE ${db} TO exdb_migrate`,
    `GRANT CONNECT ON DATABASE ${db} TO ${[...RUNTIME_ROLES, 'exdb_audit_maint'].join(', ')}`,
  ]
  for (const role of CONTROL_STORE_ROLES) {
    // An empty search_path: every statement qualifies its objects, so no
    // schema can shadow another (search-path hijacking).
    out.push(`ALTER ROLE ${role} IN DATABASE ${db} SET search_path = ''`)
  }
  for (const role of [...RUNTIME_ROLES, 'exdb_audit_maint']) {
    out.push(`ALTER ROLE ${role} IN DATABASE ${db} SET idle_in_transaction_session_timeout = '60s'`)
  }
  return out
}

/** Statements to run connected to the new database. */
export function inDatabaseSql(): string[] {
  // The default `public` schema is not used; dropping it removes the last
  // place where a role could create objects by default.
  return ['DROP SCHEMA IF EXISTS public']
}

/** The whole bootstrap as one psql script (`psql -v ON_ERROR_STOP=1 -f bootstrap.sql`). */
export function bootstrapPsqlScript(database: string, verifiers: RoleVerifiers): string {
  const db = checkDatabase(database)
  const lines = [
    '-- ExponetDB Control Store bootstrap. Run as the bootstrap superuser, once:',
    '--   psql -v ON_ERROR_STOP=1 --dbname=postgres -f bootstrap.sql',
    '-- Contains SCRAM verifiers, never passwords. Do not commit this file.',
    '\\set ON_ERROR_STOP on',
    ...rolesSql(verifiers).map((s) => `${s};`),
    `SELECT 'CREATE DATABASE ${db} WITH TEMPLATE template0 ENCODING ''UTF8'' LC_COLLATE ''C'' LC_CTYPE ''C''' WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_database WHERE datname = '${database}') \\gexec`,
    ...databaseGrantsSql(database).map((s) => `${s};`),
    `\\connect ${db}`,
    ...inDatabaseSql().map((s) => `${s};`),
    '',
  ]
  return lines.join('\n')
}

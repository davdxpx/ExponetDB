import { sql, type TrustedSql } from './sql.ts'

/**
 * The session conditions shared between display and action
 * ([health.md §3](../../../exponetdb-docs/10-observability/health.md#3-named-conditions)):
 * the predicate that marks a session as "stalled" in the activity summary is
 * the one the terminate plan re-checks in its terminating statement, so "the
 * page says stalled" equals "the plan will accept it".
 *
 * Each builder takes the alias of a `pg_stat_activity` row (engine SQL,
 * never a caller's text) and returns a parenthesized boolean expression over
 * its base columns, evaluated with `clock_timestamp()` at the moment the
 * statement reads the row.
 */
export const STALLED_SECONDS = 60
/** `connections.terminate` condition `idle_in_transaction`: the transaction idles this long. */
export const TERMINATE_IDLE_IN_TRANSACTION_SECONDS = 60
/** `connections.terminate` condition `long_running`: the active query runs this long. */
export const TERMINATE_LONG_RUNNING_SECONDS = 300

/** `state = active`, `wait_event = ClientRead`, query age ≥ 60 s (health.md `stalled_sessions`). */
export function stalledSession(row: TrustedSql): TrustedSql {
  return sql`(${row}.state = 'active' AND ${row}.wait_event = 'ClientRead'
     AND ${row}.query_start <= pg_catalog.clock_timestamp() - interval '60 seconds')`
}

/** Idle in a transaction (also aborted) for at least 60 s. */
export function idleInTransactionSession(row: TrustedSql): TrustedSql {
  return sql`(${row}.state IN ('idle in transaction', 'idle in transaction (aborted)')
     AND ${row}.state_change <= pg_catalog.clock_timestamp() - interval '60 seconds')`
}

/** Active with a query that started at least 300 s ago. */
export function longRunningSession(row: TrustedSql): TrustedSql {
  return sql`(${row}.state = 'active'
     AND ${row}.query_start <= pg_catalog.clock_timestamp() - interval '300 seconds')`
}

/**
 * Sessions ExponetDB never signals, whoever asks (policy
 * `connections.replication-protect`, `connections.no-superuser-terminate`;
 * performance.md §5): anything that is not a client backend (walsenders,
 * autovacuum, background workers), ExponetDB's own roles and sessions,
 * superuser sessions, and backup tools by their application name. Kept as
 * one expression so planning, the policy facts and the signaling statement
 * agree.
 */
export function protectedSession(row: TrustedSql): TrustedSql {
  return sql`(${row}.backend_type IS DISTINCT FROM 'client backend'
     OR ${row}.usename::text LIKE 'exponetdb\\_%'
     OR coalesce(${row}.application_name, '') LIKE 'exponetdb/%'
     OR coalesce(${row}.application_name, '') ~* '(pgbackrest|pg_basebackup|pg_dump|pg_dumpall|pg_restore|barman|wal-g|walg|pg_receivewal)'
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.oid = ${row}.usesysid AND r.rolsuper))`
}

/**
 * Why a session is protected (`null`: it is not), in the order the policy
 * reports it; the same tests as {@link protectedSession}.
 */
export function protectionReason(row: TrustedSql): TrustedSql {
  return sql`(CASE
     WHEN ${row}.backend_type IS DISTINCT FROM 'client backend' THEN 'not_client_backend'
     WHEN ${row}.usename::text LIKE 'exponetdb\\_%' OR coalesce(${row}.application_name, '') LIKE 'exponetdb/%' THEN 'exponetdb_session'
     WHEN coalesce(${row}.application_name, '') ~* '(pgbackrest|pg_basebackup|pg_dump|pg_dumpall|pg_restore|barman|wal-g|walg|pg_receivewal)' THEN 'backup_session'
     WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.oid = ${row}.usesysid AND r.rolsuper) THEN 'superuser_session'
     ELSE NULL END)`
}

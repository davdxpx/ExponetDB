# @exponetdb/control-store

The only persistence boundary for ExponetDB's own Control Store
([control-database.md](../../exponetdb-docs/02-control-plane/control-database.md)).
It is not a repository layer: domain packages (`audit`, `secrets`,
`operations`) write their own SQL through its transaction API.

## Owns

| Module | What |
|---|---|
| `store.ts` | one `pg` pool per process role and login; `query`, `transaction` (explicit `Tx` handle shared by packages, unusable after the transaction ends, savepoints instead of nesting, `rollbackOnly` for verification), `session` (dedicated connection, `DISCARD ALL` afterwards), `isolated` (new connection, closed afterwards); static query classes label the duration metric and trace span; `verifyLogin` refuses a login that is not the expected role or holds superuser, CREATEROLE, CREATEDB, REPLICATION, BYPASSRLS or any membership |
| `errors.ts` | driver errors become `ControlStoreError` (code + SQLSTATE, constant message) |
| `rows.ts` | typed, checked access to result rows (no casts on database data) |
| `roles.ts` | the five logins `exdb_migrate`, `exdb_serve`, `exdb_worker`, `exdb_gateway`, `exdb_audit_maint` and their connection limits |
| `scram.ts` | SCRAM-SHA-256 verifiers in PostgreSQL's stored form (bit-identical to PostgreSQL's own, proven in `roles.int.test.ts`), CSPRNG passwords |
| `bootstrap-sql.ts` | bootstrap SQL for an empty server: roles with verifiers, the database owned by the bootstrap superuser, database grants, empty `search_path` per role, no `public` schema |
| `bundles.ts` | loads the shipped bundles (`migrations/`) with the frozen `migrations/format` code and orders them with `migrations/graph` |
| `runner.ts`, `verify.ts`, `ledger.ts`, `installation.ts` | `exponetdb control-store migrate`: session advisory lock, DAG-ordered apply with the ledger row in the same transaction, installation marker, separate read-only verification, schema compatibility (`compareSchema`) |
| `locks.ts` | advisory lock keys in the `EXDB` namespace |
| `heartbeats.ts`, `maintenance.ts` | process heartbeats (row-level security per role), maintenance task leases (`FOR UPDATE SKIP LOCKED`) |
| `testing/` (subpath `@exponetdb/control-store/testing`) | integration test harness: real PostgreSQL 17 from `EXDB_TEST_PG_URL`, production bootstrap SQL, a fresh database per suite; never imported by product code (boundary rule) |
| `migrations/` | the Control Store's own bundles and `exponetdb.project.yaml` |

## Does not own

Business decisions, target (managed) PostgreSQL connections (Wave 4,
`packages/postgres`), authentication, the audit chain, envelope encryption,
the operation state machine.

## Allowed dependencies

`@exponetdb/kernel`, `@exponetdb/observability`, `@exponetdb/migrations`
(`format`, `graph`), `@exponetdb/contracts` (reached through `format`), `pg`.
Never `operations`, `audit`, `secrets`, `policy` (they depend on it).

## Security properties

- Every statement is parameterized; identifiers are never built from input.
  The only multi-statement execution (`Tx.executeScript`) is used by the
  runner for shipped, reviewed bundles.
- No login used by ExponetDB is a superuser or can create roles or
  databases; the database is not owned by any ExponetDB login; `PUBLIC` has
  no privilege on the database, its schemas, tables or functions.
- Append-only tables (installation marker, ledger, verification history)
  refuse `UPDATE`, `DELETE` and `TRUNCATE` by trigger for every role, the
  owner included.

## Failure behavior

Unreachable store: `control_store_unavailable`, never an empty result. A
lost connection fails the transaction; nothing is committed; the pool
replaces the connection. A failed `COMMIT` surfaces as an error (outcome
unknown to the caller, which re-reads). The runner refuses a checksum
mismatch, a newer schema, an inconsistent ledger and any login but
`exdb_migrate`; a failed `up.sql` is rolled back completely; a failed
verification after commit is never answered by re-running `up.sql`.

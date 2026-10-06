# REOSA: measured state of the first consumer

| | |
|---|---|
| Status | Audit result (Wave 0), 2026-10-04 |
| Source | read-only REOSA repository `davdxpx/REOSA` at commit `f09a302e` (shallow clone; oldest visible commit 2026-09-08) |
| Method | files read directly; analysis scripts; REOSA's own read-only validators run at HEAD; **full replay of all migrations on PGlite 0.4.5** (PostgreSQL 17.5 in WASM with `vector` 0.8.1 and `pg_trgm` 1.6, the engine REOSA's tests use). Nothing in REOSA was changed. |
| Used by | [`../04-migrations/legacy-import.md`](../04-migrations/legacy-import.md), [`reosa-integration.md`](./reosa-integration.md), the design of the migration engine, health model and backups |

Labels in this document: **OBSERVED** (read or measured in the repository),
**DOC** (stated in REOSA documents, not verified against a live database),
**INFERRED** (reasoning from code and upstream behavior). In the terms of the
docs index, DOC and INFERRED are `[ASSUMPTION]`s until measured live.

## Summary

| Metric | Value | Label |
|---|---|---|
| SQL migration files | **454** (45,182 lines; median 59 lines, largest 1,276) | OBSERVED |
| Distinct numeric prefixes | 377 (`0000` to `0376`, no gaps) | OBSERVED |
| Prefixes used more than once | **60**, covering **137 files** (46 doubles, 11 triples, 3 quadruples) | OBSERVED |
| Drizzle journal coverage | 233 of 454 files; 221 files not in the journal | OBSERVED |
| Drizzle snapshots | 1 snapshot with 4 tables, against 408 tables in the TypeScript schema | OBSERVED |
| Ways to apply migrations | 5 executors, 3 ledger tables, plus "no ledger" | OBSERVED |
| Fresh replay in file-name order | 454/454 apply: 408 tables + 5 partitions, 383 policies, 110 functions, 36 views, 104 triggers, 1,372 indexes, 892 foreign keys, 773 check constraints, 0 enums, 5,702 columns | OBSERVED |
| Fresh replay in journal order | fails at entry 0; 26 of 233 entries fail even with continue-on-error | OBSERVED |
| Second full run on a migrated database | 17 files fail; the "successful" re-runs **resurrect 7 tables** renamed away by `0045`, with 7 policies and 26 indexes | OBSERVED |
| File name ≠ applied name | at least 14 cases in the repository; docs say about a quarter of names differ; 55 of 294 unmatched on 2026-09-13 | OBSERVED + DOC |
| Staging-first enforcement in code | none | OBSERVED |
| Collision checker for migration numbers | none | OBSERVED |
| Growth | 166 files (2026-07-29) → 454 (2026-10-04), about 4 files per day | DOC + OBSERVED |

These numbers are why ExponetDB uses ULID identities, a DAG, content-bound
checksums over executable text, object-level verification and an importer that
treats prose as hints only.

## Databases and environments

| Database (Supabase project) | Role | Notes | Label |
|---|---|---|---|
| `reosa-production` | production, real customer data | migration ledger `supabase_migrations.schema_migrations` starts at `0020`; one policy (`tenant_members_select_own`) still uses `auth.uid()` because the `0014` fix was never applied there | DOC |
| `reosa-staging` | staging (created 2026-07-31) | every migration applied immediately after writing | DOC |
| `reosa-production2` | paused backup, "do not touch" | | DOC |
| `reosa-status` | status page database, separate project | takes a **hand-picked subset** of global migrations; two lists disagree (13 files vs 7); agent sessions have no access | OBSERVED + DOC |

The same `status_*` tables also exist in the platform database (from migrations
`0008` to `0012`), so a misconfigured URL "succeeds in the wrong place".

Planned: move to self-hosted PostgreSQL 17 on `reos-db-01` (`10.8.1.2`, private
network) with production and staging on the same host as separate databases
(DOC, handbook 4, "not measured on the device").

## Migration flows

Five executors disagree on selection, ordering, splitting, transactions and
ledger (OBSERVED):

| # | Executor | Selects | Order | Transaction | Ledger | Used for |
|---|---|---|---|---|---|---|
| F1 | `bun db:migrate` (Drizzle `migrate()`) | journal only (233 of 454) | journal `when` | all pending in one transaction (INFERRED) | `drizzle.__drizzle_migrations` | nothing current; docs warn against it |
| F2 | Supabase MCP `apply_migration` | one file chosen by a human or agent | manual | whole file | `supabase_migrations.schema_migrations`, keyed by the **name given at apply time** | **the real path for staging and production** |
| F3 | `bun db:apply-all` (`tooling/scripts/apply-migrations.sh`) | all files | shell glob order | one transaction per file, `ON_ERROR_STOP` | `public.applied_migrations(filename)` | local development, building staging from zero |
| F4 | PGlite unit tests | hand-curated list of 292 tags | hand order with 30 justified inversions | none, split on breakpoints | none (template cache keyed by SHA-256 over the chain) | CI tests of `@reosa/db` |
| F5 | full-history replays (`db:restore-test`, embedding-pipeline tests) | all files | sorted names | none | none | manual only, **not in CI** |

Module migrations: 94 files in 10 modules are copied byte-identically from
`apps/app/src/modules/<id>/db/migrations/` into the global directory by
`sync-module-migrations.ts`, which also edits the Drizzle journal; two journal
`when` values differ from their manifests (OBSERVED). A module migration has
**three identities**: module-local file, global tag, applied name.

The `supabase/` folder has no migrations directory; the Supabase CLI migration
flow is unused (OBSERVED).

## Ledgers

| Ledger | Where | Key | Checksum | State |
|---|---|---|---|---|
| `supabase_migrations.schema_migrations` | staging, production | name passed by the operator | none known | production starts at `0020`; 288 entries vs 294 files on 2026-09-13 (DOC) |
| `drizzle.__drizzle_migrations` | possibly staging and production (historical) | `created_at` = journal `when` | SHA-256 of file content, never re-verified (INFERRED) | unknown |
| `public.applied_migrations` | local databases, databases built by F3 | file name | none | needs manual pre-seeding for databases migrated otherwise (DOC) |
| prose | migration headers, commit messages, `lead-log.md` | text | none | 12 headers say "applied"; contradictions exist (one header says both "not yet applied anywhere" and "already applied") |

No ledger is canonical. The effect of `0014` is missing in production without
any ledger recording it.

## Numbering and collisions

**OBSERVED.** 454 files, 377 distinct prefixes, **60 prefixes duplicated across
137 files**. Quadruples: `0162`, `0284`, `0357`. Triples: `0243`, `0258`, `0290`,
`0291`, `0292`, `0293`, `0294`, `0295`, `0296`, `0343`, `0358`. Doubles: 46,
clustering in the recent ranges (0284 to 0301 alone account for 17 prefixes),
which matches the period of heavy parallel branch work (35 branches had `main`
merged into them within 26 days).

How names diverge: each branch takes "the next free number"; rules say to apply
to staging (and to production when additive) **immediately**; when the branch
merges and the number is taken, the **file** is renumbered but the **ledger
keeps the old name**. Documented cases:

| File today | Applied name |
|---|---|
| `0260_task_sync_runs` | `0252_task_sync_runs` (file went 0252 → 0256 → 0260) |
| `0261_notifications_delivered_at` | `0253_notifications_delivered_at` |
| `0262_tasks_service_wave2` | `0258_tasks_service_wave2` |
| `0263_notifications_model` | `0259_notifications_model` |
| `0272_status_subscriber_severities` | `0252_status_subscriber_severities` (0252 → 0258 → 0270 → 0272) |
| `0274_status_subscriber_webhook` | `0260_status_subscriber_webhook` |
| `0373_mail_fetcher` | `0366_mail_fetcher` |
| `0368_…` to `0371_…` | `0362_…` to `0365_…` (recorded only in a commit message) |
| `0197`, `0198`, `0200` (optimizer) | `0196`, `0197`, `0199` |
| `0047_agent_projects` | `0045_agent_projects` |
| `0023_runs_webhooks_jobs_storage` | no number |
| `0032` to `0036` (5 files) | one entry `0032_0036_lead_columns_backfill_on_renamed_tables` |
| `0059_address_sync` | `0056_address_sync` |

On 2026-10-01, five already-applied files were renamed and their **comments**
edited after apply (commits `44354ed2`, `f0e95b2a`, `58de20b4`); the executable
statements were unchanged. This is why ExponetDB's apply checksum covers
normalized executable text and not raw bytes
([ADR-0009](../01-architecture/adr/0009-checksum-semantics.md)).

Order sensitivity: 23 functions are defined in more than one file, 22 of them
with different bodies, so the final body depends on apply order (OBSERVED).
Statements in REOSA's own documents are stale: "numbered sequentially, never
renumbered" (README), "21 numbers are duplicated" (test setup; measured 60),
"212 migrations" (README header; measured 454).

## Journal vs files

- 221 of 454 files are not in the Drizzle journal; module files are all in it,
  hand-written global files only 139 of 360. The gap grows over time.
- Journal integrity defects (OBSERVED): two entries with `idx 221` after a hand
  edit; 12 numeric-order inversions; the first entry is `0014` before `0000`.
- Replaying the journal order fails at entry 0 (`relation "tenant_members"
  does not exist`); the result has 215 tables instead of 413 and 140 tables
  without a `service_role` grant. Since Drizzle runs all pending migrations in
  one transaction (INFERRED), `bun db:migrate` on an empty database applies
  nothing.

## Hand-written vs generated

- Exactly one file looks Drizzle-generated (`0000_short_iron_monger.sql`), and
  it was hand-edited (`IF NOT EXISTS`). 453 of 454 files contain comments.
- `--> statement-breakpoint` appears in 307 files (4,148 markers) because
  hand-written files kept the convention.
- The only Drizzle snapshot covers 4 of 408 tables; `drizzle-kit generate` is
  unusable, although several documents still advertise it.
- "Source of truth" is contradictory in REOSA's docs ("Drizzle as schema truth"
  vs SQL files as truth). In practice SQL defines the database and TypeScript
  defines the queries; drift surfaces as `42703` (undefined column) at runtime.
- Table-name parity between the replay and the TypeScript schema is exact (408 =
  408); column parity is checked by no tool.

## Idempotency

The convention is "migrations are always idempotent, so re-running is
collision-free" (DOC). Measured (OBSERVED):

| Pattern | Count |
|---|---|
| `CREATE TABLE … IF NOT EXISTS` | 410 of 411 |
| `CREATE INDEX … IF NOT EXISTS` | 924 of 924 |
| `ADD COLUMN IF NOT EXISTS` | 458 of 460 |
| `CREATE POLICY` / `DROP POLICY IF EXISTS` | 399 / 369 |
| `DO $$` guard blocks | 181 in 111 files (branching on `pg_roles` in 37 files, `to_regclass` in 17) |
| `CONCURRENTLY`, `BEGIN`/`COMMIT`, `lock_timeout`, `statement_timeout`, advisory locks | **0** each |

10 files are statically not re-runnable; a second full run fails on 17 and
silently recreates objects renamed by later migrations. **Idempotency is not a
safety net**; ExponetDB never re-executes applied bundles and decides "already
applied" from ledger and fingerprint
([`../04-migrations/failure-and-recovery.md`](../04-migrations/failure-and-recovery.md)).

## Grants, RLS and policies

Static counts over migrations (OBSERVED): `ENABLE ROW LEVEL SECURITY` 397,
`FORCE ROW LEVEL SECURITY` 77, `CREATE POLICY` 399, `GRANT` 548 (483 on tables,
53 on functions), `REVOKE` 449, dynamic grants in 34 files,
`ALTER DEFAULT PRIVILEGES` 2, `SECURITY DEFINER` 55 with `SET search_path` 133.

End state after replay (OBSERVED):

- 82 tables with FORCE RLS; **12 relations without RLS** (5 event partitions,
  `loops`, 5 `status_*` tables, `user_preferences`); **132 tables with RLS and no
  policy** (service-role-only by design).
- 383 policies; 332 reference `current_tenant_id()`, 0 reference `auth.uid()`;
  6 restrictive.
- `service_role` has `SELECT` on all 413 relations; `authenticated` lacks it on
  116. **Column-level privileges are used** (`website_renderer` has 133 column
  grants).
- 110 own functions, 44 of them `SECURITY DEFINER`.

RLS model: `current_tenant_id()` reads the setting `app.tenant_id`; REOSA's
`withTenant` sets `role = authenticated`, the tenant id and timeouts in one
setup statement per transaction. Tenant isolation does **not** depend on
Supabase Auth.

Environment divergence (DOC): on 2026-08-01 staging and production had the same
migrations but opposite effective grants (64 of 194 vs 189 of 191 tables
readable by `authenticated`), caused solely by default ACLs; on 2026-09-14
production had 286 tables and 343 policies, staging 289 and 345. Security state
is half the schema, and environments drifted on exactly that half.

## Roles

| Group | Roles | Created by |
|---|---|---|
| Bootstrap | `service_role` (NOLOGIN, BYPASSRLS), `authenticated`, `anon`, `platform_admin` (not BYPASSRLS) | `packages/db/roles/0000_bootstrap_roles.sql` (not a migration; also a different inline copy in a test setup) |
| From migrations | `agent_master`, `agent_cost_watch`, `agent_codegen`, `website_renderer`, `consent_writer` (created twice), `sales_reader`, `case_study_reader`, `team_reader` | 9 `CREATE ROLE` in 7 files, all NOLOGIN, guarded |
| Login roles | `website_renderer_login`, `consent_writer_login`, `sales_login` | owner, manually, with passwords; outside migrations |
| Phantom | `agent_role_admin` | referenced conditionally by policies, never created; whether those policies exist depends on the environment |
| Memberships | `case_study_reader` and `team_reader` granted to `consent_writer` | migrations |
| Role settings | `ALTER ROLE postgres SET idle_in_transaction_session_timeout = '60s'` | migration `0265` (cluster-level setting inside a database migration) |

Role names are hard-coded in function bodies (8 files compare
`current_setting('role')` with literal names). Role names of a consumer are API.

The planned self-hosted setup (handbook 4) creates `anon`, `authenticated`,
`service_role`, `reosa_app` and `supabase_auth_admin`, but **not**
`platform_admin`, the nine migration roles or the login roles (OBSERVED in the
handbook text); policies `TO website_renderer` cannot be restored without them
(INFERRED). The documented restore uses `pg_dump --no-owner --no-privileges`
and states "privileges come from the migrations", which leaves table and column
grants missing and `SECURITY DEFINER` functions executable by `PUBLIC` after a
restore (INFERRED from PostgreSQL defaults).

## Extensions, pgvector and schemas

- Extensions used: `vector` (`0004_pgvector.sql`) and `pg_trgm` (created five
  times, never with `WITH SCHEMA`, so into `public` on a fresh build). No
  migration creates `pgcrypto`, `uuid-ossp`, `pg_cron`, `pg_net`,
  `pg_stat_statements`, vault or pgsodium (`validate:portability` forbids the
  Supabase-specific ones). `pg_stat_statements` is nevertheless enabled by the
  hosted provider on `reosa-production`: REOSA's performance measurements read
  it, cumulative since 2026-07-02 (`reosa-docs/09-operations/build-performance.md`).
- pgvector: three `vector(1024)` tables and one HNSW cosine index (OBSERVED).
  On Supabase the extensions live in the `extensions` schema (DOC), so a
  `public`-only dump probably references `extensions.vector`, which a restore that
  creates extensions in `public` cannot resolve (INFERRED).
- Schemas: `CREATE SCHEMA` in migrations = 0. Everything lives in `public`
  (including `status_*`); `auth` exists as a stub in the bootstrap file for
  replays and as GoTrue's schema on Supabase. Implicit: `drizzle`,
  `supabase_migrations`.
- Partitions: `0002_events.sql` creates partitions relative to **today's date**,
  so a replay's result is date-dependent.

## Destructive, non-transactional and data-changing statements

OBSERVED: `DROP TABLE` 2 (one with a hand-written "refuse if rows exist"
pre-flight), `DROP COLUMN` 7, table renames 7 in one file (33 `RENAME TO`),
`DROP INDEX` 4, `DROP FUNCTION` 1 (return-type change), `SET NOT NULL` 1,
`ALTER COLUMN TYPE` 2, 182 `DROP CONSTRAINT IF EXISTS` (check constraints are
evolved by drop and re-add because there are no enums), top-level `UPDATE` 17,
`INSERT` 23, `DELETE` 2, more backfills inside `DO` blocks. Non-transactional
statements: none today, which is likely why no executor needed them.

## Validators and CI

| Validator | Enforces | CI | Notes |
|---|---|---|---|
| `validate:grants` | tables after `0171` get a grant somewhere | yes | regex; ignores revokes, dynamic SQL, order |
| `validate:rls` | tenant tables have RLS enabled somewhere | yes | does not check policies exist |
| `validate:portability` | no `auth.*` usage in SQL and `packages/db`, `@supabase/*` only in the adapter, no vendor extensions | yes | does not scan `apps/*` for raw `auth.*` SQL (by design) |
| `validate:doc-migrations` | migration names in docs resolve | yes | |
| `sync:module-migrations --check` | module copies in sync | **no** (header claims CI) | |
| `db:restore-test` | full history applies on an empty instance | **no** (a doc claims it breaks CI) | |
| PGlite tests | behavior of 292 curated migrations | yes | 111 files never named in tests |

Missing entirely: duplicate-prefix check, journal integrity check, double-apply
check, compatibility classification check, any check against a live database,
staging-before-production gate, ledger-vs-repository drift check, column parity
check. REOSA's CI has run nothing since 2026-09-07 because its self-hosted
runner is offline (DOC).

## Staging and production rules

DOC (`.claude/rules/migrations.md`):

1. Staging: every migration applied immediately after writing, then verified.
2. Production: applied immediately too **if compatible with the running older
   build** (additive), one at a time, verified; "no batch runs".
3. Not compatible (drop/rename, `NOT NULL` without default, narrowed
   constraints, RLS changes that empty old queries): staging only; production
   after the deploy, marked in the PR.
4. Procedure: check state with `execute_sql`, `apply_migration(name)`, verify
   objects, RLS flags, policy counts and `get_advisors(security)`.

Compatibility is judged by reading the SQL; the classification lives in German
prose in headers (247 of 454 files). Staging-first is enforced by convention
only. ExponetDB turns these rules into engine policy
([`../04-migrations/staging-production-policy.md`](../04-migrations/staging-production-policy.md));
the **classification of a REOSA migration stays REOSA's decision**, declared in
the manifest and checked by ExponetDB's analysis.

## Drift detection today

Manual: compare all files against `list_migrations` and then verify objects
(tables, columns, indexes, policies, grants including column privileges),
because "name matches prove nothing" (DOC). Documented cases: two merged
migrations missing in production not at the end of the sequence (2026-07-30,
hidden by fail-soft code); 294 files vs 288 entries with 55 unmatched
(2026-09-13); the missing `0014` effect (2026-09-15). A helper script that reads
core tables and policies exists but is not wired to anything.

## Fail-soft code that hides missing migrations

OBSERVED: identity mirroring catches all errors and logs (hid the missing
`0159`); a public navigation query catches `42501`/`42703` and falls back
(hid a missing column grant from `0140`); status reads return fallbacks on any
error; status probes select explicit column subsets to survive schema lag;
REOSA's own design rule for the status database is "every new query
fail-soft". 7 non-test files mention `42703`, 14 mention `42501`. REOSA's rule
"fail-soft needs a cross-check" is prose. ExponetDB answers with the runtime
schema contract ([`../04-migrations/authoring-and-ci.md`](../04-migrations/authoring-and-ci.md#8-runtime-schema-contract)).

## Connections and diagnostics

| Item | State | Label |
|---|---|---|
| Driver | postgres.js 3.4.9 + Drizzle; `prepare: false`; pipelining disabled through a patch after the 2026-09-24 outage | OBSERVED |
| Pools | request pool 10 per process, background pool 3, one control connection for rescue | OBSERVED |
| Guardrails | per-transaction budgets; `SET LOCAL statement_timeout` (≤ 120 s), `lock_timeout` (≤ 10 s), `idle_in_transaction_session_timeout`; stale-transaction detection; pool fuse | OBSERVED |
| TLS | **no `ssl` option** in the client and no `sslmode` in any template; REOSA's own status document records plaintext over the internet as a finding | OBSERVED + DOC |
| Login role | Supabase `postgres` for app, admin, auth, API, worker; restricted logins for sites, marketing and sales | OBSERVED |
| Paths | runtime via the transaction pooler (6543), migrations via the session pooler (5432), `pg_dump` via the direct host | OBSERVED |
| Reaper | two in-app reapers (console and worker) terminate own-role sessions stuck in `ClientRead` for ≥ 60 s, every 30 s; history in `db_backend_reaps` | OBSERVED |
| Health | `select 1`, 1,500 ms, memoized 5 s; stayed green during the 2026-09-24 outage | OBSERVED |

Incident chain (DOC, from code comments): session-pooler cap exhausted
(2026-07-07); unbounded transactions leaving orphans in the pooler (2026-09-05);
8-minute idle-in-transaction (2026-09-12); dashboard 504s waiting for
connections (2026-09-15); the pool fuse killing the pool on short card timeouts
(2026-09-21); parameterized queries hanging up to an hour while health stayed
green (2026-09-24).

Environment variables (OBSERVED): `DATABASE_URL` (all apps; status app points
to the separate project), `DATABASE_REPLICA_URL` (validated in admin, **read by
no code**), `REOS_ADMIN_STATUS_DATABASE_URL` (status project; value missing on
2026-09-23 per DOC), `REOS_SALES_DATABASE_URL` (restricted `sales_login` with a
runtime check that it is not superuser or BYPASSRLS), `DIRECT_URL` (no code),
test URLs.

## `/status/database` today

A platform-admin page (`apps/admin/src/app/(console)/status/database/page.tsx`)
built after the 2026-09-24 outage. It answers, in incident order: which path
reaches the database, whether it answers on the path every page uses (simple
and extended-protocol probes through the console pool), and whether anything is
stuck (sessions from a separate diagnostic connection with conditions:
stalled, waiting, long-running, idle in transaction; per role/application
usage; reaper history). It renders failed reads explicitly and never as "nothing
stuck" (tested). A terminate action (`db.backend.terminate`) binds `pid` and
`backend_start` and re-checks own role.

Not shown anywhere (OBSERVED by absence): locks and blocking trees,
replication, sizes, `pg_stat_statements`, vacuum, WAL and checkpoints,
transaction ID age, cache hit rate, TLS state, backup status.

Gaps (INFERRED): reaper history can be silently incomplete; reaper liveness is
asserted, not measured; the path shown is the console's own connection only;
unknown hosts are labeled "self-hosted, ok"; snapshot truncation is silent;
diagnosing uses the pool under diagnosis; per-transaction `application_name`
tags make grouping useless; the terminate action itself runs through the pool
that may be hanging and does not re-check the condition in the final
statement.

ExponetDB adopts the incident-order structure, the dual probe, the separate
diagnostic connection and the "failed read is not empty" rule, and closes the
gaps ([`../10-observability/health.md`](../10-observability/health.md)).

## Backup and restore

| Source | RPO | RTO | Drills | Label |
|---|---|---|---|---|
| `backup-and-disaster-recovery.md` | 1 h | 4 h | every 6 months | DOC |
| `backup-and-dr.md` | 5 min (PITR) | 30 min | quarterly | DOC |

Two documents promise different targets. Supabase plan tier and PITR status are
not verifiable from the repository (tasks to upgrade and enable PITR are
unchecked). A weekly own `pg_dump` script (handbook 3) has two defects as
written (pooler URL for `pg_dump`; client 16 against server 17) and is not
measured. "RTO documented, never exercised" (REOSA's quality baseline). The
console has a well-designed restore **drill checklist** (throwaway-target
confirmation, disposal confirmation, verified-at timestamp, findings for
overdue drills) but cannot execute restores. The planned self-hosted setup
(daily host backups + daily dumps + WAL archive on the same host) gives about
24 h RPO when the host is lost (INFERRED); neither promised RPO is reachable with
it. ExponetDB's backup design responds to each point
([`../09-backups-and-restore/architecture.md`](../09-backups-and-restore/architecture.md)).

## Auth dependencies

- Supabase Auth (GoTrue) today; near-term plan: self-host GoTrue at exactly the
  same version with the same JWT secret and the `auth` schema in a separate
  dump; owner goal: REOSA's own auth without Supabase (DOC).
- Foreign keys into `auth`: 0. `auth.uid()` in policies: 1 statement in history
  (`0013`, replaced by `0014`), still live in production.
- **Raw SQL from apps into `auth.*`** (OBSERVED, about 10 files in `apps/app` and
  `apps/admin`): `UPDATE auth.users SET banned_until`, `SELECT/DELETE
  auth.sessions`, `SELECT/DELETE auth.mfa_factors`. The planned new login role
  has no privileges on `auth.*`, so these features would break after the move
  (INFERRED).
- Mirrors in `public`: `users` (id = auth id, no FK), `user_identities`,
  `user_second_factors`.
- Many paths assume the login role bypasses RLS (82 tables with FORCE RLS after a full replay,
  mostly without policies, read through the "service connection"). Today the
  login role is Supabase's `postgres` (BYPASSRLS per DOC); the planned
  `reosa_app` has no BYPASSRLS, which would turn these reads into silent empty
  results (INFERRED).

ExponetDB's role in this: verify and grant what the consumer needs (role desired
state, privileges on a foreign-owned schema), never run or migrate GoTrue and
never hold Supabase API keys or JWT secrets.

## Supabase Edge Functions

**OBSERVED: three functions** (not two, as REOSA's portability document says) in
`supabase/functions/`:

| Function | Lines | Purpose | Database access |
|---|---|---|---|
| `reset-password-complete` | 125 | set a new password after REOSA's own reset code was verified; revoke sessions | none |
| `managed-account-admin` | 565 | owner/admin management of workspace-provisioned staff accounts (create, set email/password, revoke sessions, factory reset, reassign, delete) | PostgREST with the service-role key: `tenant_members`, `users`, `custom_roles`, `user_preferences`, nulling `*_by` columns in six tables, RPC `claim_member_seat` |
| `email-change-revert` | 201 | restore the previous e-mail after a disputed change; revoke sessions | `users` update |

All three: Deno, `supabase-js` from `esm.sh` (so the portability validator's
import pattern does not match), `verify_jwt = false`, authorized by short-lived
HMAC tickets (60 to 300 s), calling the GoTrue Admin API with the service-role
key. They exist because the service-role key should not live in the Next.js
apps; that is no longer fully true (the auth adapter in `apps/auth` uses the
secret key too).

Cutover hazard (INFERRED): after a move to self-hosted GoTrue, the functions
would keep pointing at the old Supabase project (auto-injected URL), and the
callers' URL (`/functions/v1/*` on the new host) would not be routed at all.
They must be ported **before or at** cutover, as ordinary route handlers in
REOSA's auth app.

**Not ExponetDB's job** ([`../00-product/vision-and-scope.md`](../00-product/vision-and-scope.md)):
ExponetDB does not host, port or run edge functions and does not handle their
secrets. It can list them as **dependents** of a target so that a cutover plan
shows every component still pointing at the old database.

## Network facts checked against the owner brief

| Owner brief | REOSA documents | Result |
|---|---|---|
| Exponet network `10.8.0.0/16` | Hetzner Cloud Network named **`exponent`**, `10.8.0.0/16` | range matches; name spelled differently |
| Cloud subnet `10.8.1.0/24` | same, zone `eu-central` | matches |
| `reos-db-01` `10.8.1.2` | same, **planned** ("server not ordered or hardened yet") | matches (planned) |
| vSwitch subnet `10.8.2.0/24` | same, gateway `10.8.2.1` | matches |
| `reos-01` `10.8.2.2` | same, on VLAN interface `enp5s0.4000`, as-built 2026-10-04 | matches |
| vSwitch `vSwitch-Exponent`, VLAN 4000 | same, vSwitch id 85953 | matches |
| MTU 1400 | same (measured; 1500 described as a silent `pg_restore` failure) | matches |
| `reos-db-01` CX43, 16 GB | handbook plans a smaller instance with 8 GB | **differs**; ExponetDB makes no size assumption |

## Requirements derived for ExponetDB

Each requirement is implemented by the referenced document.

| # | Requirement | Where |
|---|---|---|
| 1 | Identity is not order: ULID ids, slug as metadata, DAG ordering | [`../04-migrations/migration-bundles.md`](../04-migrations/migration-bundles.md), [`../04-migrations/dependency-graph.md`](../04-migrations/dependency-graph.md) |
| 2 | Renames keep identity; legacy names resolve through aliases | [`../04-migrations/legacy-import.md`](../04-migrations/legacy-import.md) |
| 3 | Apply checksum over normalized executable text; comment edits are not drift | [ADR-0009](../01-architecture/adr/0009-checksum-semantics.md) |
| 4 | One canonical ledger per target; import all three legacy ledgers by content and objects | [`../04-migrations/ledger.md`](../04-migrations/ledger.md), [`../04-migrations/legacy-import.md`](../04-migrations/legacy-import.md) |
| 5 | Verify by object, including table and column ACLs, default ACLs, RLS/FORCE, policies, function security | [`../03-database-model/schema-fingerprints.md`](../03-database-model/schema-fingerprints.md), [`../04-migrations/verification.md`](../04-migrations/verification.md) |
| 6 | Never re-execute applied bundles; idempotency is not a safety net | [`../04-migrations/failure-and-recovery.md`](../04-migrations/failure-and-recovery.md) |
| 7 | Staging evidence for production as an engine invariant | [`../04-migrations/staging-production-policy.md`](../04-migrations/staging-production-policy.md) |
| 8 | Machine-readable compatibility class, checked by analysis | [`../04-migrations/analysis.md`](../04-migrations/analysis.md) |
| 9 | Target-specific bundle subsets (status database) with wrong-database guards | [`../04-migrations/migration-bundles.md`](../04-migrations/migration-bundles.md), identity markers |
| 10 | Continuous drift detection against repository, ledger and live fingerprint | [`../03-database-model/drift-detection.md`](../03-database-model/drift-detection.md) |
| 11 | Runtime schema contract instead of per-query fail-soft | [`../04-migrations/authoring-and-ci.md`](../04-migrations/authoring-and-ci.md#8-runtime-schema-contract) |
| 12 | One execution model; default `lock_timeout`; explicit non-transactional bundles | [`../04-migrations/planning-and-apply.md`](../04-migrations/planning-and-apply.md) |
| 13 | Record conditional DDL branches; account for intentional environment variance | [`../04-migrations/planning-and-apply.md`](../04-migrations/planning-and-apply.md), [`../03-database-model/drift-detection.md`](../03-database-model/drift-detection.md) |
| 14 | Cluster roles, memberships, role settings and login roles as desired state, not migrations; no secrets in bundles | [`../03-database-model/credentials-and-roles.md`](../03-database-model/credentials-and-roles.md) |
| 15 | ORM schema as a verification target, not a generator | [`../04-migrations/authoring-and-ci.md`](../04-migrations/authoring-and-ci.md#7-framework-adapters-orm-neutrality) |
| 16 | Dual health probe; separate diagnostic connection; failed reads never empty; path awareness | [`../10-observability/health.md`](../10-observability/health.md) |
| 17 | One RPO/RTO per environment, measured; restore drills executed with evidence | [`../09-backups-and-restore/architecture.md`](../09-backups-and-restore/architecture.md), [`../09-backups-and-restore/restore.md`](../09-backups-and-restore/restore.md) |
| 18 | ExponetDB is the source of truth for database infrastructure; REOSA's infrastructure register links by id instead of duplicating | [`reosa-integration.md`](./reosa-integration.md) |
| 19 | ExponetDB roles are namespaced (`exponetdb_*`); consumer role names are API | [`../03-database-model/credentials-and-roles.md`](../03-database-model/credentials-and-roles.md) |
| 20 | Hold database credentials only; never Supabase keys, JWT or HMAC secrets | [`../08-auth-and-security/secrets.md`](../08-auth-and-security/secrets.md) |
| 21 | Do not depend on REOSA's CI; ExponetDB's checks run on their own | [`../04-migrations/authoring-and-ci.md`](../04-migrations/authoring-and-ci.md) |

## Open items that only a live check can settle

1. `rolsuper`, `rolbypassrls`, `rolinherit` of `postgres` on both Supabase
   projects (decides the BYPASSRLS hazard for the move).
2. Extension schemas on the source (`extensions` vs `public`) and whether a
   `public` dump references `extensions.*`.
3. Full `pg_roles` on production: which login roles exist, whether
   `agent_role_admin` and `platform_admin` exist.
4. The live definition of `tenant_members_select_own` in production and the
   owner's decision on applying `0014` before the move
   ([OD-7](../00-product/open-decisions.md#od-7-manage-reosas-current-hosted-databases-before-the-move)).
5. Privileges of the app login on `auth.users`, `auth.sessions`,
   `auth.mfa_factors`.
6. Supabase plan tier and PITR status.
7. Whether any restore drill rows exist in REOSA's drill table.

## Wave 4 re-audit (2026-10-06)

**[OBSERVED]** A read-only re-read of REOSA `main` at `c65da452` for the
synthetic fixtures of Wave 4 ([G4 record §2.3](../14-roadmap/gates/4.md#23-reosa-read-only-real-world-consumer-reference)).
Nothing in REOSA was changed, built or connected to; the docs that contain
connection-string templates hold placeholders only, and none was copied.

| Area | Measured (from the repository) |
|---|---|
| Migrations | 471 files under 391 number prefixes (`0000` to `0390`, 63 prefixes shared by up to four files); 250 files in the Drizzle journal; three history tables (`drizzle.__drizzle_migrations`, `supabase_migrations`, `public.applied_migrations`) |
| Tables | about 420 `CREATE TABLE`, all in `public` with name prefixes; 274 with `tenant_id uuid`; live counts stated in REOSA's docs: 286 tables and 343 policies on production, 289 and 345 on staging (2026-09-14) |
| Types and columns | no `CREATE TYPE … AS ENUM` (enumerations are `CHECK (… IN …)`); 9 generated stored columns (digits-only phone via `regexp_replace`, `sha256` hex, a `tsvector` over two configurations); `text[]`, `uuid[]`, `jsonb` with `jsonb_path_ops` GIN |
| Partitions, views | one `RANGE` partitioned table with a default partition and monthly partitions; 37 views, many `security_barrier`; no materialized view |
| Functions, triggers | 116 functions (43 `SECURITY DEFINER`: 55 definitions with `SET search_path = public, pg_temp`, none with `''`, seven functions without any `search_path`); 93 row triggers (append-only guards, touch, per-tenant sequences, `pg_notify`); no event trigger in the repository, but `rls_auto_enable` exists on both live databases |
| RLS | `current_tenant_id()` reads `app.tenant_id` (`LANGUAGE sql STABLE`, no `search_path`); `ENABLE` on about 405 tables, `FORCE` on 84 (82 of them without a policy, so only a `BYPASSRLS` role reads them); 400 policies, 6 `AS RESTRICTIVE` (GUC-switched), 307 without `TO` |
| Privileges | 535 `GRANT`, 317 `REVOKE`; `ALTER DEFAULT PRIVILEGES` once; documented drift: `pg_default_acl` `arwdDxtm` on production vs `Dxtm` on staging (2026-08-01), a named `anon` EXECUTE surviving `REVOKE … FROM PUBLIC` |
| Extensions | `vector` and `pg_trgm` only (in `extensions` on the hosted provider, `public` on a fresh instance); three `vector(1024)` columns, one HNSW cosine index without `WITH` options; 15 `gin_trgm_ops` indexes, one over an expression |
| Connections | postgres.js with `prepare: false`, pools of 10 + 3, per-transaction `statement_timeout` ≤ 120 s and `lock_timeout` 10 s |
| Incident 2026-09-24 | through a transaction pooler, parameter-free `SELECT 1` kept answering while every parameterized query (Parse/Bind/Execute, pipelined) waited forever in `ClientRead`; the health endpoint reported "reachable"; only `pg_terminate_backend` cleared it (`packages/db/src/pooler-reaper.ts`, `reosa-docs/09-operations/database-connections.md` §1) |
| Diagnostics | `/status/database`: settings, up to 500 `pg_stat_activity` rows with literal-redacted statements, a probe with and one without a parameter, concern rules (stalled `ClientRead` ≥ 60 s, waiting ≥ 10 s, long running ≥ 30 s/300 s, idle in transaction ≥ 10 s, usage 75 %/90 % of `max − reserved`); an autonomous reaper terminates stalled sessions every 30 s |

Consequences for ExponetDB (Wave 4): the dual probe is the named condition
`extended_protocol_failing`; the synthetic REOSA-shaped fixture reproduces
these shapes without REOSA names, data or roles; ExponetDB reports stalled
sessions but never terminates them on its own.


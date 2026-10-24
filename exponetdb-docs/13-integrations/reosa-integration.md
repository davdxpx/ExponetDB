# REOSA integration

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05; nothing in REOSA changes before Wave 10 |
| Applies to | Wave 10 (REOSA integration), Wave 11 (REOSA move from Supabase to ExponetDB-managed PostgreSQL) |
| Read before | [`reosa-current-state.md`](./reosa-current-state.md), [`sdk.md`](./sdk.md), [`../04-migrations/legacy-import.md`](../04-migrations/legacy-import.md) |

> ExponetDB may learn from REOSA. REOSA may consume ExponetDB. ExponetDB must
> never depend on REOSA.

## 1. Relationship

```
admin.reosa.de (REOSA Admin)          REOSA apps (app, auth, worker, …)
        │ @exponetdb/sdk (server side)         │ own login roles, own pools
        ▼                                      ▼
  db.exponet.cloud /api/v1             PostgreSQL (reosa/platform/<env>)
        │                                      ▲
        └──── ExponetDB control plane ─────────┘ observer, migrator, operator roles
```

- REOSA's applications talk to PostgreSQL **directly**, never through
  ExponetDB (C-1, C-5). If ExponetDB is down, REOSA keeps working.
- REOSA Admin is a **client** of ExponetDB through the SDK, server side only;
  no ExponetDB token reaches a browser.
- ExponetDB contains no REOSA brand strings, no REOSA-specific code paths and no
  REOSA data model. REOSA-specific knowledge lives in **registry data**
  (product `reosa`, its projects, environments, endpoints, dependents, advisor
  packs, masking profiles) and in REOSA's own repository (bundles, manifests,
  runtime schema contract).

## 2. Registry model for REOSA

| Registry item | Value |
|---|---|
| Product | `reosa` |
| Environments | `staging` (nonprod), `production` (prod, `evidence_from = staging`) |
| Projects | `platform` (main database), `status` (status page database) |
| Targets | `reosa/platform/staging`, `reosa/platform/production`, `reosa/status/production` |
| Evidence for `reosa/status/production` | no staging target exists. `evidence_override: none` (audited, admin-only) only records that fact; it is no bypass (C-15, [staging-production-policy.md §1](../04-migrations/staging-production-policy.md)): production plans there have no evidence and are denied unless a person uses a time-boxed break-glass grant per change. The intended path is a `reosa/status/staging` target (recommended once the status database moves to its own host) |
| Paused database `reosa-production2` | not registered (or registered as `suspended` with no credentials), so nothing can touch it |
| Dependents per target | apps with their login roles and endpoints (app, admin, auth, API, worker, email, sites, marketing, sales, status), GoTrue (`supabase_auth_admin`), edge functions, PostgREST for the docs site; used by cutover plans and health attribution |
| Bundle subsets | the `status` project has its own stream; bundles that create `status_*` objects move there during import instead of being hand-picked subsets of the platform stream |

## 3. Wave 10: integration on the current databases

**[OBSERVED]** (owner's Wave 9 order §6, 2026-10-21) The databases are no
longer all hosted: REOSA **staging** already runs self-managed on
`reos-db-01` (`reosa_staging`, PostgreSQL 17.11, no node agent, so an
**external cluster** for ExponetDB), next to a self-hosted identity service
whose role owns the `auth` schema; REOSA **production** still runs on the
hosted provider. [OD-7](../00-product/open-decisions.md#od-7-manage-reosas-current-hosted-databases-before-the-move)
is resolved by splitting it (2026-10-21): **OD-7a (staging): yes**, the
owner registers staging and its scratch database after Part A of Wave 9,
imports the history and lets sessions apply staging migrations through
ExponetDB; **OD-7b (production): no applies before Wave 11**, at most
read-only observation. The product capabilities this needs (the import of a
real Supabase-origin history, per-environment execution roles,
external-cluster onboarding) are brought forward into Part A of Wave 9; the
REOSA-side deliverables below stay in Wave 10.

| Step | What | Risk control |
|---|---|---|
| 10.1 | Register the clusters as **external clusters** (no agent), with ExponetDB's idempotent bootstrap SQL (no password in it) run by the owner: `reos-db-01` for staging and its scratch database after Part A of Wave 9 (OD-7a, [`../12-operations/onboard-external-cluster.md`](../12-operations/onboard-external-cluster.md)); the hosted production database at most read-only (OD-7b) | read-only roles first (`observer`, `reader`) on production; `CAPABILITY_UNAVAILABLE` where hosting forbids grants |
| 10.2 | Health, diagnostics, fingerprints, drift findings for staging and production | no writes |
| 10.3 | **Legacy import** of the platform stream on staging (8 steps in [`../04-migrations/legacy-import.md`](../04-migrations/legacy-import.md)): discover about 530 files (2026-10-21) and the legacy ledgers (`supabase_migrations.schema_migrations`, 391 rows; `public.applied_migrations`, 187 rows), replay on the scratch target, compare by objects, classify, review items for every ambiguity (renamed files, merged entries, missing effects such as `0014`), baseline, verify, freeze; done by the owner after Part A of Wave 9 (OD-7a) | the baseline is a planned `high` operation per target; review items need owner decisions; nothing is re-executed |
| 10.4 | Freeze REOSA's old paths: after the baseline, REOSA's rules route all migrations through ExponetDB; the Supabase MCP `apply_migration` path and `bun db:apply-all` against shared databases are retired (REOSA's decision and change, made in REOSA's repository) | a drift finding fires on any change applied outside ExponetDB |
| 10.5 | New REOSA migrations as bundles: REOSA's repository gets `exponetdb.project.yaml` with bundle roots (global and per module, read in place); manifests declare compatibility class, which REOSA authors decide; CI runs `exponetdb migration lint` and `exponetdb migration graph` | REOSA's authors keep the classification decision; ExponetDB analysis flags mismatches |
| 10.6 | Staging-first through ExponetDB: agents plan and apply on `reosa/platform/staging` via MCP with nonprod scopes (from the owner's registration after Part A of Wave 9, OD-7a); production plans reference the same bundles and require the staging evidence and human approval, and are not applied before Wave 11 (OD-7b) | approvals in the Web App only |
| 10.7 | Runtime schema contract in REOSA's health checks (`exponetdb.missing_migrations`) | replaces fail-soft detection; checked directly against the database |
| 10.8 | REOSA Admin `/database` via the SDK (§5) | read-only |
| 10.9 | ExponetDB as source of truth for database infrastructure; REOSA's infrastructure register links to ExponetDB ids instead of keeping its own copy of database facts | avoids a second register |

Roles on the hosted production database: whether a new migrator role can
become a member of the provider-owned object owner is an assumption to verify
before any migration runs there, which is not before Wave 11
([`../03-database-model/credentials-and-roles.md` §8](../03-database-model/credentials-and-roles.md#8-external-clusters-no-node-agent)).
Roles on staging: **[OBSERVED]** each environment has its own role set on
`reos-db-01` (`<env>_owner` with `BYPASSRLS` owning `public`, `<env>_auth`,
`<env>_app`, `<env>_migrator`); ExponetDB binds the project's `owner` alias
to `<env>_owner` per environment and needs a declared `BYPASSRLS` exception
for it (ADR-0034,
[`../03-database-model/credentials-and-roles.md` §3.3](../03-database-model/credentials-and-roles.md#33-the-reference-installations-role-set)).

## 4. Wave 11: moving REOSA from Supabase to ExponetDB-managed PostgreSQL

ExponetDB does not perform REOSA's auth migration or application changes. It
provides the database side and the evidence.

| Step | ExponetDB's part |
|---|---|
| 11.1 Prepare `reos-db-01` | **[OBSERVED]** (owner's Wave 9 order §6, 2026-10-21) the host already runs staging: PostgreSQL 17.11 from PGDG, TLS `verify-full` with its own name-constrained CA (name `reosdb01.exponet.cloud`), `pg_hba` with `hostssl` and SCRAM only, backups by the owner's pgBackRest setup, no node agent. Still to do before production moves: production's own role set on the same cluster (owner, identity service, application login, migrator) with the remaining REOSA roles (bootstrap roles, migration-created roles, login roles with verifiers, memberships, role settings such as the idle timeout), extensions in the **same schemas** as on the source; role desired state through the node only once the agent is enrolled (the G5 waiver's expiry condition, and [OD-54](../00-product/open-decisions.md#od-54-how-an-external-cluster-gains-the-node-agent) for a cluster registered external), otherwise by the owner's scripts and the bootstrap SQL |
| 11.2 Rehearse | restore the source dumps into a scratch target on `reos-db-01` (separate restore units for `public` and `auth`, GoTrue version pinned); compare fingerprints with the source, including **table and column ACLs, default ACLs, function `EXECUTE` grants**, RLS/FORCE flags and policy counts; RLS invariants (`tables == tables with RLS`, isolation probe as a non-superuser); record the BYPASSRLS behavior of the new login role against the paths that depend on it; measure dump and restore duration |
| 11.3 Cutover plan | a `critical` plan per target: writer freeze checklist from the dependents list (every app, worker, cron, edge function, GoTrue), final dump and restore, verification, placement move (target identity stamped on the new cluster, generation bumped), consumer switch (REOSA rebuilds apps whose database URL is baked at build time), acceptance checks; **rollback plan**: the old Supabase project stays untouched and writable-again until acceptance passes; rollback = switch consumers back, no data merged |
| 11.4 Execute | human-only, approved, in a maintenance window; ExponetDB records timings and evidence |
| 11.5 After | backups and PITR active on the new cluster before the window closes (the owner's pgBackRest setup is adopted, then owned, in Wave 9 Part B, OD-52); first drill within 7 days; old project kept read-only for an agreed period, then retired by REOSA |

Gate: every item in [`../14-roadmap/acceptance-gates.md` "Product gates before REOSA production moves"](../14-roadmap/acceptance-gates.md#product-gates-before-reosa-production-moves)
must pass before 11.4.

## 5. REOSA Admin as a client

Route in REOSA Admin: **`/database`** (not `/databases`). Content, all read-only
through the SDK:

| Block | SDK call (illustrative) |
|---|---|
| Targets of product `reosa` with tier and state | `exponetdb.targets.list({ product: "reosa" })` |
| Health per target (path, answers, stuck) | `exponetdb.health.get(targetId)` |
| Migration status (head, pending, staging vs production, drift) | `exponetdb.migrations.status(targetId)` |
| Connections summary by role/application | `exponetdb.connections.summary(targetId)` |
| Backup protection, RPO measured vs objective, last drill | `exponetdb.backups.status(clusterId)` |
| Top statements and regressions | `exponetdb.performance.summary(targetId)` |
| Links | deep links into `db.exponet.cloud/t/reosa/platform/<env>/…` for every action |

REOSA Admin authenticates as a **service account** with read scopes
(`targets.read`, `diagnostics.read`, `migrations.read`, `backups.read`) bound to
product `reosa`, using `private_key_jwt`; it holds no database credentials for
these views.

`/status/database` in REOSA Admin **stays an incident view**: "what is happening
with the production database right now". It may read ExponetDB's health for
`reosa/platform/production` and link to ExponetDB, and it keeps its own direct
probes so that it works when ExponetDB is down (C-29). It does not grow into a
management surface.

## 6. Conventions REOSA adopts (proposals for REOSA's repository, not changed now)

| Convention | Why |
|---|---|
| Stable `application_name` per process role (`reosa-app`, `reosa-worker`, …); per-transaction tags as a suffix that ExponetDB's grouping rule strips | session attribution ([`../10-observability/health.md` §5](../10-observability/health.md#5-attribution-of-sessions)) |
| `sslmode=verify-full` with the private CA on every database URL | plaintext finding in REOSA's own status document |
| Login roles never `BYPASSRLS` unless declared in the role manifest with a reason | silent-empty hazard after the move |
| Role-level timeouts in the role manifest, not in migrations | survive dump/restore; cluster-level settings out of database migrations |
| Migrations authored as bundles with ULIDs; compatibility class in the manifest | replaces prose classification and number collisions |
| No new fail-soft catch for `42703`/`42501` without the runtime schema contract | missing migrations become loud |
| REOSA documents point to ExponetDB for RPO/RTO and infrastructure facts | one number, measured |

These are written into REOSA's rules by REOSA when Wave 10 starts. ExponetDB's
documentation only records them.

## 7. What stays REOSA's

Tenant isolation logic (`withTenant`, `current_tenant_id()`), REOSA's RBAC and
operations kernel, authoring and classifying migrations, driver guardrails and
the in-app reaper (until REOSA decides it is no longer needed), GoTrue and the
auth migration, the edge functions and their replacement, PostgREST for the docs
site, application deployment on Coolify, brand configuration.

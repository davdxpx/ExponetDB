# ExponetDB — Wave 9: Backup, restore, performance, with the migration engine made fit for real imported schemas (implementation order)

| | |
|---|---|
| What this is | The implementation prompt for a **new Claude Code session** that builds Part A (migration engine and onboarding for real, imported, Supabase-origin schemas) and Part B (Wave 9). Paste it as the first message of that session, or tell the session to read this file. In Phase 0 the session commits it as `exponetdb-docs/14-roadmap/orders/wave-9-order.md`. |
| Prepared | 2026-10-21, on `main` at `485619c` (merge of `davdxpx/ExponetDB#32`), from a read-only research pass over ExponetDB and from a **real onboarding attempt** of an existing, Supabase-origin PostgreSQL database (REOSA staging on `reos-db-01`) that stopped at the gaps listed in Part A. |
| Authority | Items marked **[OWNER]** are the owner's instructions for this order. Items marked **[DEFAULT]** are proposals of the research pass; they stand unless the owner overrules them in Phase 0. The executing session records every decision in `open-decisions.md` (or an ADR) in Phase 0 before it relies on it. |
| Not in scope of this file | It changes no code and decides nothing in `open-decisions.md` by itself. It does not accept any gate. |

---

## 1. Mission

ExponetDB must become usable for its first real managed database, and Wave 9 must make backups, restores and diagnostics real. This order has two parts. **Part A comes first and ships as its own pull request.**

**Part A — Migrations for real, imported schemas.** [OWNER] On 2026-10-21 the owner tried to put REOSA staging (a real, Supabase-origin schema on a self-managed PostgreSQL 17 cluster) under ExponetDB. The registry steps worked; the migration path did not. An execution role that mirrors Supabase's `postgres` is refused, execution roles cannot differ per environment, the CLI cannot start a legacy import at all, the import cannot match a real Supabase ledger, legacy files that touch roles cannot be replayed, and onboarding an external cluster needs hand-made SQL. Every one of these hits **every** project that comes from Supabase, not only REOSA. Part A fixes them in ExponetDB, properly: with contracts, additive Control Store bundles, ADRs, policy rules, tests against real PostgreSQL and documentation. A REOSA-specific workaround is not acceptable (CLAUDE.md "No REOSA dependency": REOSA specifics are registry data).

**Part B — Wave 9 (backup, restore, performance)**, as defined in `14-roadmap/implementation-waves.md` §Wave 9 and gate G9 in `acceptance-gates.md`. Backups that are proven by restores; RPO/RTO measured; restore planning and drills, including the C-35 drill without the Control Plane; generated restore runbooks; session cancel/terminate as plans; statement statistics; advisors and findings. The Web App's Wave 9 placeholders become real pages.

[OWNER] **Quality over speed.** The owner explicitly prefers more careful engineering work now over problems later. Choose the professional design even when it costs more code: contracts first, additive bundles, ADRs where a DECIDED rule changes, real-PostgreSQL tests for every PostgreSQL claim, independent review rounds, truthful records. Size is a consequence, not a target; the checks in §11 decide whether work is done.

Stop at the end of Part A (pull request, Part A record) and at **G9** (gate record awaiting the owner). Do not deploy anything, do not enroll any node on a real host, do not connect to any real database unless the owner asks for exactly that.

---

## 2. Ground rules (read `CLAUDE.md` and the constitution first; these are the ones that bite this order)

- **Read first, in this order:** `CLAUDE.md`; `exponetdb-docs/00-product/constitution.md` (C-1 to C-35); `14-roadmap/implementation-waves.md` (Waves 6, 9, 10 and their State rows); `14-roadmap/acceptance-gates.md` (G6, G9, the product gates PG-13, PG-14, PG-16, "How gates are recorded"); `14-roadmap/gates/5.md` (§11 waiver), `gates/6.md` (§10 and the waivers expiring "before Wave 9 closes", around `:237-259` and `:474`), `gates/8.md` (record shape); `orders/wave-8-order.md` (order shape); all of `04-migrations/` (especially `legacy-import.md`, `migration-bundles.md`, `staging-production-policy.md`); `03-database-model/credentials-and-roles.md` (§3 execution roles, §7, §8), `postgres-adapter.md`, `schema-fingerprints.md`, `sql-execution-security.md`; `02-control-plane/registry.md`, `policy-engine.md`, `operations-engine.md`, `error-model.md`, `data-retention.md`; all of `09-backups-and-restore/` and `10-observability/`; `07-node-agent/` (architecture, capabilities, security, protocol); `08-auth-and-security/threat-model.md` (T18, T19), `secrets.md`, `ai-agent-safety.md`; `13-integrations/reosa-integration.md` and `reosa-current-state.md` (both partly outdated, see §6); `00-product/open-decisions.md` (OD-4, OD-7, OD-8, OD-12, OD-16, OD-20, OD-21, OD-27, OD-29, OD-44, OD-46).
- **Documentation first.** A behavior change updates its document in the same commit. Use `[OBSERVED]` (with a path), `[DECIDED]`, `[PLANNED]`, `[ASSUMPTION]`, `[OPEN: OD-n]`, `[NON-GOAL]`. A real open question goes into `open-decisions.md`; never decide an owner question silently. Next free numbers at preparation time: **OD-51**, **ADR-0034** (re-check; Wave 8 follow-ups may have taken numbers).
- **Frozen is frozen.** `c1`, `ls1`, JCS, the plan-hash construction, `ac1`, `se1`, `pv1`, `fp1` and the 21 bundles in `packages/control-store/frozen-bundles.json` never change. A schema change is a **new, additive** bundle; a stored or wire contract change is a new version through an ADR; golden vectors are append-only (`bun run golden:check`, `bun run golden:history`). The Wave 7 and Wave 8 bundles are not frozen yet (G7 and G8 are not accepted); still treat them as published and change them only additively.
- **One engine (C-9), plan → apply → verify → audit, fail closed, truthful reads, production is its own tier, content is untrusted** (CLAUDE.md principles 1 to 8). No "run this write now" path anywhere, also not for backups or restores.
- **No REOSA dependency.** Use REOSA only as the *shape* of a fixture (§6). No REOSA brand strings or REOSA-specific code paths in product code; no REOSA data, credentials or real file contents in fixtures. Write synthetic fixtures that reproduce the shape.
- **Supabase is a read-only source** (ADR-0017, ADR-0030). Advisors are a clean-room catalog (as `10-observability/performance.md` already says); learning from splinter's concepts is fine, copying its SQL is not.
- **CI has never run** for this repository (no GitHub Actions runner starts). Evidence is local and recorded with the commit; no PASS is derived from a workflow file. Keep `CI: not waived` in the records.
- **Git:** commits as `𝕏0L0™ <davdxpx@gmail.com>`, never Claude as author or co-author, no session links, no `Co-Authored-By`, at most "Developed by `@davdxpx`" at the end; the same for PR titles, bodies and comments. Conventional Commits, atomic (code, tests and docs together). Commit and push after every unit of work. If the session environment assigns a branch name, that rule wins over `feat/…`.
- **Do not touch other repositories.** REOSA's repository and REOSA's servers are out of bounds for this session. The REOSA onboarding itself (registering `reos-db-01`, importing its history) is done afterwards by the owner with a REOSA session, using what Part A delivers.

---

## 3. Decisions this order takes

### 3.1 [OWNER]

1. **Order of work:** Part A first, delivered as its own pull request and record, then Part B. Part A may be merged before Part B is finished.
2. **Scope pull-forward:** Part A brings forward the parts of Wave 10 that are product capabilities (import of a real Supabase-origin history, per-environment execution roles, external-cluster onboarding). It does **not** bring forward Wave 10's REOSA-side deliverables (bundle roots in REOSA's repository, REOSA Admin `/database`, runtime schema contract); those stay Wave 10.
3. **Quality over speed** (§1).
4. **OD-7 is overtaken by events and must be split** (record it in Phase 0):
   - **OD-7a** (staging): REOSA staging already runs on `reos-db-01` (self-managed, external to ExponetDB). After Part A, the owner registers it, imports its history and lets sessions apply staging migrations through ExponetDB. Decision: **yes**.
   - **OD-7b** (production): REOSA production still runs on hosted Supabase and moves only in Wave 11. Until then ExponetDB at most observes it read-only. Decision: **no applies to production before Wave 11**.
   - `CLAUDE.md` says the 2026-10-07 local bootstrap mode "does not authorize any real managed target". OD-7a is the owner's explicit authorization for exactly one real nonprod target set (REOSA staging and its scratch database on `reos-db-01`). Update `CLAUDE.md` "Current phase", `bootstrap.md` and the G2 record's wording in Phase 0 so they state this precisely; it does not close G2 off-host evidence and does not authorize any production target.

### 3.2 [DEFAULT] (stand unless the owner overrules them in Phase 0)

1. **D-A1, BYPASSRLS execution-role exception (new OD and ADR-0034):** a declared, audited, revocable exception that allows exactly the `BYPASSRLS` attribute on an execution role, per (project, environment, role); never SUPERUSER, CREATEROLE, CREATEDB, REPLICATION, LOGIN or reach into `pg_*`/`exponetdb_*`. Agents may apply nonprod migrations under a declared exception; on production the exception raises the plan to at least `high` and agent-initiated applies keep needing human approval (OD-13 unchanged). Reason: Supabase's `postgres` has `BYPASSRLS`, and Supabase-origin schemas use SECURITY DEFINER functions owned by it on `FORCE ROW LEVEL SECURITY` tables. Removing the attribute silently breaks them (measured on REOSA: 159 FORCE-RLS tables, 48 definer functions, 41 of them touching FORCE-RLS tables). A product that can only manage greenfield schemas cannot adopt real ones.
2. **D-A2, per-environment execution-role bindings:** the alias→role map is resolved per (project, environment), with the project map as default. This also removes a divergence between code (per project) and `credentials-and-roles.md:104-106` (per target).
3. **D-B1, OD-4 engine:** **pgBackRest** for L1 (physical + WAL). Reason: the owner already runs pgBackRest 2.59.3 on `reos-db-01` with client-side encryption, scheduled full/diff/monthly backups to S3-compatible storage and passed PITR drills (also on a freshly built host); the docs' own recommendation is pgBackRest too. The **storage** choice stays open until the measured spike B0 (§8.1) and is then a stop-and-ask point.
4. **D-B2, adopt then own (new ADR):** ExponetDB can **adopt** a running, hand-made pgBackRest setup: first observe it (catalog, archive status, verify, drills) with no change to its configuration or schedules, then take ownership of configuration and scheduling through a planned, verified hand-over. The docs today only know an ExponetDB-owned setup ("repository config written by the agent, never edited by hand", `09-backups-and-restore/backup-engines.md`, around `:253`), which would force a destructive re-setup of a working backup chain. OD-20 (foreign values are shown, never overwritten) points the same way.
5. **D-B3, OD-8:** recommend option (a) (permanent pseudonymous audit); the docs require the final legal setting **before Wave 9 starts**. This is a stop-and-ask point in Phase 0 if the owner has not decided it.
6. **D-B4, L2/L3 in Wave 9:** `pg_dump` (L2) plus restic to a second provider (L3) are part of Wave 9, engine-independent; restic needs an allowlist addition (§8.3).
7. **D-B5, G5 waiver:** items 2 and 4 of G5 expire "before a node agent is installed on, or enrolled for, any real host (this includes `reos-db-01`)". Part B develops and proves node capabilities only on disposable hosts (the local lab, containers, a disposable VM). Closing the waiver needs the `node-pg` and `node-host-scenarios` steps on a disposable Ubuntu 24.04 VM; if no VM is available to the session, that is a stop-and-ask point, and the record keeps the items `NOT PROVEN`.

---

## 4. Orchestration and the model policy

- Work in phases with a durable progress and evidence record (the Part A record and `gates/9.md`); after a context switch, read the record and continue, never restart a proven phase.
- Subagents may build independent pieces once their contracts are fixed. Security-relevant decisions (policy rules, role checks, restore destination checks, encryption, lock semantics, secret handling) are not delegated to a builder: the main session designs them, and an independent reviewer (fresh context, strongest available model) reviews each one against the threat model before merge.
- Every phase ends with: tests green, docs updated, record updated, commit pushed. At the end of each part: at least two independent review rounds over the whole diff (correctness, security, truthfulness of states, docs/code agreement), each finding fixed with a regression test or recorded as an explicit residual risk.

---

## 5. What exists today (facts to build on; re-verify all of them before relying on them)

Paths are relative to the repository root at `485619c`.

### 5.1 Migration engine and legacy import

- **Execution role check:** `packages/postgres/src/migration-facts.ts:107-127` (`executionRoleProblem`) refuses `bypassRls` as `privileged_attribute`, also LOGIN and reach to superuser/`pg_*`/`exponetdb_*`. Policy rule `migration.execution-role` in `packages/policy/src/catalog/migrations.ts:203-209` is built by `requirementRule`, which hard-codes `overridableByBreakGlass: false` (`:176`): **no override exists of any kind**. The executor re-checks under the lock (`packages/migrations/src/engine/executor.ts:616-627`, `kind.ts:150-156`). Docs: `credentials-and-roles.md:115-127` [DECIDED], `threat-model.md:289`.
- **Legacy replay never checks the role** (inconsistent with the rule above): `ImportReplayKind` runs `SET LOCAL ROLE` (`legacy.ts:1048-1056`, `executor.ts:175`) without `executionRoleProblem`; `planImportAnalysis` (`legacy.ts:372`) does not check it either.
- **Execution roles are per project:** `packages/contracts/src/rest/registry.ts:197-206`; column `registry.projects.execution_roles` in the frozen bundle `01M4QEE7…_migration-engine/up.sql:11-15`. Direct readers: `planner.ts:99-129,365,599,678,694`, `resume.ts:312`, `rollback.ts:190`, `reverify.ts:164-167`, `reads.ts:376-403`, `deps.ts:45-61`, `kind.ts:151`, `legacy.ts:372`. `c1` hashes only the alias (`migration-bundles.md:141`); the plan binds resolved names per target (`planner.ts:754-759`); evidence binds the checksum (`evidence.ts:33,197`). Per-environment resolution therefore breaks neither `c1`, nor the plan hash, nor staging→production evidence.
- **CLI cannot start an import:** `apps/cli/src/commands/migration.ts:871` sends `flag ?? legacy.baseline`. The project manifest requires `baseline:<slug>` (`packages/contracts/src/manifest/migration.ts:54-58`, `project.ts:112-116`), the REST contract wants the bare slug (`packages/contracts/src/rest/migrations.ts:628-632`), so `checkedBody` (`apps/cli/src/cli/planning.ts:66-77`) throws locally whenever the project default is used. The engine adds the prefix itself (`legacy.ts:437,465`). The CLI cannot send `aliases`, `role` or `searchPath`. No CLI test covers `import analyze`.
- **Supabase ledger matching cannot succeed on real data:** the Supabase entry name is built as `version_name` (`legacy.ts:578`); with the Supabase MCP the real shape is `version = 20261021180932`, `name = 0445_account_service`, so it never equals the file stem `0445_account_service`. The fixture uses `version '0002'`, `name 'listings'` (`packages/testkit/src/fixtures/legacy-history.ts:118-126`), so the real shape is untested. Statement matching (`legacy.ts:552-554,723-747`) requires an equal statement count and per-index equality after whitespace collapse. **Measured on a real Supabase ledger (2026-10-21): every entry has exactly one element in `statements`, the whole file with comments stripped.** Per-index comparison against the parsed file therefore fails for every multi-statement file. `public.applied_migrations` (drizzle-style runner; real columns `filename text`, `applied_at timestamptz`) is name-only but a name hint counts as "recorded" (`legacy.ts:744,764`). Aliases are single-stem although `legacy-import.md` §6 promises one entry → several files; date pinning and extension-schema declaration (§2 there) are not implemented.
- **Role DDL in legacy files:** the parser refuses CREATE/ALTER/DROP ROLE, GRANT role, REASSIGN OWNED (`packages/postgres/src/parser/migration.ts:1471-1477`); `reviewedStatements` throws (`reviewed.ts:62-64`) → `MIGRATION_STATEMENT_FORBIDDEN` → incomplete report (`executor.ts:147-155`, `legacy.ts:1077-1090`); `legacy-import.md:262-267` admits it. **Measured on PostgreSQL 17.11 (2026-10-21):** as a non-CREATEROLE owner, `DO $$ BEGIN CREATE ROLE x; EXCEPTION WHEN duplicate_object THEN NULL; END $$` fails with `42501 permission denied to create role` even though the role exists; the duplicate handler never runs. `GRANT role TO role` needs ADMIN OPTION. `notApplicable` skips a whole file, so non-role effects in mixed files are lost and come back as drift. `CONCURRENTLY` and comment-only files are refused the same way (`reviewed.ts:58-60`, `executor.ts:153`).
- **Scratch target:** must be registered, active, nonprod, same project, different target (`legacy.ts:357-370`), therefore needs its own nonprod environment. "Empty" means no objects in the managed scope and no ledger rows (`:526-530,1023-1033`). After a replay it is "consumed; a person re-creates it" (`:1171-1176`), but re-creating the database changes its oid → `database_mismatch` (`packages/registry/src/plans.ts:883-886`), re-registering the name is blocked by `databases_one_registered_name` (`01M48WRF…_registry/up.sql:157-158`), and **no database-retire operation exists**. Baseline requires the analyzed fingerprint unchanged (`legacy.ts:1309-1312`).
- **Drift items are silently capped at 500** (`legacy.ts:830,873`): a report can reach `resolved` while drift was never shown.
- Limits: 1000 files, 4 MiB each, 32 MiB per request body (`packages/contracts/src/rest/migrations.ts:604-612`, `:55`); a real history has about 530 files, 2.7 MB.

### 5.2 External-cluster onboarding

- `cluster register` always creates an external cluster (`packages/registry/src/kinds.ts:460-462`); there is no management-mode field (correct, but undocumented).
- Bootstrap SQL (`packages/postgres/src/bootstrap.ts:94-135`) uses plain `CREATE ROLE` (not idempotent); per-database sections appear only for already registered databases (`packages/registry/src/bootstrap.ts:23-25`), while registration already inspects the database as the observer (`plans.ts:747`): a chicken-and-egg problem when `CONNECT` is revoked from `PUBLIC`. It emits no `GRANT <owner> TO exponetdb_migrator WITH INHERIT FALSE, SET TRUE` and no read grants on declared legacy ledgers (otherwise `ledger_unreadable`; the fixture grants them by hand, `legacy-history.ts:131-132`).
- `pg_hba` guidance covers agent clusters only (`credentials-and-roles.md` §7).
- The declared cluster tier (OD-22) can only be set in the Web App; no CLI command. An undeclared cluster counts as production (fail closed), so even a scratch database registration needs production authority.

### 5.3 Wave 9 starting point

- **Contracts exist, handlers do not:** REST `GET /clusters/{clusterId}/backups` (`packages/contracts/src/rest/routes.ts:938-948`), `getQueryStats` (`:843-858`), `getTableStats` (`:872-884`), `POST /targets/{t}/advisor-runs` (`:885-895`); `BackupSchema`/`BackupCatalogSchema` (`resources.ts:1718-1747`), `BackupHealthStateSchema` (`:148-150`), health field `backups` (`:289-295`, always `null` in `packages/diagnostics/src/health.ts:530`); actions `query_stats.list`, `table_stats.list`, `advisor.run`, `backup.list` (`actions.ts:636-647`), `connections.cancel` (`low`) and `connections.terminate` (`standard`/`high`, `:1040-1058`), `connections.terminate.plan` (`:755`), `backup.run`, `backup.verify`, `restore.execute` (human, re-auth 300 s, by plan, `:1171-1205`). MCP tools `query_stats`, `table_stats`, `advisors_run`, `backups_list` are `status: 'planned'` (`mcp/tools.ts:704-784`). No restore-plan route, no `restore_plan`/`backup_run` MCP contract.
- **Control Store:** scopes `backups.read`, `backups.run`, `restore.plan`, `restore.execute` exist (frozen `oauth-delegation`), role permissions (frozen `access-control`), exclusivity domain `cluster:…:backup` (frozen `operations-engine`). **No backup, restore or advisor tables.** `observation.findings` (frozen) allows only `kind IN ('drift','health')` with `target_id NOT NULL` (`01M48WRFNGYF5WH0884N169FNH_observation/up.sql:101-118`): advisor findings and cluster-level backup findings need a new additive bundle. IDs `bkr`, `bkp`, `rst` exist (`packages/kernel/src/ids.ts:21-23,83-85`).
- **Policy:** `migration.destructive-backup` always fails for destructive, data-rewrite or unknown production migrations (`packages/policy/src/catalog/migrations.ts:381-404`) until a backups fact exists, and break-glass is refused while OD-21 is open. Wave 9 delivers that fact.
- **Node agent (Go):** only `wal.archive_status@1` (`agent/node/internal/capabilities/catalog.go:42`, `extensions.go:199-233`); no `backup.*`/`restore.*` (`packages/contracts/src/node-protocol/capabilities.ts:22-24`). Helper binary allowlist: systemctl, dpkg, dpkg-query, journalctl, apt-cache, apt-get (`internal/helper/run.go:28`); package allowlist without pgbackrest or restic (`internal/helper/ops_packages.go:14-20`); helper timeout 60 s default, **15 min maximum** (`run.go:23-25`): long backups and restores need an asynchronous, durable long-run design. `service.status` covers only `postgresql@`, agent and helper units (`ops.go:32,103-112`), not backup timers. `archive_command`/`restore_command` are withheld from exports as secrets (`export.go:31-38`).
- **Statements:** `packages/diagnostics/src/raw-statement.ts` reads `pg_stat_statements` live (Wave 8 S2); no sampler, no delta store.
- **Web App:** `apps/web/src/features/wave9/wave9-pages.tsx` renders named "not available yet" pages for `/t/…/performance`, `/advisors`, `/backups` and the global `/backups` (`shell/navigation.ts:221-227,415-452`); the connections page "Session cancel and terminate" (`features/connections/connections-page.tsx:290`), the fleet tile "Backups at risk" (`features/fleet/fleet-page.tsx:186`), the gate kind `wave9` (`features/target/gate.ts:52,141-143`), messages in `lib/i18n/messages/wave9.ts`.
- **CLI:** no backup commands; presets name the scopes (`apps/cli/src/presets.ts:24-34`); `diagnose` has a Backups row (`commands/diagnose.ts:13,51`).
- **Runbooks:** RB-06, RB-07, RB-08 are single table rows in `12-operations/incident-model.md:55-57`; none has its own document.
- **G6 waivers that expire before Wave 9 closes:** E25 (no restore operation) and the partial cases E4, E5, E7, E8, E9, E11, E13, E14, E15, E26, E28 (`gates/6.md` around `:237-259`, expiry `:474`). Wave 9 must cover them.

---

## 6. The real reference installation (shape for fixtures and docs; never connect to it)

The owner's first real database host. Use these facts to shape synthetic fixtures and to correct the documents; **do not connect to the host, do not use any of its data, and do not put REOSA names into product code.**

| Fact | Value |
|---|---|
| Host | `reos-db-01`, Hetzner Cloud, Falkenstein; PostgreSQL **17.11** (PGDG packages), private address **`10.8.1.1`** (the docs say `10.8.1.2` in `reosa-current-state.md:49,451`, `bootstrap.md:138`, `deployment.md:23,48,151,169`, `domain-model.md:40`, `control-plane-and-data-plane.md:44,69,76,108`; that is wrong) |
| TLS | name `reosdb01.exponet.cloud` (resolves to the private address inside the private network), own CA with name constraints (`DNS:exponet.cloud`, `IP:10.8.0.0/16`), `hostssl` + SCRAM only, verify-full. Bun/BoringSSL rejects name-constrained CAs; Node/OpenSSL and Go accept them (ExponetDB's server runs on Node 24) |
| Clients | containers on `reos-01` reach it SNAT'ed from `10.8.2.2`; that is the source address ExponetDB's worker will have |
| Management | external (no node agent); configuration and backups by shell scripts and systemd timers |
| Database | `reosa_staging`, managed schema `public`; `auth` owned by an identity service's role (must be excluded); `supabase_migrations` holds a legacy ledger |
| Roles | per environment: `<env>_owner` NOLOGIN **with BYPASSRLS** owning `public` (159 FORCE-RLS tables, 48 SECURITY DEFINER functions, 41 of them on FORCE-RLS tables); `<env>_auth`; `<env>_app` LOGIN BYPASSRLS, member of the owner with INHERIT; `<env>_migrator` NOLOGIN, member of the owner with SET TRUE, INHERIT FALSE. Production will get its own set on the same cluster |
| Legacy history | about 530 flat files `NNNN_name.sql` with drizzle `--> statement-breakpoint` comments; Supabase ledger `supabase_migrations.schema_migrations` (391 rows; `version` a 14-digit timestamp, `name` the file stem, `statements` one element = whole file with comments stripped); `public.applied_migrations` (187 rows; `filename text`, `applied_at timestamptz`); some files contain role DDL (top-level, and `CREATE ROLE … EXCEPTION WHEN duplicate_object` in DO blocks, and `GRANT role TO role`) |
| Backups | pgBackRest **2.59.3**, repository 1 on Cloudflare R2 (EU), repository 2 a monthly bundle, `aes-256-cbc`, `archive_mode on`, `archive_timeout 300`, systemd timers (diff Mon to Sat, full Sunday, monthly); PITR drills passed locally and on a freshly built host. pgBackRest **2.60.0** was released on 2026-10-18 |

---

## 7. Part A — the migration engine for real, imported schemas

Each item: design → contracts → bundle (additive) → implementation → tests against real PostgreSQL → docs → record. Items A1 to A3 are corrections of Wave 6 defects against DECIDED docs or contracts; A4 to A9 are new capabilities brought forward from Wave 10 by §3.1.

### A0. Phase 0 for Part A

Inventory record (actual SHA, what of §5 still holds); commit this order as `orders/wave-9-order.md`; record the §3 decisions (OD-7a/7b, the new ODs for D-A1 and D-B2, OD-4 and OD-8 status); open the Part A record (a new section "Part A correction and pull-forward" in a dedicated record file, e.g. `14-roadmap/gates/9-part-a.md`, following the gate-record shape: contract / implementation / evidence / status).

### A1. CLI legacy import works from the project file (Wave 6 correction)

- Accept both `baseline:<slug>` and `<slug>` on `--baseline` and from `legacy.baseline`; send the bare slug. No contract change.
- Add `--hints <file>` (JSON or YAML, checked against the request contract, same pattern as `cluster register --file`) for `aliases`, `role`, `searchPath`, `notApplicable`.
- Tests: CLI unit tests for every input form; an installed-CLI end-to-end test of `import analyze → report → resolve → baseline` against the local lab.

### A2. Supabase ledger matching on real data (Wave 6 correction)

- Name matching: compare the Supabase `name` with the file stem; carry `version` as `appliedAt` evidence. Keep the `version_name` form only as a fallback hint.
- Statement matching: compare the **joined executable statement sequence** of both sides, each normalized with the same lexical normalization as `c1` (`packages/migrations/src/format/sql.ts` `scanExecutableText`), so comments outside and inside statements, drizzle breakpoints and whitespace do not matter. Do not change `c1`. Add an explicitly weaker tier "comment-insensitive inside dollar-quoted bodies".
- Evidence strength, recorded per item: drizzle hash equal to file bytes = strong; exact executable statement sequence = strong; normalized sequence = medium; curated alias = curated; name only = weak; `applied_migrations` name = weak. **Name-only evidence never sets `recorded`.**
- Aliases become `string | string[]` (one ledger entry → several files), as `legacy-import.md` §6 promises; additive contract version.
- Implement or explicitly de-scope with a document change: date pinning and extension-schema declaration (`legacy-import.md` §2).
- Fixture: a **real-shape** synthetic Supabase history (14-digit timestamp versions, names equal to stems, one-element `statements` with comments stripped, drizzle breakpoints, inline comments, function bodies with comments, a multi-file entry) plus an `applied_migrations` table with the real column names.

### A3. Consistency and truthfulness fixes (Wave 6 correction)

- The legacy replay checks the execution role exactly like apply (with A4's exception model), at plan time and under the lock.
- Drift-item cap: record a truncation flag in the report; **refuse the baseline while the flag is set**; show the true total. No silent cap anywhere in the import path.

### A4. Declared BYPASSRLS execution-role exception (ADR-0034, new OD)

- New registry record per (project, environment, PostgreSQL role): attribute set restricted to `{bypassrls}` by a CHECK constraint; reason, declaring human, optional review/expiry date, revision; revocation. Additive bundle (e.g. `registry.execution_role_exceptions`).
- Declaring and revoking: `registry.manage:<tier>`, human-only (never MCP, like `evidenceOverride: none`); production needs approval plus re-authentication.
- `executionRoleProblem(facts, allowedAttributes)` stays pure and returns `declared_exception` only when BYPASSRLS is the **sole** problem and it is declared; SUPERUSER, CREATEROLE, CREATEDB, REPLICATION, LOGIN and reach into `pg_*`/`exponetdb_*` are never excusable.
- New warn rule `migration.execution-role-exception` (visible in every plan); on production it raises the plan risk to at least `high`.
- Bindings: the plan binds `{exceptionId, revision}` in its expected state (plan content grows, plan-hash construction unchanged); `checkBindings` and the executor's re-check under lock refuse a revoked or changed exception with `PLAN_STALE`.
- Audit events for declare and revoke; a drift finding when the live role's attributes no longer match the declaration; evidence check that staging and production roles have equal attributes and exception status (warn on mismatch).
- Threat-model update (T-new): what an authored migration could read under BYPASSRLS, why it is accepted for declared Supabase-origin schemas, and the compensating controls (lint, verification, audit, review of agent plans).
- Tests: unit (declared/undeclared, superuser never excusable), policy rule tests, integration (plan deny/allow, revoke between plan and apply → `PLAN_STALE`, agent principal on nonprod allowed and on production approval-bound, audit, replay role check, drift finding).
- Documents: `credentials-and-roles.md` §3 (amended DECIDED rule, with the ADR), `policy-engine.md`, `threat-model.md`, `legacy-import.md`, `04-migrations/README.md`. Also record the recommended **target state for adopters**: move SECURITY DEFINER functions to a dedicated definer role so the owner can drop BYPASSRLS later; the exception is a supported bridge, not a hidden permanent hole.

### A5. Per-environment execution-role bindings (ADR-0034 or a short ADR of its own)

- New additive bundle `registry.execution_role_bindings (project_id, environment_id, alias, role)`; the project map stays as default.
- One resolver `executionRolesFor(target)` replaces every direct reader listed in §5.1; no code path reads the project map directly afterwards (add a test or lint that enforces it).
- Changing a production environment's binding needs `registry.manage:prod`; a binding change between plan and apply → `PLAN_STALE`.
- The replay resolves the role for the scratch target's environment.
- Tests: staging and production of one project on one cluster with different roles; a production plan consumes staging evidence with the same checksum; golden plan-hash vector appended.
- Fix `credentials-and-roles.md:104-106` and the registry docs so code and docs agree.

### A6. Legacy files with cluster-global effects

- **Replay elision**, for legacy replay only, never for real migrations: role statements, and DO blocks whose PL/pgSQL body contains only role DDL plus exception handlers, are elided from the replay; mixed DO blocks stay `ambiguous` and need a human decision.
- Each elided statement is listed per file in the analysis and recorded as a **cluster-global expectation** (`pg_roles` attributes, `pg_auth_members` with INHERIT/SET/ADMIN, `pg_db_role_setting` for `ALTER ROLE … SET`), checked by the observer against the imported target's live catalog → evidence `cluster_global_held:n/m`. A file whose expectations do not hold cannot be `recorded_present`.
- The same treatment for `CONCURRENTLY` index statements (replayed non-transactionally or verified structurally, as the design decides) and for comment-only files (`no_statements` evidence instead of a refusal).
- Tests: fixture files for top-level role DDL, the DO-block pattern above (assert the measured 42501 behavior on PostgreSQL 16, 17 and 18), `GRANT role TO role`, `ALTER ROLE … SET`, mixed DO blocks, `CREATE INDEX CONCURRENTLY`, comment-only files.

### A7. Scratch targets that can be prepared and reused

- A read-only preflight `migration import scratch-check` (REST, CLI; MCP only if read-only and scoped): extensions present and in the same schemas as the imported target, referenced excluded schemas (such as an identity service's schema) present as schema-only copies, owner and execution role facts, emptiness, oid/marker state.
- A documented and tested **in-place reset** of a consumed scratch target that keeps the database oid and the identity marker.
- A database-retire operation (planned, audited) so a wrong registration can be corrected without hand-editing the Control Store.
- Docs: tell operators to freeze out-of-band DDL on the imported target between analyze and baseline, and show the fingerprint check that enforces it.

### A8. External-cluster onboarding without hand-made SQL

- Bootstrap SQL becomes **idempotent** (guarded statements) and can be generated for databases **before** they are registered (`?database=`); it emits the owner-membership grant for the migrator (`WITH INHERIT FALSE, SET TRUE`) from the registry, and a "legacy ledger read" section for declared legacy ledgers.
- A CLI command to declare a cluster's tier (OD-22), with the same authority rules as the Web App.
- `pg_hba` and network guidance for external clusters (hostssl, SCRAM, source address of the worker), plus a short operator walkthrough "onboard an existing self-managed cluster" from `server create` to an active target, with expected outputs.
- Document that `cluster register` always creates an external cluster and how a cluster later gains an agent.

### A9. Documents brought up to the real state

`reosa-current-state.md`, `reosa-integration.md` (§3 and §4: staging already on `reos-db-01` as an external cluster without an agent, a self-hosted identity service, production still on the hosted provider), `legacy-import.md` §1 counts, `credentials-and-roles.md` (§3, §8), `bootstrap.md:19-20`, and the IP/TLS facts of §6 in every document listed there.

### A10. Part A done

All A-items PASS with evidence, or explicitly `NOT PROVEN` with the reason; G6 frozen contracts and golden vectors unchanged; two independent review rounds; pull request with the Part A record. **Then stop and report to the owner before Part B's host-touching phases** (you may continue with B1, which is Control-Plane-only, while the owner reviews).

---

## 8. Part B — Wave 9

### 8.1 B0: decisions and the storage spike

- Confirm OD-8 is decided (stop and ask otherwise). Record OD-4 (engine per D-B1) and the adopt-then-own ADR (D-B2).
- **pgBackRest version and the 2026-10-04 advisory:** determine from the project's release notes which release fixes the weak-subkey/salt issue described in `backup-engines.md` (§2 notes), whether 2.59.3 is affected, and write the project's published check procedure for existing encrypted stanzas into the adoption runbook. Pin the version per `backup-engines.md` §3.
- **Storage spike on disposable buckets** (never the owner's real buckets), end-to-end backup → verify → restore → PITR with pgBackRest:
  - Cloudflare R2 with **bucket lock rules**. Verified facts (Cloudflare docs, 2026-10-21): bucket locks prevent **deletion and overwrite**; rules can be scoped by prefix; any token that may edit the bucket configuration can remove a rule; R2 does not implement the S3 Object Lock API (no retention modes, no legal hold). pgBackRest rewrites `backup.info`/`archive.info`, so a lock may cover only WAL-segment and backup-set prefixes, with expiry retention ≥ lock duration. Prove whether this works, and whether the host's token can delete a locked object (it must not).
  - Hetzner Object Storage with S3 Object Lock (the docs' recommendation for repository 1).
  - Record the results; the G9 security item "object lock prevents deletion by the host's credentials (tested)" must be tested with the host's real credential shape. If R2 is chosen, the gate wording becomes "provider lock, overwrite-aware, rule changes impossible with the host's credentials" through an ADR, not by silently relaxing it.
- **Stop and ask** the owner for the storage decision with the measured results.

### 8.2 B1: Control-Plane-only work (no host contact)

- New additive bundles: findings that allow `advisor` and `backup` kinds and cluster-level subjects; statement statistics (samples, deltas, reset detection); catalog mirror (`backup_repositories`, `backup_policies`, `backups`, `wal_coverage`, `restores` per `09-backups-and-restore/architecture.md`); drill records; data retention per `data-retention.md`.
- Statement statistics: `pg_stat_statements` deltas every 5 minutes, top 200, reset detection, regressions linked to migrations (`10-observability/performance.md`); table statistics.
- Advisors: clean-room catalog (security, performance, operations, change safety), findings with source and time, "draft fix" only as a migration draft within OD-44's limits.
- Standing-access findings (Wave 7 order decision 10).
- `connections.cancel` and `connections.terminate` as plans with the shared "stalled" predicate (`10-observability/health.md`), precondition token re-checked in the same statement, bound to `pid` + `backend_start`; replication and backup sessions never terminable.
- RPO/RTO computation from the mirror; "unknown" when an input is missing; a cluster without a passed drill is "unproven".
- REST handlers, SDK namespace, CLI commands and the four planned MCP tools (`query_stats`, `table_stats`, `advisors_run`, `backups_list`), all over `packages/application`.
- Web App: replace every Wave 9 placeholder (§5.3) with real pages, keeping the `Readable<T>` truthful states; no mock data.

### 8.3 B2: node capabilities for backups and restores

- Entry condition: D-B5 (G5 items 2 and 4 closed on a disposable VM, or the owner's explicit decision).
- An asynchronous, durable long-run design for the helper (backups and restores outlive the 15-minute helper limit): start, progress, crash recovery, cancellation, result proof bound to job, plan, node and cluster identity; ADR.
- Allowlist additions for pgbackrest and restic (binaries and packages), fixed argv only; no shell, no free text from the Control Plane.
- Capabilities: `backup.list@1` and `backup.verify@1` first (read/verify), then `backup.run`, `backup.expire`, `restore.prepare`, `restore.execute`, `restore.verify`, `restore.discard`; `service.status` extended to backup timers.
- **Adopt mode** (D-B2): observe an existing stanza and its schedules without changing them; a planned hand-over to ExponetDB-owned configuration and schedules, verified, reversible until confirmed.
- Repository configuration through signed `config.update` once owned; secrets sealed to the agent with an offline copy (`secrets.md`); `archive_command`/`restore_command` stay withheld from exports.
- L2 `pg_dump` and L3 restic to a second provider (D-B4).

### 8.4 B3: restore planning, drills and runbooks

- Restore plans per `09-backups-and-restore/restore.md` (purposes drill, clone, recovery; no in-place restore), destination identity checks, human-only execution with re-authentication, policies `restore.target-identity`, `restore.source-verified`, `restore.human-only`, `backup.repository-healthy` (and `restore.clone-masking` only if clones are in scope; default: not in scope).
- Drills: latest backup, an older backup, PITR to a random point; verification with amcheck, fingerprint, ledger head, row counts.
- **C-35:** a generated, plain-shell restore runbook from the repository configuration, and a drill with the Control Plane stopped and offline keys.
- RB-06 (WAL archive failing), RB-07 (disk high), RB-08 (restore) as complete documents.
- Failure injection: archive blocked, storage unreachable, wrong key, lock refusing deletion.

### 8.5 B4: close the expiring G6 waivers

E25 and the partial cases E4, E5, E7, E8, E9, E11, E13, E14, E15, E26, E28, each with an executed test and the record updated. The backups fact now feeds `migration.destructive-backup`; prove that a destructive production migration is refused without a verified backup and allowed with one (OD-21 break-glass stays refused while OD-21 is open).

### 8.6 B5: G9 record

`gates/9.md` with every G9 criterion in contract / implementation / evidence / status columns, the security items (**S**) never waived, the product gates PG-13, PG-14 and PG-16 marked with what Wave 9 proves and what only Wave 11 can prove, and the owner test package (§12). Status **awaiting owner acceptance**.

---

## 9. Server gaps (additive, contracts first, in the phase that needs them)

Contracts in `packages/contracts` first, then generated artifacts (`bun run generate`), never hand-edited. Expected additions: the A4/A5 registry resources and actions; the A7 preflight and database-retire; the A8 bootstrap parameters and tier command; the restore-plan route; `restore_plan` and read-only backup MCP tools (no MCP apply of restores, no MCP node planning, OD-29); findings kinds; statement-statistics reads; drill reads. Every new action has its scope, tier rule, risk class and audit event in the action catalog.

---

## 10. Phases (suggested order)

1. **A0** Phase 0: inventory, order committed, decisions recorded, Part A record opened.
2. **A1, A2, A3** Wave 6 corrections, each with its tests.
3. **A4, A5** ADR-0034, bundles, policy, resolver, tests.
4. **A6, A7, A8** replay elision, scratch preflight/reset/retire, onboarding.
5. **A9, A10** docs, reviews, Part A pull request and record. **Stop and report.**
6. **B0** decisions, advisory check, storage spike. **Stop and ask for storage.**
7. **B1** Control-Plane-only work (may start after A10 while the owner reviews Part A).
8. **B2** node capabilities (after the D-B5 entry condition).
9. **B3** restore, drills, C-35, runbooks.
10. **B4** G6 waivers.
11. **B5** reviews, G9 record, owner test package.

---

## 11. Checks and tests

- Every PostgreSQL claim is tested against real PostgreSQL 16, 17 and 18 where behavior differs (role DDL, `pg_stat_statements`, `pg_auth_members` options).
- Frozen contracts and golden vectors unchanged (`bun run golden:check`, `bun run golden:history`); all earlier waves' tests stay green; never skip, disable or quarantine a test.
- Security tests: no excusable attribute beyond BYPASSRLS; agents cannot declare or revoke exceptions; MCP cannot plan node changes or apply restores; restore destination identity enforced; locks refuse deletion with the host's credentials; secrets never in logs, errors, MCP output, audit, exports or API responses.
- Truthful states: every new read returns `Readable<T>` semantics; a failed read is an error, never an empty list; `unknown` never renders green.
- Installed-CLI end-to-end tests for the new commands; Web App component, render, accessibility and E2E tests for the new pages; CSP stays strict.
- Record every run with commit, command and result; no PASS from a workflow file.

## 12. Documentation and owner test package

- Docs updated in the same commits (§7, §8); ADR-0034 (and further ADRs for adopt-then-own, the long-run helper, and any gate-wording change); `open-decisions.md` entries; CLI reference regenerated (`bun run --cwd apps/cli reference`); `agent-help` current.
- **Owner test package for Part A:** a copyable walkthrough on the local lab that onboards a synthetic, Supabase-shaped external cluster end to end: server, cluster, idempotent bootstrap, tier, database, staging and scratch targets, execution-role exception, per-environment binding, scratch preflight, legacy import with the real-shape fixture (analyze, report, resolve, baseline), then a first bundle applied by an MCP agent on nonprod, with expected outputs. The owner then runs the same steps against REOSA staging in a REOSA session.
- **Owner test package for Wave 9:** backup, verify, drill, PITR, C-35 drill, cancel/terminate, advisors, with expected outputs and known intentional refusals.

## 13. Stop and ask the owner (do not decide silently)

- OD-8 not decided at Phase 0.
- The storage decision after B0 (R2 with prefix locks and an ADR'd gate wording, or Hetzner Object Storage with S3 Object Lock, or both in different layers).
- No disposable VM available to close the G5 waiver.
- Any change to a DECIDED security rule beyond ADR-0034's scope, any constitution exception, or any wish to relax a G9 **S** item.
- Anything that would touch a real host, a real bucket, a real database, the deployment on `reos-01`, or another repository.
- Clone-with-masking in scope or not (default: not in scope).

## 14. Definition of done and handoff

- **Part A:** merged-ready pull request; Part A record with every item PASS or explicitly `NOT PROVEN` with a reason; ADR-0034 and the OD entries; the owner test package; two review rounds documented.
- **Part B:** G9 record **awaiting owner acceptance**, owner test package, RB-06/07/08 documents, every placeholder page replaced, expiring G6 waivers closed or truthfully listed.
- The final report names the exact base and head SHAs, what was proven where (lab, container, VM), what remains `NOT PROVEN` and why, and what the owner must decide. No self-acceptance of any gate, no deployment, no real host change.

**Begin with the current-main audit and Phase 0 of Part A.**

# Wave 11 dress rehearsal, restore and clone traps, scale (tester S5, block B)

Commit under test `d51da5d0` (fix PR #46). Server `vc-2` (4 vCPU, 8 GB, UTC), stack `s5` built with the S1 kit (`D/infra`, notes in [`NOTES.md`](./NOTES.md)),
`AGENT=0` (no node agent: the clusters are external), PostgreSQL 17.11 as the main target, 16.15 and 18.6 for the import part. Date 2026-10-29, 20:25 to 23:10 UTC.
Raw logs stay on the server (`/srv/work/logs-s5`, index in [`logs-index.md`](./logs-index.md)); this folder holds scripts, small excerpts ([`results/`](./results)) and the timings.

**Verdict: PASS with findings.** The whole flow runs end to end with the CLI: import, baseline, plan, apply under load, drift, backup, point-in-time restore,
reconcile, promotion through the evidence rule, replay check. The refusals that matter held (never-verified checksum, altered bundle with the same id, clone behind a
registered name, a foreign instance behind an endpoint, a destructive production change without a verified backup): **nothing was ever executed on a wrong or
unverified target, and no way to change production without the gates was found (no P0).** What the rehearsal found is how the flow *feels* to an operator: errors that do not
name the cause, a drift baseline that falls behind after a plan that stops part-way, hazards that the plan does not predict, and limits nobody announced.
Findings: 15 (11 P2, 4 P3, no P0, no P1). The harness refused a write of `F/findings-S5.md` and `F/decisions-S5.md` from this agent, so both texts are in the agent's final message
(the lead saves them as `F/findings-S5.md` and `F/decisions-S5.md`).

## 1. What was built

| Item | Result |
|---|---|
| Schema generator [`scripts/gen_legacy.py`](./scripts/gen_legacy.py) (seeded, deterministic) | **306 tables** (240 `public`, 24 `auth`-like, 8 `storage`-like, 34 `app_private`), **165 tables with RLS and 402 policies**, 71 functions (39 `SECURITY DEFINER` with `search_path`, SQL and plpgsql), 157 triggers, 25 views (some `security_invoker`), 6 materialized views, 194 sequences (identity columns included), 20 enums, 580 indexes, 5 extensions (`pgcrypto`, `uuid-ossp`, `pg_trgm` created by the history in schema `extensions`, `pg_stat_statements` by the setup), roles `anon`/`authenticated`/`service_role`/`authenticator` with memberships, grants, `ALTER DEFAULT PRIVILEGES`, publication `supabase_realtime`. Counts: `results/summary-facts.txt` |
| Data | **4.4 GB** (4,755 MB `pg_database_size` after the history and the bundles; about 16M rows: `events_log` 5M, `storage.objects` 1.5M, `audit_log` 1.5M, `billing_items` 1.5M, `crm`/`sales`/`tasks` items 1M each, five smaller ones). The brief allows 1 to 5 GB; the task text said 2 to 3 GB, this is above it because the generator's default scale was kept. Load 4 min 12 s (`generate_series`, replica role, one transaction per table) |
| Legacy history | **150 `supabase/migrations`-style files** `YYYYMMDDHHMMSS_slug.sql`, applied in order by `apply_legacy.sh` (one transaction per file, the CONCURRENTLY file outside one) in 7 to 9 s, plus `supabase_migrations.schema_migrations` with 149 rows holding the whole file (comments stripped) in one `statements` element, as a real Supabase ledger does |
| Hostile content | a role-only `DO` block; a `DO` block with a catalog query and dynamic SQL; `CREATE EXTENSION ... SCHEMA extensions` (3 times); policies; grants; `ALTER DEFAULT PRIVILEGES`; `CREATE INDEX CONCURRENTLY`; data statements in a migration; a comment-only file; a rename; **a file edited after apply** (default 0 applied, 1 in the repository); **a duplicate** (`add_search_index` twice); **a gap** (ledger entry whose file was deleted: the file that dropped `legacy_sessions`); **an applied file never recorded in the ledger**; **a hotfix applied out of band** (column, policy, index) |
| Pinned targets | `lab/platform/rhstg` (staging-like, nonprod, the 4.7 GB database), `rhscr` (scratch), `rhprod` (production tier, evidence from `rhstg`, schema only), `rhrep` (empty, for the replay), `rh18`/`rh16` plus scratch (the other majors) |

## 2. The flow, step by step, with times

All commands are the product's CLI as the signed-in owner; the browser parts (re-authentication, approval, step-up confirmation) are the S1 kit's scripted human. Times are
wall clock from `timings.tsv` unless marked. "Actions" counts what a person must do (command, confirmation, approval).

| Step | What happened | Time | Actions |
|---|---|---|---|
| Stack | `stack-up.sh` from nothing (warm Bun cache) | 4 min 15 s | 1 |
| History + data | 150 files, ledger, 4.4 GB | 8 s + 4 min 12 s | scripts |
| Preflight | `scratch-check`: failed for extensions (3) and legacy references (`uuid_generate_v4`), fixed by installing the extensions on the scratch target; then `ready` | 0.3 s per run | 1 + fix |
| Analysis 1 (`import analyze --apply`) | **`incomplete`**: `replay_failed:20240417041947_realtime_publication:MIGRATION_STATEMENT_FORBIDDEN` (`CREATE PUBLICATION` is refused); the operation ends `verification_failed`; scratch consumed; reset in place with `scratch-reset-sql` | 14.7 s, reset 2 s | 3 |
| Analysis 2 (file excluded with `notApplicable`) | report `open`, 163 items, **23 ambiguous**: 7 `expectations_unreadable` because the observer role lacked `USAGE` on `auth`, `storage`, `app_private` | **21.6 s**; worker RSS 173 to **265 MB** (serve flat at 189 MB) | 2 |
| Analysis 3 (after `GRANT USAGE ... TO exponetdb_observer`) | 16 ambiguous, exactly the hostile content: the table with the dropped `legacy_sessions` (6 failing expectations), the file edited after apply (`effects_not_derivable`, and `column crm_items.priority differs default` as drift), 2 ledger entries without a file (the gap and the excluded publication file), 4 hand-made objects (`only_in_target`), 7 `only_in_replay` items of `legacy_sessions`; the duplicate, the unrecorded file, the `DO` blocks and the `CONCURRENTLY` file classified without a decision | 21.6 s | 2 |
| Review | `import resolve` for 16 items with a note each (scripted loop) | 7.2 s | 16 |
| Baseline (staging) | plan + apply + verify: "passed (structural 0 of 3614 failed, 6 excused by review decisions)" | 7.5 s | 1 |
| Production import | analysis (needs `--yes`), 13 decisions, baseline plan; **apply needs a step-up confirmation and an approval** | 20 s + 7 s + 0.9 s + about 25 s | 1 + 13 + 4 |
| Bundles | 5 authored (mixed risk) with `migration new`; lint at the default (prod) tier: 8 blocking findings until the manifests declare `potentially_breaking`/`data_rewrite`/`destructive` and the `verify.sql` uses `pg_catalog.` names; at `--tier nonprod` 0 blocking | 1 s per bundle | |
| Plan | 5 bundles planned: decision `allowed`, per bundle lock severity high/high/high/**critical**/high, compatibility `destructive` | 1.0 s | 1 |
| Apply 1 (unloaded) | bundles 1 to 3 applied and verified, **bundle 4 failed `0A000`** (`ALTER COLUMN TYPE` on a column read by two views), operation `verification_failed`, "Next: migration resume" | 11.7 s | 1 |
| Apply 2 (unloaded) | the fixed bundle (views dropped and recreated in the same transaction) with a second index bundle and the drop: all `applied/passed` | 16.7 s | 1 |
| **Apply 3 under pgbench load** | index build on `events_log` (5M rows) and a type change on `billing_items` (1.5M rows) at 300 tps: **p99 6 ms before, 8.75 s during, 4.8 ms after; 0 failed queries; 48% of the transactions inside the 16.6 s window took longer than 1 s** (`results/apply-under-load.txt`) | 16.6 s | 1 |
| Drift | after the 8 legitimate bundles: **34 drifted (6 critical)**, see the finding on the drift baseline; accepted (`findings/{id}/accept`, REST only); then 6 hand-made changes: **5 drifted (2 critical)**, the table comment is not seen | 1.1 to 1.5 s per check | 2 + 1 |
| Backup | `pg_basebackup` of 4.8 GB with the WAL archive (`archive_timeout` 60 s). **Product path NOT RUN** (see section 6) | **15.5 s** | |
| More data and bundles | marker writer (1 commit per second) + pgbench -R 100; bundles 6 and 7 planned and applied while the first drift is still open (bundle 6's own objects show up as drift too, nothing is adopted) | 4.4 s each | |
| **PITR to just before bundle 7** | cluster stopped, directory moved away, base backup copied back, recovery to `21:08:17.001` | **RTO (stop to accepting) 13.4 s** (copy 9.3 s, recovery 3.4 s); **RPO against the target 0**: 105 marker commits before the target in the client log, 105 restored, none after | 1 script |
| What the system says | `target show`: health healthy, `Ledger: unknown`; `migration status`: `Mirror: out of sync`; `migration plan`: `LEDGER_DIVERGENCE ... missing: <bundle 7>`; no finding, no health condition | detected at the first plan, 0.9 s | |
| **Reconcile** | `migration ledger reconcile --note ...` + `plan apply`, **no approval, no step-up** on a nonprod target; bundle 7 planned and applied again | 3.9 s + 5.3 s | 4 |
| Whole recovery | decision (stop) to ledger, mirror and bundle consistent again | **72 s** (21:09:31 to 21:10:43) | |
| Promotion | bundle 1: plan `approval required`, `Evidence: present`, apply with approval; `Lineage: mismatch` (warn) because staging has the hotfix. Same for an independent bundle. Each | 25 s | 3 each |
| Cheat A | a bundle never applied on staging: `PLAN_DENIED`, `migration.staging-evidence: The evidence target has not applied and verified this checksum.` | 0.9 s | |
| Cheat B | the verified bundle's `up.sql` altered, same id: `MIGRATION_CHECKSUM_MISMATCH ... Applied history is immutable` (also toward staging); `--stored` plans the genuine bytes | 0.4 s | |
| The whole chain to production | `PLAN_DENIED`: lint (3 blocking at the prod tier), `destructive-backup`, `lock-risk critical`, `compatibility destructive`, lineage | 1.0 s | |
| Destructive bundle, evidence present | plan `approval required` + "a verified backup newer than PT24H"; **apply: `INTERNAL`, no operation, no log line** (finding) | 20 s | |
| I10 replay | 149 legacy files + 12 bundles into an empty database: 8.9 s. `fp1` replay `e7f771...` against live `8f4c94...`: **+7 -7 ~6 (=4260), every difference explained** (`results/i10-replay-schema-diff.txt`) | 8.9 s | |
| PostgreSQL 18 and 16 | scratch-check, analysis, 18 decisions, baseline, plan, apply of **14 bundles in one plan**, drift **clean** | 18: analysis 20.1 s, apply 21.7 s; 16: 20.1 s, 16.1 s | |

## 3. Restore and recovery numbers (what was achieved, not promised)

| Scenario | RTO | RPO | System consistent again |
|---|---|---|---|
| Planned PITR in place to `21:08:17` (before bundle 7) | 13.4 s to accepting connections | 0 against the chosen target (105 of 105 markers; the 74 later commits are gone by design) | 72 s from the decision: `LEDGER_DIVERGENCE` at the first plan, reconcile (plan + apply), bundle 7 planned and applied again |
| Unplanned loss (kill -9 of the primary, base backup + WAL archive only, new instance `rs1` on another port) | 16.3 s (copy 10.0 s, start 3.2 s, replay 1.2 s) | **12.0 s**: the last commit the client saw was `21:28:31.19`, the last recovered `21:28:19.19`; 12 marker commits **and a bundle applied 11 s earlier** are lost (ledger head `drop-docs-tags`) | 4 min 24 s with the registry steps done one at a time: endpoint add (plan, apply, approval), health, endpoint retire (the same), `LEDGER_DIVERGENCE`, reconcile, bundle planned and applied again; 10 commands, 2 approvals, 0 step-ups |
| Promote a streaming standby (`pg_ctl promote`) and re-point | | 0 | the registry pointed at the **standby**: health healthy, plan allowed, apply `failed`/`OUTCOME_UNKNOWN`; after the promotion the same apply passed |

RPO is bounded by the archive: `archive_timeout = 60 s` plus the segment in flight. The product's drills and Control Plane restore were NOT RUN here (no node agent): the numbers above are
plain PostgreSQL tools (`pg_basebackup`, archived WAL, `recovery_target_time`), chosen because the product path needs the node agent and adopted repository that S2 measured separately
(`C/backup-restore.md`); the ledger and registry behaviour after the restore is the product's own and is what was tested.

## 4. Restore and clone traps (task B)

| Case | What the product says | Executed? | Way forward |
|---|---|---|---|
| `CREATE DATABASE ... TEMPLATE` clone, registered as a second target | `TARGET_REGISTRATION_REFUSED ... reason: other_target` (no id of the other target; the CLI text says "register a different database") | no | drop the copied `exponetdb` schema, then it registers as a new target without history (tested, works) |
| `pg_dump \| pg_restore` clone in the same cluster | the same refusal | no | the same |
| The clone takes the registered name (rename swap) | `target show` **healthy**, drift **clean**, `migration plan` **allowed** (finding), apply of the old plan and of a new plan: `PLAN_STALE` "The plan no longer matches the target. Create a new plan." (no cause; the registry holds the old database oid, the clone has another) | no | swap back; nothing tells the operator that the oid changed |
| Rename of the registered database | health `unreachable`; `migration plan` **`INTERNAL`** (the log has `TARGET_SQL_ERROR`) | no | rename back |
| Restore into another instance (physical, same system identifier) | add endpoint, health probes `identity ok`, retire the old endpoint: healthy | yes, after reconcile | endpoint change is the only path (no placement move) |
| New instance by logical copy (another system identifier) | endpoint add accepted by the plan; probes: `identity_mismatch critical`, **targets `rhprod` and `rhrep` suspended at once** (`TARGET_SUSPENDED reason: identity_mismatch`) | no | retire the endpoint, `target resume --reason ...` per target (the prod one needs approval: 50 s) |
| Hot standby behind the endpoint | health healthy; plan allowed; apply `failed` with `OUTCOME_UNKNOWN` ("Nothing was applied") | no | promote, apply again |
| Logical replication subscriber as target | nothing: health healthy, drift clean, 0 findings; the stuck subscription (3 apply errors, slot inactive and retaining WAL) is invisible; a migration applied normally (and happened to add the missing column) | yes | the product has no concept of replication roles |

## 5. Scale (task C)

| Check | Result |
|---|---|
| 100 targets through the registry (`add_target`: environment, database, bootstrap, plan, apply) | 100 in 636 s, mean 6.35 s (5.1 to 7.3), flat from the first to the last; 113 targets listed |
| Target list pagination | pages of 1, 7, 50, 100: 113 ids, 113 distinct, equal to the Control Store; 17/3/2/113 pages |
| 16,272 open findings (a drift check opens 500 per check; 33 checks) | pages of 50, 100, 1000, 5000: **16,272 distinct ids each, equal to the Control Store**, no gap, no duplicate. Whole list in 4.1 s (5000 per page), 65 s (100 per page), 126 s (50 per page, CLI process per page). `--all` stops at 10,000 (documented in `--help`). A drift check on 16k objects takes 8 s growing to 13 s (every check updates every finding) |
| Web App list with 10,000 rows | **NOT RUN**: no browser on vc-2 (REST/CLI only) |
| 500 bundles, local lint (`--tier nonprod`) | fan-out **1.8 s**, chain 22 s, **diamond-ish 45 s** (250 bundles: 5.5 s, so about cubic: 1,000 would be 6 minutes, 5,000 half a day); RSS 165 MB |
| 500 bundles in one plan | **rejected by the contract**: `bundles: Too big: expected array to have <=50 items` (200 stored ids). In batches of 50: 1.7 s each in all three shapes; 200 stored ids: 3.5 s (diamond), 1.4 s (fan-out). Worker RSS 443 MB, serve 313 MB (they had grown during the session) |
| 5,000 bundles | **NOT RUN**: the plan cap and the lint curve make a single plan impossible; see finding |

## 6. What was not run

* The product's own backup path (node agent, adopted pgBackRest repository, drills, product `restore.plan`): `AGENT=0`; S2 measured it. The destructive-backup requirement could therefore not be satisfied.
* Reconcile and point-in-time restore on a **production-tier** target (the production target holds schema only).
* A browser: the Web App list at 10,000 rows, the review dialogs.
* Concurrent applies and failure injection during the rehearsal (S1 covered them).
* Hosted Supabase `auth` schema handling (owned by another role, outside the scope): here `auth` is in scope and owned by the execution role.

## 7. Files

`scripts/` (generator, driver, step scripts `steps/NN-*.sh` in the order they ran, pgbench scripts), `results/` (small excerpts), `timings.tsv`, `NOTES.md`, `logs-index.md`.

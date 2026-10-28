# Security review of the three Control Store bundles added by fix PR #46 (tester D0)

| | |
|---|---|
| Tree under test | `T` = `/home/david/Development/ExponetDB-verify` at `d51da5d0` (read only; no edit, no build output) |
| Bundles | `01M61AGQKSBZ9VN71DHYFVCQHT_operation-supersession`, `01M61C90YHV706H2B8EW39TBAF_ledger-reconcile`, `01M61FKAJN5VP9H2E73K74NCZ2_offline-drill-record` (`packages/control-store/migrations/`) |
| Method | static review of the bundles, the calling code, the frozen bundles they build on and the product documents; live exercise against a throwaway PostgreSQL 17.11 (`docker run postgres:17.11`, container `d0-pg`, `127.0.0.1:56500`, removed at the end); the product's own tests run against the same container |
| Label | **All live results are exploratory.** Node 26.5 / Bun 1.3.14 on the lead's machine (not the pinned Node 24.22.1 / Bun 1.4.4). Where I applied bundles with my own `psql` harness (`D/d0/apply_bundles.py`) that is not the product runner; where I say "product runner" the repository's `migrateControlStore` ran (via the repository's vitest integration tests, in a scratch copy of `T`, not in `T`). |
| Raw material | `D/d0/` (scripts, fixtures, SQL exercises, `logs/`, `tests/`); scratch copy and logs outside `EV` were under the session scratchpad |

## 1. Verdict

| Item | Verdict | One line |
|---|---|---|
| **Bundle 1 `operation-supersession`** | **PARTIAL** | The new edge is exactly one pair and adds no capability the worker did not already have; but the engine code that uses it closes the stuck operation *before* it checks the recovery (finding 1), and `verify.sql` would pass on a broken guard (finding 4). |
| `operations.recovery_transition_allowed(text, text)` | **PASS** | pure `IMMUTABLE STRICT`, one pair, `search_path = pg_catalog`, `REVOKE ... FROM PUBLIC`, execute for serve and worker only (needed because the guard runs as the invoker). |
| `operations.operation_guard()` (replaced) | **PASS** (text) / see finding 1 (use) | two differences from the frozen original, both explained in 2.2; owner, ACL, `search_path`, trigger binding unchanged. |
| **Bundle 2 `ledger-reconcile`** | **PARTIAL** | History table and function are sound as written (owner `exdb_migrate`, not a superuser; pinned path; target binding holds; atomic; append-only history). Gaps: the "insert-and-revert-only" mirror is not enforced by the database (finding 2), the function binds neither generation, ids nor lease and takes no row lock (finding 3), weak `verify.sql` (finding 4). |
| `migrations.ledger_mirror_history` | **PASS** | append-only against serve, worker, owner and superuser (`EXA01`); worker has SELECT only. |
| `migrations.archive_mirror_rows(...)` | **PARTIAL** | right target, right kind, right state enforced; other bindings not (finding 3); not reachable by serve, gateway, audit_maint, PUBLIC. |
| **Bundle 3 `offline-drill-record`** | **PASS** (with P3 notes) | one INSERT of mode `offline_runbook`, `attested` or `failed` only, table CHECKs and `drill_guard` still apply, executable by serve only. The function trusts its caller for cluster/repository pairing and `recorded_by` (the application checks both); a time ahead of the database clock becomes a 500 (finding 5). |
| `backups.record_offline_drill(...)` | **PASS** | as above. |
| Order on an existing installation / on a fresh install | **PASS** | linear `dependsOn` chain after `excused-value-digests`; product runner applied and verified all 45 bundles from empty and upgraded the G3B and G4 baselines; identical function definitions on both paths (2.7). |
| Transactional / rollback story | **PASS** | all three `transactional: true`; the runner test "rolls back a failing up.sql completely and records nothing" passed; no bundle has a `down.sql` (forward-fix only, by the product's own rule). |
| Frozen / pinned-checksum status | **PARTIAL** | not frozen, not pinned (neither are the 24 bundles after Wave 6); PR #46 changed no frozen bundle, the frozen list or the pin test (finding 6). |

Counts: 3 bundles (1 PASS, 2 PARTIAL); 4 functions + 1 table (4 PASS, 1 PARTIAL); 7 findings (0 P0, 0 P1, 2 P2, 5 P3); 5 owner questions.
No P0 and no P1: nothing here lets a caller change a production target without the gates; the worst result is a Control Store state change (a stuck operation closed, a lock domain released) that a refused recovery should not have caused.

## 2. Evidence per item

### 2.1 Definer inventory and privileges

Full ACL / owner / RLS / function-config dump of the control database at the pre-PR head (bundles up to `excused-value-digests`) against the head with the three bundles (`D/d0/acl_dump.sql`; 671 vs 676 lines; `D/d0/logs/acl_diff_pre_vs_post.txt`). The **only** differences are 5 additions: the three functions, `migrations.ledger_mirror_history` and its identity sequence. No existing table, column, policy, schema, or function ACL changed; **the worker gained no right on any table directly** (`exdb_worker` has `r` on the history table, nothing else new).

| Function | Definer? | Owner | `search_path` | Callable by | Source |
|---|---|---|---|---|---|
| `operations.recovery_transition_allowed(text,text)` | no (invoker, `IMMUTABLE STRICT`) | `exdb_migrate` | `pg_catalog` | serve, worker, owner | `operation-supersession/up.sql:8-14` |
| `operations.operation_guard()` | no (trigger, invoker) | `exdb_migrate` (kept by `CREATE OR REPLACE`) | `pg_catalog` | trigger only; ACL unchanged (`exdb_migrate=X`) | `operation-supersession/up.sql:18-64` |
| `migrations.archive_mirror_rows(text,text,integer,text[],text)` | **yes** | `exdb_migrate` | `pg_catalog, pg_temp` (pg_temp last) | `exdb_worker` only | `ledger-reconcile/up.sql:25-57` |
| `backups.record_offline_drill(text x7, timestamptz x2)` | **yes** | `exdb_migrate` | `pg_catalog, pg_temp` | `exdb_serve` only | `offline-drill-record/up.sql:5-21` |

* The definer owner is `exdb_migrate`: `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS` (`control-store/src/bootstrap-sql.ts:44`, mirrored in `D/d0/bootstrap.sql`; confirmed on the container: `owner_is_superuser = f`, `owner_bypassrls = f`). It owns every Control Store table, so a definer body runs with full table rights on all of them; the two bodies touch only `migrations.ledger_mirror[_history]`, `operations.operations/plans` and `backups.drills`.
* Every object in the bodies is schema-qualified; the only unqualified names are `pg_catalog` operators/functions (`= ANY`, `to_jsonb`, `count`). No dynamic SQL, so no injection through `p_ids`/`p_reason`/`p_notes`.
* `pg_temp`: the roles have no TEMP privilege (`REVOKE ALL ON DATABASE ... FROM PUBLIC` in the bootstrap); the worker and serve got `42501 permission denied to create temporary tables` (`logs/exercise_archive.log` A11, `logs/exercise_drill.log` C9), so a `pg_temp` shadow object cannot be created in the first place.
* `REVOKE ALL ... FROM PUBLIC` precedes `GRANT` in all three; `has_function_privilege('public', ...)` is false (also asserted by each `verify.sql` and by the frozen operations `verify.sql` last check, which passed on the head).
* Denials, as exercised (`logs/exercise_archive.log` A1, `logs/exercise_drill.log` C1/C2): serve → `42501 permission denied for function archive_mirror_rows`; gateway and audit_maint → `42501 permission denied for schema migrations` / `backups`; worker → `42501` on `record_offline_drill`; serve `INSERT/UPDATE/DELETE` on `backups.drills` → `42501` x3.

### 2.2 The replaced `operations.operation_guard()` against the frozen original

Frozen original: `01M46KJ34887CQ6GFEX3SXMC2G_operations-engine/up.sql:160-205`; replacement: `operation-supersession/up.sql:18-64`. `diff` of the two extracted ranges (sha256 of the extracted texts `848787ea...` vs `261b4111...`):

```
1c1
< CREATE FUNCTION operations.operation_guard() RETURNS trigger
---
> CREATE OR REPLACE FUNCTION operations.operation_guard() RETURNS trigger
24c24,25
<   IF NEW.state <> OLD.state AND NOT operations.transition_allowed(OLD.state, NEW.state) THEN
---
>   IF NEW.state <> OLD.state AND NOT (operations.transition_allowed(OLD.state, NEW.state)
>                                      OR operations.recovery_transition_allowed(OLD.state, NEW.state)) THEN
```

Every other byte is identical (no CRLF, no whitespace drift). Explanation: (1) `CREATE OR REPLACE` keeps the owner, the (empty) ACL and the trigger `operations_guard` that calls it; (2) the one added disjunct. I also compared the catalog text on the container, before and after the bundle (`pg_get_functiondef`): the same single hunk, `proconfig = {search_path=pg_catalog}`, owner and `proacl = {exdb_migrate=X/exdb_migrate}` unchanged, trigger `operations_guard` still `O` (enabled).

**Does the new edge allow anything beyond `needs_attention -> verification_failed`?** No. `recovery_transition_allowed` is `(p_from, p_to) = ('needs_attention', 'verification_failed')`; the frozen `transition_allowed` still has its 15 pairs (its frozen `verify.sql` passed). The old `state_admits` still gates the outcomes: from `needs_attention (unknown, pending)` the transition is refused unless the writer also changes `apply_outcome` (live: B4 `EXO01 outcomes do not match`; B5 `applied/failed` or `partially_applied/failed` accepted).

**Who can trigger it?** Only a role that is not `exdb_serve` and holds UPDATE on `operations.operations`: in practice the worker (and the owner). Serve is refused by the existing `EXO02` branch (live B1: `EXO02: serve may only approve or cancel an operation that has not started`). The edge has no lease requirement (needs_attention is not leased).

**Does it give the worker a capability it lacked?** No. At the pre-PR head the same end state is reachable in two steps (live `logs/exercise_pre.log` D2: `needs_attention(unknown) -> verifying` with `apply_outcome := applied` and a lease, then `-> verification_failed`; and D1 shows the one-step edge is refused there with `EXO01`). The edge removes the lease/claim requirement and the intermediate state, nothing else. The database continues to trust the worker for outcome truthfulness (a worker can rewrite `unknown` to `applied`; before and after).

**Lock side effect:** `locks_release` RLS lets the worker delete an operation's lock only when the operation is finished (`operations-engine/up.sql:250-253`). Live B6: `DELETE 0` while `needs_attention`, `DELETE 1` after the new transition. So the edge is precisely the key to releasing a stuck operation's schema domain; who may use it is decided in code, see 2.3.

### 2.3 Who closes what: the IDOR angle, and approvals on production

Code path: `packages/operations/src/supersede.ts:27-67`, called from `driver.ts:179`. The names come from `kind.supersedes(plan)`:

* `migration.verify` (`reverify.ts:380-386`): `content.supersedes`, written at plan time by `stuckOperationOf` (`recovery.ts:14-35`), which selects, from the lock table, the operation in `needs_attention` holding **this target's** `target:<id>:schema` domain whose plan mentions the migration. Server-derived, bound by the plan hash.
* `migration.resume` (`kind.ts:131-139`): `resume.originalOperationId`, taken from `resumeLog` (`resume.ts:123`), i.e. from the events **read from the target's ledger** (untrusted text, see finding 7).

Cross-target / cross-project / cross-tenant: **closed**, by `supersede.ts:36,49`: the named operation must (a) parse as an `op_` id, (b) be in `needs_attention` (read `FOR UPDATE`), and (c) hold a domain in the set the *recovery itself* locks (`expandDomains(kind.exclusivity(plan))`). Domains are per target (`target:tgt_...:schema`), so an operation of another target, project or tenant is left alone even when named. At most 16 names are read (`MAX_NAMED`). The repository's test `driver.int.test.ts` "closes only an operation in needs_attention that holds a domain the recovery needs" covers a recovery of another target naming the stuck operation; I ran it (`driver.int.test.ts` 10/10 passed, exploratory) but did not add a cross-project case: the property rests on the domain key, which carries the target id.

Approval on production:

| Recovery plan | Class | Production, a person (web/cli) | Production, MCP |
|---|---|---|---|
| `migration.verify` that names a stuck operation | `low` (`actions.ts:964-970`) | **`allow`: no approval, no re-authentication** | `require` approval (`migration.agent-production`, `policy/catalog/migrations.ts:471-495`) |
| `migration.resume` | `high` | `require` approval + re-authentication (`migration.nontransactional`) | `require` |
| `operation.force_release` (planned, not built) | `high`, `operations.recover`, re-auth 300 s | approval/reauth by action | n/a |

Reproduced with the real policy engine (`D/d0/tests/verify-supersede-policy.test.ts`, `D/d0/logs/verify-supersede-policy.log`: 2/2 passed). The decision does not read `content.supersedes`. A person holding `migrations.apply:prod` can therefore release a production target's schema lock domain, held by an operation that may have an `unknown` apply outcome, with a `low` plan and no second person. This is an owner question (decisions file D0-01), not a defect against the written design (OD-58 is open and "built with option (a)").

### 2.4 `migrations.archive_mirror_rows`: argument validation, history, races

Exercised on the container as the real roles (`D/d0/exercise_archive.sql`, `logs/exercise_archive.log`; fixture `D/d0/fixture.sql`: two targets, running/queued/needs_attention operations, mirror rows in two generations).

| Case | Result |
|---|---|
| serve / gateway / audit_maint | `42501` |
| running `migration.apply` (wrong kind), queued `ledger.reconcile`, `needs_attention` operation, unknown id, `NULL` operation | `EXM01`, nothing moved |
| operation of target 2 naming target 1; operation of target 1 naming target 2 | `EXM01` x2 (target binding holds, `ledger-reconcile/up.sql:36-38`) |
| unknown reason `'gone'` | `EXM01` (`up.sql:32-34`) |
| `NULL` reason | `23502` from the history table's NOT NULL, whole statement rolled back, mirror untouched (the `IF` is `NULL`-silent, the constraint catches it) |
| `NULL` ids / empty array / array of `NULL` | 0 moved |
| 300,000 ids matching nothing | 0 moved, 0.78 s (the array rides the primary key; a caller can only spend its own time) |
| happy path | 1 moved; history row has `reason`, `operation_id`, full row image (`to_jsonb`, 17 keys) |
| **other generation** of the same target (`OLD1`, gen 1) | **moved** (the function does not bind `p_generation` to the plan) |
| **ids the plan never named** (`M1`,`M3`) with a **wrong reason label** `'differs'` | **moved**, label accepted |
| history `UPDATE`/`DELETE`/`TRUNCATE` as owner and as superuser | `EXA01` x3 each; worker `INSERT` → `42501` |
| two concurrent calls for the same rows (`exercise_concurrent.sh`) | first moves 2, second blocks on the row locks then moves 0; history has 2 rows, no duplicate |

Append-only promise: **kept for the history**; the audit hash chain is not touched by any of the three functions. "A reconciliation deletes no row anywhere" holds in the sense that every mirror row leaves with a full `jsonb` image in the same statement (`WITH gone AS (DELETE ... RETURNING m.*), kept AS (INSERT ... SELECT to_jsonb(g) FROM gone)`, one atomic statement; `up.sql:43-52`); it is a physical `DELETE` of the mirror row, which the documents word as "no row is deleted".

**Race / TOCTOU (reproduced, exploratory):** the "running ledger.reconcile" check (`up.sql:35-42`) is a plain read with no `FOR SHARE`, separate from the `DELETE` statement. `D/d0/exercise_race.sh e1`: a session holds the row lock of `M1`; the call passes the check and blocks in the `DELETE`; meanwhile the operation moves `running -> verifying` and commits (19:35:18); the `DELETE` then proceeds (19:35:22) and moves 2 rows for an operation that is no longer `running` (`logs/exercise_race_e1.log`). With the engine's fence (`records.ts` `fenced` → `leaseHeld ... FOR SHARE`, `leases.ts:161-174`) the transition waits until the fenced transaction committed (`exercise_race.sh e2`, `logs/exercise_race_e2.log`: the flip commits after the fenced caller). So the **engine path is safe, the function alone is not** (finding 3).

### 2.5 `backups.record_offline_drill`

Exercised as serve (`D/d0/exercise_drill.sql`, `logs/exercise_drill.log`).

* Intended call: one row, `mode = offline_runbook`, `restore_id` NULL, `selection = latest`, `measured_rto_seconds` NULL.
* `outcome` other than `attested`/`failed`: `EXB06`; future finish, finish before start: `EXB06` (via `drill_guard`); NULL `recorded_by`, bad digest, empty or 4001-char notes: `23514`; duplicate id `23505`; unknown cluster `23503`.
* **Not checked by the function or the table:** a repository of *another* cluster (cluster 1 with repository of cluster 2 accepted), and `recorded_by` of any identity. The application checks the pairing (`packages/application/src/backups.ts:596`: `r.clusterId !== clusterId`), the runbook digest (`:598`) and uses the caller's identity (`:609`); the function trusts serve. A compromised serve can forge an `attested` or `failed` attestation (rows are append-only afterwards). Impact is small: offline attestations never count toward protection or RTO (`backups/src/protection.ts:249-251` measures `control_plane` drills only).
* Serve cannot change or delete what it recorded (`42501`, `EXA01` for the owner).
* Added write surface for serve is exactly this one insert (ACL diff). The function itself does not append audit; the application does in the same transaction (`backups.ts:631`), like every serve write.

### 2.6 `verify.sql`: do they prove what they claim? (mutation test)

`D/d0/mutate_verify.sh` copies the fully migrated database, breaks one promised property, and runs the bundle's checks the way `verify.ts` does (>= 1 row, boolean `ok`, all true). `logs/mutate_verify.log`:

| Mutation | `verify.sql` |
|---|---|
| S1 recovery edge also allows `needs_attention->verifying`; S2 allows every pair; S5 guard back to the frozen text; D1/D2 definer path unpinned or `public` first; D5/D6/D7 extra grants; L7/L8/L9 extra grants | fails, as it should |
| **S3** guard replaced by a no-op that has the name in a comment; **S4** guard calls the function but `OR true`; **S6** guard loses the serve restriction | **still passes** (`operation-supersession/verify.sql:16` is only `pg_get_functiondef(...) LIKE '%recovery_transition_allowed%'`) |
| **L1** history trigger fires on INSERT only; **L2** trigger disabled | **still passes** (`ledger-reconcile/verify.sql:3-4` only counts 2 triggers) |
| **L3** `archive_mirror_rows` loses its `search_path`; **L4** becomes `SECURITY INVOKER`; **L5** body drops the running-operation check and deletes by target; **L6** owner changed | **still passes** (`verify.sql:10-13` checks privileges only; no `prosecdef`, `proconfig`, `proowner` or body check) |
| **D3** `record_offline_drill` body inserts a `control_plane` `passed` drill with an RTO; **D4** owner changed | **still passes** (`offline-drill-record/verify.sql:10-12` checks `prosecdef` and `search_path` only) |
| S7 owner changed to another role | fails only incidentally (the runner role lost EXECUTE) |

Also: `verify.sql` is read-only and cannot run the behaviour (a transition, a refusal); the behaviour is proven by the repository's integration tests, which I ran (2.7). Against `control-database.md` §5a ("Every bundle's `verify.sql` checks ownership, grants, triggers and the absence of `PUBLIC` privileges") none of the three checks ownership. Not vacuous in the other direction: before the three bundles are applied all 7 checks of the three files fail (existing-installation database, `logs`), i.e. each file detects a missing bundle.

### 2.7 Order, fresh install, existing installation, frozen status, rollback

* `dependsOn`: `excused-value-digests (01M5X840BP8J...)` <- `operation-supersession` <- `ledger-reconcile` <- `offline-drill-record`; the graph has one head. `apply_bundles.py x order` lists them last.
* **Existing installation** (my harness): 42 bundles to `excused-value-digests`, then the three; **fresh** (harness): all 45. Both: all 45 bundles' `verify.sql` pass, and the md5 of all `pg_get_functiondef` of the `operations`/`migrations`/`backups` schemas is identical (`156c714f...`).
* **Product runner** (scratch copy of `T`, exploratory, `EXDB_TEST_PG_URL` = the container): `migrate.int.test.ts` 3/3 ("applies and verifies every shipped bundle from an empty database", "upgrades a Control Store at the G4 baseline: only the new bundles run"), `registry-schema.int.test.ts` 13/13 (the G3B upgrade lists the three ids explicitly and verifies all), `roles.int.test.ts` 20/20, `runner.int.test.ts` 10/10 (incl. "rolls back a failing up.sql completely and records nothing", checksum mismatch refusal), `operations/engine.int.test.ts` 18/18, `operations/driver.int.test.ts` 10/10, `immutable-bundles.test.ts` 3/3, `policy/migration-rules.test.ts` 19/19.
* **Frozen / pinned:** `packages/control-store/frozen-bundles.json` and `test/immutable-bundles.test.ts` stop at Wave 6 (21 entries); the three bundles, and the 24 bundles `01M4S5...` to `01M5X8...`, are neither frozen nor pinned. `git diff d0229550 d51da5d0` touches no frozen bundle, no `01M5*` bundle, not the frozen list, not the pin test. Consequence: an edit of a not-yet-deployed new bundle is caught only by the runner's checksum mismatch at startup after a deployment, not before merge (finding 6). The migration texts of TC-013 and the PRE-WAVE-11 review call the backup-catalog bundle "frozen"; it is not on the frozen list.
* **Rollback if a bundle fails halfway:** `transactional: true`, each `up.sql` and its ledger row in one transaction, so nothing of a failed bundle remains (runner test above); the first bundle replaces a live function, which is also inside that transaction. After a *committed but unverified* bundle the product rule is no automatic rollback (`down.sql` does not exist for any Control Store bundle); the three are additive, so the recovery is a forward-fix bundle.

## 3. Findings and open questions

Findings, in the required format: `F/findings-D0.md`. Owner-level questions: `F/decisions-D0.md`.

| # | Sev | Title |
|---|---|---|
| 1 | P2 | A refused recovery has already closed the `needs_attention` operation and released its lock domain |
| 2 | P2 | `migrations.ledger_mirror` is rewritable in place by the worker; "insert-and-revert-only" is code convention, so history can be bypassed |
| 3 | P3 | `archive_mirror_rows` binds neither generation, ids nor lease to the operation and takes no row lock |
| 4 | P3 | The three `verify.sql` files pass on broken bundles; none checks ownership |
| 5 | P3 | `POST /clusters/{id}/drills/offline` with a time ahead of the database clock is a 500 (`EXB06` unmapped) |
| 6 | P3 | The three bundles (and 24 earlier ones) are not pinned by a checksum test; the docs call an unpinned bundle "frozen" |
| 7 | P3 | `migration.resume` takes the operation it closes from the target's own ledger events (untrusted); NOT RUN |

(The numbers are local to this review; the lead assigns `VC-nnn`. The findings file lists them in this order.)

## 4. NOT RUN

* HTTP/route level: `apps/server/test/http-backups.int.test.ts` (TC-013 end to end), the `ledger/reconcile-plans` route, and the Go node agent: they need the managed-target servers of `bun run dev:targets` (TLS, PostgreSQL 16/17/18) and a node agent; I covered the database contract of the functions by SQL instead. So finding 5 is reproduced at SQL level (`EXB06`) and by grep for the missing mapping, not through HTTP.
* `packages/migrations-engine/test/reconcile.int.test.ts` and `recovery.int.test.ts`: same reason (target servers).
* Finding 7 (hostile ledger events steering a resume plan): static only.
* Pinned toolchain (Node 24.22.1 / Bun 1.4.4): not used; no verdict here depends on it.
* A cross-project case for the supersession (the test I wrote covers the guard ordering, not another project): the domain-key argument is static plus the repository's cross-target test.

## 5. Reproduce

```
docker run -d --name d0-pg -p 127.0.0.1:56500:5432 -e POSTGRES_PASSWORD=<throwaway> postgres:17.11
docker exec -i d0-pg psql -U postgres -v ON_ERROR_STOP=1 < D/d0/bootstrap.sql
D/d0/reset_existing.sh                 # 42 bundles + the three; verifies all 45
D/d0/reset_and_load.sh                 # + fixtures
docker exec -i d0-pg psql -X -U postgres -d exponetdb_control < D/d0/exercise_archive.sql   # A
docker exec -i d0-pg psql -X -U postgres -d exponetdb_control < D/d0/exercise_guard.sql     # B
docker exec -i d0-pg psql -X -U postgres -d exponetdb_control < D/d0/exercise_drill.sql     # C
D/d0/reset_pre.sh && docker exec -i d0-pg psql -X -U postgres -d exponetdb_pre < D/d0/exercise_pre.sql   # D (pre-PR head)
D/d0/reset_and_load.sh && D/d0/exercise_race.sh e1 ; D/d0/reset_and_load.sh && D/d0/exercise_race.sh e2   # E
D/d0/mutate_verify.sh                  # verify.sql mutation test
# product tests: copy D/d0/tests/*.ts into packages/operations/test and packages/policy/test of a scratch copy of T,
# EXDB_TEST_PG_URL=postgres://postgres:<throwaway>@127.0.0.1:56500/postgres vitest run --config vitest.integration.config.ts <file>
docker rm -f d0-pg                     # done at the end of this review
```

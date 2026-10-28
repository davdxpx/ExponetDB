### [P2] CI never compiles the `pglab` Go tests nor runs `runbook.lab.test.ts`; the real-engine proofs of Wave 9 Part B are manual
- **Area:** CI, `agent/node/internal/helper`, `packages/backups`
- **Block:** B (static audit defects 1 and 2; gate-map G9.3/G9.4)
- **Reproduction:** `grep -n 'pglab' .github/workflows/ci.yml` finds nothing; `packages/backups/package.json:19-24` has no `test:lab` script; `vitest.shared.ts` excludes `*.lab.test.ts`; `packages/backups/test/runbook.lab.test.ts` throws instead of skipping (`:67-73`). On a disposable systemd host this campaign ran `go test -tags pglab -count=1 -run TestPglab -v ./internal/helper/` as root (PASS, 37.5 s, real pgBackRest 2.60.0, restic, PostgreSQL 17; `D/ci-replica` and the server summary `go-pglab rc=0`).
- **Expected:** every artifact that the W9-04 table and `gates/9.md` point the owner at runs in a CI job (or the exact manual command is wired into `verify` behind a flag) so a compile break is seen.
- **Actual:** `pglab_test.go` (the only proof of the C-2 publisher-slot neutralization `:468-651`, the `noWorkers` gate `restore.go:437-456`, T-NODE-5, M-4, M-5 local evidence) and `runbook.lab.test.ts` (the only artifact for A-2/C-1 and C-5, the C-35 offline restore) are never run by CI; `tlspair_pgit_test.go` is vet-only (`ci.yml:451`). Four of the five Go artifacts the W9-04 table labels "(pglab)" (B-2, B-3, A-9, C-2/B-4) are untagged fake-exec unit tests.
- **Evidence:** `B/review-items-static-audit.md` (defects 1, 2 and section 6); `D/ci-replica` and the server logs.
- **Root cause:** missing CI wiring (`.github/workflows/ci.yml:378-386` go job; no job for the lab).
- **Proposed fix:** add a CI job on `ubuntu-24.04` with root that installs PGDG PostgreSQL 17, pgBackRest >= 2.59.3 and restic and runs `go test -tags pglab ./internal/helper -run TestPglab` and `bunx vitest run --config vitest.lab.config.ts` in `packages/backups`; add `test:lab` to `packages/backups/package.json`; run `go vet -tags pglab ./...` in the go job; correct the "(pglab)" labels in W9-04.
- **Acceptance test:** the new CI job is green on the PR; removing a symbol used by `pglab_test.go` breaks `go vet -tags pglab`; `bun run --cwd packages/backups test:lab` exists.

### [P2] Regression artifacts missing or weak for Wave 9 Part B security fixes (review W9-04)
- **Area:** tests for backup/restore authorization and verification
- **Block:** B (static audit defects 3 to 6; 6 ARTIFACT-MISSING, 4 ARTIFACT-WEAK of 35 rows)
- **Reproduction:** read each row's cited artifact; all fixes are present in the code, none of the rows below is covered by a test that names it.
  - A-7/B-7 (restic/pg_dump verify refused): fix `packages/backups/src/plans.ts:749`; cited `http-backups.int.test.ts:489` covers the `owned` refusal only; no TypeScript test creates a restic or pg_dump repository; node side still has the 1/10 subset check (`agent/node/internal/helper/engine.go:680`).
  - F-1 (plan views without repository location): `packages/application/src/views.ts:46-57,173-177`. F-2 (declared prod tier): `packages/registry/src/subjects.ts:142-143`, `packages/backups/src/plans.ts:56-60`. A-10 (engine floor): `plans.ts:331`. A-11/F-3 (runbook needs the location permission): `packages/application/src/backups.ts:371` (the only runbook call in a test is made by the owner, `http-backups.int.test.ts:679`; `POST /clusters/{id}/drills/offline` has no server test). C-6/C-7/C-9/C-10/C-11 (apply re-checks WAL end, archived point, backup by id, target placement and generation, runbook digest, maintenance exclusivity): `kinds.ts:1144,1160,1484`, `selection.ts:135`, `plans.ts:437-505`, `application/src/backups.ts:597-600`.
  - ARTIFACT-WEAK: A-4 second half (`kinds.ts:1356-1374` `replayShort`; the simulated node always answers `0/9000000`, `http-backups.int.test.ts:185`), C-2/B-4 (the named `TestScratchStartNeutralizesTheRestoredServer` `backup_test.go:1424` is untagged fake-exec; "the run fails unless no worker runs" `restore.go:202,239,455` has no negative test), C-4, E-5.
- **Expected:** each Critical/High/Medium fix has a named regression test that fails without the fix (the repository's own rule).
- **Actual:** see list; a permission denial for the runbook or a stale WAL end is never exercised.
- **Evidence:** `B/review-items-static-audit.md` sections 2 to 4.
- **Root cause:** the review's "regression test pending" rows were never closed.
- **Proposed fix:** write the negative tests: read a backup plan as a holder of only `backups.read` (no location field); plan a drill on a cluster declared prod with only staging targets under a nonprod grant; plan a run on an engine below 2.59.3; request the runbook without `registry.manage`; replay a drill with a stale WAL end, a moved target and a runbook digest of another repository; a restore whose replay stops short fails `recovery_target_reached`; a restic repository verify is refused; a drill refused when a worker runs.
- **Acceptance test:** each listed case is a named test in `apps/server/test/http-backups.int.test.ts`, `packages/backups/test/*` or `agent/node/internal/helper/*_test.go`, shown to fail with the fix reverted; W9-04 "Regression artifact" column updated.

### [P2] Local evidence the W9-02 matrix names does not exist (selection, 500-chain, PostgreSQL 16/18)
- **Area:** test evidence claims in `PRE-WAVE-11-REVIEW.md`
- **Block:** B (static audit defect 7; gate-map G9.3)
- **Reproduction:** M-6 "oldest, latest, PITR random": the only server-side selection used is `{ kind: 'latest' }` (`apps/server/test/http-backups.int.test.ts:597,613`); `selectSource` (`packages/backups/src/selection.ts:111-165`, branches older, backup, pitr, pitr_random) has no direct test and `packages/backups/test/` has no selection test. M-1 "all suites green on the three majors": the E-1 and OD-55 tests run on PostgreSQL 17 only (`packages/migrations-engine/test/ledger-guard.int.test.ts:146` `if (!full) return`, `:379-381`) and the advisor integration tests on 17 only (`packages/diagnostics/test/performance.int.test.ts:266`; cancel/terminate `[17, 18]`). M-10 "500+ migration baseline chain": `legacy-large.int.test.ts` imports 600 files end to end but its own comment says memory is not measured (the audit's claim "longest chain 50" was a misreading of poll loops; corrected by the editor check).
- **Expected:** the matrix's "local" column is true.
- **Actual:** gaps as listed; also `coverageView` invents `fromLsn: '0/0'` for every WAL gap (`packages/backups/src/records.ts:336`; harmless today because nothing writes `wal_coverage.gaps`).
- **Evidence:** `B/review-items-static-audit.md` defect 7; `B/gates-g7-g10-evidence-map.md` (G9 row 3).
- **Root cause:** documentation overstates test coverage.
- **Proposed fix:** write `packages/backups/test/selection.test.ts` (all four selection kinds with a fixture catalog) and a drill integration per selection; run the E-1/OD-55 and advisor suites on 16/17/18 where the major allows (state which not); correct the matrix.
- **Acceptance test:** the selection test covers older, backup, pitr and pitr_random with expected sources and the refusals (`RESTORE_SOURCE_INVALID`); the ledger-guard suite registers all tests for majors 16, 17, 18.

### [P2] Silent partial coverage in the default test run (CI classes and conditionals)
- **Area:** test infrastructure
- **Block:** B (static audit section 6)
- **Reproduction:** read `vitest.shared.ts`: default `bun run test` runs 509 files; `*.host.test.ts` (12 files) are not in `verify` (CI only, `node-pg` and `node-host-scenarios`); `*.lab.test.ts` (5 files; `packages/backups` has no script); `*.install.test.ts`; `*.model.test.ts`. Conditionals: `ledger-guard.int.test.ts:146`, `performance.int.test.ts:266,531,799`, `agent-capabilities.host.test.ts:47,410,...` (`SYSTEMD`), `mcp-replay.int.test.ts:31,226`, `visual-regression.e2e.test.ts:39,224,235`, `EXDB_CLI_BIN` unset runs the CLI from source (`http-migrations.int.test.ts:992`, `cli-import.int.test.ts:46`). No host scenario covers backup or restore runs (T-NODE-1 to T-NODE-5 stay manual).
- **Expected:** `test-strategy.md` lists what `verify` does not run and who runs it.
- **Actual:** `bun run verify` is described as the full proof; it is not (host, lab, install, model, `pglab`).
- **Evidence:** `B/review-items-static-audit.md` section 6.
- **Root cause:** documentation.
- **Proposed fix:** add a table "what `verify` does not run" to `exponetdb-docs/14-roadmap/test-strategy.md` and a `verify:host` script that prints the exact commands; add a host scenario for backup runs under real systemd (see the backup/restore findings of this campaign).
- **Acceptance test:** docs link check; `bun run verify:host --list` prints the commands.

### [P3] G10.4 `exponetdb.missing_migrations` exists only in the documentation
- **Area:** runtime schema contract (G10 criterion 4)
- **Block:** B (gate map)
- **Reproduction:** `grep -rn missing_migrations packages apps` finds nothing outside docs; `exponetdb-docs/04-migrations/authoring-and-ci.md:164-175` marks it **[PLANNED]**; `exponetdb-docs/04-migrations/ledger.md:148` grants `EXECUTE` on it; `packages/postgres/src/ledger.ts:231-267` creates only guard functions.
- **Expected:** the function exists before the Wave 10 criterion "runtime schema contract active in REOSA health checks" can be met.
- **Actual:** MISSING.
- **Evidence:** `B/gates-g7-g10-evidence-map.md` G10 row 4.
- **Root cause:** not built.
- **Proposed fix:** an additive target-side bundle (`exponetdb.missing_migrations(required text[]) returns text[]`, SECURITY DEFINER with a fixed `search_path`, executable by the application's health role only) installed by the engine's bootstrap; documentation updated from [PLANNED].
- **Acceptance test:** integration test on PG 16/17/18: the function returns the required ids absent from the ledger; unprivileged roles cannot call it; its checksum is part of the ledger-guard set.

### [P3] G10.3 as worded contradicts OD-7b; other gate-row gaps
- **Area:** acceptance gates documentation
- **Block:** B (gate map)
- **Reproduction:** `exponetdb-docs/14-roadmap/acceptance-gates.md:200` (G10 row 3) requires "at least five REOSA migrations applied staging-first, production with evidence", while `exponetdb-docs/13-integrations/reosa-integration.md:70` and `CLAUDE.md` (OD-7b) forbid production applies before Wave 11. Other gaps: G9 row 1 (scheduler) `packages/backups/src/cron.ts:88` `nextRun` is never called, so "backups run on schedule" has no ExponetDB scheduler (R-BKP-3); G8 row 5 `apps/server/test/web-axe.e2e.test.ts:37-69` has no `/t/**` page and omits 8 other routes, `visual-regression.e2e.test.ts:33` baselines only design-system frames (9 of 14 target sections never load in a real browser), root `package.json:21` `test:e2e` omits the design-system build that its own suites need (CI builds it separately); the bare `/infrastructure` redirect (to servers) has no test; G7 row 1 doc rot `05-mcp/protocol-baseline.md:18-24` names three non-existent test files; stale text `owner-test-package.md:193,196`, `information-architecture.md:191`; G10 row 5 the SDK has no `migrations`, `connections`, `backups` or `performance` namespaces although `reosa-integration.md:105-113` uses them.
- **Expected:** gate wording is achievable and the evidence it names exists.
- **Actual:** see Reproduction.
- **Evidence:** `B/gates-g7-g10-evidence-map.md` (G7 row 1, 8; G8 row 5 and routes; G9 rows 1, 3; G10 rows 3, 4, 5).
- **Root cause:** documentation drift and unbuilt pieces.
- **Proposed fix:** owner decision for G10.3 (wording: staging-first with production evidence checked by a plan only until Wave 11); add the missing tests/routes; fix the stale docs; add the SDK namespaces or correct `reosa-integration.md`; make `test:e2e` build the design-system app.
- **Acceptance test:** docs link/symbol check (a test that every test file named in a gate document exists); axe test over a `/t/<p>/<p>/<e>` page and the 8 missing routes; `bun run test:e2e` from a clean checkout passes without a prior design-system build.

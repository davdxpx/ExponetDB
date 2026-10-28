# Static audit of the Wave 9 Part B review items (test campaign, stream B)

Target: worktree `ExponetDB-testcampaign` at `d0229550` (detached, read only; not modified).
Method: read the claimed fix and the claimed regression artifact for every row of
`PRE-WAVE-11-REVIEW.md` W9-04 (35 finding rows), every residual R-* (16), and the G6
waivers E16, E18, E25. No test was executed, no network, no secret read. Verdicts are by
reading; "hash" claims were checked: all 12 cited commits exist and are ancestors of
`d0229550` (the history is not squashed), so each fix could also be located by content.
All paths are relative to the repository root.

Verdicts: VERIFIED = the fix is present at `d0229550` and a located test asserts the main
claim. ARTIFACT-WEAK = a test exists but a principal part of the claim is not asserted, or
the named test is not what the table says. ARTIFACT-MISSING = fix present, no test.
FIX-ABSENT = the fix is not in the code. Flags: LAB (only runs as root against real
engines), PG17 (runs on one major only), FAKE (fake executor or simulated node),
UNWIRED (no script or CI job runs it).

## 1. Counts

| Verdict | Findings (35 rows) | Residuals (16) | G6 waivers (3) |
|---|---|---|---|
| VERIFIED | 25 | 16 (description matches code; pinned or not per row in section 4) | 1 (E25 partial, as stated) |
| ARTIFACT-WEAK | 4 (C-2/B-4, A-4, C-4, E-5) | 0 | 0 |
| ARTIFACT-MISSING | 6 (A-7/B-7, F-1, F-2, A-10, A-11/F-3, C-6/7/9/10/11) | 0 | 2 (E16, E18: no code and no test, which is what the waiver says) |
| FIX-ABSENT | 0 | 0 | 0 |

The table row "C-6, C-7, C-9, C-10, C-11" is one row; its five ids all lack a test. Of the
25 VERIFIED rows, two (A-2/C-1, C-5) have a LAB and UNWIRED artifact and one (E-1) runs on
PostgreSQL 17 only; five more (A-1/B-1, B-2, B-3, B-5, A-9) prove behavior against a fake
executor, not a real host.

## 2. Defects, most important first

1. **The C-35 runbook test is wired to nothing.** `packages/backups/package.json:19-24`
   has no `test:lab` script; `packages/backups/vitest.lab.config.ts` exists but no script,
   `verify` (`package.json` scripts.verify) or CI job (`.github/workflows/ci.yml`) calls
   it, and the default config excludes `*.lab.test.ts` (`vitest.shared.ts`, sharedConfig
   exclude). `packages/backups/test/runbook.lab.test.ts` is the only artifact for A-2/C-1
   and C-5 and the evidence W9-08 step 4 and `gates/9.md` row 4 point the owner at. It
   throws instead of skipping (`:67-73`), so it only ever runs by hand:
   `cd packages/backups && bunx vitest run --config vitest.lab.config.ts` as root with
   `/usr/bin/pgbackrest` and PostgreSQL 17 under `/usr/lib/postgresql/17`.
2. **`pglab` Go tests are not even compiled in CI.** `agent/node/internal/helper/pglab_test.go`
   (`//go:build pglab`, `TestPglab` `:404`, root only, PG 17, real pgBackRest and restic)
   is the only artifact for the end-to-end C-2 proof (publisher slot unchanged,
   `:468-651`), the `noWorkers` gate (`restore.go:437-456`) and T-NODE-5. CI runs
   `go vet ./...`, `go vet -tags e2e ./cmd/...`, `go vet -tags pgit ./...` and
   `go test -race ./...` (`ci.yml:378-386`): no `-tags pglab` anywhere, so a compile break
   would go unseen. `internal/helper/tlspair_pgit_test.go` (`TestTLSPairOnPostgreSQL`) is
   vet-only; `ci.yml:451` runs `-tags pgit` for `./internal/pgwire ./internal/capabilities`
   only. The W9-04 preamble discloses "not in CI", but not that four of the five Go
   artifacts it labels "(pglab)" are NOT pglab tests (see 3, C-2).
3. **A-7/B-7 has no artifact.** Fix: `packages/backups/src/plans.ts:749` (restic and
   pg_dump verify refused). Cited artifact `apps/server/test/http-backups.int.test.ts`
   asserts `CAPABILITY_UNAVAILABLE` only for the ownership change to `owned`
   (`:489`). No TypeScript test creates a restic or pg_dump repository
   (`grep restic` hits only `runbook.test.ts`). The node side still contains the 1/10
   subset check (`agent/node/internal/helper/engine.go:680`), so the fix lives in the
   Control Plane gate only.
4. **Six rows are "regression test pending" and the audit confirms it**: F-1
   (`packages/application/src/views.ts:46-57,173-177`), F-2
   (`packages/registry/src/subjects.ts:142-143`, `packages/backups/src/plans.ts:56-60`),
   A-10 (`plans.ts:331`), A-11/F-3 (`packages/application/src/backups.ts:371`), and
   C-6/C-7/C-9/C-10/C-11 (`kinds.ts:1144,1160,1484`, `selection.ts:135`, `plans.ts:437-505`,
   `application/src/backups.ts:597-600`). The fixes are all present. No test names any of
   them. Worse than stated for F-3: the only runbook call in a test is made by the owner,
   who holds the permission (`http-backups.int.test.ts:679`), so a permission denial is
   never seen. The server route `POST /clusters/{id}/drills/offline` has no server test at
   all (only CLI mocks, `apps/cli/test/backups.test.ts:768-792`).
5. **A-4's second half is untested.** `packages/backups/src/kinds.ts:1356-1374`
   (`replayShort`: a restore to the archive end fails `recovery_target_reached` when replay
   stops short) has only a positive path: the simulated node always answers
   `recoveryReachedLsn: '0/9000000'` (`http-backups.int.test.ts:185`); no test has a
   shorter replay.
6. **C-2/B-4: the named artifact is a fake-exec unit test.**
   `TestScratchStartNeutralizesTheRestoredServer` (`backup_test.go:1424`) has no build
   tag and uses `fakeExec`; it proves the postmaster command line and the moved-aside
   `postgresql.auto.conf`. "The run fails unless no worker runs" (`restore.go:202,239,455`)
   has no negative test in any suite (`grep "refused to verify"` in tests: none).
7. **Local evidence named in W9-02 that does not exist.** M-6 "oldest, latest, PITR
   random": the only server-side selection is `{ kind: 'latest' }`
   (`http-backups.int.test.ts:597,613`); `selectSource` (`selection.ts:111`, the pitr and
   older branches) has no direct test and `packages/backups/test/` has no selection
   test. M-10 "500+ migration baseline chain": the longest chain in any test is 50
   (`packages/migrations-engine/test/legacy.int.test.ts:112`,
   `legacy-baseline-verify.int.test.ts:299`). M-1 "all suites green on the three majors":
   the E-1 tests and the OD-55 test run on PostgreSQL 17 only
   (`ledger-guard.int.test.ts:146` `if (!full) return`, `:379-381`), and the advisor
   integration tests are PostgreSQL 17 only (`performance.int.test.ts:266`).
8. **E16 and E18 have no code at all, and E16 is reachable.** `grep` of the whole
   repository for `hotfix_without_evidence` and `applied_not_in_source` finds six
   documents and zero source or test files. E16 does not need an out-of-band write: a
   break-glass grant on `migration.staging-evidence` can be activated once a
   notification channel exists (`apps/server/test/http-migrations.int.test.ts:710-725`),
   and nothing marks the production ledger row afterwards (the break-glass id lives only
   in plan content, `packages/migrations-engine/src/content.ts:96`; the policy doc's
   "ledger row is marked `evidence: break_glass`" is not implemented). See section 5.

Smaller: A-2 and C-5 cite "(M-9)" for the owner's offline drill; M-9 is cancel and
terminate. The offline drill is M-6 / T-C35-1. `coverageView` invents
`fromLsn: '0/0'` for every WAL gap (`packages/backups/src/records.ts:336`); harmless
today because nothing writes `wal_coverage.gaps`, but it is a fabricated value in a read
model (R-BKP-1 context). Five registry cluster planners still record `derivedTier` only
(`packages/registry/src/plans.ts:941,975,1010,1047,1092`), the F-2 sibling; authorization
for them goes through the fixed `subjects.ts`, so this is a recorded-tier inconsistency,
not an authority hole (not traced further).

## 3. Findings table (W9-04 "Security review findings")

"Runs in" says which default command reaches the artifact: `go test` = untagged Go test
(CI job `go`, `ci.yml:385`); `test` = `bun run test`; `int` = `bun run test:integration`
(needs `EXDB_TEST_PG_URL`; the target suites also `EXDB_TEST_TARGETS`; both fail, never
skip, when absent: `packages/testkit/src/servers.ts:75-79`).

| Id | Verdict | Fix located (present) | Artifact located | Runs in | Notes |
|---|---|---|---|---|---|
| A-1 / B-1 | VERIFIED | `agent/node/internal/helper/repository.go:238` (reads root-owned `pgbackrest` binding) | `TestRepositoryBinding` `backup_test.go:1302`: other repo index, other stanza, missing, malformed, duplicated, writable binding all `CodePreconditionFailed`; bound run starts; observation needs no binding | go test; FAKE | no real systemd (G5 waiver still applies) |
| A-2 / C-1 | VERIFIED, UNWIRED, LAB | `packages/backups/src/runbook.ts:97-136` (`TARGET_DIR.exponetdb`, waits `pg_is_in_recovery()=f`, prints replayed LSN) | `runbook.lab.test.ts:157-201` asserts 1234+200000 rows restored and `recovery ended; replayed to` | none (defect 1) | doc cross-ref "(M-9)" is wrong |
| C-2 / B-4 | ARTIFACT-WEAK | `restore.go:341-356` (command-line neutralization), `:437-456` (`noWorkers`), `agent/node/internal/pgwire/pgwire.go:129` (`search_path=pg_catalog`) | named: `TestScratchStartNeutralizesTheRestoredServer` `backup_test.go:1424` (untagged, FAKE: command line, auto.conf moved, check settings `restore.go:388`); real proof only in `TestPglab` `pglab_test.go:468-651` | go test (named); pglab test unwired | table says "(pglab)"; `noWorkers` refusal untested; `search_path` pinned only by `pgwire_pgit_test.go:28` (CI) |
| B-2 | VERIFIED | `engine.go:584-591` | `TestStartsCheckTheStanzasCluster` `backup_test.go:1349`: backup, verify, expire, restore.execute refused on another `db-system-id`; engine-run refuses when the stanza changed | go test; FAKE | table says "(pglab)"; it is not |
| B-3 | VERIFIED | `engine.go:548,573` (dry run names a kept label; label gone after expiry) | `TestEngineRunExpireRace` `backup_test.go:1033`: dry run naming a kept label refused before expiry; label gone after expiry fails with "is gone after the expiry" | go test; FAKE | narrowed, not removed (R-BKP-6) |
| B-5 | VERIFIED | `runs.go:334` (`--property=EnvironmentFile=`) | `backup_test.go:171-176,832-840`: env file under root's private dir, never the engine user's | go test; FAKE | not under real systemd |
| A-3 / C-3 | VERIFIED | `packages/backups/src/reconcile.ts:20`, `protection.ts:198`, `selection.ts:143` | `reconcile.int.test.ts:159-188` (exact newest segment only; lagging copy gives null; future time not believed), `protection.test.ts:110` | test, int | `restore.plan` PITR half has no test: `selectSource` untested (defect 7) |
| A-4 | ARTIFACT-WEAK | `protection.ts:208`, `kinds.ts:1356-1374` | `protection.test.ts:75-86` asserts `wal_continuity_unproven`; nothing asserts the `recovery_target_reached` failure on short replay | test | second half untested (defect 5) |
| A-5 | VERIFIED | `protection.ts:96` comment, `partial` handling | `protection.test.ts:102`, `backups.int.test.ts:241` (partial marks nothing missing) | test, int | R-BKP-7 |
| A-6 | VERIFIED | `packages/control-store/migrations/*backup-catalog/up.sql` (EXB01, EXB04, EXB06) | `backups.int.test.ts:482,506,542,596,615,666`: as `exdb_worker`, EXB04 refusals, EXB01 ownership/retirement/advisory, EXB06 future drills | int | strong; real PostgreSQL |
| A-7 / B-7 | ARTIFACT-MISSING | `plans.ts:749` | cited `http-backups.int.test.ts` covers only `owned` (`:489`); no restic or pg_dump fixture anywhere | int | defect 3; node still has `engine.go:680` |
| C-4 | ARTIFACT-WEAK | `kinds.ts:682-708` (`NOT_STARTED`, start-job binding, ask the node) | `http-backups.int.test.ts:512` covers the `NOT_STARTED` branch only | int | binding to the start job and the "lost statement" branch untested |
| C-5 | VERIFIED, UNWIRED, LAB | `runbook.ts:97-125` (own `postgresql.conf`, hba, ident; every safety setting on the command line) | `runbook.lab.test.ts:78-93` moves the config out of the data directory and restores | none | same as A-2; unit `runbook.test.ts` asserts the script text |
| D-1 | VERIFIED | `packages/postgres/src/session-conditions.ts:25-31` (`pg_stat_progress_copy`) | `performance.int.test.ts:740-797`: a slow `COPY FROM` samples as waiting and old but not stalled; terminate `not_matched`; plan `PLAN_STALE` | int, PG 17 and 18 | waits `STALLED_SECONDS + 5` s plus feeding (`:754`) |
| D-2 | VERIFIED | `packages/diagnostics/src/advisors/catalog.ts:26` (untrusted names, quoted, prose message) | `advisors.test.ts:58-78` (hostile column), `interfaces.test.ts:300` (untrusted labels) | test | none |
| F-1 | ARTIFACT-MISSING | `application/src/views.ts:46-57,173-177` (`withoutLocation` for kinds `backup.*`) | none; `views.test.ts` has no location case | - | `restore.*` plan content carries no location (checked `plans.ts`); `registry.endpoint.add` not stripped (R-VIEW-1) |
| F-2 | ARTIFACT-MISSING | `registry/src/subjects.ts:142-143`, `backups/src/plans.ts:56-60` (`clusterTier`) | none with declared prod and derived nonprod; `registry.int.test.ts:920` only declared null; `registry-tier.test.ts:36` tests another function | - | five registry planners keep `derivedTier` only (section 2) |
| A-8 | VERIFIED | `reconcile.ts` (engine cipher wins) | `reconcile.int.test.ts:190-213` | int | none |
| A-9 | VERIFIED | `repository.go`, `runs.go` (`--config-include-path`) | `TestConfDIsNamedToTheEngine` `backup_test.go:1383` (also refuses a world-writable `conf.d`) | go test; FAKE | table says "(pglab)" |
| A-10 | ARTIFACT-MISSING | `plans.ts:331` | none; `backups.int.test.ts:288` tests the advisory, not the run refusal | - | grep of `repository_engine_below_floor` in tests: 0 |
| A-11 / F-3 | ARTIFACT-MISSING | `application/src/backups.ts:371` (`PERMISSION_DENIED`) | none; the only runbook call is by the owner (`http-backups.int.test.ts:679`) | - | defect 4 |
| B-6 | VERIFIED | `kinds.ts` verify path (label first seen after the run row) | `http-backups.int.test.ts:493` (title lacks the "(B-6)" tag): run naming an existing label gets `verificationOutcome: 'failed'` | int | none |
| C-6 | ARTIFACT-MISSING | `kinds.ts:1144` (binding `walTo`) | none | - | traced only, as the table says |
| C-7 | ARTIFACT-MISSING | `selection.ts:135` (`bases.find`) | none | - | |
| C-9 | ARTIFACT-MISSING | `plans.ts:437-505`, `kinds.ts:1160` | none | - | |
| C-10 | ARTIFACT-MISSING | `application/src/backups.ts:597-600` | none; no server test of the offline-drill route | - | |
| C-11 | ARTIFACT-MISSING | `kinds.ts:1484` (`target:<id>:maintenance` domain) | none; generic domain locks tested in `operations/test/locks-idempotency.int.test.ts:67` | - | |
| C-8 | VERIFIED | `policy/src/catalog/backups.ts:115-145` | `backup-rules.test.ts:140-185` (both tiers, drill exempt, unknown requires, not break-glass) | test | none |
| D-3 / F-4 | VERIFIED | `application/src/performance.ts` (one transaction) | `performance.int.test.ts:357-388` (failing audit rolls back run and findings), `interfaces.test.ts:265` | int, test | R-MCP-1 remains |
| D-4 | VERIFIED | `session-conditions.ts:53-62,79` (member of a superuser role, `pg_probackup`) | `performance.int.test.ts:704-738` | int, PG 17 and 18 | tests a login that may `SET ROLE`; the post-`SET ROLE` session is covered by the same membership predicate, not separately |
| D-5 | VERIFIED | `statement-math.ts:14` (`STATEMENT_GAP_SECONDS`), `statements.ts:532,804` | `statements.test.ts:94-117` (gap), `:119` (stats_since) | test | "windows bind from_at and generation" in SQL is not asserted separately |
| F-5 | VERIFIED | `e05826f` (contracts, pins) | `mcp-catalog.test.ts:101-109`, five pinned digests (`:61-80`) | test | digests not recomputed here (static audit); re-pinned again in `685bd52` |
| F-6 | VERIFIED | `apps/server/src/composition/access.ts:318-330` | `http-backups.int.test.ts:695-729`: three kinds refused with `authorization: revoked`; an unlisted kind returns `[]` | int | none |
| F-7 | VERIFIED (text only) | `apps/cli/src/presets.ts:59`, `policy/src/catalog/backups.ts` | none claimed; correct | - | `presets.test.ts:62` pins preset names only |
| E-1 | VERIFIED, PG17 | `migrations-engine/src/executor.ts:184-220` (`DEFERRED_TRIGGER_ROUNDS = 16`, `pg_stat_xact_all_tables`) | `ledger-guard.int.test.ts:204,249,253` (late write, redeferring chain of 4, chain beyond the bound with `gate.check = deferred_trigger_chain`) | int, PG 17 only (`:146`) | "shown to fail without the fix" cannot be checked statically |
| E-2 | VERIFIED | `packages/postgres/src/parser/procedural.ts:26,75` | `procedural.test.ts:67-81` (CTAS, matview, `REFRESH`) on 16, 17, 18 | test | pure unit, no env |
| E-3 | VERIFIED | `procedural.ts:75` | `procedural.test.ts:77-80` (a rule gives `trigger_created`) | test | |
| E-4 | VERIFIED | none needed | `verification-failures.test.ts:170-177` | test | pinned |
| E-5 | ARTIFACT-WEAK | none (informational) | the write-once triggers `excused_value_guard` (`control-store/migrations/01M5X840BP8JXGEQGS0PHPTB58_excused-value-digests/up.sql`, ERRCODE `EXO12`) are untested (`grep EXO12`: 0 tests); only "serve cannot read digests" is tested (`legacy-baseline-verify.int.test.ts:845`) | int | replay protection rests on an untested trigger |

## 4. Residuals (W9-04 "Residuals")

VERIFIED here means: the residual is real at `d0229550` as described (code read). "Pinned"
means a test fails if someone removes the limitation without noticing.

| Id | Verdict | Evidence in code | Pinned by a test |
|---|---|---|---|
| R-NODE-3 | VERIFIED | `agent/node/internal/helper/runs.go:302-350`: engine unit properties have no `IPAddressAllow`, `IPAddressDeny`, `PrivateNetwork` or address-family limit (`PrivateNetwork` appears only in the helper comment `:413`) | no |
| R-BKP-1 | VERIFIED | `protection.ts:208`; `records.ts:336` builds gaps with a fabricated `fromLsn: '0/0'`; nothing writes `wal_coverage.gaps` (`reconcile.ts` has no `gaps`) | `protection.test.ts:75` |
| R-BKP-2 | VERIFIED | Control Store refuses `proven` | yes: `backups.int.test.ts:368` |
| R-BKP-3 | VERIFIED | no timer calls `backup.catalog.refresh`; only `setInterval` in the worker are heartbeat and readiness (`composition/role.ts:249-250`) | no |
| R-BKP-4 | VERIFIED | `kinds.ts` emits `fingerprint` and `ledger_head` as `not_run` | `http-backups.int.test.ts:577` drill path |
| R-BKP-5 | VERIFIED | advisory mechanism, `protection.test.ts:234` | yes |
| R-NODE-4 | VERIFIED | no `PrivateNetwork`; `restore_command` reaches the repository (`backup_test.go:1424` pins it) | yes (the command) |
| R-BKP-6 | VERIFIED | `TestEngineRunExpireRace` `backup_test.go:1033` (run fails and names the label) | yes |
| R-BKP-7 | VERIFIED | `backups.int.test.ts:241` | yes |
| R-BKP-8 | VERIFIED | `plans.ts:749` | no (defect 3) |
| R-VIEW-1 | VERIFIED | `registry/src/plans.ts:925-945` puts the endpoint in plan content; `views.ts:176` strips only `backup.*` | no |
| R-BKP-9 | VERIFIED | guard `EXB01` moves only with a forward `reconciled_at` (`backups.int.test.ts:615`); a forged observation passes by design | partially |
| R-MCP-1 | VERIFIED | `packages/contracts/src/mcp/tools.ts:770` `RO_OPEN`; `rateClass: 'read'` `:779`; `interfaces.test.ts:239` ties `readOnlyHint` to `effect === 'read'` | yes (the rule), not the OD |
| R-OD56-1 | VERIFIED | see E-5 | no |
| R-OD55 | VERIFIED | decided in `open-decisions.md` OD-55 | no |
| R-CLI-1 | VERIFIED | `packages/auth/src/stepup.ts:22` `STEP_UP_ACTIONS = ['plan.apply', 'node.enrollment_token.reveal']`; comment `contracts/src/actions.ts:2034` | no |

## 5. G6 waivers (gate record `gates/6.md` §5 and §10)

### 5.1 What the three cases mean

| Case | Meaning (`failure-and-recovery.md` §1, lines 33-35) | State in code |
|---|---|---|
| E16 `hotfix_without_evidence` | production holds a migration that the evidence (staging) environment lacks, so the invariant "staging contains everything production contains" no longer holds | not implemented |
| E18 `applied_not_in_source` | a migration is in the target ledger but no longer in the project's submitted bundle source | not implemented |
| E25 | a restored ledger (older than the Control Store mirror) | partial |

`grep -rI` over `packages apps agent tooling` for `hotfix_without_evidence`,
`applied_not_in_source` and for any `orphan`/`not_in_source` finding: no source or test
hit. The six hits are documents only (`drift-detection.md`, `failure-and-recovery.md`,
`staging-production-policy.md`, `dependency-graph.md`, `gates/6.md`, the review file). No
test names E16 or E18.

### 5.2 What a detection would need (from the code)

E18 (kind A in `drift-detection.md` §1: source against ledger). Inputs that exist: the
target ledger rows (`readLedgerRows`, `packages/migrations-engine/src/target.ts`), the
project's stored bundle stream (`storedStream`, used in `reads.ts:296-303`). Missing: a
comparison of the two sets. Today `migration.get` answers per id only (`state:
'unknown_to_target'` when neither side has it; `reads.ts:296-303`), and a ledger row with
no bundle is just a ledger row. A detection must (1) list ledger ids absent from the
stream, (2) emit them as a finding (the unified findings list already carries `drift`,
`health`, `advisor`, `statement`, `performance.int.test.ts:390`), (3) keep the ledger row
(the doc forbids deleting it), and (4) not turn the finding into `LEDGER_DIVERGENCE`
(that error is for mirror differences only, `divergence.ts`).

E16 (kind D, environment against environment). Inputs that exist: `readEvidenceTarget`
(`evidence.ts:98`) reads the evidence target's ledger and verifications live, but only for
the bundles of a plan being made; the result is bound into the plan, not stored per ledger
row. Missing: (1) a standing job that runs the same read for every non-reverted production
ledger row (id, apply checksum, verify digest), (2) a way to know which production rows
were hotfixes: the target ledger has no evidence column; the break-glass grant id sits
only in plan content (`content.ts:96`), so the Control Store would have to be joined
through plan and operation, (3) a finding that stays open until the same id and checksum
is applied and verified on the evidence environment (`staging-production-policy.md`
§3, line 155). How reachable the state is: an out-of-band row is already caught as
`unrecorded` by the ledger comparison (E24, `divergence.ts` `compareLedger`) and blocks
plans; the supported route is a break-glass plan. Break-glass activation is refused by
default (`BREAK_GLASS_UNAVAILABLE`, OD-21, `application/src/breakglass.ts:61-94`) but
works once a notification channel is configured
(`http-migrations.int.test.ts:710-725`), after which nothing records that the row lacks
evidence. So E16 is latent, not impossible, and has no detection.

### 5.3 E25

Claim in W9-05: partial. Confirmed. A restore operation exists (kinds `restore.drill`,
`restore.execute`, `restore.discard`). An older restored ledger reads as `missing` in
`compareLedger` (`divergence.ts`), covered by the E24 test "a ledger row deleted by hand
is missing" (`failures.int.test.ts:653`). Not covered, as stated: no test restores a real
ledger (the lab and drill tests never read the ledger; the drill records `ledger_head` as
`not_run`, `kinds.ts` checks list), no placement move, no re-plan of lost migrations.
Verdict VERIFIED as stated, waiver not closed.

The eleven partial cases (E4, E5, E7, E8, E9, E11, E13, E14, E15, E26, E28) match the
`gates/6.md` §5 table; Part B did not touch them, as W9-05 says.

## 6. What a default run does NOT run

Counts: 0 uses of `.skip`, `skipIf`, `.todo`, `.fails`, `runIf`, `xit`, `xdescribe` in any
TypeScript or TSX test under `apps/ packages/ tooling/` (the five files that match
`skip` are sources: `apps/web/src/...`, `packages/postgres/src/parser/migration.ts`).
Go: one `t.Skip`, `agent/node/internal/helper/pglab_test.go:64` (guards the re-executed
child process). The project rule "never skipped" holds: tests that need an environment
fail with an explanation (`vitest.shared.ts` comments; `servers.ts:75-79`;
`agent/node/internal/pgtest/pgtest.go:21-24`; Go root checks use `t.Fatal`:
`capabilities_pgit_test.go:115`, `tlspair_pgit_test.go:153`, `pglab_test.go:405`).
What is not run by default comes from suffix exclusion, build tags and four in-test
conditionals.

### 6.1 Vitest suffix classes (`vitest.shared.ts` sharedConfig exclude)

Default `bun run test` runs 509 files (`*.test.ts`, `*.test.tsx` minus the classes below).
`bun run test:integration` runs `*.int.test.ts` only. `bun run verify` runs: check,
typecheck, test, test:integration, test:e2e, server test:conformance, build, generated,
golden, boundaries, secrets, third-party, licenses, ui-safety, go:test.

| Class | Files | Script | Needs | In `verify` | In CI | Therefore NOT run by `test` / `test:integration` |
|---|---|---|---|---|---|---|
| `*.int.test.ts` | 103 | `test:integration` (11 packages and `apps/server`) | `EXDB_TEST_PG_URL`; target suites `EXDB_TEST_TARGETS` (PG 16, 17, 18, TLS) | yes | yes (job `postgres`) | every PostgreSQL-behavior claim, incl. all Part B integration artifacts |
| `*.e2e.test.ts` | 10 | `apps/server test:e2e` | Chromium, built Web App, PG 17 | yes | yes (job `browser`) | all browser flows, CSP, visual regression |
| `*.conformance.test.ts` | 2 | `apps/server test:conformance` | package registry access | yes | yes (job `typescript`) | MCP conformance and Inspector |
| `*.host.test.ts` | 12 | `apps/server test:host` | root, systemd as PID 1, `EXDB_NODE_CLUSTERS`, `EXDB_NODE_E2E_AGENT_USER`, `EXDB_TEST_PG_URL` | no | yes (`node-pg` 1 file; `node-host-scenarios` 11-way matrix) | the real Go agent and helper against real clusters; no host scenario covers backup or restore runs (T-NODE-1 to T-NODE-5 have no CI job) |
| `*.install.test.ts` | 1 | `apps/cli test:install` | packed CLI, Node 24 | no | yes (`postgres`) | installed-artifact CLI |
| `*.lab.test.ts` | 5 | `apps/cli test:lab`, `apps/server test:lab`; `packages/backups`: NO SCRIPT | Docker, `EXDB_LAB_IMAGE`, `EXDB_CLI_BIN`; backups: root + pgBackRest + PG 17 | no | yes (`image`) except `runbook.lab.test.ts` | local lab, quickstart, traefik, MCP stability; `packages/backups/test/runbook.lab.test.ts` is run nowhere |
| `*.model.test.ts` | 1 | `apps/server test:evals` | `EXDB_EVAL_ANTHROPIC_API_KEY` | no | no (by design) | model evals; `mcp-evals.model.test.ts:45` returns from `beforeAll` without a key and the tasks then fail as NOT RUN |

Default `bun run test` also needs Chromium (`packages/tokens/test/contrast.test.ts`,
`theme.test.ts`; CI installs it, `ci.yml:60-62`); without it they fail, not skip.

### 6.2 Conditionals inside tests (silently partial)

| File:line | Condition | What is then not run |
|---|---|---|
| `packages/migrations-engine/test/ledger-guard.int.test.ts:146` (`suite(17, true)`, `suite(16, false)`, `suite(18, false)` at `:379-381`) | `if (!full) return` | on PostgreSQL 16 and 18 only the first 3 tests register; dynamic EXECUTE forgery, disabled trigger, deferred triggers incl. E-1, the OD-55 classification and the concurrent verification run on 17 only |
| `packages/diagnostics/test/performance.int.test.ts:266,531,799` | `describe` blocks fixed to PG 17 (advisors, findings) and to `[17, 18]` (cancel and terminate); PG 16 has no operator credential by design (`:171`) | advisor, cancel and terminate checks on PG 16 (M-1 and M-9 say 17 and 18) |
| `apps/server/test/agent-capabilities.host.test.ts:47,410,650,663,670,700,751,1245,1531` | `SYSTEMD = existsSync('/run/systemd/system')` | restart and failed-unit assertions on a host without systemd as PID 1; CI asserts systemd first (`ci.yml:449`) |
| `apps/server/test/host/config.host.test.ts:106`, `apps/server/test/support/host-world.ts:587,1001,1063,1077,1086,1105` | `if (SYSTEMD)` | unit install and log reading differ without systemd |
| `apps/server/test/mcp-replay.int.test.ts:31,226` | `EXDB_RECORD_TRANSCRIPTS=1` | the "replay is not vacuous" check returns early in record mode |
| `apps/server/test/web-tour.e2e.test.ts:21,69` | `EXDB_TOUR_DIR` unset | tour screenshots are not written (no assertion lost) |
| `apps/server/test/visual-regression.e2e.test.ts:39,224,235` | `EXDB_UPDATE_VISUAL=1` or an empty baseline set | comparison replaced by rewrite; the baseline-completeness check returns early when no PNG exists (the set itself is reported by the comparison tests, `:198`) |
| `apps/server/test/http-migrations.int.test.ts:992`, `cli-import.int.test.ts:46` | `EXDB_CLI_BIN` unset | the CLI runs from source (`bun main.ts`), not the installed artifact |
| `packages/audit/test/export.int.test.ts:37` | S3 env | fails with a message when missing (listed for completeness) |

### 6.3 Go (`agent/node`, 287 untagged test functions)

`bun run go:test` = `go vet ./... && go test -race -count=1 ./...`, no tags.

| File | Tag and condition | Tests | Not run by default | In CI |
|---|---|---|---|---|
| `internal/helper/pglab_test.go` | `pglab`; root, `postgres` OS user, `/usr/lib/postgresql/17`, `/usr/bin/pgbackrest`, restic | `TestPglab`, `TestPglabEngineChild` (skips unless re-executed, `:64`) | real encrypted pgBackRest and restic runs, C-2 publisher slot, drill, restore verify, discard (T-NODE-5, M-4, M-5 local evidence) | never run, never compiled |
| `internal/capabilities/capabilities_pgit_test.go`, `confidentiality_pgit_test.go` | `pgit`; root, `EXDB_NODE_CLUSTERS` | 14 + 5 | capability behavior on real PG 16, 17, 18 | yes (`ci.yml:451`) |
| `internal/pgwire/pgwire_pgit_test.go` | `pgit`; `EXDB_NODE_CLUSTERS` | 1 (`TestQueriesOnEveryMajor`) | wire client on every major incl. `search_path` | yes |
| `internal/helper/tlspair_pgit_test.go` | `pgit`; root, `postgres` user | 1 (`TestTLSPairOnPostgreSQL`) | root helper's TLS pair on real PostgreSQL | vet only |
| `cmd/exponetdb-node/e2e_test.go` | `e2e` | 1 | agent end to end | yes (`ci.yml:383`) |
| `cmd/exponetdb-node/release_test.go` | `!e2e` | 1 | - | yes |

The untagged backup and restore helper tests (`backup_test.go`, about 1489 lines) drive a
fake `systemd-run` and a scripted engine (`scriptRunner`, `fakeExec`, fake binaries
written as `#!/bin/false`, `backup_test.go:110`): they prove argument lists, refusals,
file modes and state transitions, never a real engine or real systemd.

## 7. Notes for the test lead

1. The four "(pglab)" labels in W9-04 for B-2, B-3, A-9 and C-2/B-4 point to untagged
   fake-exec unit tests that do run in CI; the real-engine evidence is `TestPglab`.
2. Cheapest local checks that move rows from "pending" to evidence, without new
   infrastructure: (a) run `runbook.lab.test.ts` as root and `go test -tags pglab
   ./internal/helper -run TestPglab` as root; (b) check CI whether `-tags pglab` ever
   compiles (it does not today); (c) for F-1, F-2, A-10, A-11, C-6, C-7, C-9, C-10, C-11
   write the negative test or run the manual step: read a backup plan as a holder of only
   `backups.read`; plan a drill on a cluster declared prod with only staging targets under
   a nonprod grant; plan a run on an engine below 2.59.3; request the runbook without
   `registry.manage`; replay a drill with a stale WAL end, a moved target or a runbook
   digest of another repository.
3. M-6 and M-10 need new local evidence for the oldest, PITR-random selection and a
   500-migration chain; the repository has none.
4. No test in the repository fails if E16 or E18 detection is added later, and none would
   notice if E16 appears; a manual check on a lab with a configured notification channel
   (apply a break-glass plan on prod, then list findings) is the only way to observe it
   today.

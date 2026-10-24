# Record: Wave 9 Part A (the migration engine for real, imported schemas)

| | |
|---|---|
| What this is | The progress and evidence record of **Part A** of the owner's Wave 9 order: "Part A correction and pull-forward". Part A corrects Wave 6 defects against DECIDED documents and contracts (A1 to A3) and brings forward the product capabilities of Wave 10 that every Supabase-origin adopter needs (A4 to A9). It is not a gate of its own: its items are evidence for G9 and for the later G10; the G9 record (`gates/9.md`) follows with Part B |
| Wave | [Wave 9](../implementation-waves.md#wave-9-backup-restore-performance) |
| Status | **DONE, waiting for the owner.** Phase 0 (§1, §2), A1 to A10 (§3, evidence in §4), two independent review rounds and a verification round (§6), every finding fixed or opened as an owner decision (OD-53, OD-54, OD-55); the pull request is `davdxpx/ExponetDB#34`. Open for the owner: OD-8 before Part B, OD-53, OD-54, OD-55, the owner test package run on the lab (NOT PROVEN until then), the execution-role membership check on REOSA staging (§5). Only the owner accepts G9 |
| Authorized | 2026-10-21, by the owner's Wave 9 order ([`../orders/wave-9-order.md`](../orders/wave-9-order.md), "ExponetDB — Wave 9: Backup, restore, performance, with the migration engine made fit for real imported schemas", the implementation prompt the owner issued for this session) |
| Base | `main` at `485619c54b3cc49b0397a1f7ad16fc9a0a6f6d1d` (merge of `davdxpx/ExponetDB#32`; the order was prepared on the same commit) |
| Branch | `ccr-3132aada-w0z6wp`, assigned by the session (the session's branch rule wins over the `feat/…` naming, order §2) |

This record follows the model in
[`acceptance-gates.md` "How gates are recorded"](../acceptance-gates.md#how-gates-are-recorded)
and the G6 to G8 records. Item status values: `open`, `PASS`, `FAIL`,
`NOT PROVEN`, `NOT APPLICABLE` (only with a reason the owner accepts),
`WAIVED` (only by the owner, with a reason and an expiry). Security items
(**S**) cannot be waived. Three columns are kept apart throughout:
**contract** (a schema, route or action exists in `packages/contracts`),
**implementation** (code serves it) and **evidence** (a test or a run proved
it here, with the commit). **G7 and G8 are not accepted yet; this record
claims nothing about them. G2 off-host deployment evidence is still
outstanding.** **[OBSERVED]** (2026-10-22) CI runs for this pull request
(GitHub Actions, 17 jobs including the systemd host scenarios; the earlier
statement that no runner starts is no longer true). On `ba763db` (run
39712668586) 15 of 17 jobs pass. `Host scenario journal (systemd)` fails
every time, as it does on `main` at `485619c` (run 39656574621), so it is
not this pull request's (noted on the pull request; no fix exists yet). The
TypeScript job passed every test and failed in `bun audit` (the audit
service closed the connection); its one re-run failed in an intermittent
`apps/design-system` filter bar test that Part A does not touch and that
passed in the first attempt and locally (a race between two key presses;
the proposed fix for `main` is on the pull request). Earlier heads showed
other one-off failures in code Part A does not touch (§6, the pull
request). No PASS here is derived from a workflow file alone. Nothing
in Part A deploys anything, enrolls a node, or connects to a real database
(order §1): every PostgreSQL claim is proven against disposable containers.

## 1. Inventory at the start (2026-10-21)

### 1.1 Environment

| | |
|---|---|
| `git rev-parse HEAD` at the start | `485619c54b3cc49b0397a1f7ad16fc9a0a6f6d1d` (session branch = `origin/main`) |
| Toolchain | Bun 1.4.2; Node.js 24.22.1 (installed for the session; the container ships 22.22.0); Go 1.24.7; Docker 29.9.1 (daemon started by the session) |
| Control Store for the integration tests | PostgreSQL 17.11 in a disposable container (`pgvector/pgvector:pg17`, pinned digest `sha256:ac08538c…`; the pinned `postgres:17.11` image of `tooling/dev/control-store.sh` could not be pulled: Docker Hub answered `429 Too Many Requests`; both images carry PostgreSQL 17.11) |
| Managed targets for the integration tests | `tooling/dev/targets.sh` unchanged: PostgreSQL 16, 17 and 18 with TLS only, plus one PostgreSQL 17 without TLS |
| S3-compatible server (audit checkpoint tests) | not started at the start (`versity/versitygw` also refused with `429`); the suites that need it are named in §4 when they run |

Baseline runs on the base commit, before any change:

| Command | Result |
|---|---|
| `bun run typecheck` | 28 of 28 tasks successful |
| `bun run test` (all packages, default turbo concurrency) | 27 of 28 packages passed; `@exponetdb/tokens` failed under the parallel run and other suites were interrupted (`exit 130`) by turbo's stop; the same package alone: 4 files, 198 tests passed. Recorded as contention of the parallel run, not a product failure; later full runs use a lower concurrency (§4) |
| `bun run --cwd packages/migrations-engine test:integration` | 4 files, 59 tests passed (PostgreSQL 17) |

### 1.2 The facts of the order §5, re-verified

Every claim of the order's §5 was checked against the code at `485619c`
(an independent read-only pass, then spot checks by the session). The order's
paths `packages/migrations/src/engine/…` do not exist: the engine is the
workspace package `packages/migrations-engine/src/` (planner, executor, kind,
legacy, resume, rollback, reverify, reads, deps, evidence). Line numbers below
are at `485619c`.

| Order §5 claim | Result | Correction or addition |
|---|---|---|
| `executionRoleProblem` refuses `BYPASSRLS`, `LOGIN`, reach into superuser, `pg_*`, `exponetdb_*` | holds | `packages/postgres/src/migration-facts.ts:107-127` |
| Rule `migration.execution-role`, no override | holds | `packages/policy/src/catalog/migrations.ts:204-210`; it applies to `migration.apply`, `.rollback`, `.resume` only, **not** to `migration.import.replay` |
| Executor re-check under the lock | holds | `migrations-engine/src/executor.ts:616-627` (`executionRolesChanged`), called at `kind.ts:333` under the lock; `kind.ts:150-156` compares only the alias map |
| Legacy replay never checks the role | holds | `legacy.ts:1042-1072` runs `SET LOCAL ROLE` through `runTransactional`; `planImportAnalysis` (`legacy.ts:344`, alias at :372-375) only checks that the alias is mapped |
| Execution roles per project; direct readers | holds; the list was incomplete | readers at `planner.ts:96-130` (and :365, :447, :599, :678, :694), `deps.ts:35-61` (used at `kind.ts:152`, `kind.ts:333`, `resume.ts:312`, `rollback.ts:190`, `legacy.ts:372`), `reverify.ts:162-167`, `reads.ts:376-406`, and in the registry `plans.ts:334-356` (`projectEngineSettings`, used for `registry.project.update`) |
| `c1` hashes only the alias; the plan binds resolved names; evidence binds the checksum | holds | the alias line is `migration-bundles.md:142` (not :141); hashed at `migrations/src/format/projection.ts:129,156`; bound at `planner.ts:675-680, 754-759`; evidence at `evidence.ts:33, 197-203` |
| The CLI cannot start an import from the project file | holds | `apps/cli/src/commands/migration.ts:871`; no CLI test covers `import analyze` |
| Supabase ledger matching cannot succeed on real data | holds | `legacy.ts:578` (`version_name`), :552-554 and :723-747 (per-index, equal count, non-empty); the name hint sets `recorded` (:744, :764), except that a file without expectations makes a name-only match `ambiguous` (:769) |
| Role DDL, `CONCURRENTLY`, comment-only files refused in the replay | holds | `parser/migration.ts:1471-1477` (also `ALTER ROLE … SET`); `reviewed.ts:58-64`; the incomplete report is written at `legacy.ts:1073-1086` |
| Scratch target rules; no database retire | holds, one difference | nothing marks a scratch target as consumed: only the emptiness check guards it (`legacy.ts:1022-1034`; "consumed" appears only in the contract text, `rest/migrations.ts:626`); `registry.databases` already allows `state = 'retired'` with a guard (frozen `registry` bundle), but no operation sets it |
| Drift items capped at 500 | holds | `legacy.ts:830, 873`; in addition the per-item evidence is cut at 16 entries without a mark (`legacy.ts:811`) |
| Limits | holds | 4 MiB per file (`rest/migrations.ts:612`), 1000 files (:633), 32 MiB per body (:55, applied at `routes.ts:2315`) |
| `cluster register` always creates an external cluster | holds | `registry/src/kinds.ts:460-462` is the only insert |
| Bootstrap SQL | holds, one correction | plain `CREATE ROLE` (`postgres/src/bootstrap.ts:96, 102`); per-database sections only for registered databases; the script **does** grant the ledger owner to the migrator (:112), but no execution-role owner; no legacy-ledger read grants |
| The declared cluster tier only in the Web App | holds, one addition | the REST route `planClusterDeclaredTier` exists (`routes.ts:1764-1769`); no CLI command |
| Wave 9 contracts without handlers | holds | routes at `routes.ts:843-858, 872-884, 885-895, 938-948` have no handler (`apps/server/src/interfaces/http/api.ts:326`); `BackupSchema` and `BackupCatalogSchema` at `resources.ts:1712-1743` |
| Node agent | holds, one addition | `catalog.go` also has `wal.status@1` (:41) beside `wal.archive_status@1`; the helper timeout cap is in `run.go:23-25` |
| Frozen bundles | 21 frozen | 32 bundle directories; the 11 Wave 7 and Wave 8 bundles are not frozen (treated as published, changed only additively) |
| Next free numbers | OD-51, ADR-0034 | confirmed |

## 2. Decisions of the Wave 9 order

Recorded in [`open-decisions.md`](../../00-product/open-decisions.md#decisions-of-the-wave-9-order-2026-10-21)
before anything relies on them.

| # | Decision | Kind | Recorded in |
|---|---|---|---|
| O1 | Part A first, its own pull request and this record; then Part B | OWNER | open decisions, this record |
| O2 | Part A brings forward Wave 10's product capabilities, not its REOSA-side deliverables | OWNER | open decisions, OD-7 |
| O3 | Quality over speed | OWNER | open decisions |
| O4 | OD-7 split: OD-7a yes (REOSA staging and its scratch database on `reos-db-01`, the one authorized real nonprod target set), OD-7b no applies to production before Wave 11 | OWNER | OD-7, `CLAUDE.md`, `bootstrap.md`, G2 record |
| D-A1 | A declared `BYPASSRLS` execution-role exception | DEFAULT | OD-51, ADR-0034 |
| D-A2 | Execution roles resolved per (project, environment) | DEFAULT | open decisions, ADR-0034 |
| D-B1 | OD-4 engine: pgBackRest; storage open until the spike B0 | DEFAULT | OD-4 |
| D-B2 | Adopt, then own an existing pgBackRest setup | DEFAULT | OD-52 (ADR in B0) |
| D-B3 | OD-8: option (a) recommended, **not decided** | DEFAULT | OD-8: a stop-and-ask point before Part B |
| D-B4 | L2 `pg_dump` and L3 restic in Wave 9 | DEFAULT | open decisions |
| D-B5 | The G5 waiver closes only on a disposable VM | DEFAULT | open decisions |

**Stop-and-ask points carried to the owner** (order §13): OD-8 before Part B;
the storage decision after B0; a disposable VM for the G5 waiver; anything
touching a real host, bucket, database, the deployment on `reos-01` or
another repository.

## 3. Items

| # | Item | Contract | Implementation | Evidence | Status |
|---|---|---|---|---|---|
| A0 | Phase 0: inventory, order, decisions, record | — | — | §1, §2 | PASS |
| A1 | The CLI starts a legacy import from the project file (`baseline:<slug>` and `<slug>`, `--hints`) | none needed (the request contract is unchanged) | `apps/cli/src/commands/migration.ts` (`baselineSlug`, `importHints`, flag `--hints`); the CLI end-to-end test `apps/server/test/cli-import.int.test.ts` (also A7, A8) | §4.2 | PASS |
| A2 | Supabase ledger matching on real data (names, statement sequences, evidence strength, multi-file aliases, real-shape fixture) | `ImportAnalysisRequest.aliases` takes a stem or a list of stems; `ImportReport.items[].evidenceStrength` (additive) | `migrations-engine/src/legacy-evidence.ts`, `legacy.ts` (`relateLedger`, `classify`, extension check); bundle `01M5G6EQ7GKZV615Y680AHT52B_legacy-import-evidence`; fixture `testkit/src/fixtures/supabase-history.ts`; the Web App shows the strength (§4.4) | §4.3 | PASS |
| A3 | The replay checks the execution role; no silent cap in the import path | error `LEGACY_IMPORT_TRUNCATED`; `ImportReport.driftTotal`, `driftTruncated` (additive) | `legacy.ts` (role check at planning and under the scratch lock, binding check, drift totals, evidence and attribute lists capped with a mark); rule `migration.import-execution-role`; Web App: strength and truncation warning | §4.4 | PASS (the A4 exception model joins the same check with A4) |
| A4 | Declared `BYPASSRLS` execution-role exception (ADR-0034, OD-51) **S** | `rxe_` ids; `ExecutionRoleExceptionDeclareRequest`, `…RevokeRequest`, `ExecutionRoleExceptionView`, `ProjectExecutionRoles`; actions `registry.execution_role_exception.declare(.plan)`, `.revoke(.plan)`, `project.execution_roles.get`; routes `planExecutionRoleException`, `planExecutionRoleExceptionRevocation`, `getProjectExecutionRoles`; `REGISTRY_CONFLICT` reasons `exception_active`, `exception_not_active`; `MigrationPlanContent.expectedState.executionRoleExceptions`, `facts.executionRoleExceptions`, `facts.executionRoleParity` (all additive) | bundle `01M5G6EQ7KP3PMPC7G3HJ7KH7R_execution-role-exceptions`; `registry/src/execution-roles.ts` (plans, kinds); `postgres/src/migration-facts.ts` (`executionRoleProblem(facts, excused)`, `declared_exception`); `migrations-engine/src/execution-roles.ts` (`roleUnder`, `boundExceptionsHold`, `rolesStillUsable`); planner, kind, executor, resume, rollback, legacy replay; rules `migration.execution-role-exception`, `migration.execution-role-parity`, `registry.execution-role-exception-production`; the health sampler's `execution_role_exception_drift` finding; CLI `project role-exception declare/revoke` | §4.5, §6.1 | PASS (independent security review §6.1, its findings fixed) |
| A5 | Execution roles per environment (one resolver) | `ExecutionRoleBindingsRequest`; actions `registry.execution_role_binding.set(.plan)`; route `planExecutionRoleBindings` (additive) | bundle `01M5G6EQ7MFWM3TVK3YN5WRK8W_execution-role-bindings` (append-only); `executionRolesFor` replaces every direct reader (planner, kind, executor, resume, rollback, reverify, reads, legacy); a source test forbids other readers; CLI `project execution-roles`, `project execution-roles set` | §4.5 | PASS, with OD-53 opened (§5) |
| A6 | Legacy files with cluster-global effects (replay elision, cluster-global expectations, `CONCURRENTLY`, comment-only files) | none needed (report evidence strings and the replay plan's analysis are additive data) | `postgres/src/parser/cluster-global.ts` (role statement effects, `DO` blocks through the PL/pgSQL parser of 18), `postgres/src/cluster-globals.ts` (the catalog check), `migrations-engine/src/legacy-replay.ts` (segments, chain supersession), `executor.ts` (`runReplayAutocommit`), `legacy.ts` (plan summary, segmented replay, classification, baseline verification); fixture `testkit/src/fixtures/cluster-global-history.ts` | §4.6 | PASS |
| A7 | Scratch targets: preflight, in-place reset, database retire | `ScratchCheck`, action `migration.import.scratch_check` and route `checkScratchTarget`; actions `registry.database.retire(.plan)`, route `planDatabaseRetirement`, `DatabaseRetireRequest`, conflicts `database_retired`, `database_in_use` (additive) | `migrations-engine/src/scratch-check.ts`, `postgres/src/scratch.ts` (objects outside the scope, presence by catalog lookup); `migrations/src/format/scratch-reset.ts` (the reset script); registry planner and `DatabaseRetireKind`; CLI `migration import scratch-check`, `migration import scratch-reset-sql`, `cluster database retire` | §4.7 | PASS (MCP not offered; see §5) |
| A8 | External-cluster onboarding without hand-made SQL | `getClusterBootstrapSql` query `database` (repeatable), `project`, `environment`, `ledgers`; `ClusterBootstrapSql.pendingDatabases`, `executionRoles`, `legacyLedgers` (additive) | `postgres/src/bootstrap.ts` (guarded `DO` blocks, the execution-role grant under the planner's checks, the psql `\connect` conninfo), `registry/src/bootstrap.ts` (roles of placed and requested projects, excused `BYPASSRLS`); CLI `cluster bootstrap-sql --database --project --environment --ledger`, `cluster declare-tier`; testkit `runPsql`; docs credentials-and-roles §8, registry §2.2, [`onboard-external-cluster.md`](../../12-operations/onboard-external-cluster.md), threat T36; OD-54 opened | §4.8 | PASS (the installed-CLI run of the new commands lands with A1's end-to-end test) |
| A9 | Documents brought up to the real state | — | docs only (§4.9) | §4.9 | PASS |
| A10 | Part A done: two independent review rounds, the pull request, the owner test package | — | — | §6.2 to §6.4, [`owner-test-package.md`](../../04-migrations/owner-test-package.md), `davdxpx/ExponetDB#34` | PASS: two full review rounds and a verification round, every finding fixed or opened as OD-55; the lab walk of the owner test package is NOT PROVEN until the owner runs it |

## 4. Evidence log

### 4.1 Phase 0 (2026-10-21)

- The order is committed as [`../orders/wave-9-order.md`](../orders/wave-9-order.md),
  unchanged.
- The decisions of §2 are recorded in `open-decisions.md` (OD-4, OD-7, OD-8,
  OD-51, OD-52, "Decisions of the Wave 9 order").
- `CLAUDE.md` "Current phase", [`../../12-operations/bootstrap.md`](../../12-operations/bootstrap.md)
  and the [G2 record](./2.md) state OD-7a precisely.

### 4.2 A1: the CLI legacy import (2026-10-21)

- Defect reproduced on the base code: with `legacy.baseline: baseline:demo-2026`
  in the project file, `exponetdb migration import analyze` stops locally
  with `usage: The request does not match the contract: baseline: …`
  (exit 2); with the fix the same command passes every local check and
  reaches the transport (exit 5 against an unreachable server).
- `apps/cli/test/local.test.ts` "migration import analyze from the project
  file" (3 tests): the project's `baseline:<slug>` and `--baseline` in both
  forms pass, an invalid slug is refused; a `--hints` file in YAML and JSON
  with `aliases`, `notApplicable`, `role`, `searchPath`, `ledgers` passes
  the contract check; an unknown field (`scratchTarget`), a wrong shape
  (`searchPath` as a string), a field given in the file and as a flag, a
  file that holds no object and a missing file are usage errors.
- `bun run --cwd apps/cli typecheck` clean; `vitest run` in `apps/cli`:
  5 files, 78 tests passed; `biome check apps/cli` clean;
  `bun run --cwd apps/cli reference` regenerated `15-cli/reference.md`.
- **End to end (2026-10-22).** `apps/server/test/cli-import.int.test.ts`
  (PostgreSQL 17, 3 tests) runs the CLI as a process (`bun` on the
  source, or `EXDB_CLI_BIN` for an installed CLI) against serve's public
  app over HTTP and the real worker. The person's CLI holds the token pair
  a `login` stores, issued by the real code flow and consent for the
  audience `api` (the scopes `login --preset admin` asks for that these
  commands use). From the project file (`layout: legacy+bundles`,
  `baseline: baseline:acme-supabase-2026`) and a `--hints` file (the
  multi-file alias, the two ledgers) `migration import analyze` plans the
  replay (`baselineId` from the project), `plan apply` replays it while the
  worker runs, `migration import report` shows the real-shape history by
  content (`0100_accounts` recorded with medium strength from
  `supabase:statements_normalized`, `0107_settings` unrecorded and weak),
  `migration import resolve` decides each open item with a note, and
  `migration import baseline --apply` exits 0 only once verified; the
  target's ledger then holds the legacy rows with their provenance and the
  baseline. No output carries a token. Command:
  `bunx vitest run --config vitest.integration.config.ts test/cli-import.int.test.ts`
  in `apps/server` (3 passed), and the same with the **installed** CLI:
  `bun run --cwd apps/cli pack`, `npm install --global --offline --prefix
  <dir> dist/artifacts/exponetdb-cli-0.6.0.tgz` with Node 24.22.1 outside the
  repository, then `EXDB_CLI_BIN=<dir>/bin/exponetdb` (3 passed).
- **Found by the end-to-end run:** `GET /targets/{target}/migrations/scratch-check`
  (A7) was answered by the earlier route
  `/targets/{target}/migrations/{migrationId}` (the server registers routes
  in contract order and the first match answers): over HTTP the preflight
  was a `VALIDATION_FAILED` on a migration id. The route is listed before
  it now, and `packages/contracts/test/interfaces.test.ts` "never shadow a
  later route" fails for any route of the same method whose parameter
  covers a later literal path (it found only this one).
- **Observed, not changed (pre-existing, Wave 3B):** the server answers
  `REAUTH_REQUIRED` with 401, and the SDK renews a renewable credential on
  every 401 before it returns the error: a CLI apply that needs a step-up
  first rotates the person's refresh token once. Harmless (the request is
  sent again and refused the same way, then the step-up starts), but a
  needless rotation; noted for a later SDK change, not widened into Part A.

### 4.3 A2: Supabase ledger matching on real data (2026-10-21)

- Design: [`legacy-import.md` §2.3](../../04-migrations/legacy-import.md#23-evidence-strength).
  Supabase `name` matches the stem (`<version>_<name>` only a fallback
  hint); the 14-digit version is the applied time; the statement sequences
  of both sides are compared after the lexical normalization of `c1`
  (unchanged), in three tiers (`strong` one by one, `medium` normalized,
  `low` comments in bodies ignored); `curated` aliases also for one entry
  → several files (compared with the files joined in file order); a name
  alone (`weak`) never records a file. Date pinning is de-scoped with the
  document change (PostgreSQL cannot fix `now()` per session); extensions are
  compared (name, schema, version) before any file replays.
- `packages/migrations-engine/test/legacy-evidence.test.ts` (9 tests, pure):
  one element with the whole file against the parsed file (medium), comments
  stripped inside a body too (low), the Wave 6 comparison (strong), a
  different text, an empty entry and unreadable text (no evidence),
  whitespace next to `;` and a missing last `;`, `;` and `--` inside
  literals and quoted names, a comment-only file, a multi-file entry in
  and out of file order, the strength rule, the Supabase version time.
- `packages/migrations-engine/test/legacy-supabase.int.test.ts` (PostgreSQL
  17, 3 tests) on the real-shape fixture: an alias naming an unknown file or
  one file twice is refused; a scratch target without the imported target's
  `pg_trgm` makes the report `incomplete` (`extensions_differ:pg_trgm`)
  before anything runs; then: `0100` and `0101` recorded by the normalized
  sequence (`medium`), `0102` by the weaker tier (`low`), `0103` and `0104`
  by the one merged entry (`medium`), the file edited after apply only
  `weak` and not recorded, `0106` (entry without statements) and `0107`
  (runner only) `unrecorded_present` and `weak`; no ledger entry is left
  without a file; the runner's table is global drift; the baseline verifies
  and takes `appliedAt` `2026-01-01T09:00:00.000Z` from the Supabase
  version, and claims none for a name-only file (`appliedAtUnknown`).
- The Wave 6 test `legacy.int.test.ts` now expects the corrected rule: a
  file matched by name only is `unrecorded_present` / `unrecorded_missing`
  (it was `recorded_*`), with the strengths `strong`, `curated`, `weak`
  shown; its other expectations are unchanged.
- Runs on this commit: `bun run check`, `bun run typecheck` (28 of 28),
  `bun run verify:generated`, `bun run golden:check`, `bun run golden:history
  origin/main` (452 vectors and 21 frozen bundles unchanged); unit tests of
  contracts (216), control-store (27), migrations-engine (19), postgres
  (1242), testkit (12), server (185), tooling (164), sdk (89); integration
  tests of control-store (117) and migrations-engine (62), all passed.

### 4.4 A3: the replay's execution role, no silent cap (2026-10-21)

- The replay plan binds `executionRoleCheck` (the role's facts read on the
  scratch target for `exponetdb_migrator`, `executionRoleProblem` as for an
  apply) and the alias; rule `migration.import-execution-role` (deny, not
  overridable) decides; acceptance refuses a plan whose alias now names
  another role; the worker reads the facts again on the migrator session
  under the scratch lock before the emptiness check and any file.
- The report records `drift_total` and `drift_truncated` (written once, by
  the worker, guarded); `planBaseline` refuses a truncated report with
  `LEGACY_IMPORT_TRUNCATED` (`driftTotal`, `held`); evidence lists and the
  attribute list of a `differs` item end with `evidence_truncated:<n>`
  instead of being cut; the error detail of unresolved items lists up to the
  contract's 1000.
- `packages/policy/test/migration-rules.test.ts` "migration.import-execution-role"
  (2 tests): usable and `declared_exception` pass; every other problem and a
  plan without the check deny, never overridable.
- `legacy-supabase.int.test.ts` (PostgreSQL 17), three more tests: the owner
  with `BYPASSRLS` makes the replay plan `deny` (rule facts `role`,
  `privileged_attribute`); `BYPASSRLS` granted after planning stops the
  replay under the lock (operation `failed`, `not_applied`, `PLAN_STALE`;
  report `incomplete`, `execution_role:privileged_attribute`; nothing ran);
  505 hand-made tables give `driftTotal` 1012 (each table and its column is
  one catalog entry), 500 drift items, `driftTruncated`, and the baseline is
  refused with `LEGACY_IMPORT_TRUNCATED` (`driftTotal` 1012, `held` 500)
  after every held item was decided.
- Web App (`apps/web/src/features/migrations/legacy-import.tsx`): the
  strength per item and a warning "This report does not hold all of its
  drift" with the counts; `test/target-pages/migrations.test.tsx` (one more
  test, 22 in the file); the copy rules of `test/i18n` hold.
- Runs on this commit: `bun run check`, `bun run typecheck` (28 of 28),
  `verify:generated`, `golden:check`, `golden:history origin/main`
  (unchanged); unit tests of contracts (216), policy (83), migrations-engine
  (19), server (185), web (159 files, 2372 tests); integration tests of the
  migrations engine (65).

### 4.5 A4, A5: execution roles for adopted schemas (2026-10-21)

- Design: [ADR-0034](../../01-architecture/adr/0034-execution-roles-for-adopted-schemas.md),
  [`credentials-and-roles.md` §3, §3.1, §3.2](../../03-database-model/credentials-and-roles.md#3-execution-roles-who-owns-application-objects),
  [`registry.md` §4.2](../../02-control-plane/registry.md#42-execution-roles-per-environment-and-declared-exceptions-wave-9),
  [`health.md` §3](../../10-observability/health.md), threat **T35**.
- **Found while building, corrected:** (1) `migration.rollback` never
  checked its execution role's facts (a Wave 6 defect): a rollback planned
  after the owner gained `SUPERUSER` or `BYPASSRLS` would have run
  `down.sql` as that role. The rollback now reads the facts at planning
  (`requirementsUnmet: execution_role`, deny), binds the role and the
  exception it relies on, and re-checks both at acceptance and under the
  lock. (2) The first bindings bundle granted `DELETE` to the worker; the
  frozen Wave 2 verification "no runtime role deletes" in the registry
  refused it on the first migration run. The bindings are now append-only
  (a change ends the current row and inserts its successor), which also
  keeps their history. (3) `credentials-and-roles.md:104-106` said "per
  target" while the code resolved per project; both now say per
  environment with the project map as default.
- `packages/postgres`: `executionRoleProblem(facts, excused)` stays pure;
  `declared_exception` only when `BYPASSRLS` is the sole problem and it is
  excused; superuser, `CREATEROLE`, `CREATEDB`, `REPLICATION`, login,
  protected reach and membership defects are reported first and never
  excused.
- `packages/migrations-engine/test/execution-roles.test.ts` (5 tests, pure
  plus a source scan): the exception excuses only `BYPASSRLS`; never
  another attribute; `boundExceptionsHold` and `rolesStillUsable` (the
  executor never widens what the plan bound); no engine module outside the
  resolver reads `execution_roles`, the bindings or the exceptions (the
  scan was checked against the old readers).
- `packages/migrations-engine/test/execution-roles.int.test.ts` (PostgreSQL
  17, 9 tests): staging and production of one project on one cluster run
  under their own owners (a production binding); the production plan
  consumes the staging evidence of the same checksum, binds the resolved
  name and shows parity `match`, and the table on production is owned by
  production's role; a binding changed after planning is `PLAN_STALE` at
  acceptance, and after acceptance at the worker's start (operation
  `failed`, `not_started`, `PLAN_STALE`; nothing ran); the ended binding
  stays as history; an alias outside the map and a protected role are
  refused; an owner with `BYPASSRLS` is denied until a person declares it
  for that environment, then the plan binds `{exceptionId, revision}`,
  shows the warn rule and applies, the objects owned by that role;
  `CREATEDB` on top is still denied; an agent plans on nonprod under the
  declaration without `migration.agent-production`; a revocation makes the
  waiting plan `PLAN_STALE` and the next plan denied, and a second
  revocation is `exception_not_active`; the rollback is denied while the
  declaration is revoked, binds a new declaration, and goes stale when it
  is revoked; on production the declaration needs an approval and a
  re-authentication, parity is `mismatch` while only staging has a
  declaration and `match` once production has one, a person's plan waits
  for an approval only because fp1 lineage differs (owners differ by
  design, OD-53), and an agent's plan needs `migration.agent-production`.
- `legacy-supabase.int.test.ts`, one more test: a declaration for the
  imported target's environment does not excuse the replay; one for the
  scratch target's environment does (bound, warned), and its revocation
  makes the replay plan `PLAN_STALE`.
- `packages/diagnostics/test/execution-role-exceptions.test.ts` (4 tests)
  and `diagnostics.int.test.ts` (3 more tests): no finding while the role
  matches; `bypassrls_lost` (warning), then on the same finding
  `privilege_exceeded` (critical) after `CREATEDB`, then `cleared`; a sample
  whose diagnostic session cannot open changes no finding; a revocation
  clears it.
- `apps/server/test/http-registry-tier.int.test.ts` (2 more tests, REST):
  the staging-only colleague binds and declares for staging, does not see
  production (`NOT_FOUND`) nor the project-wide view; a tier-restricted CLI
  grant changes no environment's roles (`PERMISSION_DENIED`: an environment
  subject passes only an unrestricted grant); a CLI grant for both tiers
  plans production's bindings (tier `prod`); an unknown alias is `422`;
  the view shows defaults, bindings, effective maps and the declaration
  (`attributes: [bypassrls]`, review date); a second active declaration is
  `exception_active`; the owner's production declaration waits for an
  approval and stays out of the registry; revocation gives revision 2 and
  a second one `exception_not_active`.
- `packages/contracts/test/registry.test.ts` (one more test): the three
  kinds are high, stored plans, re-authenticated, human only, tier
  `subject`; the plans are Web App and CLI only; no MCP tool exposes them.
- Golden vector `plan-006` (plan hash over a plan with per-environment
  roles and a bound exception) derived independently (Python JCS and
  SHA-256), appended and locked; the TypeScript implementation agrees.
- Also corrected in passing: the Web App's plan titles cover the three new
  kinds (`apps/web/src/features/plans/plan-title.ts`, a contract-wide
  test), and the server's served-routes test admits Wave 9 and pins its
  four routes.
- Runs on this tree: `bun run check`, `bun run typecheck` (28 of 28),
  `verify:generated`, `golden:check`, `golden:history origin/main` (452
  vectors unchanged, 1 new, 21 frozen bundles byte-identical), `boundaries`,
  `secrets`; unit tests of all 28 packages (turbo, `--env-mode=loose` so
  Playwright finds the preinstalled Chromium; in strict mode the tokens
  suite cannot launch it, an environment fact, not a code one), among them
  contracts 217, cli 78, server 186, diagnostics 143, web 2372; integration
  tests of control-store (117), registry (25), migrations-engine (75),
  postgres (483), diagnostics (162) and the server's migration, registry,
  MCP plan, break-glass, drift-accept and Wave 8 suites (87) plus
  `http-registry-tier` (8), all passed.
- **Found by the whole server suite (2026-10-22):** the MCP replay
  `plan-staging.modern` (`apps/server/test/mcp-replay.int.test.ts`) no
  longer equalled its recording: the plan a tool returns now carries the
  additive facts of A4 (`facts.executionRoleExceptions: 0`,
  `facts.executionRoleParity: "not_required"`, `analysis.executionRoleExceptions: []`).
  Recorded again on purpose (`EXDB_RECORD_TRANSCRIPTS=1`); the fixture diff
  is exactly those fields, in the text and the structured content, nothing
  environment-specific; the replay then passed twice (4/4) and its
  non-vacuity test still reports a changed answer. The tool catalog
  digests are unchanged (the output schemas did not change).

### 4.6 A6: legacy files with cluster-global effects (2026-10-21)

- Design: [`legacy-import.md` §2.4](../../04-migrations/legacy-import.md#24-files-with-cluster-global-effects).
- **Measured** on PostgreSQL 16, 17 and 18 (2026-10-21, then asserted by
  `legacy-cluster-global.int.test.ts`): as a `NOLOGIN` owner without
  `CREATEROLE`, `CREATE ROLE` in a `DO` block with `WHEN duplicate_object`
  fails with `42501` for a new and for an existing role, as do `GRANT
  <role> TO <role>` in such a block and `ALTER ROLE … SET`; a block guarded
  by `IF NOT EXISTS (… pg_roles …)` passes when the role exists.
- `libpg-query` 18.1.5 is the only binding with a PL/pgSQL parser
  (`parsePlPgSQLSync`); it reads `DO` bodies for the shape check only, the
  body's SQL statements are parsed with the target's major, and a body
  either cannot read is not elided.
- `packages/postgres/test/cluster-global.test.ts` (11 tests): `CREATE ROLE`
  with attributes and memberships and never the password, `ALTER ROLE`,
  `ALTER GROUP ADD/DROP USER`, settings rendered as PostgreSQL stores them
  (list quoting, `IN DATABASE`, `RESET`, `ALL`), `FROM CURRENT`, `RESET ALL`
  and `CURRENT_USER` as unknown, `DROP ROLE`, `GRANT`/`REVOKE` of roles with
  options, `RENAME`, `COMMENT ON ROLE`; role-only `DO` blocks (presence
  only under a handler, nested blocks, `RAISE NOTICE … SQLERRM`) and mixed
  ones (`IF`, other SQL, `PERFORM`, a declared variable, `RAISE EXCEPTION`,
  a function in a `RAISE`); `DO` without role statements and `LANGUAGE sql`
  untouched; the same on 16, 17 and 18.
- `packages/migrations-engine/test/legacy-replay.test.ts` (8 tests): a file
  without elision runs as submitted; elided statements and the remaining
  segment; a mixed block replayed; `CONCURRENTLY` alone between
  transactional segments; a comment-only file; an unparsable file;
  supersession over the chain (the last statement wins, a removal
  supersedes what names the role, a role created again survives).
- `legacy-cluster-global.int.test.ts` (PostgreSQL 16, 17, 18 for the
  measurement; 17 for the import, 5 tests): the replay plan lists 7 elided
  statements, the mixed block, the autocommit statement and the
  comment-only file; the replay completes; role-only files are
  `unrecorded_present` by `cluster_global_held:6/6` and `2/2`, a file with a
  table and role statements by both kinds of evidence, the mixed block's
  file `ambiguous` (`do_block_mixed:0`), the index file `unrecorded_present`
  with the index valid on the scratch target, the comment-only file
  `unrecorded_present` (`no_statements`), and a file whose connection limit
  was changed by hand on the target `ambiguous` (`cluster_global_held:0/1`);
  nothing cluster-wide ran (the hand-set limit is unchanged).
- The baseline verification checks the accepted files' surviving
  cluster-global expectations too.

### 4.7 A7: scratch targets that can be prepared and reused (2026-10-21)

- Design: [`legacy-import.md` §2.5](../../04-migrations/legacy-import.md#25-scratch-targets),
  [`registry.md` §4.3](../../02-control-plane/registry.md#43-correcting-a-wrong-registration-wave-9).
- **Reset without a new endpoint.** The reset script is built in the CLI
  from REST reads (target, project, installation): the server gains no
  write path, and the script runs only where a person runs it, as a
  superuser, guarded by the identity marker. Re-creating the database was
  not an option: a new oid fails `database_mismatch` at the next analysis.
- **Found while building:** `to_regclass` and its kin raise `42501` for a
  schema the observer may not use; the presence check reads the catalogs
  instead. A foreign key depends on the referenced table's unique index
  too; the preflight lists it, a schema-only copy with the same key has it.
- `packages/migrations-engine/test/scratch-check.int.test.ts` (PostgreSQL
  17, 5 tests): a fresh scratch target lacks the imported target's
  extension (`pg_trgm: target public@…, scratch missing`) and the three
  objects outside the scope (the identity table, its key, the function a
  policy calls); prepared, every check passes and an analysis replays; used,
  `empty` fails with the replayed objects; a role with `CREATEDB` fails
  `execution_role`; the reset script refuses the imported target's
  database, then on the scratch database keeps its oid and marker, restores
  the extension and the owner's `CREATE`, and the preflight is ready and the
  next analysis replays; a target that cannot be a scratch target is named
  (`same_target`, `not_found`) and nothing further is checked.
- `packages/registry/test/database-retire.int.test.ts` (2 tests): a current
  placement is refused (`database_in_use`); after the target's
  decommissioning the record is retired (verified, audited), a second
  retirement is `database_retired`, the database itself is untouched, and
  the re-created database (a new oid) registers again under the same name.
- `packages/migrations/test/scratch-reset.test.ts` (4 tests): the guard
  values, the scope's schemas, quoting of every name and the path, and
  refusal of non-canonical ids.
- Docs: freeze out-of-band DDL on the imported target between analysis and
  baseline (`SCHEMA_FINGERPRINT_MISMATCH` at planning, `PLAN_STALE` under the
  lock), `legacy-import.md` §2.5.

### 4.8 A8: external-cluster onboarding without hand-made SQL (2026-10-22)

- Design: [`credentials-and-roles.md` §8](../../03-database-model/credentials-and-roles.md#8-external-clusters-no-node-agent),
  [`registry.md` §2.2](../../02-control-plane/registry.md#22-external-cluster-no-agent),
  the walkthrough [`onboard-external-cluster.md`](../../12-operations/onboard-external-cluster.md).
- **The grant is guarded where it runs.** The script would otherwise be a
  way to give the migrator `SET ROLE` into any role a project names
  (`postgres` included). The grant runs only if the role passes the
  planner's checks in the administrator's session (`LOGIN`, the privileged
  attributes, `BYPASSRLS` unless a declared exception excuses it in an
  environment on the cluster, a reach into a privileged, predefined or
  ExponetDB role); otherwise a `WARNING` names it. The planner checks again
  at plan and apply (threat T36).
- **The psql connection to each database is by name only.** A database
  name with `=` or a URI prefix would make psql's `\connect` read it as a
  connection string (another host); the script passes a conninfo holding
  only `dbname`, single-quoted for psql (no variable, no backquote command),
  with `-reuse-previous=on`. **[OBSERVED]** psql 17 inside the PostgreSQL
  17 test container connects to a database named `we'ird\db host=evil`
  from that line; the host's psql 16, connected with `verify-full`, keeps
  it across `\connect` (`pg_stat_ssl`: TLSv1.3 after the switch, the TLS
  name kept).
- **A project named in the request** adds its execution roles only when
  the caller may also read them (`project.execution_roles.get`), so the
  cluster's `registry.manage` alone does not reveal another project's
  role names.
- `packages/registry/test/bootstrap.int.test.ts` (PostgreSQL 16, 17, 18; 3
  tests): the script generated from the registry (a placed target's
  project, a second project named in the request, a registered and an
  unregistered database, the `supabase` and `drizzle` ledgers) runs with
  psql without an error; the migrator holds `SET` without `INHERIT` on the
  fit roles only (the excused `BYPASSRLS` role included); a `LOGIN` role and
  one reaching `pg_read_all_data` get a `WARNING`, a missing one a `NOTICE`;
  a second run leaves the roles, memberships, settings and database and
  ledger privileges identical; a role created afterwards is granted on the
  next run; the observer reads the declared ledger. Command:
  `bunx vitest run --config vitest.integration.config.ts test/bootstrap.int.test.ts`
  in `packages/registry` (3 passed).
- `packages/postgres/test/adapter.test.ts` (36 tests, 4 new): no bare
  `CREATE`; six guarded roles; the grant list and its checks (`BYPASSRLS`
  only where excused); predefined and ExponetDB names refused; the
  `\connect` line of a hostile name; control characters refused; the
  largest registry state (1 032 databases, three ledgers, 1 024 roles:
  3.0 MB) stays under the response's limit.
- **Found while building:** the server checks every response against its
  contract, and `ClusterBootstrapSql.script` was capped at 65 536
  characters; the guarded statements reach that at about 20 databases with
  three ledgers, which would have answered `INTERNAL`. The cap is 8 MiB
  now (a widening of an output field).
- `apps/server/test/http-registry.int.test.ts` (14 tests): the query over
  REST (repeated `database`, `project`, `ledgers`), and its refusals: an
  `environment` without its `project` and an unknown ledger kind are
  `VALIDATION_FAILED` (422), an unknown project `NOT_FOUND`.
- CLI unit tests (78) pass; `exponetdb-docs/15-cli/reference.md` regenerated
  (`bun run --cwd apps/cli reference`).
- **Found while building:** `cluster register` always creates an external
  cluster and the record never changes its mode or server (guard `EXG07`);
  no operation makes a cluster agent-managed. Opened as OD-54 (it decides
  whether Part B's node capabilities can reach REOSA staging if it is
  registered external first).

### 4.9 A9: documents brought up to the real state (2026-10-22)

The facts of the order §6 (and §5.1 where they bear on the documents) are
written as **[OBSERVED]** with that source, everything still to come as
**[PLANNED]**; ExponetDB never connected to the host.

- Private address `10.8.1.1` (the documents said `10.8.1.2`) and the TLS
  facts (`reosdb01.exponet.cloud`, the name-constrained CA, `hostssl` with
  SCRAM, `verify-full`, BoringSSL versus OpenSSL and Go) in
  `control-plane-and-data-plane.md` (the topology, the V1 diagram, the
  network paths), `domain-model.md`, `deployment.md` (the diagram, the
  host rows, the network rules, the egress note, §5), `bootstrap.md`
  (§1, §5) and `reosa-current-state.md` (the network table and a closing
  section with the installation as of 2026-10-21).
- The host runs without a node agent (an external cluster): the V1
  diagram, `deployment.md` and `bootstrap.md` say so, with the G5 waiver's
  expiry condition and OD-54 as what an agent there waits for; the
  per-wave host table records that the Wave 5, 6 and 9 rows have not
  happened there.
- `reosa-integration.md` §3 (staging already on `reos-db-01` as an external
  cluster, a self-hosted identity service, production still hosted; OD-7a
  and OD-7b) and §4 (11.1 starts from the running host; 11.5 the
  pgBackRest adoption, OD-52).
- `legacy-import.md` §1: the real history's shape (about 530 files, the
  Supabase ledger's 391 rows and its shape, `public.applied_migrations`'
  187 rows, role DDL in files, the managed scope).
- `credentials-and-roles.md` §3 (the reference shape in the declaration
  table, and §3.3 "The reference installation's role set" with how
  ExponetDB maps it under ADR-0034 and OD-53), §7 (SNAT from `10.8.2.2`
  now observed), §8 (the hosted-provider assumption narrowed to
  production).
- `registry.md` §4: `reos-db-01` runs and hosts staging; production moves
  in Wave 11.
- Not given by the order and so not stated as fact: pgvector on the host
  (kept from the earlier plan in two diagrams), whether the containers on
  `reos-01` resolve `reosdb01.exponet.cloud` (the documents give the
  endpoint as `10.8.1.1:5432` with that TLS name), whether PostgreSQL also
  listens on loopback (dropped from the deployment row), and whether
  `<env>_owner` is itself a member of a privileged role (the reach check
  decides when it is registered).

## 5. Limits and residual risks

- **OD-53 (open).** fp1 includes owners, so a non-legacy project whose
  environments own their objects with different roles needs an approval
  for every production plan (`migration.fingerprint-lineage`); imported
  legacy projects see only the legacy warning. Fail closed, fp1 unchanged.
- **T35 (accepted residual risk, OD-51).** While a declaration is active,
  a reviewed migration running as the declared owner reads rows of tables
  owned by other roles past their row security. The target state is a
  dedicated definer role (ADR-0034 §7).
- A6: a setting value PostgreSQL renders differently from the statement
  (a reserved word in a `search_path`, an interval it normalizes) does not
  hold and makes the file `ambiguous` (fail closed). A `DO` block that
  creates roles through a dynamic `EXECUTE` is not recognized; it replays
  as submitted and fails like before (`replay_failed`, 42501).
- A7: the preflight is not an MCP tool (the order allows it only read only
  and scoped; a new tool needs its own catalog version, left for when an
  agent needs it). It reads at most 1 000 objects outside the scope
  (`unknown` beyond) and does not compare the copies' definitions, only
  that they exist. The reset drops default privileges set inside a managed
  schema.
- The health finding compares on the 15-second sample; between two samples
  a changed role is caught by the plan and the executor's own checks.
- A8: the bootstrap SQL does not remove what a person granted by hand
  beyond it (an extra membership or attribute of an ExponetDB role or of
  an execution role); the planner refuses an execution role that gained
  one. The legacy ledger section needs psql (`\connect`). The Web App's
  cluster page shows the registry's default script (registered databases,
  placed projects) and does not take the new query parameters yet.
- **OD-54 (open).** A cluster registered external stays external: node
  capabilities on it are `CAPABILITY_UNAVAILABLE` until the owner decides
  how it gains the agent.
- A8 (review round 1, security P3-2): the bootstrap SQL grants the
  migrator `SET` on an execution role whose `BYPASSRLS` is excused in any
  environment of the cluster's projects; that role's other attributes and
  reach are still checked. That the role is used only where its
  environment's declaration holds is the plan's and the executor's check
  (`executionRoleExceptions`, re-checked under the lock), not the grant's.
- A8: a database whose name holds a double quote gets no legacy ledger
  grant from the script (psql cannot `\connect` to it); the script says so,
  and a person grants the read by hand.
- **OD-55 (open), threat T38.** Procedural code a migration or a replay
  runs (a `DO` block, a routine it creates and calls) can switch to any
  role the migrator holds and back, unseen by the executor's guard: the
  ledger owner (the target's ledger and marker inside the transaction),
  the migrator, other projects' execution roles on the cluster. A forged
  ledger diverges from the Control Store mirror (C-19); production needs a
  person and Control Store verification runs. Part A closed its one path
  to superuser code (§6.4).
- Review round 2 (C2-S2), for the owner: an execution role that is a
  member of a role with `BYPASSRLS` (Supabase's `service_role`) or of a
  `pg_*` role is never usable, declared or not (ADR-0034 excuses the role's
  own attribute only). Check REOSA staging's `<env>_owner` memberships
  before running the owner test package's §8 there.
- Review round 2 (C2-P3-3): the preflight does not compare what lies
  outside the managed scope beyond what the imported schema depends on, and
  `pg_depend` holds no references from function bodies other than `BEGIN
  ATOMIC`; objects a replay creates outside the scope stay on the scratch
  target after the reset (legacy-import.md §2.5).
- Review round 1, P3-5: the baseline verification fails when the imported
  target's major cannot parse the chain (`structural.unparsed`); no test
  drives it, since it needs the imported target's major to change between
  the analysis and the baseline (a scratch target on another major is now
  refused before the replay, §6.2). The `total` of `LEGACY_IMPORT_AMBIGUOUS`
  (more than 1 000 undecided items) has no test either.

## 6. Reviews

Two independent review rounds over the whole Part A diff (correctness,
security, truthfulness of states, docs and code agreement) are recorded here
before the pull request is marked ready.

### 6.1 Security review of A4 and A5 (2026-10-21)

An independent reviewer (fresh context, no part in building it) reviewed
`aa459e3` against ADR-0034, the order and the threat model, ran the golden
checks and the A4/A5 suites, and edited nothing. **No P1.** Findings and
what was done, in `fix(migrations): …` after `79cfcf0`:

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| P2-1 | P2 (from Wave 6) | An execution role reaching, through a membership, a role with `CREATEROLE`, `CREATEDB`, `REPLICATION` or `BYPASSRLS` passed the check (only superusers and protected roles counted); a migration could hand an object to that role (`ALTER … OWNER TO`) and use its powers without any declaration | the reach check counts those attributes; such a role is never usable, declared or not (ADR-0034 §3, `credentials-and-roles.md` §3); the health finding reports it (and `LOGIN`) as `privilege_exceeded` | `execution-roles.int.test.ts` "refuses an owner that reaches a privileged role"; `execution-role-exceptions.test.ts` |
| P3-1 | P3 | A revocation or expiry did not stop the later migrations of a running plan | the apply kind re-checks bindings, roles and exceptions before each further migration (`PLAN_STALE`, the rest not started) | "stops a running plan before its next migration" |
| P3-2 | P3 | The replay's check under the lock did not compare the resolved alias with the bound role | compared (`execution_role:alias_changed`) | the existing replay tests |
| P3-3 | P3 | A tier change of an environment kept nonprod-authority bindings and declarations effective on production | the planner refuses `tier_in_use` and a Control Store trigger refuses the change while bindings or active declarations exist | "keeps an environment's tier while it binds roles" |
| P3-4 | P3 | A binding outlived an alias removed from the project map | the resolver and the view bind only aliases of the map | same test |
| P3-5 | P3 | Binding maps were sorted by the Control Store's collation, compared as JSON in JS | sorted in JS | (latent under C collation) |
| P3-6 | P3 | The binding kind could end rows, then return "not applied" without an audit event | every value checked before any write | (unreachable after contract validation) |
| P3-7 | P3 | A declaration's reason (untrusted text) was copied into migration plans agents read | left out of plans; shown in the registry view only | `execution-roles.int.test.ts` (analysis) |
| P3-8 | P3 | Missing tests: Control Store guards, a passed review date, audit events | added | "guards the records in the Control Store", "excuses nothing after the review date", "audits every declaration and revocation" |

Checked and found sound by the reviewer: only `BYPASSRLS` is ever excused;
plans bind `{exceptionId, revision}` and acceptance, dispatch and the
executor under the lock re-check them; the Control Store guards; human-only
authorization with production approval and re-authentication; no SQL
injection path; the single resolver; the health finding's read and
clearing rules; the frozen pieces unchanged.

### 6.2 Review round 1 over the whole Part A diff (2026-10-22)

Two independent reviewers (fresh context, no part in building it), one for
correctness and truthfulness of states, one for security and authority,
reviewed `git diff origin/main...4a26597` (13 commits), ran the golden
checks and the suites they needed on disposable containers, and edited
nothing. Their probes stayed in the session's scratch directory. Every
finding is fixed in `fix(migrations): …` after `4a26597`, with a test
unless the row says otherwise.

**Correctness.** One P1, three P2, nine P3:

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| C-P1-1 | P1 | One ledger entry's content recorded every file with the same content: a fix copied into a second, never applied file was `recorded_present` | an entry's content goes to one file: the entry that names one takes it, as many entries as files pair up in order, fewer leave each file `ambiguous` (`content_matches_files:<n>`); legacy-import.md §2.3 | `legacy-ledger-match.int.test.ts` "records a file by content once" (fails on the old code) |
| C-P2-1 | P2 | `superseded` hid `cluster_global_unknown`: a file whose objects a later file dropped never showed its unknown role effect | `cluster_global_unknown` is always `ambiguous` (§2.4) | same test (`0004_x`) |
| C-P2-2 | P2 | The reset script's fixed `$reset$` tag broke on a schema name holding it | the tag is chosen to occur nowhere in the body (the same defect as S-P1-1) | `scratch-reset.test.ts`, `scratch-check.int.test.ts` |
| C-P2-3 | P2 | The `strong` statement tier collapsed whitespace, so data (`'a b'` and `'a  b'`) and text a line comment ended were equal | `strong` is byte equality per statement with only the ends trimmed (§2.3, step 3 table) | `legacy-evidence.test.ts` "never treat whitespace that is data …" |
| C-P3-1 | P3 | The `low` tier removed comments and whitespace in any dollar-quoted body: data and Python bodies too | only `DO` blocks and `plpgsql`/`sql` routine bodies | `legacy-evidence.test.ts` "remove comments … only inside code bodies" |
| C-P3-2 | P3 | A report analyzed before drift totals were kept could be baselined though it may have been cut at 500 items | refused (`LEGACY_IMPORT_TRUNCATED`, `driftTotal` null; the detail is nullable, additive) | `legacy-supabase.int.test.ts` drift test |
| C-P3-3 | P3 | A truncated report with every held item decided read `resolved` | `resolved` only when it can become a baseline | same test |
| C-P3-4 | P3 | The preflight checked the scratch environment's role, not that it is the role the imported target resolves (every replayed object would drift by owner); the alias was always `owner` | `execution_role` fails `differs_from_target`; `role` query and CLI `--role` (additive) | `legacy-ledger-match.int.test.ts` "names an execution role other than …" |
| C-P3-5 | P3 | The baseline verification passed on the fingerprint alone when the chain did not parse on the imported target's major | fails (`structural.unparsed`). Found while fixing it: nothing checked that the scratch target runs the imported target's major, which §2 step 2 requires; the preflight (`major_differs`) and the replay (`incomplete`, `major_differs:<target>/<scratch>`) now refuse it | the major: "refuses a scratch target on another major"; the unparsed path: none (§5) |
| C-P3-6 | P3 | The bootstrap's ledger section stopped psql at the `\connect` to a database that does not exist yet | guarded with `\gset`/`\if`, a message, the next database handled | `bootstrap.int.test.ts` on 16, 17, 18 |
| C-P3-7 | P3 | The reset's `DROP SCHEMA … CASCADE` also dropped objects outside the scope that depend on it | refused, naming them (`pg_depend`, normal and automatic) | `scratch-check.int.test.ts` (a view); a probe on 16 and 18 named a column type, a default, a view and a trigger and passed operators, operator classes, policies and triggers inside the scope |
| C-P3-8 | P3 | `LEGACY_IMPORT_AMBIGUOUS` listed 1 000 items without saying more wait | `total` (additive) | none (§5) |
| C-P3-9 | P3 | An alias that the entry's own statements contradict still recorded every file | `alias_contradicted` (`weak`), `ambiguous` unless content records the file | `legacy-ledger-match.int.test.ts` (`0009_notes_index`) |

**Security.** One P1, one P2, three P3. The reviewer found the A4/A5
authority model, the replay's elision of role statements, the preflight's
read-only access, the database retirement, the bootstrap's name escaping
(backquotes, `\gexec`, `$exdb$`, `:var`, `host=`, URIs, control characters
run end to end through psql), secrets and the frozen pieces sound.

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| S-P1-1 | P1 | A managed-scope schema name holding `$reset$` closed the reset script's `DO` block early, and the rest ran as top-level SQL as the superuser running it, past the marker guard (proven without `ON_ERROR_STOP`; with it, a failed reset); `registry.manage` sets schema names | the collision-free tag; the script stays one transaction with one `DO` block, so nothing runs after an error | `scratch-reset.test.ts` "quotes the block with a tag …"; `scratch-check.int.test.ts` runs the reviewer's name and finds no table created |
| S-P2-1 | P2 | psql drops double quotes from a `\connect` argument: the ledger grants for `q"w"e` landed in `qwe` (observer read only) | each grant block checks `current_database()` and raises otherwise; a name holding `"` gets no `\connect`, only a message (credentials-and-roles.md §8) | `adapter.test.ts`; `bootstrap.int.test.ts` "never grants the ledger read in another database" on 16, 17, 18; the guard's raise proven with psql 17 |
| S-P3-1 | P3 | The reset's documents did not name `ON_ERROR_STOP` | the CLI, the script's header and legacy-import.md §2.5 say `psql -v ON_ERROR_STOP=1` | — |
| S-P3-2 | P3 | The bootstrap excuses `BYPASSRLS` for the grant when any environment declared it | stays: documented (§4.8, §5); the plan and the executor check the declaration per environment | — |
| S-P3-3 | P3 | The replay's autocommit step leaves session settings set | stays: the Wave 6 autocommit runner does the same, each step sets its own, and the session belongs to one operation and is closed after it | — |

### 6.3 Review round 2 over the whole Part A diff (2026-10-22)

Two fresh independent reviewers (no part in building it or in round 1), one
for correctness and truthful states, one for security and authority,
reviewed `git diff origin/main...b38b970` (16 commits), re-verified the
round-1 fixes, ran the golden checks and the suites on disposable
containers, and edited nothing. Both confirmed the frozen pieces unchanged.
Fixes in `65b4837` (security) and the commit after it (correctness), each
with a test that fails on the code before it unless the row says otherwise.

**Security.** One P1, two P3:

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| S2-P1-1 | P1 | The scratch reset script, run by a superuser, resolved its operators through the session's `search_path`: an exact-type operator a replay left in a managed schema (`public.=(oid, regclass)`) won over the built-in one and ran as the superuser (the reviewer: `ALTER ROLE … SUPERUSER` ran; here, 61 280 calls in one reset) | the transaction sets `search_path = pg_catalog, pg_temp` before the `DO` block (threat T37, legacy-import.md §2.5) | `scratch-check.int.test.ts` plants the operator: 0 calls (61 280 without the fix); `scratch-reset.test.ts` |
| S2-P3-1 | P3 | The bootstrap script compares names unqualified while an administrator runs it (no hijack found: every comparison collides with a `pg_catalog` operator) | the same path in its first session and after each `\connect`, reset at the end (credentials-and-roles.md §8, T36) | `adapter.test.ts`; `bootstrap.int.test.ts` on 16, 17, 18 |
| S2-P3-2 | P3 (suspected by the reviewer) | A retirement and a registration of the same database could both commit (READ COMMITTED; the foreign key's lock does not conflict with the retirement's update), leaving a placement on a retired database | the registration locks the database row `FOR SHARE` first; whichever comes second waits and its guard refuses (registry.md §4.3) | `database-retire.int.test.ts` "never leaves a placement …" (the registration finished during the retirement without the lock) |

**Correctness.** Two P2, four P3, two suspected:

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| C2-P2-1 | P2 (the C-P1-1 class) | An entry's name only counted inside one tier's group: a copy of a named file's text recorded as applied when the named file was reformatted, edited after it ran, or named by two entries | an entry that names a stem stands for that file only; its content never records another file (`content_names_other_file`); each ledger records a file once; only unnamed entries pair (legacy-import.md §2.3, §6) | `legacy-ledger-match.int.test.ts` (`0012`–`0017`) |
| C2-P2-2 | P2 | `migration import scratch-reset-sql` threw for a project scope without an include list (`null` in the project view), the walkthrough's default | `null` means all schemas but the excluded ones | `scratch-reset.test.ts`; `local.test.ts` "resets a project scope that lists no schemas" |
| C2-P3-1 | P3 | Entries of one content matching at different tiers never paired | entries are grouped by the files their content equals, at any tier | same test (`seed_b`, `medium`) |
| C2-P3-2 | P3 | An entry beyond the files of its content disappeared from the report | it stays a ledger item without a file | same test (`seed_c`) |
| C2-P3-3 | P3 | The reset refused publication members; its list was cut without a mark; the preflight's `ready`, objects a replay leaves outside the scope (the Supabase `auth.users` trigger) and references inside function bodies were not described | publication members no longer refused; the count and a cut mark in the message; legacy-import.md §2.5 and the owner test package say what `ready` does not cover | `scratch-check.int.test.ts` (a publication kept, the count); a probe on 16 and 18 |
| C2-P3-4 | P3 | The `low` tier normalized a dollar-quoted default before a routine's body | only the string after `AS` (or `DO`) is a code body | `legacy-evidence.test.ts` |
| C2-S1 | suspected | An imported target unreachable during the replay left the report `pending`, not `incomplete` as §6 says | `incomplete`, `target_unavailable` (before the replay: not applied; after it: the scratch target took the files) | `legacy-ledger-match.int.test.ts` "an imported target that cannot be read" (a connector that refuses it) |
| C2-S2 | suspected, owner question | ADR-0034 excuses only the role's own `BYPASSRLS`: an owner that is a member of a role with `BYPASSRLS` (Supabase's `service_role`) or of a `pg_*` role reaches a protected role and is never usable, declared or not | not changed: the reach rule is a DECIDED security rule (order §1, stop-and-ask); the owner checks the `<env>_owner` memberships on REOSA staging before §8 of the owner test package (§5) | — |

### 6.4 Review round 3: the round-2 fixes verified (2026-10-22)

Round 2 found a P1 and the ledger matching was rewritten, so a third fresh
reviewer (no part in building or in rounds 1 and 2) verified the round-2
commits `65b4837` and `ba763db` on disposable containers, edited nothing,
and confirmed the frozen pieces unchanged. Every other round-2 fix it
verified as correct and complete: the reset's `search_path`, the
bootstrap's path in every session, the `FOR SHARE` lock in both orders (no
deadlock), the `relateLedger` rewrite (per ledger; named first, then
unnamed pairing; leftover entries kept; `content_names_other_file` never
hides a recorded file), `isCodeBody`, and `target_unavailable` (no read
swallowed as empty).

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| S3-P1-1 | P1 (since Wave 6; it defeated S2-P1-1) | The reset read its marker with `SELECT FROM exponetdb.target_identity`, qualified, so the pinned path did not help: a replayed `DO` block that ran `EXECUTE 'SET ROLE exponetdb_ledger_owner'` (the migrator holds `SET` on the ledger owner) and switched back could replace the marker with a view whose condition calls a planted function, which then ran as the superuser running the reset (the reviewer: `ALTER ROLE … SUPERUSER` ran) | the reset reads the marker and the ledger only once the catalog shows plain tables of `exponetdb_ledger_owner` with built-in column types, no children, no row security; it reads them `ONLY` and with qualified operators and casts; otherwise it refuses and says to re-create the scratch database (legacy-import.md §2.5, T37) | `scratch-check.int.test.ts` replaces the marker with such a view: refused, the planted function never runs (without the fix it ran and the reset went on to its dependency check); `scratch-reset.test.ts` |
| S3-OD | open decision | The general cause: procedural code in a migration session can act as any role the migrator holds (the ledger owner, the migrator, other projects' execution roles on the cluster) and switch back unseen; also for authored bundles, also an agent's nonprod plan (proven on PostgreSQL 17) | not changed in Part A: the containment needs a change to a DECIDED rule (the ledger in the same transaction, C-19; `NOLOGIN` execution roles), a stop-and-ask point of the order; **OD-55** and threat T38 opened with options and a recommendation | — |

## 7. Follow-up after the merge: an execution role that owns its database (2026-10-22)

**[OBSERVED]** While the first real external cluster (`reos-db-01`,
PostgreSQL 17.11) was onboarded with the merged release `41ebcbb`, the
scratch preflight refused `reosa_stg_owner` with `reaches_protected_role`.
Every plan and replay on a target whose execution role owns its database
was refused the same way.

- **Cause.** Inside a database its owner is an implicit member of
  `pg_database_owner`, and the reach predicate counted every `pg_*` role.
  The bootstrap SQL evaluates in `postgres`, where that membership does not
  exist, so it granted the role; the planner and the bootstrap disagreed.
- **The owner's request.** Fix it in ExponetDB as a Part A follow-up, with
  no consumer-side workaround.
- **Decision.** [ADR-0034 §3.1](../../01-architecture/adr/0034-execution-roles-for-adopted-schemas.md#31-pg_database_owner-is-not-a-protected-reach-2026-10-22):
  - `pg_database_owner` is excluded by its oid;
  - every other predefined role stays protected;
  - the predicate is one fragment, `REACHES_PROTECTED_ROLE`, used by the
    role facts and embedded in the bootstrap SQL;
  - no per-database bootstrap check is needed, because no other membership
    depends on the database.
- **Evidence:**
  - `packages/postgres/test/migration-exec.int.test.ts` on PostgreSQL 16,
    17 and 18:
    - a role that owns its database is usable and applies a migration;
    - the predicate gives the same answer in that database and in
      `postgres`;
    - a database owner that reaches `pg_read_all_data` is still refused;
    - without the exclusion the test fails on all three majors.
  - `legacy-supabase.int.test.ts` and `scratch-check.int.test.ts` (17): the
    databases are now owned by their execution role, as on `reos-db-01`.
    The replay under the declared exception, the classification, the
    preflight and the reset pass; without the exclusion 9 of their 12
    tests fail.
  - `adapter.test.ts`: the bootstrap embeds the planner's text, and the
    exclusion is by oid only.
  - The owner test package creates `acme_staging` and `acme_scratch` owned
    by `acme_staging_owner`, and its fixture's SQL loads into such a
    database (PostgreSQL 17).
- **On `reos-db-01`** nothing changes. After this is deployed, the owner
  runs `scratch-check` again.

**Independent security review of this follow-up** (2026-10-22). It found
the core change sound: `pg_database_owner` is a leaf of the membership
graph, and the predicate is the same in every database. It also found
three P2 defects, merged with `davdxpx/ExponetDB#35` and fixed in the next
pull request. Each has a test that fails on the merged code.

| # | Finding | Fix | Test |
|---|---|---|---|
| F-A | The credential verifier's own reach query kept `pg_database_owner`, so the migrator credential failed (`role_attributes`) on a database its execution role owns. On `reos-db-01` that would happen at the next verification once such a database is registered | the same oid exclusion in `credentials.ts`; ADR-0034 §3.1 | `packages/registry/test/credential-db-owner.int.test.ts` on 16, 17 and 18 |
| F-B | Admission admitted `GRANT`/`REVOKE … ON DATABASE`, `COMMENT` and `SECURITY LABEL ON DATABASE`, which an owning execution role can now run (a `REVOKE CONNECT` from ExponetDB) | every statement on the database object is refused (`database`), including `ALTER DATABASE … OWNER TO` and `RENAME TO` | `migration-analysis.test.ts` |
| F-C | The scratch reset script quoted values as plain literals, so a database owner who turned `standard_conforming_strings` off let a schema name holding a backslash end its literal and run code as the superuser (the reviewer proved it on 16, 17 and 18) | `E''` literals and `SET LOCAL standard_conforming_strings = on` | `scratch-check.int.test.ts` (the payload never runs); `scratch-reset.test.ts` |


## 8. Follow-up 2: the legacy import against a real Supabase-origin history (2026-10-22)

**[OBSERVED]** The owner ran the first real legacy import on `reos-db-01`
(PostgreSQL 17.11) with the deployed release `04b3edcd`: 556 legacy files,
the ledgers `supabase` and `applied_migrations`. `scratch-check` passed all
six checks (the `pg_database_owner` fix works). The owner's request: fix in
ExponetDB (contracts, tests on PostgreSQL 16, 17 and 18 with a synthetic
fixture of that shape, docs), no consumer-side workaround. Nothing on the
cluster changed.

| # | Observed | Decision | Evidence |
|---|---|---|---|
| F1 | The second replay stopped with `42501` at a `DO` block `IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = …) THEN GRANT <role> TO <role>; END IF` (two of 556 files): the guard made the block mixed, so it ran as the execution role | A role-only `DO` block may hold `[NOT] EXISTS` guards over `pg_roles` or `pg_auth_members`, `THEN` only, nothing else in them. `NOT EXISTS` keeps presence only; `EXISTS` makes the expectations conditional: checked only while the guard holds on the imported target, never superseding another one ([legacy-import.md §2.4](../../04-migrations/legacy-import.md#24-files-with-cluster-global-effects)) | `cluster-global.test.ts` (both real shapes on 16, 17, 18, nested guards, nineteen guards that stay mixed), `cluster-globals.int.test.ts` (16, 17, 18), `legacy-replay.test.ts`, `legacy-cluster-global.int.test.ts` (the `42501` measured on 16, 17, 18; fails on the code before) |
| F2 | `scratch-reset-sql` refused with 25 "objects outside the managed scope": the casts and access methods of `vector` in `public` | A member without a schema of an extension in the scope goes with it and is re-created; a member in a schema outside the scope now refuses (it was dropped silently before: `pg_depend` `e` rows were not read) ([§2.5](../../04-migrations/legacy-import.md#25-scratch-targets)) | `scratch-reset.int.test.ts` with `vector` and `pg_trgm` in `public` on 16, 17, 18 (the 25 objects on the script before); `scratch-check.int.test.ts` |
| F3 | `scratch-check` passed; the replay stopped at a policy calling `auth.uid()` (`3F000`): no current object depended on it any more | The preflight with the legacy files (`POST …/scratch-check`) adds `legacy_references` from the files' parse trees and `copySchemas`; `migration import scratch-copy-commands` prints a schema-only copy without triggers (§2.5) | `legacy-references.test.ts` (16, 17, 18), `scratch.int.test.ts` (16, 17, 18), `scratch-check.int.test.ts`, `scratch-copy.test.ts`; the copy commands run once on PostgreSQL 17 |
| F4 | `serve` restarted during the first `import analyze` at 512 MiB; at 1 536 MiB the request passed (cause not proven by the owner) | **Proven here:** on Node 24 V8's tier-up of the parser's WebAssembly takes hundreds of MiB outside the heap; in a 512 MiB container the plan of a 600-file, 3 MB history was killed, and so was one 3.6 MiB file. Every role starts with `node --liftoff-only` (plan peak 164 MiB, replay 250 MiB); a history is at most 8 MiB per request; one parse is given at most 200 000 tokens, and `serve` holds at most two such requests at once (after the verification review, below) ([deployment.md §2a](../../12-operations/deployment.md#2a-memory)) | `legacy-large.int.test.ts` (600 files, 3 MB, end to end on 17), `legacy-parse.test.ts`, `scripts/measure-analyze-memory.ts` |
| F5 | The hosted connector strips comments inside dollar-quoted bodies: ten functions differed byte for byte and matched once normalized | The `statements_bodies` tier is `medium` (a code body normalized as the statement around it); `low` is no longer given (§2.3) | `legacy-evidence.test.ts` (the connector's shape), `legacy-supabase.int.test.ts` |

**Owner actions after this is deployed** (in this order; nothing here is
done from this session):

1. The Coolify resources' Custom Docker Options become `--entrypoint "node
   --liftoff-only /app/bin/exponetdb.mjs serve"` (`worker`, `gateway`
   likewise); the startup log no longer shows
   `process.wasm_tier_up_enabled`. Memory and swap limits are changed
   together.
2. The consumed scratch database is reset with `migration import
   scratch-reset-sql` (F2).
3. `migration import scratch-check` runs in the project directory, so it
   sends the legacy files; `migration import scratch-copy-commands` prints
   what the scratch target still lacks (the `auth` copy made by hand
   already covers `auth.uid()`).
4. The analysis runs again.

**Independent reviews of follow-up 2** (2026-10-22). A security review and
a correctness review read the five commits; neither found a P1. Every
finding is fixed on this pull request, each with a test, unless noted.

| # | Review | Finding | Fix |
|---|---|---|---|
| S-F3-a | security P2 | Nested `LANGUAGE sql` bodies made the reference scan exhaust `serve` (a 300 KB file above 512 MiB, deeper ones a stack overflow) | bodies followed two levels deep; beyond, `legacy_references` is `unknown` (`too_complex`) |
| S-F2-a | security P2 | The reset dropped, unseen, a server and a foreign table outside the scope that hung off an extension's member (a regression of F2) | the reset lists every object outside the scope by identity before and after; anything missing refuses and rolls back |
| S-F2-b | security P2 (older) | An extension outside the scope holding an object inside it was dropped and never re-created | the same inventory |
| S-F1-a | security P2 (older) | A declared `found`/`sqlstate`/`sqlerrm` with a default passed the implicit-variable check; its default ran on the target, the replay elided the block | only the implicit variables pass |
| S-F5-a | security P3 | `LANGUAGE` after a body was read with a regex, so `'language sql'` in a literal made a `plpython3u` body code | read as tokens |
| S-F4-a | security P3 | The process-wide parse slot was held across a caller's target connections | removed: the parse is synchronous, the slot bounded nothing (replaced by a cap of two requests in flight, V-P3-7) |
| S-F1-b | security P3 | A temporary `pg_roles` made by the file is found before `pg_catalog`'s | in such a file only qualified guards count; one made by an earlier file is a residual (§2.4) |
| S-F1-c | security P3 | Long names in guards; `NOT EXISTS` on another subject made a removal unconditional | names cut to 63 bytes; see C-P3-1 |
| C-P2-1 | correctness P2 | The copy carried the history's policies on `storage.objects`; the restore failed | policies and their comments are left out like triggers |
| C-P2-2 | correctness P2 | A guarded `DROP ROLE x; CREATE ROLE x` (or `REVOKE`; `GRANT`) gave a contradictory pair and an unconditional removal | a later statement of a block supersedes an earlier one behind no extra guard |
| C-P3-1 | correctness P3 | Under `NOT EXISTS` facts about other subjects were unconditional | only the guard's own subject made present is; anything else never supersedes |
| C-P3-2 | correctness P3 | Safe shapes stayed mixed | notices, an `ELSE` of notices, `AND`, `LIMIT n` accepted; `pg_user` guards stay mixed |
| C-P3-3 | correctness P3 (older) | as S-F2-b | the inventory |
| C-P3-4 | correctness P3 | `copySchemas` named schemas of extension members, which a schema-only dump never holds | such members are named with their extension and their schema is not copied |
| C-P3-5 | correctness P3 | References made before the history creates the object, `CALL`, `COMMENT ON` and schema-level needs were missed | read; operator classes and qualified operators are not (§2.5) |
| C-P3-6 | correctness P3 | The hints' not-applicable files were checked | left out (`notApplicable`, CLI `--hints`) |
| C-P3-7 | correctness P3 | A missing legacy directory failed the CLI with `ENOENT` | a usage error naming it |
| C-P3-8 | correctness P3 | Docs: 32 MiB in `resources.md`; the reset after a replay | corrected |
| C-P3-9 | correctness P3 | The gate and the analysis bound were untested | the gate is gone; the bound is tested on both schemas |

**Verification review of the fixes** (2026-10-22). An independent reviewer
re-tested the fixes above (`0d684e9..a263a46`) against PostgreSQL 16, 17
and 18 and the parser, with its own inputs. It confirmed S-F2-a, S-F2-b,
F1-a (for defaults), F1-b (for `CREATE`), F1-c (for untyped constants),
F3-a (nesting), F5-a (the literal) and the reset's inventory (no way found
for it to run replay-owned code; 2.3 s with 3 000 tables outside the
scope), and found the following. Every one is fixed on this pull request,
each with a regression test on the reviewer's own input.

| # | Review | Finding | Fix |
|---|---|---|---|
| V-P1-1 | P1 | `serve` could still be pushed far past 512 MiB inside the byte bounds: the parser's memory grows with the tokens, not the bytes (4 MiB of `SELECT 1;` took 930 MiB, a 4 MiB `DO` block 1 144 MiB, 4 MiB of dump-like DDL 486 MiB), and WebAssembly memory never shrinks | one parse is given at most 200 000 tokens on every path (`MAX_PARSE_TOKENS`; the worst shapes below it peak at 165 to 233 MiB with the parsers); a legacy file or a body in it above it is refused before any work (`422`, `/files/<i>/text`, `too_large`); redaction falls back to the lexer ([deployment.md §2a](../../12-operations/deployment.md#2a-memory)) |
| V-P2-1 | P2 | A declared `sqlstate` constant of a domain type (`%TYPE`) passed the implicit-variable check; the domain's check ran at block entry | only the parser's own datums pass: `found`, then `sqlstate`/`sqlerrm` `text` constants per exception block |
| V-P2-2 | P2 (older) | An operator `public.=(oid, regrole)` answered a membership guard's `=` under the default `search_path` | the whole history is read first: an operator named `=`, or a `search_path` naming `pg_catalog` after another schema, makes only fully qualified guards count (§2.4) |
| V-P2-3 | P2 | `LANGUAGE` after a body was still taken from a non-ASCII dollar tag or a `SET` value (`SET search_path = language, sql`) | `SET` values are skipped, any tag is one token, and exactly one `LANGUAGE` clause must name the language |
| V-P2-4 | P2 | The reference scan dropped references deeper than its depth cap and reported itself complete | `too_complex` at the cap (1 000 levels), and for a body that cannot be given to its parser |
| V-P2-5 | P2 | `NOT EXISTS (a) AND NOT EXISTS (b) THEN CREATE ROLE a` gave an unconditional "a exists" | unconditional only when the subject is the one missing thing the branch waited for |
| V-P3-1 | P3 | Two IF statements with the same guard were read as one decision (`DROP` then `CREATE` hid the removal) | supersession needs the same IF statements, not the same guards |
| V-P3-2 | P3 | `RAISE NOTICE '%', sqlerrm` outside a handler fails at run time, and a handler around it swallowed the rest | parameters only in a handler |
| V-P3-3 | P3 | `SELECT … INTO TEMPORARY TABLE pg_roles`, `ALTER VIEW … RENAME TO pg_roles`, a dynamic `EXECUTE`, an earlier file | read from the whole history's text, string literals included; a name built at run time is a residual (§2.4) |
| V-P3-4 | P3 | A `::text` guard constant longer than 63 bytes was cut, which PostgreSQL never does | such a guard is no guard |
| V-P3-5 | P3 (older) | The reset re-created `earthdistance` before `cube` once `cube` was updated after it, and failed | extensions re-created after the ones they require (`pg_depend`) |
| V-P3-6 | P3 | 3 000 nested IFs overflowed the stack | blocks deeper than 64 are mixed; trees deeper than 1 000 levels are not followed |
| V-P3-7 | P3 | With the slot gone, slow targets let requests holding 16 MiB bodies add up | at most two requests that carry a history at once, `429 RATE_LIMITED` with `Retry-After: 5` |

## 9. Follow-up 3: a reviewed baseline can never pass its verification (2026-10-23)

**[OBSERVED]** The import itself worked end to end after follow-up 2 on
`reos-db-01` (PostgreSQL 17.11, release `d36ba29b`): report
`imr_01M5MM4KHX4TN0XE4PVY8ZR03B` with 454 review decisions, state `resolved`,
baseline plan `pln_01M5MQMNS15RMAJ8R5P9CXRCF0`, operation
`op_01M5MQMZS58HKVQ0M2ZQ4FSQAV`. The apply recorded 555 `legacy_import` rows
and the baseline; the verification failed (`structural {held: 13115,
checked: 13507}`, `engine {fingerprint: match}`) and said nothing more; drift
kept comparing with the registration snapshot (348 findings, 17 critical).
The owner's request: fix in ExponetDB (contracts, tests on PostgreSQL 16, 17
and 18, docs), no consumer-side workaround; staging schema changes stay
frozen until the baseline verifies.

| # | Observed | Decision | Evidence |
|---|---|---|---|
| F1 | Step 5 lets a person accept a file whose expectations partly hold; Step 7 required every surviving expectation of every accepted file to hold, so a real history could never verify | The analysis records each file's failing expectations (`ImportReport.items[].failing`, bundle `01M5PZFYDPT065MDFHG5G3WSG1_legacy-import-failing`, bound into the report digest); an accepting decision excuses exactly those while they fail the same way; anything else fails the run; the Web App says what an acceptance excuses before it is recorded, the CLI lists each item's failing count and answers `resolve` with what the recorded decision excuses ([legacy-import.md Steps 5 and 7](../../04-migrations/legacy-import.md#step-5-review)) | `legacy-baseline-verify.int.test.ts` (16, 17, 18), `verification-failures.test.ts` |
| F2 | A failed verification kept two counts | Every verification layer keeps its failing expectations (the first 200 and how many; names and aspect codes, never catalog values); `Operation.verifications` (REST), `operation show`, `migration show baseline:<slug>` and the Web App's operation page list them; for every verifying kind ([verification.md §5](../../04-migrations/verification.md#5-verification-runs-and-history)) | the same, the CLI suite, `http-migrations.int.test.ts` |
| F3 | `verification_failed` is final (a trigger of the frozen operations bundle) and a second baseline is refused, so a failed baseline had no way back | `migration.verify` takes `baseline:<slug>`: a planned, audited re-verification with the baseline plan's report and decisions; the baseline operation keeps its outcome, the target's history and the mirror carry the new run ([verification.md §5](../../04-migrations/verification.md#retrying-verification)) | `legacy-baseline-verify.int.test.ts`: fails on a failure the review never saw and on a schema change, passes once the cause is gone |
| F4 | The baseline kind never adopted the schema for drift, also after a passed verification | A passed baseline verification (own or planned) records the schema as the drift reference; the open findings then resolve `cleared` with the next drift check; `explainedByOperationId` stays `null` (nothing sets it yet) ([drift-detection.md §7](../../03-database-model/drift-detection.md#7-wave-4-implementation-kind-c)) | `legacy-baseline-verify.int.test.ts` (the reference is recorded once per passed run, never for a failed one) |

**Found on the way.** The baseline's verification also checked the files a
person decided `superseded` (their effects replaced later): it read the
plan's rows, which only knew the analysis state. Such a file is no longer
checked. This explains part of the difference the owner saw between the
report's evidence (226 failed of 5 610) and the verification (392 of 13 507);
the verification also checked every accepted file, also those no decision
needed, and a report's evidence list is capped at 16 entries. The next run
names each failure, so the rest is visible.

**The report on `reos-db-01` was analyzed before failures were recorded**
(`failing` is null on its items). For such a report a decision that accepts a
file excuses every failure of that file, bound by the fingerprint of the
managed scope **[DECIDED]**; a file accepted without a decision, and a file
decided superseded, are handled as above. Expectations outside the managed
scope of such a file (role attributes, memberships) are then excused
unverified; a report analyzed after this change records them and excuses
only those.

**Owner actions after this is deployed** (nothing here is done from this
session):

1. Re-verify the baseline: `exponetdb migration verify
   baseline:reosa-platform-2026-10 --target reosa/platform/staging`. It
   waits for the result; exit 0 only when it passed.
2. If it fails, `exponetdb operation show <op>` lists what failed (file,
   statement, expected object, what differs, excused or not); `--json`
   gives the first 200.
3. Once it passed, `exponetdb drift check --target reosa/platform/staging`
   compares with the reviewed schema; the 348 findings resolve `cleared`.
4. Then the first bundles can be planned on staging.

### 9.1 Independent review of follow-up 3 (2026-10-24)

**[OBSERVED]** An independent review of `d36ba29..40654f8` (with its own
adversarial tests on PostgreSQL 17) confirmed the excusal matching, the
digest binding, the immutability of `failing`, the fingerprint cases, the
owner's case, the target and generation bindings of the re-verification, that
no catalog value reaches a failure, the contracts (the MCP tool digests are
unchanged) and the authorization of a baseline ref. Its findings and what
this pull request does with them:

| # | Finding | Fix |
|---|---|---|
| P1-1 | A check that raised in the baseline's verification (`to_regclass` on a schema the observer may not use: `permission denied for schema`, as on `auth` or `storage` of a Supabase history) made the run `error`; the operation then needed attention, recorded no run and kept the target's schema domain, and neither `migration.baseline` nor `migration.verify` could be retried | Each file's checks run under their own savepoint, as in the analysis; a file that cannot be read is one failure with the aspect `unreadable`, recorded at the analysis too, so an acceptance excuses it explicitly. `migration.baseline` and `migration.verify` are retryable (`retry-verification`); a re-verification's errored run is pending again on a retry. Tests: `legacy-baseline-verify.int` (a schema the observer may not use; a re-verification that errors, retried, releases the target) on 16, 17 and 18; `failures.int` (a re-verification whose `verify.sql` cannot get its lock, retried) |
| P3-1 | A cluster-global failure of a value (`role_setting`, `role_connection_limit`, `role_comment`: aspect `value`) stays excused whatever the value becomes, as roles are outside the fingerprint | **[OPEN: OD-56]** Not fixed here: the checks return no observed value, and a stored digest of one needs a key the engine does not hold (a setting can hold a secret). Proposal: the checks return a keyed digest (HMAC with an installation key) of the observed value for open-domain kinds, recorded with the failure and compared ([open-decisions.md OD-56](../../00-product/open-decisions.md#od-56-an-excused-value-outside-the-fingerprint-that-changes-after-the-review)) |
| P3-2 | A decision recorded after the plan's last binding check and before the report is baselined changed what the verification excuses | The verification compares the report's digest with the one the plan bound; a change fails the run (`import_report`, aspect `changed`) |
| P3-3 | The rule for reports analyzed before failures were recorded (an acceptance excuses everything) was reachable for open reports too | A baseline plan of such a report is refused (`LEGACY_IMPORT_ANALYSIS_OUTDATED`, additive): analyze again. Only a baseline recorded before keeps the rule (the owner's report) |
| P3-4 | The baseline's mirror write and drift reference were not fenced by the lease | Both run only while the worker holds the operation |
| P3-5 | The import report's failing items lost the `untrusted` marker (an `omit` drops the meta) | Marked again |
| P3-6 | An old run with an unparsed chain read as `skipped` | Read as `error`, as runs write it now (`verification-failures.test.ts`) |
| P3-7 | The docs said the CLI shows what an acceptance excuses before it is recorded; statement numbers differ between the interfaces | The docs say what each interface shows. Statement numbers are 0-based in the contract and the CLI and 1-based in the Web App, as everywhere else in each |
| P3-8 | An acceptance that excuses nothing said nothing | The Web App's dialog and the CLI's `resolve` say that every expectation must hold. A file the hints call not applicable and a person decides present stays unchecked (as before this change); the re-verification reads the project's current trusted extensions and scope (a change there is a project change, planned and audited) |

**[OBSERVED]** **Re-review of these fixes (2026-10-24).** The same reviewer
confirmed P1-1 and P3-2 to P3-6. With its own test (RVB-4), it showed that
the owner's re-verification passes: a baseline was recorded with the code of
`d36ba29` (items without `failing`, the run `verification_failed` as on
`reos-db-01`), and the re-verification at this pull request's code passes
with the decided files excused, while a file without a decision still has
to hold. Its further findings:

| # | Finding | Fix |
|---|---|---|
| P2 | Worlds log in as the verifier in their `beforeAll` (the credential check), outside the per-test lock | A file holds the shared lock from before its own `beforeAll` until its first test ended, then each test does; the rotating file declares itself when it is imported (`rotatesVerifierPassword()`), so it never waits for its own lock; `targetIntegrationConfig` gives a hook 10 minutes |
| P3 | Every error of a read became `unreadable`, also a timeout, a lock wait or a cancel, which then failed the run for good instead of erroring it | Only a read that would fail the same way again is `unreadable` (a privilege, a name the server refuses, a row the engine cannot decode); a transient failure (SQLSTATE classes 08, 40, 53, 55, 57, 58, a timeout, the target unreachable) errors the run, which can be retried (`verification-failures.test.ts`) |
| P3 | An acceptance of an unreadable file excuses what nobody saw; an observer that can read the schema later compares it for the first time | The Web App's dialog and the CLI's `resolve` say so; `legacy-import.md` recommends giving the observer the reads and analyzing again |
| P3 | A non-human principal with `migrations.apply:prod` can retry a production `migration.verify` a person approved once (the retry runs its `verify.sql` again without a new approval); MCP has no retry tool | **[OPEN]** Not changed: the same as `migration.apply` retries since Wave 6. Proposal: refuse a retry by a non-human principal when the plan needed an approval because an agent proposed it |
| P3 | The run in the target's own history is written before the lease fence (a stale worker can add one row there) | **[OPEN]** Not changed: the same in the bundle paths since Wave 6; the mirror and the drift reference are fenced |

**[OBSERVED]** **CI: the PostgreSQL integration job.** It failed twice on this
branch (`failures.int` E2 read `needs_attention`/`error`, and the three E27
cases then found the worker busy) and passed on `main`. Cause:
`node-credential-rotation.int` rotates the verifier's password on the
shared PostgreSQL 17 test server for its whole file, and every verification
with a `verify.sql` in another package running at the same time met the
rotated password. A probe of 150 verifier logins during a rotation failed 44
times before and 0 times after the fix: the suites against the target servers
hold a shared advisory lock for each test, and the rotation holds it
exclusively (`packages/testkit/src/verifier-password.ts`).

**Open after this change:** the second verification review of follow-up 2
(reported to the owner on 2026-10-22, not part of this order) found three
P1 that are on `main` and are not fixed here: a single-quoted `DO` body
passes the parser's token bound, memory adds up across the files of a large
history, and the `search_path` check of the guard strictness is a
quadratic regular expression. They wait for the owner's go-ahead.

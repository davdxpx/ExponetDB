# Record: Wave 9 Part A (the migration engine for real, imported schemas)

| | |
|---|---|
| What this is | The progress and evidence record of **Part A** of the owner's Wave 9 order: "Part A correction and pull-forward". Part A corrects Wave 6 defects against DECIDED documents and contracts (A1 to A3) and brings forward the product capabilities of Wave 10 that every Supabase-origin adopter needs (A4 to A9). It is not a gate of its own: its items are evidence for G9 and for the later G10; the G9 record (`gates/9.md`) follows with Part B |
| Wave | [Wave 9](../implementation-waves.md#wave-9-backup-restore-performance) |
| Status | **IN PROGRESS.** Phase 0 (inventory, the order committed, the decisions recorded, this record) done (§1, §2); the items are listed in §3 and their evidence in §4. Only the owner accepts G9 |
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
outstanding. CI has never run for this repository (no GitHub Actions runner
starts); no PASS is derived from a workflow file. CI: not waived.** Nothing
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
| A10 | Part A done: two independent review rounds, the pull request, the owner test package | — | — | open | open |

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

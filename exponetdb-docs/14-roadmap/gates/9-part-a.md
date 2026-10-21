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
| A1 | The CLI starts a legacy import from the project file (`baseline:<slug>` and `<slug>`, `--hints`) | none needed (the request contract is unchanged) | `apps/cli/src/commands/migration.ts` (`baselineSlug`, `importHints`, flag `--hints`) | unit tests §4.2; the end-to-end run of the CLI process (analyze → report → resolve → baseline) lands with the real-shape fixture of A2 | open (end-to-end pending) |
| A2 | Supabase ledger matching on real data (names, statement sequences, evidence strength, multi-file aliases, real-shape fixture) | `ImportAnalysisRequest.aliases` takes a stem or a list of stems; `ImportReport.items[].evidenceStrength` (additive) | `migrations-engine/src/legacy-evidence.ts`, `legacy.ts` (`relateLedger`, `classify`, extension check); bundle `01M5G6EQ7GKZV615Y680AHT52B_legacy-import-evidence`; fixture `testkit/src/fixtures/supabase-history.ts`; the Web App shows the strength (§4.4) | §4.3 | PASS |
| A3 | The replay checks the execution role; no silent cap in the import path | error `LEGACY_IMPORT_TRUNCATED`; `ImportReport.driftTotal`, `driftTruncated` (additive) | `legacy.ts` (role check at planning and under the scratch lock, binding check, drift totals, evidence and attribute lists capped with a mark); rule `migration.import-execution-role`; Web App: strength and truncation warning | §4.4 | PASS (the A4 exception model joins the same check with A4) |
| A4 | Declared `BYPASSRLS` execution-role exception (ADR-0034, OD-51) **S** | open | open | open | open |
| A5 | Execution roles per environment (one resolver) | open | open | open | open |
| A6 | Legacy files with cluster-global effects (replay elision, cluster-global expectations, `CONCURRENTLY`, comment-only files) | open | open | open | open |
| A7 | Scratch targets: preflight, in-place reset, database retire | open | open | open | open |
| A8 | External-cluster onboarding without hand-made SQL | open | open | open | open |
| A9 | Documents brought up to the real state | — | — | open | open |
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

## 5. Limits and residual risks

Filled as the items land.

## 6. Reviews

Two independent review rounds over the whole Part A diff (correctness,
security, truthfulness of states, docs and code agreement) are recorded here
before the pull request is marked ready.

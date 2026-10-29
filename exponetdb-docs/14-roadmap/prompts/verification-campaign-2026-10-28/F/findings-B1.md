### [P2] The apply checksum depends on client-supplied project defaults: editing `defaults` after an apply makes applied bundles a non-overridable MIGRATION_CHECKSUM_MISMATCH
- **Area:** packages/migrations/src/format/projection.ts, migrations-engine/src/store.ts and planner.ts, CLI migration plan
- **Block:** B
- **Reproduction:** Exploratory (pure, B/conformance/exploratory/c1-pairs.ts, Bun 1.3.14 on the lead's machine, to be repeated on the pinned toolchain): same up.sql and migration.yaml (no lockTimeout), project default lockTimeout absent vs 10s, gives different checksums. The same holds for statementTimeout 30m and for searchPath. Stack: apply bundle B (manifest silent on timeouts, role, search path) on staging. Change defaults.lockTimeout in exponetdb.project.yaml. Run `exponetdb migration plan --target <staging>` (the CLI resubmits all local bundles, migration.ts:487-508).
- **Expected:** migration-bundles.md §3: a later change of the project default cannot change what an applied migration meant. An applied id keeps its identity.
- **Actual:** `defaults` come from the request (store.ts:150, planner.ts:597) and are hashed (projection.ts:129-155). The new checksum differs from the ledger's, so MIGRATION_CHECKSUM_MISMATCH (store.ts:197-207), not overridable, and the whole default CLI plan is refused. The server holds no authoritative copy of the defaults.
- **Evidence:** B/conformance/exploratory/c1-pairs.out rows "PROJECT default ..."; B/contract.md §3 DF-14, §6.
- **Root cause:** An input of the identity is neither part of the bundle nor stored per project.
- **Proposed fix:** Keep the project defaults in the registry, versioned and changed by a planned operation, and ignore or refuse the request's copy. Or materialize defaults into migration.yaml at `migration new` so the bundle is self-contained. No c2 needed.
- **Acceptance test:** B/conformance/I02-content-identity.test.ts (pure: a project-default change must not change the checksum of an unchanged bundle of the same project; fails today). Plus a stack test that a changed default is refused or ignored with a clear code.

### [P2] Default `migration plan` and `migration apply` submit every local bundle; the request accepts 50
- **Area:** apps/cli/src/commands/migration.ts, packages/contracts/src/rest/migrations.ts
- **Block:** B
- **Reproduction:** Exploratory (pure, B/conformance/exploratory/limits.ts): MigrationPlanRequestSchema accepts 50 bundles; 51 and 500 fail with `bundles: Too big: expected array to have <=50 items` (MIGRATION_REQUEST_LIMITS = { bundles: 50, migrationIds: 200 }, contracts/src/rest/migrations.ts:68, checked by the lead). CLI: a project with 51 bundle directories, `exponetdb migration plan --target <t>` without ids; submissions(ctx, []) returns all (migration.ts:487-493), checkedBody throws UsageError (cli/planning.ts:66-75).
- **Expected:** authoring-and-ci.md §4 and the CLI reference: ids "default: what is pending". The CLI reads up to 5,000 bundles (local/project.ts:25).
- **Actual:** The default flow stops at the 51st bundle of the stream, applied ones included. Naming ids is a workaround. The 50/200 limits are documented only in 06-rest-api/resources.md:103.
- **Evidence:** B/conformance/exploratory/limits.out; B/contract.md §3 DF-17. **Confirmed by S5 on a 500-bundle project:** `The request does not match the contract: bundles: Too big: expected array to have <=50 items` (exit 2); batches of 50 plan in 1.7 s in all three DAG shapes and 200 stored ids in 3.5 s; the limit appears in no 04-migrations or 15-cli document (`B/rehearsal/README.md` §5).
- **Root cause:** The CLI cannot know what is pending without the server, and submits everything.
- **Proposed fix:** Ask the server for the pending ids (`migration status` already knows them). Submit only those, plus stored ancestors by id. Document the limits in 04-migrations/.
- **Acceptance test:** apps/cli test: 60 local bundles, 55 applied, `migration plan` submits only the pending ones and succeeds. I15-limits.test.ts compares every limit with its document.

### [P2] Ledger divergence is noticed only when someone plans: no periodic check, no finding, no suspension
- **Area:** apps/server/src/composition/worker-tasks.ts, packages/migrations-engine/src/divergence.ts
- **Block:** B
- **Reproduction:** Static. Delete or insert a row in a production target's exponetdb.schema_migrations by hand. Wait 30 min. Read findings, target state, drift-check history.
- **Expected:** ledger.md §5: periodic reconciliation (default every 10 min per active target, and on every plan). The divergence table says target suspended for schema changes, finding raised.
- **Actual:** The comparison runs on migration.apply plans (planner.ts:145, 397), on `migration status` (reads.ts:191) and inside writeMirror. There is no worker task, no finding, and the target stays active. Drift kind B does not exist as a finding.
- **Evidence:** B/contract.md §2.5, §3 DF-11, DF-22. **Stack timings (S5, S3):** after a point-in-time restore to before the last bundle, `target show` read Health healthy with `Ledger: unknown`, `migration status` was the only place saying "Mirror: out of sync", and `migration plan` answered `LEDGER_DIVERGENCE` with no next step; the recovery `migration ledger reconcile` + `plan apply` took 3.9 s (nonprod: no approval, no step-up), consistent again after 72 s (planned PITR) or 4 min 24 s (crash, including re-pointing the endpoint). The error should name `migration ledger reconcile` (`B/rehearsal/results/pitr-restore.txt`, `crash-recovery.txt`). **Also (S6):** a hand-made ledger row on a stack target was planned over without `LEDGER_DIVERGENCE`: `migration status` said "Mirror: out of sync", `target show` said "Ledger: unknown" with 0 findings, `drift check` was clean, `migration plan` allowed, no log line; the row is permanent (append-only trigger) (`C/stack/observability-results.md` step 11).
- **Root cause:** Waived with E24/E25 ("no detection yet"), not revisited.
- **Proposed fix:** A worker task every 10 min per active target (observer read plus compareLedger). It opens a critical finding `ledger_divergence` naming the ids and resolves it when the ledger agrees. Optionally suspend schema operations.
- **Acceptance test:** Stack: hand-edit the ledger, wait one interval, expect a critical finding and an alertable audit or metric signal.

### [P2] `generation` never changes: documented restore protections are inert, and a future bump switches the divergence check off and re-adopts the restored ledger
- **Area:** packages/registry/src/register.ts:169, migrations-engine/src/divergence.ts:79, records.ts:170-210
- **Block:** B
- **Reproduction:** Static. The registry's only writer of registry.targets.generation is the insert with literal 1 (register.ts:166-170, checked by the lead; the other `SET generation` hits are the mirror table). Latent: set generation to 2 (what ledger.md §4.5 and backup-runbooks.md §3.1 step 7 describe), keep a generation-1 mirror that is ahead of the restored ledger, run a plan, then an apply.
- **Expected:** ledger.md §4.5/§5 and E25: a restore makes plans stale and a person reconciles the mirror. A divergence stays a divergence.
- **Actual:** Today nothing bumps it, so stale plans after a restore, evidence condition 4 and a marker-generation mismatch cannot trigger. If it is bumped, readMirrorFacts returns undefined for the new generation (divergence.ts:79) and ledgerDivergence returns null (no comparison). The next apply's writeMirror starts from an empty mirror and inserts every ledger row whose operation_id belongs to any operation of the target (records.ts:180-191; operationsOfTarget is not generation-scoped). The restored ledger is adopted with no human.
- **Evidence:** B/contract.md §2.5 "Latent hazard", §3 DF-10, DF-13.
- **Root cause:** "Never mirrored yet" and "new generation" are one code path.
- **Proposed fix:** A target with a mirror for an earlier generation and none for the current one is a divergence needing ledger.reconcile. Carry the mirror forward only through an explicit planned operation. Add the test before the bump is built.
- **Acceptance test:** A variant of packages/migrations-engine/test/reconcile.int.test.ts: bump the generation, expect LEDGER_DIVERGENCE on the next plan and no mirror row written by a following apply.

### [P2] Lint overrides, lint profile and invariants are taken from the plan request, not from an authoritative project record
- **Area:** migrations-engine/src/planner.ts:474-495, contracts/src/rest/migrations.ts:197-208, policy catalog
- **Block:** B
- **Reproduction:** Static. POST /targets/{production}/migrations/plans with lintProfile "standard" and lint.rules {unsafe_not_null: off, create_index_without_concurrently: off, ...} for a bundle `strict` would block. Compare blockingFindings and the decision with the same request without the overrides. (MCP cannot send them; REST, CLI and SDK can.)
- **Expected:** analysis.md §6: the project's reviewed exponetdb.project.yaml may lower a rule, shown in plans. Fixed rules are never lowered.
- **Actual:** The overrides come from whoever plans (the CLI sends its working-tree file; the server cannot tell it from the reviewed one). The plan shows `lowered` on the finding (lint.ts:305-330), but no policy rule treats a lowered production rule as a reason for approval or denial.
- **Evidence:** B/contract.md §3 DF-15.
- **Root cause:** Project configuration has no server-side home (same root as the defaults finding).
- **Proposed fix:** Keep lintProfile, lint and invariants in the registry project record. Ignore or refuse the request's copy for a production plan. Add a policy rule requiring approval when a blocking rule was lowered.
- **Acceptance test:** Stack: the request above on production is refused or yields `require`. A change of the registry record is audited.

### [P3] Edits that do not change the checksum are dropped by ingest, and three lints cannot fire on the server path
- **Area:** migrations-engine/src/store.ts:184-190, migrations/src/lint/lint.ts:817-834, planner.ts:656-678
- **Block:** B
- **Reproduction:** Static. Ingest bundle B. Edit only description, the directory slug/name, or a comment of up.sql. Plan again. Read the stored revision.
- **Expected:** BundleIngestResultSchema: verify_revision also for "comment bytes". Lints comment_only_change, renamed_applied_migration, rewritten_unapplied_migration (migration-bundles.md §7, analysis.md §6).
- **Actual:** `same` compares checksum and bundleDigest only and returns the stored old bytes as `unchanged`. comment_only_change and renamed_applied_migration (stored revision vs ledger) cannot fire. `ingested` is never passed to lintBundles (lint.ts:70), so rewritten_unapplied_migration is dead on every path.
- **Evidence:** B/contract.md §3 DF-06, DF-07.
- **Root cause:** bundleDigest does not cover the source digest or the metadata.
- **Proposed fix:** Compare the submitted source digest and metadata with the newest revision and store a metadata revision, or document the drop. Pass `ingested` from the store.
- **Acceptance test:** Unit test of ingestBundles: a comment-only edit returns a distinct status or the documented `unchanged`. A lint test with `ingested` fed.

### [P3] c1 summary sentences are looser than c1: spacing, adjacency, formatters and case change the checksum
- **Area:** exponetdb-docs/04-migrations/migration-bundles.md §3, CLAUDE.md, 04-migrations/README.md
- **Block:** B
- **Reproduction:** Exploratory (to be repeated on the pinned toolchain), c1-pairs.out: `(a int,b text)` to `(a int,/*c*/b text)` differs. `;INSERT` to `;\nINSERT` differs. `( a int )` to `(a int)` differs. `select` to `SELECT` differs. `a  b` to `a b` equal.
- **Expected:** "comment-only edits are not drift" (CLAUDE.md). "collapse every run of whitespace" (§3 summary).
- **Actual:** N5 is exact and pinned by golden vectors c1-sql-016 and c1-sql-032. But a comment or space inserted between two adjacent tokens, a formatter run, or a case change after apply is a non-overridable MIGRATION_CHECKSUM_MISMATCH.
- **Evidence:** B/conformance/exploratory/c1-pairs.out; B/contract.md §6.
- **Root cause:** Documentation and tooling, not code (c1 is frozen).
- **Proposed fix:** One paragraph in §3 and the README: "where a separator already exists". A `migration lint` rule `checksum_sensitive_edit` comparing source digest with the ledger and naming the class. Recommend formatters off for applied files.
- **Acceptance test:** A doc test that the three sentences quote N5. A CLI test of the lint rule.

### [P3] The CLI reads a whole oversized bundle file into memory before cutting it
- **Area:** apps/cli/src/local/project.ts:127-131
- **Block:** B
- **Reproduction:** `truncate -s 8G up.sql` in a bundle directory; `exponetdb migration lint`.
- **Expected:** The code comment: an oversized file is read only up to limit + 1 byte.
- **Actual:** readFile reads everything, then subarray cuts it.
- **Evidence:** B/contract.md §3 DF-18.
- **Root cause:** lstat size is used for the cut, not for the read.
- **Proposed fix:** Open the file and read at most limit + 1 bytes.
- **Acceptance test:** CLI test with a sparse 2 GiB file: refused with file_too_large, peak RSS under 100 MiB.

### [P3] Hotfix follow-up is unbuilt: no hotfix_without_evidence finding, no evidence mark
- **Area:** staging-production-policy.md §3, break-glass apply
- **Block:** B
- **Reproduction:** Static. `grep -rn hotfix_without_evidence packages apps` finds nothing. Apply a bundle to production under break-glass and read findings and the ledger row.
- **Expected:** The ledger row is marked and a finding stays open until staging has the same migration.
- **Actual:** Neither exists, so "staging contains everything production contains" can break silently. (This is the first campaign's TC-023 / E16, which the fix left to an owner decision, OD-65.)
- **Evidence:** B/contract.md §3 DF-26.
- **Root cause:** Unbuilt.
- **Proposed fix:** Mark the ledger row source evidence break_glass, open the finding, resolve it from the evidence read.
- **Acceptance test:** Stack: after a break-glass apply the finding exists; after the same migration is applied and verified on staging it resolves.

### [P3] The bundle store has no way to retire a bundle; `pending` lists every never-applied stored id forever
- **Area:** migrations-engine/src/store.ts, reads.ts:178-185, migrations.bundle_revisions
- **Block:** B
- **Reproduction:** Static. Ingest bundles of an abandoned branch through a staging plan (planned, never applied). Read `migration status` for any target of the project.
- **Expected:** dependency-graph.md §7 names the orphaned case and a remedy. The pending list should be about the stream.
- **Actual:** The table is immutable with no tombstone and no listing of unreferenced revisions. getTargetMigrations reports every stored id not in the ledger as pending (reads.ts:178-185). There is no CLI command to ingest, list or retire bundles.
- **Evidence:** B/contract.md §3 DF-05.
- **Root cause:** A missing state.
- **Proposed fix:** An append-only `withdrawn` marker read by status and planning, plus a store doctor (dangling, orphaned, unreferenced). See E/proposals.md.
- **Acceptance test:** Stack: ingest, withdraw; status no longer lists it as pending; planning it by id is refused with a clear code.

### [P3] A later migration that fails to execute ends the operation as verification_failed with error code VERIFICATION_FAILED
- **Area:** migrations-engine/src/kind.ts:618-619, operations/src/driver.ts:412-422
- **Block:** B
- **Reproduction:** Plan two chained migrations, the second with a failing statement (`DO $$ BEGIN PERFORM 1/0; END $$`). Apply. Read the operation.
- **Expected:** planning-and-apply.md §9: "second rolled back; third not attempted; operation `failed` with per-migration outcomes".
- **Actual:** #run returns partially_applied and drops firstError. Verification aggregates `partial` and the driver ends verification_failed / VERIFICATION_FAILED. failures.int.test.ts:786 pins the state for the revoked-grant case, and failure-and-recovery.md E27 already says verification_failed. The cause (statement index, SQLSTATE) is only in the per-migration progress row.
- **Evidence:** B/contract.md §3 DF-20.
- **Root cause:** Two outcomes share one terminal state.
- **Proposed fix:** Carry firstError as the operation's error code and detail when the stop was an execution failure. Fix planning-and-apply.md §9.
- **Acceptance test:** engine.int.test.ts case: the second migration fails; the operation's errorCode is MIGRATION_EXECUTION_FAILED with migration id, statement index and SQLSTATE.

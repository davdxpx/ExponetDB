# Migration engine failure cases, tested against real PostgreSQL (test campaign B)

| | |
|---|---|
| Date | 2026-10-27 |
| Code under test | `origin/main` d0229550, read-only worktree `ExponetDB-testcampaign` (nothing modified there) |
| Method | Throwaway integration tests in a scratch copy, using the repo's own packages and helpers (`packages/migrations-engine/test/world.ts` pattern, `registry/test/harness.ts`, `testkit`, `diagnostics`) |
| Infrastructure | Control Store PostgreSQL 17 (`exdb-control-tc`); managed targets on PostgreSQL 18 with TLS (the tests default to `TC_PG=18`; the engine logic under test lives in the Control Store, not in the target's version) |
| Layer | Engine level: serve and worker in one process, no HTTP, no CLI. The worker composition used for drift is the one of `apps/server/src/composition/access.ts:284` (`MigrationBaselineStore` as `expected`) |
| Evidence | `migration-engine/evidence/*.jsonl` (one JSON line per observation), `migration-engine/logs/`, test sources in `migration-engine/tests/` |
| Cleanup | Only `exdb_t_tc_mig_*` target databases (28), the Control Store databases of the runs and the role `tc_mig_owner` were created; all dropped afterwards |

Reproduce: copy `tests/tc-*.ts` into `packages/migrations-engine/test/` of a scratch copy of the repo, then
`bunx vitest run --config vitest.integration.config.ts test/tc-N.int.test.ts` with the dev-infra environment
(`TC_EVID=<dir>` collects the JSON lines). Each test file builds its own world (`tc_mig_cs<N>` Control Store,
targets named `tc_mig_*`) and does not depend on another file, except that `tc-3` e1 leaves a stuck operation by
design (run `-t e2` alone for the second scenario).

## 1. Verdicts per item

| Item | Verdict | Evidence (id in `evidence/`) |
|---|---|---|
| (a) verify.sql fails after a successful apply | **PASS** | `a1`..`a5` |
| (b) verify revision, comment-only vs executable, checksum binding | **PASS for `migration.verify`; FAIL for the documented recovery of a verify.sql that errors (MIG-01)** | `b0`..`b6` |
| (c) out-of-band DDL, drift, plan staleness | **PARTIAL**: detection and PLAN_STALE work; the next migration silently adopts the out-of-band change into the baseline (MIG-02) | `c0`..`c3` |
| (d) lock timeouts, advisory lock, concurrent applies | **PASS** (typed `MIGRATION_LOCK_TIMEOUT`, rolled back, ledger unchanged, `EXDB` advisory lock and domain released); under ACCESS EXCLUSIVE the failure is mislabelled (MIG-09) | `d1`..`d6` |
| (e) non-transactional bundle killed mid-way | **FAIL**: the documented `migration.resume` can never start after a killed backend (MIG-01) | `e1`..`e12` |
| (f) rollback plans | **PASS** | `f1`..`f5` |
| (g) E16, E18, E25 | **E16 and E18: review claim CONFIRMED (no detection). E25: claim PARTLY REFUTED (detected as `LEDGER_DIVERGENCE`) but there is no recovery (MIG-03)** | `g/e16`, `g/e18`, `g/e25` |
| (h) Part A P1s | skipped as instructed | |
| (i) ledger integrity | **PARTIAL**: checksum change, deleted row and the deferred-trigger chain (E-1) are caught; other tampered columns, the non-apply planners and a hand-written event are not (MIG-08) | `i.*`, `e1.*` |
| (j) unknown `dependsOn` | **CONFIRMED**: no id in the error (MIG-05), and one stored dangling bundle blocks every plan of the project (MIG-04) | `j1`..`j3` |
| (k) | skipped as instructed | |

## 2. Detail per item

### (a) A verify.sql that fails after a successful apply: PASS

Test `tc-1` "(a)". Bundle with `up.sql` (create table), `verify.sql` (`count(*) > 0`, fails on the empty table) and a
`down.sql` that would drop the table.

- Outcome: operation `verification_failed`, apply `applied`, verification `failed`; progress row `applied / failed / VERIFICATION_FAILED` (`a1.outcome`).
- No automatic retry, no rollback: a snapshot before and after the worker ran idle three times (4 s apart) is identical
  (`a2.no_retry_no_rollback` PASS): one ledger row (`reverted` null), one `applied` event, one failed verification run,
  the table still exists, no `reverted` event, the operation's step list unchanged (execute, verify, then locks released).
- A second plan for the same migration is refused: `MIGRATION_ALREADY_APPLIED`, by id and by the same bundle (`a3`).
- A raw `retry-verification` request on a `verification_failed` operation (inserted past the use case) is ignored by
  the worker; the use case refuses it with `OPERATION_NOT_RETRYABLE` (`verificationRetryable` is false for this
  state, `application.ts:2046-2056`) (`a5`).
- Observation, not a defect: a dependent bundle on top of the failed migration is planned `allow` and applies on a
  nonprod target (`dependenciesVerified: false`, rule `migration.dependencies-verified` is production-only,
  `policy/src/catalog/migrations.ts:296-297`). On a production target the same plan is denied with
  `migration.dependencies-verified = fail` (`a6.prod_dependent_plan` PASS).

### (b) Verify revision and checksum binding: PASS (with one gap, MIG-01)

Tests `tc-1` "(b)", `tc-6`, `tc-8`.

- Comment-only edit of `verify.sql`: stored as `verify_revision` (revision 2), same apply checksum, **new verify digest**
  (`b1`), as `verification.md` says. `migration.verify` uses the newest stored revision by default; it ran and
  failed again (new run with the new digest).
- Executable fix of `verify.sql`: revision 3; `migration.verify` with `revision: 3` passes. History in the target:
  `failed d0`, `failed d1`, `passed d2`; ledger checksum unchanged; the original operation stays `verification_failed`
  forever (terminal), the migration's latest run is `passed` (`b2`).
- `up.sql` executable change after apply: `MIGRATION_CHECKSUM_MISMATCH` with the known checksum and the target (`b3`).
  `up.sql` comment-only change: the submission is answered `unchanged` (same checksum and same bundle digest), so the
  comment is not stored at all.
- Any stored revision of the applied checksum may be chosen, including an older failing one; that appends a failed run
  and flips staging evidence back to `unverified` (`b4`, `b5.evidence_after_old_revision_reverify`). Revision 99: `NOT_FOUND`.
- Production evidence is bound to the verify digest: with staging passed on digest d2, a production plan by id (newest
  revision) has `evidence = present`; a plan that submits the original `verify.sql` (revision 1, digest d0) has
  `evidence = other_verify_digest`; while staging's latest run failed it is `unverified` (`b5`).
- `retry-verification` re-runs the operation's own digest (`verification.md` says so); for a verify.sql that **errors**
  (missing column) the operation is `needs_attention / applied / error`, the retry ends `needs_attention` again, and
  the documented fix (verify revision + `migration.verify`) never starts (MIG-01 repro A, `b6`).

### (c) Out-of-band DDL and drift: PARTIAL

Test `tc-2`. Baseline after the first migration is recorded by the worker (`reason = migration`), drift check is `clean`.

- Detected as drift (23 cases, each undone and clean again): added column, index, table, ACL (`critical`), RLS
  (`critical`), owner (`critical`), `fillfactor`/`autovacuum` reloptions, replica identity, column statistics target,
  extended statistics, publication, UNLOGGED, extension, event trigger (`critical`).
- Invisible, as designed: a table in an excluded schema, row data, `ALTER DATABASE ... SET`, `ALTER ROLE ... SET`.
  `COMMENT ON TABLE` is invisible too (`schema-fingerprints.md` section 5: comments are not structural; the drift check
  answers `clean` although the stored documentation digest differs).
- E23: a plan made before the out-of-band column is `PLAN_STALE` at acceptance (`c2.plan_before_oob_is_stale` PASS). A plan
  made **after** it is `allow` with no signal that a drift finding is open (`c2.plan_after_oob`), binds the drifted
  fingerprint, applies and verifies.
- **The drift then disappears without anyone accepting it**: after that migration the drift check is `clean`, the open
  finding is `resolved` (`cleared`), the baseline is the migration's (`c2.drift_after_next_migration`). With a security
  change (`GRANT ALL ON public.items TO PUBLIC`, drift `critical`) the same happens after an unrelated migration;
  `has_table_privilege('public', ..., 'SELECT')` is still true (`c3.after_unrelated_migration`). This is MIG-02.

### (d) Lock timeouts and concurrency: PASS, one mislabel

Test `tc-3` "(d)".

- Conflicting lock that catalog reads do not wait for (ROW EXCLUSIVE held by a superuser session), `lockTimeout 1s`:
  `failed / not_applied`, error `MIGRATION_LOCK_TIMEOUT`, SQLSTATE `55P03`, statement index 0, transaction rolled
  back (column absent), ledger rows 2 -> 2, no advisory lock of key `EXDB` left on the target, operation locks 0; the
  same bundle applies after the lock is gone (`d4` PASS, 1.3 s).
- The schema advisory lock `(1163412546, lockKey2('schema', target))` held by another session, `lockWaitSeconds: 2`:
  3 `waiting_for_lock` events, `MIGRATION_LOCK_TIMEOUT`, nothing applied; applies once released (`d5` PASS).
- Two accepted plans from the same state, two workers driven concurrently: one `succeeded`, the other `failed / not_started /
  PLAN_STALE`; exactly one ledger row, one table; advisory locks and operation locks released (`d6` PASS, 0.56 s).
  Sequentially: second plan `PLAN_STALE` at acceptance.
- ACCESS EXCLUSIVE held (the observer's catalog reads wait): planning ends `QUERY_TIMEOUT` after 2 s, acceptance
  `PLAN_STALE`, a started operation `failed / not_started / PLAN_STALE` with `changedBindings: ["target"]`
  (`d1`, `d2`, `d3`, `d3b`). Nothing runs, nothing is left held, but the cause is not named (MIG-09).

### (e) Non-transactional bundle killed mid-way: FAIL

Tests `tc-3` "(e)", `tc-7`. `CREATE TABLE` then `CREATE INDEX CONCURRENTLY` held waiting by an older snapshot, then
`pg_terminate_backend` on the migrator backend.

- Result: operation `needs_attention`, apply `unknown`, verification `pending`, error `OUTCOME_UNKNOWN`, progress
  `MIGRATION_INCOMPLETE`; events `nontx_started`, `nontx_statement_done`; an INVALID index (`indisready` true, `indisvalid`
  false); **the operation still holds the target's schema domain** (`e1.killed_state`). The `EXDB` advisory lock is gone.
- Every other plan is refused `MIGRATION_INCOMPLETE` (`e2`); the cleanup-migration alternative of
  `failure-and-recovery.md` section 2 is refused the same way (`e3`, MIG-11); re-planning the original is refused (`e4`).
- `migration.resume` without cleanup: `deny`, `readback: invalid_index`, finding `resume_cleanup_required` (PASS, `e5`);
  with cleanup: `allow`, cleanup names the exact index OID. **Accepted, it never starts**: state `queued`, every worker
  poll answers `waiting`, the domain is held by the `needs_attention` operation (`e5d`, `e6`, `e7`). The same when the
  kill hits statement 0 (`e8`..`e10`). `retry-verification` does not apply (apply outcome is `unknown`, `e11`), cancel
  only covers `awaiting_approval` and `queued`, `operation.force_release` is planned. This is MIG-01 repro B.
- Each worker poll of the stuck resume adds two events (`lease_acquired`, `locks_waiting`): 1 -> 21 events over 10 polls (`e12`, MIG-10).

### (f) Rollback plans: PASS

Test `tc-1` "(f)". `down.sql` is planned only on request and only for the latest migration.

- Non-latest: `MIGRATION_ROLLBACK_BLOCKED` reason `not_latest`; latest without `down.sql`: `no_down_sql`; a migration with an
  applied dependent: `dependents_applied` (`f1`..`f3`).
- A migration whose verification failed is not rolled back by itself (table still there after extra worker passes,
  `f4.failed_verification_is_not_rolled_back`); an explicit rollback plan is `allow`, applies, verifies against the earlier
  fingerprint, writes `reverted`; a second plan made from the same state is `PLAN_STALE` at acceptance; the id then
  cannot be planned again (`MIGRATION_REVERTED`) (`f4`).
- Out-of-band DDL after the migration: `SCHEMA_FINGERPRINT_MISMATCH` (`f5`).

### (g) E16, E18, E25

The grep `hotfix_without_evidence|applied_not_in_source` over `packages`, `apps`, `agent` finds **no source match**; they
appear only in `failure-and-recovery.md`, `staging-production-policy.md:155`, `drift-detection.md:37`,
`dependency-graph.md:151`, `gates/6.md:249,251` and `PRE-WAVE-11-REVIEW.md:636`. The drift check implements only kind C
(`diagnostics/src/drift.ts:329-343`, `driftKind: 'C'`).

- **E16, confirmed** (`tc-4`, `e16.*`). Setup: the post-break-glass state simulated by planning and accepting without the
  overridable migration rules (`setRules('registry-only')`), because the real hotfix needs a grant and a second person. Prod has
  a migration staging lacks. Findings of both targets: none. Drift of both: `clean`. `migrationStatus` lists the migration
  as applied on prod only, the stream cell is `verified` on prod and absent on staging, with no marker; a later production
  plan is denied for its own evidence, not because of the hotfix. Staging can plan the hotfix (the documented recovery).
- **E18, confirmed** (`tc-4`, `e18.*`). A request whose source omits an applied migration: plan `allow`, no lint entry or
  finding mentions it. With the bundle revisions deleted from the Control Store: status lists the row as applied, the
  verification plan answers `NOT_FOUND`, findings none, drift `clean`. The server never sees the repository, so any detection
  needs the full source set submitted by the CLI or CI; nothing compares it with the ledger.
- **E25, partly refuted** (`tc-5`, `e25.*`). A "restored" target (two ledger rows, their events and runs deleted, their tables
  dropped; simulated, not a real PITR) is detected: the next apply plan and a re-plan of the lost migration are refused
  `LEDGER_DIVERGENCE` `{missing: [m2, m3]}` (`divergence.ts:35-55`), `migrationStatus.mirror.inSync` is false, the drift check
  reports 4 removed objects. But `ledger_state.divergent` stays `false` until a worker write (no background detection), and
  there is no way forward: the doc says the mirror is reconciled and the lost migrations show as pending again; in fact every
  schema plan on the target stays refused (MIG-03).

### (i) Ledger integrity

Tests `tc-1` "(i)", `tc-6`. Tampering as the target's superuser with `session_replication_role = replica` (past the guard
triggers), then the four planners:

| Tamper | apply plan | verify plan | rollback plan |
|---|---|---|---|
| none | plan | plan | plan |
| `checksum` changed | `LEDGER_DIVERGENCE` | `NOT_FOUND` | `MIGRATION_ROLLBACK_BLOCKED no_down_sql` |
| `reverted_at` set by hand | `MIGRATION_DEPENDENCY_MISSING` (not divergence) | `MIGRATION_REVERTED` | `MIGRATION_REVERTED` |
| `fingerprint_after` changed | **plan created** | plan | `SCHEMA_FINGERPRINT_MISMATCH` |
| row deleted | `LEDGER_DIVERGENCE` | `NOT_FOUND` | `NOT_FOUND` |
| row restored | plan | plan | plan |

Only `planMigrationApply` compares the ledger with the mirror (`planner.ts:368`; the status read does it in `reads.ts:191`);
`compareLedger` compares existence, checksum and operation id only (`divergence.ts:35-55`). A hand-written
`migration_events` row (`nontx_started`, no ledger row) blocks every schema plan with `MIGRATION_INCOMPLETE`, and the
documented way out (`migration.resume`) answers `NOT_FOUND` for an id without a stored bundle (`i.hand_written_nontx_started_event`).
MIG-08.

E-1 (deferred trigger chain that writes `exponetdb.schema_migrations` at COMMIT, as the migrator, `tc-1` "E-1"): chain of 4
is refused by the guard (`gate: {guard: exponetdb_ledger, changed: schema_migrations}`), a chain at the bound
(`DEFERRED_TRIGGER_ROUNDS`) and one past it are refused with `gate.check = deferred_trigger_chain`; in all three the operation
is `failed / not_applied / MIGRATION_EXECUTION_FAILED`, zero forged rows, the probe table is not created. PASS.

### (j) Unknown `dependsOn`

`tc-1` "(j)": `planMigrationApply` with `dependsOn: [<unknown ULID>]` throws `MigrationError` code
`MIGRATION_DEPENDENCY_UNKNOWN`, `details` is `undefined`, message `dependsOn names an id that is not in the project stream.`
for one or for two unknown ids (`j1`, `j2`). Cause `planner.ts:162-163` (and the default branch at `:178-179`) drop
`failure.from` / `failure.missing`, which `stream.ts:225-232` puts into `migrationIds`.

## 3. Defects

Severity: P0 data loss, security or production outage; P1 wrong result or blocked core flow; P2 degraded or workaround;
P3 polish.

### MIG-01 (P1) A `needs_attention` operation holds the target's schema domain and the documented recovery cannot start

- **Reproduction A (verify.sql that errors, E10 second case)**: `tc-8`. Apply a bundle whose `verify.sql` selects a missing
  column (`SELECT count(no_such_column) >= 0 AS ok FROM public.bv`). Operation: `needs_attention / applied / error`
  (`VERIFICATION_ERROR`). Request `retry-verification` and let the worker run: `needs_attention` again (same digest).
  Ingest a fixed `verify.sql` (verify revision), `planMigrationVerify(..., {revision})`, accept, run the worker six times:
  every poll is `waiting`, the verify operation stays `queued` (`b6.migration_verify_while_needs_attention`).
- **Reproduction B (non-transactional bundle killed)**: `tc-3` e1/e2 and `tc-7`. Statement 1 is a `CREATE INDEX CONCURRENTLY`
  waiting for an older snapshot, `pg_terminate_backend` on the migrator backend. Operation `needs_attention / unknown /
  OUTCOME_UNKNOWN` (progress `MIGRATION_INCOMPLETE`), INVALID index left. `planMigrationResume(..., {cleanup: true})` is
  `allow`, accept succeeds, the resume stays `queued` for ever; all other plans are refused `MIGRATION_INCOMPLETE`.
- **Expected**: `failure-and-recovery.md` E10 ("a verify revision, then `migration.verify`") and section 2 (the target "stays
  blocked until a resume"; resume "continues at the failed statement"): the recovery plan runs.
- **Actual**: the recovery operation waits for the domain `target:<id>:schema` that the `needs_attention` operation holds. No
  API releases it: `needs_attention` leaves only to `verifying` (`operations/src/states.ts:42`), a retry is claimable only for
  apply outcome `applied`/`partially_applied` and re-runs the operation's own digest (`operations/src/leases.ts:57-58`;
  `application/src/views.ts:239-250`; `application/src/application.ts:2046-2056`), cancel covers `awaiting_approval` and
  `queued` only (`application.ts:1983-1985`), and `operation.force_release` is unbuilt (`02-control-plane/operations-engine.md:356,709`).
  The same domain key is used by apply, resume, verify and rollback (`kind.ts:117`, `reverify.ts:362`, `rollback.ts:362`). The target is
  blocked for every schema change, production hotfixes included, until someone edits the Control Store by hand. The existing
  suites miss it because their partial failure (lock timeout) ends in the final state `verification_failed`, which holds no domain
  (`engine.int.test.ts` "leaves a failure after an earlier effect partially applied...").
- **Proposed fix**: give the recovery operation a way in. Either (1) let a `migration.resume` or `migration.verify` plan that
  names the `needs_attention` operation of the same target adopt its domain, closing that operation in a terminal state with an
  audit event and the same human re-authentication as the recovery; or (2) build `operation.force_release` now with a
  `needs_attention -> failed|verification_failed` transition; and (3) let `retry-verification` take an optional `revision`
  and cover apply outcome `unknown` with a non-transactional start by re-running reconciliation.
- **Acceptance test**: flip `tc-8` and `tc-3` e1 to assert that the verify or resume operation reaches `succeeded` (index valid,
  `applied` event written, ledger row present), the original operation is terminal, `operations.operation_locks` holds nothing
  for the target and the next ordinary plan is admitted. Add a unit test on the state machine that `needs_attention` with
  apply `unknown` has an exit.

### MIG-02 (P1) The next verified migration adopts an out-of-band schema change into the drift baseline

- **Reproduction**: `tc-2` ("E23" and "security-relevant" tests). Apply a migration (baseline recorded). As a superuser
  `GRANT ALL ON public.items TO PUBLIC` (or add a column). `runDriftCheck`: `drifted`, finding open (ACL: `critical`). Plan and apply
  any unrelated bundle with the real kinds (`expected = MigrationBaselineStore`). `runDriftCheck` again.
- **Expected**: `drift-detection.md` sections 5 and 7 and the opening rule "ExponetDB's own migrations are never drift and a change
  outside them is": the finding stays open until `drift.accept` (which needs a reason for security-relevant drift and an approval on
  prod), and the baseline is the old one plus the migration's change.
- **Actual**: `status: clean`, the finding is `resolved/cleared` by the check, baseline `reason = migration`, `PUBLIC` still has
  `SELECT` (`c2.drift_after_next_migration`, `c3.after_unrelated_migration`). The plan gave no signal either
  (`c2.plan_after_oob`: `allow`, binds the drifted fingerprint).
- **Suspected root cause**: `executor.ts:381,398` records `fingerprintAfter = snapshot.fingerprint` (the live schema after the migration,
  out-of-band change included); `kind.ts:785-795` calls `#recordExpected`, and `diagnostics/src/migration-baselines.ts:28-45` adopts a
  snapshot whose fingerprint equals that value, without comparing the pre-migration fingerprint (`planner.ts:830`
  `expectedState.schemaFingerprint`) with the previous baseline.
- **Proposed fix**: in `MigrationBaselineStore.record`, also take the plan's pre-migration fingerprint and adopt the new snapshot only
  when it equalled the current baseline's fingerprint; otherwise return a new outcome `drift_open`, keep the baseline and the findings.
  Optionally add a plan fact `openDriftFindings` and a policy rule that asks for `drift.accept` (or an approval on prod) first.
- **Acceptance test**: `tc-2` c2 and c3 assert `drifted` and the finding still open after the unrelated migration; and the inverse
  (no out-of-band change) still ends `clean`.

### MIG-03 (P1, known waiver) E25: a restored ledger blocks the target for ever

- **Reproduction**: `tc-5` e25. After three migrations, delete the last two from the target's ledger, events and runs and drop their
  tables (a restore to an older point). Plan anything.
- **Expected**: `failure-and-recovery.md` E25: "ledger reflects the restored state; mirror reconciled; plans stale; re-plan; migrations
  after the restore point show as pending again".
- **Actual**: detection works (`LEDGER_DIVERGENCE {missing: [...]}` on apply plans, `mirror.inSync = false`, drift reports removed objects),
  but `ledger_state.divergent` stays false until a worker write, and nothing re-baselines the mirror: all schema plans stay refused;
  `ledger.reconcile` is planned (`gates/6.md:370`). Waiver "before Wave 9 closes" (`PRE-WAVE-11-REVIEW.md:636`) is not closed.
- **Suspected root cause**: `divergence.ts:110-125` compares with the mirror of the target's generation, and no operation rewrites the mirror.
- **Proposed fix**: build `ledger.reconcile` (explicit operator plan, human re-authentication, audit) that rewrites the mirror rows of the
  target from the live ledger when the identity marker and the cluster identity match, and re-runs the verification of the baseline.
- **Acceptance test**: `tc-5` e25 ends with the lost migration planned and applied again after `ledger.reconcile`.

### MIG-04 (P2) A stored bundle with an unknown dependency blocks planning for the whole project

- **Reproduction**: `tc-5` "(j)". Ingest (the `migration.bundle.ingest` path, `application/src/migrations.ts:99-108`) a bundle with
  `dependsOn: [<unknown ULID>]`: status `stored`. Plan an unrelated bundle on any target of the project.
- **Expected**: the unrelated plan works; a dangling edge is refused at ingest or confined to the bundle that has it.
- **Actual**: every plan of the project, on every target, is `MIGRATION_DEPENDENCY_UNKNOWN` with no id (`j3.unrelated_plan_after_poison`,
  `j3.other_target_same_project`). Workaround found: ingest a corrected revision of the same id (`rewritten_unapplied`), after which plans work.
- **Suspected root cause**: `store.ts:149-` `ingestBundles` has no graph check; `planner.ts:295-298` puts every stored bundle's edges into the graph;
  `planner.ts:311-312` fails on the first dangling edge.
- **Proposed fix**: restrict the graph to the selected ids, their ancestors and the ledger (`planner.ts:295`), and report dangling stored edges as
  a finding on the stream; and validate `dependsOn` against the stream plus the submission at ingest.
- **Acceptance test**: ingest a dangling bundle, then an unrelated plan succeeds; planning the dangling bundle itself names its missing ids.

### MIG-05 (P3) `MIGRATION_DEPENDENCY_UNKNOWN` carries no id

- **Reproduction**: `tc-1` "(j)". **Expected**: the missing ids and the node, as `stream.ts:225-232` returns them. **Actual**: `details` undefined
  (`j1`, `j2`). **Root cause**: `planner.ts:162-163` and `:178-179`. **Fix**: `new MigrationError('MIGRATION_DEPENDENCY_UNKNOWN', { migrationId: failure.from,
  missing: failure.missing.slice(0, 256) })` (catalog entry with schema-checked details). **Acceptance**: a unit test on `graphRefusal` and `tc-1` (j) asserting the ghost id in `details`.

### MIG-06 (P2, known waiver) E16 `hotfix_without_evidence` has no detection

- **Reproduction**: `tc-4` e16. **Expected**: an open finding on the production target until the same migration is applied to staging
  (`staging-production-policy.md:155`). **Actual**: no finding, drift clean, nothing marks the migration (`e16.detection_search`).
  **Root cause**: not implemented; no source match for the code. **Fix**: at ledger mirror write (`kind.ts` reconcile path and `records.ts` `writeMirror`) compare each
  production row with the evidence target's mirror and record a finding `hotfix_without_evidence` (kind `drift`, severity `warning`), resolved when the evidence target has the
  same checksum with a passed verification. **Acceptance**: `tc-4` e16 asserts one open finding on prod, cleared after the apply on staging.

### MIG-07 (P3, known waiver) E18 `applied_not_in_source` has no detection

- **Reproduction**: `tc-4` e18. **Expected**: finding `applied_not_in_source`. **Actual**: none, also with the bundle revisions gone from the Control Store.
  **Root cause**: the server never receives the source set except as a plan's `bundles`; no comparison exists. **Fix**: a lint or stream finding when the submitted source
  set (CLI `migration lint`, `bundles` of a plan) omits an id present in the target's ledger and not reverted. **Acceptance**: `tc-4` e18 asserts the finding on a plan whose source omits `x`.

### MIG-08 (P2) The ledger comparison is shallow and only the apply planner runs it

- **Reproduction**: `tc-1` "(i)" (table in section 2), `tc-6` "(i)". **Expected**: any hand change of a ledger row or event is `LEDGER_DIVERGENCE` for every planner
  (`ledger.md` section 5). **Actual**: `reverted_at` and `fingerprint_after` edits are not divergence; verify, rollback and resume planners ignore the comparison and answer with
  unrelated codes (`NOT_FOUND`, `no_down_sql`, `MIGRATION_DEPENDENCY_MISSING`); a hand-written `nontx_started` event blocks the target with no recovery.
  **Root cause**: `divergence.ts:35-55` (checksum and operation id only), `planner.ts:368` (the only caller besides `reads.ts:191`), `planner.ts:184-189`.
  **Fix**: compare `reverted_at`/`reverted_by_op`, `fingerprint_after`, `transactional` and the event count per migration; call `assertLedgerAgrees` in `planMigrationVerify`,
  `planMigrationRollback`, `planMigrationResume`. **Acceptance**: `tc-1` (i) expects `LEDGER_DIVERGENCE` in all rows with a tamper.

### MIG-09 (P3) Lock contention on catalog reads is reported as `PLAN_STALE` or `QUERY_TIMEOUT`

- **Reproduction**: `tc-3` d1..d3, `tc-7` d3b. **Expected**: a typed lock failure with the holders (`MIGRATION_LOCK_TIMEOUT` / busy). **Actual**: planning `QUERY_TIMEOUT` after 2 s, acceptance and
  dispatch `PLAN_STALE` with `changedBindings: ["target"]`, although the plan is not stale. **Root cause**: `kind.ts:203` maps any error of the observer read to a changed binding. **Fix**: map
  `TargetError` lock/timeout reasons to a `TARGET_BUSY` style code and keep `PLAN_STALE` for real differences. **Acceptance**: `tc-3` d2/d3 assert the busy code.

### MIG-10 (P3) A waiting operation writes two events per worker poll

- **Reproduction**: `tc-7` e12 (21 events after 10 polls from 1). **Root cause**: `operations/src/locks.ts:88-95` inserts `locks_waiting` on every conflict and the claim inserts `lease_acquired`.
  **Fix**: write `locks_waiting` once per blocking operation and release the lease silently; or back off. **Acceptance**: events stay constant over 10 polls.

### MIG-11 (P3, documentation) The "cleanup migration" alternative of section 2 is unreachable

- **Reproduction**: `tc-3` e3. **Actual**: a cleanup bundle is refused `MIGRATION_INCOMPLETE` like every other plan; `failure-and-recovery.md` section 2 offers it next to resume.
  **Fix**: delete the alternative or allow a bundle that only drops the named INVALID index while the start is open.

## 4. What was not done

- No real PITR restore and no real break-glass activation; E25 and E16 are constructed as described above.
- No HTTP, CLI or Web App layer; no run on PostgreSQL 16 or 17 targets (engine behavior in MIG-01 to MIG-04 is Control Store logic).
- The repo's own suites (`engine`, `failures`, `ledger-guard`) were not run, to keep every created object under the `tc_mig_` prefix; the tests here follow their patterns.
- (h) and (k) skipped as instructed.

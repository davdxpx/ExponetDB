### [P2] A refused recovery has already closed the needs_attention operation and released its lock domain
- **Area:** packages/operations (supersede.ts, driver.ts), bundle operation-supersession (fix of TC-005)
- **Block:** D
- **Reproduction:** `D/d0/tests/supersede-order.int.test.ts`, run from `packages/operations` in a scratch copy of the tree under test with vitest and `--config vitest.integration.config.ts` (exploratory run on Node 26.5 / Bun 1.3.14 / PostgreSQL 17.11; to be repeated on the pinned toolchain). Case a: the recovery plan is refused with PLAN_STALE at dispatch. Case b: admit returns GRANT_REVOKED. Case c: the recovery then waits on another domain.
- **Expected:** a recovery that is refused or that has to wait leaves the operation it names in needs_attention with its lock, exactly as before.
- **Actual:** the named operation ends `verification_failed` with its lock released and committed, while the recovery did nothing. All three cases pass, so the defect is present (spot check by the lead: `driver.ts:178-186` calls `closeSuperseded` first, then `acquireLocks`, `checkBindings` and `admit`; the refusal paths `return` inside the transaction, so it commits).
- **Evidence:** D/new-bundles-security-review.md §3 (finding 1); D/d0/tests/supersede-order.int.test.ts; D/d0/logs/supersede-order.log.
- **Root cause:** `packages/operations/src/driver.ts:178-186`: `closeSuperseded` (:179) runs before `acquireLocks` (:180), `checkBindings` (:184) and `admit` (:186).
- **Proposed fix:** perform the close after the locks, bindings and admission succeed, or wrap it in a savepoint and roll back to it on refusal or wait.
- **Acceptance test:** the same three cases with inverted assertions (the operation stays needs_attention and keeps its lock when the recovery is refused or waits).

### [P2] migrations.ledger_mirror is rewritable in place by the worker; "insert-and-revert-only" is code convention only
- **Area:** bundle migration-engine (frozen) and ledger-reconcile; `migrations.ledger_mirror`
- **Block:** D
- **Reproduction:** `D/d0/` exercise_archive.sql A10, as the worker role against a PostgreSQL 17.11 scratch database: `DELETE` gives 42501, but `UPDATE migrations.ledger_mirror SET checksum = 'FORGED'` and `UPDATE ... SET generation = 99` both succeed and leave no history row.
- **Expected:** ledger.md §5 and `ledger-reconcile/migration.yaml:10`: the mirror is insert-and-revert-only for the worker; a reconciliation deletes no row anywhere, and every change of a mirror row is kept.
- **Actual:** the worker holds table-wide UPDATE (`migration-engine/up.sql:142`: `GRANT INSERT, UPDATE ON migrations.ledger_mirror, ...`, checked by the lead) and no trigger limits the columns. A compromised or buggy worker can rewrite what the divergence check compares against, which is the control that catches a restored or hand-edited ledger.
- **Evidence:** D/new-bundles-security-review.md §3 (finding 2); D/d0/ exercise_archive.sql and proposed_mirror_guard.sql.
- **Root cause:** a frozen bundle grants more than the documented contract; the new bundle added the history table but not the matching guard.
- **Proposed fix:** a new additive bundle with a BEFORE UPDATE trigger that allows only `reverted_at`, `reverted_by_op` and `mirrored_at` to change (D0 tested `proposed_mirror_guard.sql`: forged updates refused, the engine upsert still works, the archive still deletes).
- **Acceptance test:** worker UPDATE of checksum, generation or migration_id is refused; the three allowed columns pass; the engine's upsert and `archive_mirror_rows` still work.

### [P3] archive_mirror_rows binds neither generation, ids nor lease to the operation, and takes no row lock
- **Area:** bundle ledger-reconcile (`migrations.archive_mirror_rows`, SECURITY DEFINER)
- **Block:** D
- **Reproduction:** `D/d0/` exercise_archive.sql A7/A8 move another generation and ids the plan never named, with a wrong reason label (every moved row is kept in history). exercise_race.sh e1: the check passes, the DELETE waits on a row lock, the operation leaves `running`, and the DELETE still moves 2 rows. With the engine's FOR SHARE fence (e2) the transition waits, so the engine path is safe and the function alone is not.
- **Expected:** the function moves only rows the named, still-running ledger.reconcile operation of that target is entitled to move.
- **Actual:** it checks the operation kind and target at call time only; a NULL reason gives 23502.
- **Evidence:** D/new-bundles-security-review.md §3 (finding 3); D/d0/ exercise_archive.sql, exercise_race.sh.
- **Root cause:** `packages/control-store/migrations/01M61C90YHV706H2B8EW39TBAF_ledger-reconcile/up.sql:35-52`.
- **Proposed fix:** FOR SHARE on the operation row, a lease test, bind generation (and ids) to the plan, use `IS DISTINCT FROM` in the reason test.
- **Acceptance test:** a raw call for an operation that left `running` is refused; a call for ids or a generation outside the plan is refused.

### [P3] The three verify.sql files of the new bundles pass on broken bundles and none checks ownership
- **Area:** bundles operation-supersession, ledger-reconcile, offline-drill-record
- **Block:** D
- **Reproduction:** `D/d0/` mutate_verify.sh applies 23 mutations to the installed objects and re-runs each `verify.sql`: 11 of 23 still pass (guard replaced by a no-op that mentions the function name in a comment; guard with `OR true`; guard without the serve restriction; history trigger INSERT-only or disabled; archive_mirror_rows without search_path, as SECURITY INVOKER, with the check removed, or with another owner; record_offline_drill with a wrong body or another owner).
- **Expected:** control-database.md §5a: every verify.sql checks ownership and what the function does.
- **Actual:** operation-supersession/verify.sql:16 is a LIKE on the function text; ledger-reconcile/verify.sql:3-4 only counts triggers and :10-13 checks no prosecdef/proconfig/owner; offline-drill-record/verify.sql:10-12 has no owner or body check.
- **Evidence:** D/new-bundles-security-review.md §3 (finding 4); D/d0/mutate_verify.sh.
- **Root cause:** weak verification assertions (the exact class the brief calls "verify.sql that passes on a broken change").
- **Proposed fix:** assert proowner, prosecdef, proconfig, trigger tgtype/tgenabled and a body digest in each verify.sql (in a new bundle revision; the files are not frozen yet).
- **Acceptance test:** the mutation script ends with every mutation failing the checks.

### [P3] POST /clusters/{id}/drills/offline with restoredAt ahead of the database clock is a 500
- **Area:** packages/application/src/backups.ts:587-630, bundle offline-drill-record, error mapping (fix of TC-013)
- **Block:** D
- **Reproduction:** `D/d0/` exercise_drill.sql C5: `drill_guard` raises EXB06. EXB06 and EXM01 are mapped nowhere (grep). The HTTP route itself was NOT RUN.
- **Expected:** a client error (400 VALIDATION_FAILED on /restoredAt), not an internal error.
- **Actual:** the application passes the value through and the database exception surfaces as a 5xx (the very class TC-013 fixed for the happy path).
- **Evidence:** D/new-bundles-security-review.md §3 (finding 5).
- **Root cause:** `packages/application/src/backups.ts:587-630` does not compare restoredAt with the clock; SQLSTATE EXB06/EXM01 have no mapping.
- **Proposed fix:** validate restoredAt against the clock and map EXB06/EXM01 to typed errors.
- **Acceptance test:** `http-backups.int.test.ts`: restoredAt one day ahead gives 400.

### [P3] Control Store bundles are not pinned: the three new ones and 24 older ones (27 in all) are outside the freeze list
- **Area:** packages/control-store/frozen-bundles.json, packages/control-store/test/immutable-bundles.test.ts
- **Block:** D
- **Reproduction:** `jq` over `frozen-bundles.json` and listing `packages/control-store/migrations/`: the freeze list stops at Wave 6 (21 entries); PR #46 changed neither the list nor the test.
- **Expected:** every bundle that can have been applied on an installation is pinned by checksum (an applied bundle changed in place is a `MIGRATION_CHECKSUM_MISMATCH` on every installation that applied it); the docs call the backup-catalog bundle "frozen".
- **Actual:** the backup-catalog bundle and everything after Wave 6, including the three new bundles, can be edited without a test failing.
- **Evidence:** D/new-bundles-security-review.md §3 (finding 6); R/baseline.md.
- **Root cause:** the freeze list is maintained per wave by hand and was not extended for Wave 7 to 9 or for the fix.
- **Proposed fix:** pin all deployed bundles; pin the three new ones as soon as they are deployed (see decision D0-05); lint the Control Store bundles in CI.
- **Acceptance test:** the pin test lists the ids and fails on a one-byte edit of any of them.

### [P3] migration.resume takes the operation it closes from the target's own ledger events (static reading only)
- **Area:** packages/migrations-engine (resume.ts:123, kind.ts:131-139, recovery.ts:14-35)
- **Block:** D
- **Reproduction:** NOT RUN (static). A hostile event in the target's ledger naming another operation of the same target.
- **Expected:** the operation to close is derived from the Control Store (as `stuckOperationOf` does for migration.verify), never from data in the managed database.
- **Actual:** resume derives it from the target's ledger events. The blast radius is at most the single needs_attention operation holding that target's schema domain, and a production resume needs approval plus re-auth.
- **Evidence:** D/new-bundles-security-review.md §3 (finding 7).
- **Root cause:** two different derivations of "the stuck operation".
- **Proposed fix:** look it up with `stuckOperationOf`.
- **Acceptance test:** a hostile event naming another same-target operation closes nothing.

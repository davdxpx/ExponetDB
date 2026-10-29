# Open decisions raised by the security read of the new bundles (agent D0)

Not findings; the owner decides. Source: `D/new-bundles-security-review.md`.

- **D0-01 (follow-up of OD-58):** production approval for closing a stuck operation. `migration.verify` is class `low`; a person on production gets `allow` with no approval and no re-auth (policy test `D/d0/tests/verify-supersede-policy.test.ts` passed), while `migration.resume` needs approval plus re-auth and `operation.force_release` is `high` with re-auth. Should a verify plan that names a stuck operation on production require approval and re-auth (a policy rule keyed on `content.supersedes`), or should closing there be limited to resume or `force_release`?
- **D0-02:** `serve` gained a write path to `backups.drills` (`record_offline_drill`). The function does not check that the repository belongs to the cluster, nor that `recorded_by` is the caller; the application does. Offline attestations do not count in protection or RTO (`packages/backups/src/protection.ts:251`). Accept this, write drills through the worker, or add the checks in the function?
- **D0-03:** add the mirror guard of finding "ledger_mirror is rewritable in place" now, or change only the wording of the promise?
- **D0-04 (static only, not reproduced):** `store.ts:132-139` `appliedElsewhere` reads the live mirror only, so a migration id applied only on a reconciled target counts as never applied afterwards and may be re-ingested with a new checksum. Should `ledger_mirror_history` count there?
- **D0-05:** when to freeze and pin the 24 unpinned Control Store bundles (45 directories, 21 pinned), and whether Control Store bundles should be linted in CI (no CI step runs `migration lint` on them).

NOT RUN by D0: `apps/server` `http-backups.int.test.ts`, the ledger/reconcile-plans route, and migrations-engine `reconcile.int.test.ts` / `recovery.int.test.ts` (they need the dev:targets servers and a node agent; D0 covered the database contracts by SQL instead); the hostile-ledger resume case; the pinned toolchain; a cross-project supersession case (the repository's cross-target test passes, the per-target domain-key argument is static).

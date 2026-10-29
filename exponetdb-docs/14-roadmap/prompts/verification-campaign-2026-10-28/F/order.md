
## 5. Suggested order of work

Several pull requests, one per group, in this order; commit per finding (or per tight group) so
the owner can review and revert pieces. Stop and ask (open decision) where a finding says "owner
decision". The order follows Wave 11's question ("can REOSA's production database be managed
without surprises?"): first what can take the whole installation down or make a recovery lie,
then the runbooks, then the planner's honesty.

1. **Group A: installation wedges and the two P0-borderline items.** The Control Store disk
   (audit and quota for bundle ingest, a purge path, a disk component in installation health, the
   `ENOSPC` runbook), the allowlisted read that crashes the target PostgreSQL (size-argument
   rules, a memory fact in the registry) together with the data read that never returns when its
   backend dies (hard deadline, never await `close()` on a dead client), the audit chain that
   refuses every event after a clock step (readiness, typed error, skew guard, repair
   operation).
2. **Group B: the engine's dead ends.** `operation close` / `operation.force_release`
   (human only, audited, never re-executes), the close that runs before its own checks, the
   reconcile of an unknown outcome, the claim loop that lets one blocked operation starve all
   others, the approval that is accepted after the plan expired, the old role that keeps
   claiming after `migrate`.
3. **Group C: backup and restore truth.** The drill that passes with data missing (replay end,
   a mandatory data check), `backup.verify` and WAL gaps, the restic globals, the space check at
   execute, helper refusals that surface as `OUTCOME_UNKNOWN`, the missing `pitr_random`
   observation.
4. **Group D: upgrade and recovery runbooks.** Rewrite `upgrades.md` (roll forward or restore,
   a mandatory verified dump, the eleven omitted steps, `schema_newer` with a remedy, a drain
   window for the worker), RB-10 step 6 as a per-target loop, RB-14 (custody of the keyring or an
   audited reset), the second RB-10 recovery, the checkpoint cadence.
5. **Group E: hostile input and containment.** Named limits and caps for nesting depth, statements
   and tokens per request, per-request memory, the second quadratic regular expression, the 32 MiB
   body read before authorization, connection and in-flight caps, forbidding server-file and
   untrusted-language functions in lint.
6. **Group F: the planner's honesty.** `serial`/identity in the parser (the CREATE TABLE that cannot
   be applied and the ADD COLUMN rewrite classified as brief), catalog facts for the lock and
   rewrite classes (`provolatile`, column types, validated CHECKs, `USING INDEX`, dependent
   views, lock held to COMMIT), `DETACH PARTITION CONCURRENTLY`, the per-finding lint
   acknowledgement (owner decision), the project settings that have no server-side home.
7. **Group G: evidence, ledger and drift integrity.** Evidence by operation id alone, the mirror
   guard, `generation`, the periodic ledger watch with a finding, the drift baseline after a
   part-way plan, the clone and standby and foreign-endpoint traps, the database move.
8. **Group H: errors, signals and tests.** 500 INTERNAL that should be typed (`BACKUP_REQUIRED`,
   Control Store errors, `TARGET_SQL_ERROR`, `AUDIT_*`), the `/unmatched` metrics route and the
   missing operational metrics, certificate and TLS signals, clock skew check, retention
   pruning, then the CI and test findings (branch protection, the three checks missing from CI,
   order-dependent tests, the regression guards for TC-049/050/054, the flaky host test).
9. **Group I: the 75 findings of the first campaign that are still open** (28 NOT FIXED, 11
   PARTIAL, 7 by decision): see `R/verdicts.md`; their text is in
   `2026-10-27-test-campaign-fixes.md` and is not repeated here.
10. **Docs and gates last:** `PRE-WAVE-11-REVIEW.md` (new section), `gates/*.md`,
    `acceptance-gates.md`, `test-strategy.md`, `open-decisions.md`.

### Owner decisions this campaign needs (do not decide them silently)

Each is described in the `F/decisions-*.md` file named in brackets.

- **P0 or P1?** A holder of `migrations.plan` can kill the Control Store with about six unaudited
  requests (`decisions-S6`), and one allowlisted read can restart the target PostgreSQL
  (`decisions-D2`). Count them as outages (P0) or accept the residual risk after the fixes.
- **OD-64 and the approval window** (`decisions-S4`, `decisions-R2`): how long may an operation wait
  for approval, and may an approval after the plan expired start it at all?
- **Closing a stuck operation** (`decisions-D0` D0-01, `decisions-B1`): approval and re-authentication for
  `migration.verify` that names a stuck operation on production; `operation.force_release` or per-kind
  retry.
- **Project settings home** (`decisions-B1` D-1): registry record or repository file, and what a lowered lint
  rule means on production.
- **Lint false positives** (`decisions-B3`, `decisions-S5` D1): a per-finding acknowledgement with a reason, or catalog
  facts that make the rules precise; and whether a bundle verified on staging may be lint-blocked at production.
- **The upgrade contract** (`decisions-S3`, `decisions-B1`): roll forward or restore only, or additive-compatible starts
  (an ADR); keyring custody or an audited reset.
- **Wave 11 prerequisites** (`decisions-S5` D6): destructive production bundles need a product-managed verified backup
  (node agent, adopted pgBackRest repository on `reos-db-01`; the storage part of OD-4 is open), or break-glass
  once OD-21 is decided.
- **Drills and data checks** (`decisions-S2`, OD-60): a drill carries a data check before `passed`.
- **Certificate and clock policy** (`decisions-C1`, `decisions-S6`, OD-62): warning thresholds, enforcing expiry on open
  gateway sessions, whether the audit chain tolerates or clamps clock skew.
- **E16/E18 waivers and G10.3** (OD-65, OD-66) and **step-up for enrollment** (OD-67): unchanged from the fix
  session; the staging import counts as real REOSA data or not.
- **Self-approval and CLI grants on production** (`decisions-S4`): a person with a production binding applies a verified
  production migration with no approval and no fresh proof when no rule fires; OD-9 lets the applying person approve.

### Things for the owner to look at now (not work for the fix session)

- The live node's certificate renewed itself on 2026-10-29 (new expiry 2026-11-01 05:52 UTC; read only,
  `D/ops/node-cert-watch.sh`). The warning for a missing renewal is still not built (OD-62).
- `main` has no branch protection and no required checks, and CI of commits on `main` is cancelled by the next
  push (`F/findings-A.md`). The commit after the fix (#47) failed the `node-pg` job once on a test race.
- The fix pull request was merged although its description said "Not merged, not deployed"; nothing of it is
  deployed. Do not deploy before the upgrade group is done: the documented rollback does not work.

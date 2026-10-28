# Migration failures, edge cases and recovery

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
| Applies to | Wave 6 |
| Read before | [`planning-and-apply.md`](./planning-and-apply.md), [`verification.md`](./verification.md), [`concurrency.md`](./concurrency.md) |

The rule behind every row in this document: **recovery is a new, planned
operation**. Nothing is re-executed implicitly, nothing is rolled back
automatically, nothing in the ledger is edited
([C-14](../00-product/constitution.md#c-14-applied-history-is-immutable-and-content-bound), [C-16](../00-product/constitution.md#c-16-failures-never-trigger-automatic-re-execution-or-rollback)).

## 1. Edge-case catalog

| # | Situation | Detection | State after | Recovery |
|---|---|---|---|---|
| E1 | `up.sql` fails before commit (SQL error, lock timeout, statement timeout) | error from server | `not_applied`; operation `failed`; error with SQLSTATE, statement index | Fix the bundle (new checksum is fine, nothing was applied) or wait (lock timeout), then re-plan |
| E2 | Apply succeeds, L1/L2/L3 verification fails | verification result | `applied`, `failed` | Forward-fix migration, or verify revision + `migration.verify`, or planned rollback (§3). Dependent prod plans blocked. |
| E3 | Network breaks after `COMMIT` was sent | no reply | operation `needs_reconciliation` | Automatic reconciliation: ledger row with this `operation_id` present → applied (verify next); absent → not applied |
| E4 | Same plan retried by the client | plan already consumed | unchanged | Existing operation returned (`alreadyAccepted`) |
| E5 | Lock holder (another ExponetDB operation) crashes | session ends on server; lease expires | lock free; crashed operation reconciles | Waiting operation proceeds or has already timed out → re-plan |
| E6 | Target restarts during apply | connection error | before commit: rolled back by server; at commit: E3 | As E1 / E3 |
| E7 | Node agent unavailable | n/a for SQL-only migrations | unaffected | Migrations do not need the agent; backup-gated migrations wait for the backup subsystem (policy) |
| E8 | Legacy migration exists but its checksum provenance is `unknown` | ledger row | imported | Treated as applied history; dependencies on the baseline are satisfied; it never needs a checksum to be re-proven |
| E9 | New migration depends on an imported legacy migration | DAG validation | n/a | Not allowed: bundles depend on the baseline or on bundles (legacy files are not graph nodes) |
| E10 | `verify.sql` times out | statement or lock timeout | `applied`, `error`; operation `needs_attention`, the target's schema domain held | `operation retry-verification` once the cause is gone (the worker re-runs only the verification); with a broken `verify.sql`, a verify revision, then `migration.verify`, whose plan names the operation and closes it as `verification_failed` (TC-005) |
| E11 | Migration requires a non-transactional statement | parser classification | n/a | `transactional: false`; plan alone; approval on prod; §2 |
| E12 | `CREATE INDEX CONCURRENTLY` fails or is interrupted | error / reconciliation | `partially_applied`; an **INVALID** index may exist (still adds write overhead; an invalid unique index still enforces uniqueness) | Cleanup plan (`DROP INDEX CONCURRENTLY IF EXISTS`), then re-plan; or `migration.resume` which re-runs from the failed statement after the engine verified the cleanup (§2) |
| E13 | Required extension missing | plan-time requirement check | n/a | `postgres.extensions.apply` operation (node capability), then re-plan |
| E14 | PostgreSQL version differs from `requires.postgres` | plan-time check | n/a | Denied; upgrade or change the bundle |
| E15 | Staging schema differs from production before the migration | lineage check | n/a | Shown in plan; warn or require approval per OD-14; reconcile environments over time |
| E16 | Production has a hotfix that staging lacks | ledger comparison | finding `hotfix_without_evidence` | Apply the same migration to staging ([`staging-production-policy.md` §3](./staging-production-policy.md#3-hotfixes)) |
| E17 | Two branches added unordered migrations touching the same object | lint `parallel_object_overlap` | n/a | Add an explicit `dependsOn` edge before merge; on prod the lint blocks |
| E18 | Migration removed from the source repository after it was applied | drift check `applied_not_in_source` | finding | Ledger stays; restore the file or write a migration that undoes it; never delete the ledger row |
| E19 | Migration modified after staging apply (executable text) | `MIGRATION_CHECKSUM_MISMATCH` at the next plan | blocked | Restore the original bytes; put the change into a new migration |
| E20 | Migration modified after staging (comments only) | checksum equal, lint `comment_only_change` | unaffected | none |
| E21 | Dependency cycle | DAG validation | n/a | Fix `dependsOn` (only possible before apply) |
| E22 | Migration's dependency applied with a different checksum on this target | DAG validation | n/a | `MIGRATION_CHECKSUM_MISMATCH`; investigate ledger divergence |
| E23 | Out-of-band DDL on the target between plan and apply | fingerprint binding | plan stale | Re-plan; drift finding records the out-of-band change |
| E24 | Ledger tampered with (row added/removed by hand) | mirror comparison | `LEDGER_DIVERGENCE`, schema changes blocked | `ledger.reconcile` with an explicit operator decision |
| E25 | Target restored to an earlier point in time | restore operation or generation/identity mismatch | ledger reflects the restored state; mirror reconciled; plans stale | Re-plan; migrations after the restore point show as pending again (and must have the same checksums as before) |
| E26 | Control Plane restarts during an operation | lease expiry | reconciliation by new worker | Automatic; see [`../02-control-plane/operations-engine.md` §4.2](../02-control-plane/operations-engine.md#42-workers-and-leases) |
| E27 | Grant of the applying client revoked mid-operation | authorization re-check at dispatch, at execution start and before each further migration | remaining migrations not started (`GRANT_REVOKED` in their progress); operation `failed` with `GRANT_REVOKED` when nothing ran, else `verification_failed` (`partially_applied`) with what ran verified | Re-plan by an authorized actor |
| E28 | Plan approved after the target changed | bindings re-checked at execution start | `PLAN_STALE`, nothing executed | Re-plan, re-approve |
| E29 | `ALTER TYPE … ADD VALUE` and use of the new value in one migration | lint `enum_value_used_in_same_tx` | n/a | Split into two migrations |
| E30 | Data migration too large for one transaction | statement timeout / lock contention | E1 | Use batched data migrations: a non-transactional bundle whose statements each process a bounded batch, or an application-side backfill job; ExponetDB does not run unbounded backfills in a schema transaction |

## 2. Non-transactional migrations

`transactional: true` is not decoration: it selects the executor
([`planning-and-apply.md` §4.3/4.4](./planning-and-apply.md#43-transactional-migration)).
For `transactional: false`:

- **Behavior**: statements run in autocommit, one by one; each successful
  statement is recorded as an event in the target ledger before the next starts.
  The ledger row (`applied`) is written only after the last statement and the
  structural checks succeed.
- **Verification**: identical layers L1-L3 after the ledger write; there is no
  L0 (nothing to roll back).
- **Partial failure**: the event log tells exactly which statements completed.
  The target receives a blocking finding `nontransactional_migration_incomplete`
  that denies further schema plans on that target until resolved:
  - `migration.resume(target, migrationId)`: a new plan that continues at the
    failed statement, bound to the event log and to a fingerprint that shows the
    expected partial state (and, for `CREATE INDEX CONCURRENTLY`, to the absence
    of a leftover invalid index, which the plan can include as a cleanup step);
  - or a cleanup migration plus a fresh plan of the original bundle (only if the
    bundle never wrote an `applied` row).
  Planning any schema change on such a target is refused with
  `MIGRATION_INCOMPLETE` (`details.migrationId`). A failure before any
  statement took effect (statement 0, and not a `CONCURRENTLY` statement that
  can leave an INVALID index) is closed at once with a `ledger_reconciled`
  event (`not_applied`) and blocks nothing **[DECIDED]**.
- **`migration.resume` in Wave 6** **[DECIDED]** (`planMigrationResume`,
  the apply kind under the name `migration.resume`, class `high`):
  - The plan reads the target's event log since the latest `nontx_started`
    and finds the first statement without a done event. It never re-runs
    that statement blindly; a catalog readback decides:
    `failed_without_effect` (a recorded SQLSTATE, or a failure before the
    statement ran: an autocommit statement that failed rolled back) runs it
    again; after a crash gap, `present` (all of the statement's structural
    expectations hold: recorded as done with `readback: present`, the next
    statement runs) or `absent` (none holds: it runs again); `invalid_index`
    (a `CREATE INDEX CONCURRENTLY` left an INVALID index) continues only
    when the request sets `cleanup`; `ambiguous` or `unreadable` (no
    expectations, a procedural statement, partly true expectations, or a
    catalog read that failed) is a blocking finding and denies the plan.
    `all_done` (every statement done, the record step failed, e.g. L0)
    retries only the record step.
  - The plan binds the original apply plan's item (checksum, bundle digest,
    execution role, timeouts, search path), the live partial fingerprint and
    ledger hash, the digest of the event log since the start, the statement
    index, the readback, the cleanup (index OID, schema, name) and the
    fingerprint before the migration (for the ledger row). Acceptance
    compares the event log again; apply compares event log and readback
    once more on the migrator session under the target lock (`PLAN_STALE`
    with `event_log` or `readback` otherwise).
  - The cleanup drops exactly the index the plan saw, by OID, while it is
    still INVALID, with `DROP INDEX CONCURRENTLY IF EXISTS` as the execution
    role, before the failed statement runs again. The first event the
    resume writes names it (`detail.resume.of`, `detail.resume.cleanup`).
  - The migration's own row and the `applied` event are written as on
    apply, with the fingerprint before the migration from the original
    plan; L1 to L3 follow. A resume that fails again stays incomplete
    (another resume plan), except a failure at statement 0 without an
    artifact, which closes the start with `ledger_reconciled`.
  - Reconciliation never reads a missing row of a started, unclosed
    non-transactional migration as `not_applied`: the operation goes to
    `needs_attention` (`MIGRATION_INCOMPLETE` in its progress) and the
    target stays blocked until a resume. The resume plan names that
    operation; when the resume starts, the operation is closed as
    `verification_failed` (`partially_applied`, the outcome it had was
    `unknown`) and its lock goes (TC-005).
  - Policy: `migration.resume` falls under the SQL rules (lint gate,
    execution role, lock risk, agent production) and
    `migration.nontransactional` (production: approval and re-authentication).
- **Stronger gates on prod tier** ([`staging-production-policy.md`](./staging-production-policy.md)):
  always approval and re-authentication; recent verified backup if any statement
  is classified destructive; the plan shows which statements are non-transactional
  and what a failure in each would leave behind.
- **Author guidance**: one non-transactional statement per bundle; idempotent
  forms where PostgreSQL offers them (`CREATE INDEX CONCURRENTLY IF NOT EXISTS`,
  `DROP INDEX CONCURRENTLY IF EXISTS`) so that `migration.resume` can re-run the
  failed statement safely.

## 3. `down.sql`

**[DECIDED]**

- Optional. Never executed automatically, never as part of a failed apply.
- Executing it is a `migration.rollback` operation: plan (with the rollback
  digest, the analysis of `down.sql` itself, and the migrations that depend on
  the one being rolled back), approval (always on prod tier, `critical` class if
  the rollback is `lossy` or `unsafe`), apply, verify.
- A rollback is refused while any applied, non-reverted migration depends on the
  target migration (roll back dependants first, in reverse topological order,
  each as its own plan or one plan listing them).
- Effect on the ledger: the migration's row receives `reverted_at` and
  `reverted_by_op` (the only permitted update); a `reverted` event is appended.
  The migration id **cannot be applied again** on that target; the fix is a new
  migration with a new id.
- Verification of a rollback: L1 derived from the parse of `down.sql`, L3 (in
  particular: the fingerprint after rollback should equal the migration's
  `fingerprint_before`; a difference is shown and, for `safe` rollbacks, fails
  verification).
- Safety classes shown to approvers:

| Class | Meaning | Example |
|---|---|---|
| `safe` | Reverses structure without losing data written since. | dropping a newly created index; dropping a newly added policy |
| `lossy` | Reverses structure but discards data written since apply. | dropping a column added by the migration (data written into it is lost) |
| `unsafe` | Cannot restore the previous state (data already transformed, dropped columns cannot come back). | reversing a type change that truncated values |

- **Forward fix is the preferred remedy** (P-16). The plan view for a failed or
  regretted migration shows "write a forward migration" first and "roll back"
  second.

**[DECIDED]** Wave 6 implementation (`MigrationRollbackKind`):

- One migration per rollback plan. Planning refuses with
  `MIGRATION_ROLLBACK_BLOCKED`: `dependents_applied` while an applied migration
  depends on it, `not_latest` while a later migration is applied (roll that
  back first: L3 can only compare with `fingerprint_before` of the latest
  migration), `no_down_sql` when no stored revision of the applied checksum
  carries `down.sql`. A reverted id is refused with `MIGRATION_REVERTED`, also
  when planned for apply again.
- Before planning, the live fingerprint must equal the `fingerprint_after` the
  latest migration recorded (`SCHEMA_FINGERPRINT_MISMATCH` otherwise: no
  rollback onto a schema changed beside the ledger). The plan binds that
  fingerprint and the ledger state; apply re-checks both under the target lock.
- `down.sql` passes the same statement admission and lint gate as `up.sql`
  (rule `migration.lint-errors`, execution role rule) and runs in one
  transaction as the declared execution role with L0. The ledger update
  (`reverted_at`, `reverted_by_op`) and the `reverted` event commit with it.
- Verification: L1 from the parse of `down.sql`, L3 against the migration's
  `fingerprint_before`; a difference fails for every safety class.
- Policy: production rollbacks need one approval and a re-authentication
  within 300 s (rule `migration.rollback-production`); `lossy` and `unsafe`
  rollbacks are `critical` there and need a verified backup (rule
  `migration.destructive-backup`, unmet before Wave 9).

## 4. Reconciliation algorithm (unknown outcome)

When an operation's outcome is unknown (connection lost at commit, worker crash,
lease lost):

1. Wait until no session with `application_name = 'exponetdb/op_<id>'` exists on
   the target (the old session must be gone, otherwise it could still commit).
   If it persists beyond the keepalive window, a human with
   `operations.recover` can terminate it through `operation.force_release`.
2. Read the target ledger: rows and events with this `operation_id`.
3. For each migration of the plan: `applied` row present → applied; for
   non-transactional, the event log gives the precise progress.
4. Update the operation (`verifying` for applied migrations, `failed` for the
   rest) and the mirror; audit `operation.reconciled` with the evidence.
5. If evidence is contradictory (event says applied, row missing), the operation
   goes to `needs_attention` and the target gets a blocking finding; no automatic
   decision.

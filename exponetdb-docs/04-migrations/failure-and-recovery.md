# Migration failures, edge cases and recovery

| | |
|---|---|
| Status | Baseline (Wave 0), awaiting owner approval |
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
| E10 | `verify.sql` times out | statement timeout | `applied`, `error`; operation `needs_attention` | `migration.verify` later or with a raised timeout (verify revision changes digest only if the file changes) |
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
| E27 | Grant of the applying client revoked mid-operation | authorization re-check before each migration | remaining migrations not started; operation `failed` with `GRANT_REVOKED` | Re-plan by an authorized actor |
| E28 | Plan approved after the target changed | bindings re-checked at execution start | `PLAN_STALE`, nothing executed | Re-plan, re-approve |
| E29 | `ALTER TYPE … ADD VALUE` and use of the new value in one migration | lint `enum_value_used_in_same_tx` | n/a | Split into two migrations |
| E30 | Data migration too large for one transaction | statement timeout / lock contention | E1 | Use batched data migrations: a non-transactional bundle whose statements each process a bounded batch, or an application-side backfill job; ExponetDB does not run unbounded backfills in a schema transaction |

## 2. Non-transactional migrations

`transactional: true` is not decoration: it selects the executor
([`planning-and-apply.md` §4.3/4.4](./planning-and-apply.md#43-transactional-migration)).
For `transactional: false`:

- **Behaviour**: statements run in autocommit, one by one; each successful
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

## 4. Reconciliation algorithm (unknown outcome)

When an operation's outcome is unknown (connection lost at commit, worker crash,
lease lost):

1. Wait until no session with `application_name = 'exponetdb/op_<id>'` exists on
   the target (the old session must be gone, otherwise it could still commit).
   If it persists beyond the keepalive window, the operator can terminate it
   through `operation.force_release`.
2. Read the target ledger: rows and events with this `operation_id`.
3. For each migration of the plan: `applied` row present → applied; for
   non-transactional, the event log gives the precise progress.
4. Update the operation (`verifying` for applied migrations, `failed` for the
   rest) and the mirror; audit `operation.reconciled` with the evidence.
5. If evidence is contradictory (event says applied, row missing), the operation
   goes to `needs_attention` and the target gets a blocking finding; no automatic
   decision.

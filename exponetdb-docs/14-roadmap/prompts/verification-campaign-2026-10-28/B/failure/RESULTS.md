# Stack-level invariants and failure injection: results (tester S1)

Commit under test `d51da5d0d8832ebc569f23985c7e5176e4d450ad` (merge of fix PR #46), Node 24.22.1, Bun 1.4.4, Ubuntu 24.04 (UTC),
PostgreSQL 16.15 / 17.11 / 18.6, on the disposable stack `D/infra` (real `serve`, `worker`, `gateway`, Control Store in Docker,
node agent 0.7.0 under systemd adopting the PG17 cluster). Run 2026-10-28 evening and 2026-10-29. Scripts and how to run them:
[`README.md`](./README.md). Every row below was produced by the script named in it; raw logs stay on the server and are not
committed. Verdict words: PASS, FAIL, PARTIAL, NOT RUN (with the reason).

## 1. Verdicts per invariant

| Invariant | Verdict | Evidence in one line |
|---|---|---|
| I4 atomicity (`I4-atomicity-stack.sh`) | **PASS** (47 cases, 0 FAIL: 38 refused at lint/plan, 4 applied exactly as written, 4 clean failures, 1 PARTIAL by design) | the transactional cases containing COMMIT, END, ABORT, ROLLBACK, BEGIN, START TRANSACTION, PREPARE TRANSACTION, COMMIT AND CHAIN, SAVEPOINT, SET ROLE, RESET ROLE, SET SESSION AUTHORIZATION, SET [LOCAL] search_path, psql meta text, CIC/DROP INDEX CONCURRENTLY/REINDEX CONCURRENTLY/VACUUM/ALTER SYSTEM/CREATE/DROP DATABASE, ALTER TYPE ADD VALUE used in the same transaction, and ledger tampering (TRUNCATE, DROP SCHEMA exponetdb, DISABLE TRIGGER) were all **refused at lint and denied at plan** (`migration.lint-errors`, so the server enforces it too): nothing reached a target, ledger 0, no object left. The three runtime forms (DO block with COMMIT, DO block with `EXECUTE 'COMMIT'`, procedure that commits) were accepted and **failed cleanly** at apply: `failed`, nothing left, ledger 0. Allowed and applied exactly as written: `\` inside a string literal, ALTER TYPE ADD VALUE alone, non-transactional CIC and VACUUM. Non-transactional ALTER SYSTEM, CREATE DATABASE, COMMIT: denied. `nontx_midfail`: PARTIAL by design (c_a created, events `nontx_started, nontx_statement_done x2, nontx_failed`, no ledger row, operation `verification_failed`, resume offered); first-statement failure closes at once. Session leakage of `SET` was not testable: lint forbids the statements. Weak points: the refusal text (finding P3) and `RESET ROLE` reported as `SET ROLE`. |
| I6 truth (`I6-truth.sh`) | **PASS** (order, false, error, hang, insert, CTE insert, nextval, advisory lock, set_config, pg_sleep, missing file), **PARTIAL** (runtimeChecks none) | Sampled every ~20 ms: `queued > running > verifying (applied/pending) > succeeded (applied/passed)`; no sample says `succeeded` before `verify=passed`, in the Control Store or over REST. A check that returns false ends `verification_failed`; one that errors or is blocked by a lock ends `needs_attention` after 6 s and `retry-verification` closes it `succeeded` once the lock is gone. Every writing or side-effecting check is refused at lint (`verify_admission`, `verify_statement_without_assertion`). A missing verify.sql is a parse error. `runtimeChecks: none` ends `verify=passed` with no runtime check (P3). Unknown state fails closed: see the cut-target and restart cells below and I9. |
| I7 no silent adoption (`I7-no-silent-adoption.sh`) | **PASS** (9 of 10 classes), **PARTIAL** (comment-only: not detected) | see section 3 |
| I8 single writer (`I8-single-writer.sh`) | **PASS** (5/5) | Two applies at once on one target: the first applied, the second ended `PLAN_STALE` (typed). Two targets of one cluster: both succeeded, one after the other (the worker runs one operation at a time, see C1). An outside session holding the target's `EXDB` advisory lock (key1 1163412546, key2 from the SHA-256 of `exponetdb/lock/v1/schema/<targetId>`): the apply never ran unlocked and ended `failed MIGRATION_LOCK_TIMEOUT`; released after 8 s, the apply waited and then ran. A terminated apply session: the lock went with the session, the operation `failed`, the next plan on the target succeeded. |
| I9 every state has an exit (`I9-exits.sh`, `I9-approval.sh`) | **FAIL** (4 dead ends reproduced, 1 order defect reproduced, 1 approval defect reproduced) | see section 2 |

## 2. I9: the dead ends, reproduced on the stack

| Scenario | Verdict | Result |
|---|---|---|
| `rollback` (migration.rollback whose verification cannot read the target) | **FAIL** | `needs_attention apply=applied verify=error`; `operation show`: `retryable=false nextAction=inspect errorCode=VERIFICATION_ERROR`; `retry-verification` `OPERATION_NOT_RETRYABLE`; `cancel` `OPERATION_NOT_CANCELABLE`; `operation_locks` holds `target:<id>:schema`; a new independent plan on the target queues and its `waitingFor` names the parked operation. The REST contract has four operation routes; `operation.force_release` exists in none. |
| `reconcile` (ledger.reconcile) | **FAIL** | identical |
| `accept` (drift.accept) | **FAIL** | identical (`cancel` answers `PLAN_BINDING_ACTOR` from another client) |
| `unknown_rolledback` (apply outcome `unknown`, the commit not durable) | **FAIL** | `needs_attention apply=unknown errorCode=OUTCOME_UNKNOWN`; same refusals; `migration verify <id>` answers `NOT_FOUND`. The rolled-back truth is simulated by removing the committed change and its ledger row by hand as superuser; the lost COMMIT reply itself is real (synchronous commit wait, cluster killed). |
| `unknown` (apply outcome `unknown`, the commit WAS durable) | not a dead end, but P2 | the operation parks in under a second, is never reconciled after the target returns, and the exit (`migration verify`) closes it `verification_failed apply=partially_applied` for a fully applied transactional migration |
| `supersede` (D0 P2, driver.ts:178-186) | **FAIL** | N (`migration.apply`, `needs_attention`, schema lock held) is named by a recovery `migration.verify` V; V is accepted, the CLI grant is revoked, the worker dispatches: V ends `failed` (refused), **N ends `verification_failed` with its lock released** though the recovery did nothing |
| `approval_expired_plan` (TC-034 / OD-64) | **FAIL** | see finding: the awaiting operation never expires; an approval 15 minutes after the plan's expiry was accepted and the production change ran and verified |
| `approval_window` (B1 P2, 4 h) | NOT RUN | the Control Store refuses to age an operation row (guard); a 4-hour wait was out of budget. 15 minutes without expiry observed |
| `endpoint` (a non-migration kind, registry.endpoint.add) | NOT RUN | no plan could be made (duplicate endpoint address); a node kind (`postgres.hba.apply`) was not tried |

C1 hypotheses (`C1-hypotheses.sh`):

| Hypothesis | Verdict | Result |
|---|---|---|
| Head-of-line blocking | **FAIL (confirmed)** | with a parked operation on target A, P1 queued on A and P2 on target B: P2 stayed `queued` for the whole 73 s observed (never leased) and P1 wrote 70 `operation_events` in 72 s (37 `lease_acquired` + 37 `locks_waiting`). Canceling P1 let P2 run to `succeeded` at once. |
| Redeploy during an apply, grace 60 s | PASS (nothing re-ran) | a 90 s `pg_sleep` apply; SIGTERM after 10 s; the worker exited with code 1 after 26 s (its own drain limit), the apply did not finish, the operation stayed `running` until the new worker took it (about 20 s after the restart), then `failed not_applied`, ledger 0, the first statement started once. The target session kept sleeping after the worker exited (open transaction, schema lock) until its statement ended. |
| Redeploy during an apply, grace 10 s | PASS (nothing re-ran) | SIGKILL after 10 s (exit 9); same end state |

## 3. I7: no silent adoption

Each class was made as the local superuser behind ExponetDB's back after a verified migration B1; then B2 and B3 (unrelated, verified) were planned
and applied, and the open drift findings were compared by object (not only the status). All nine detectable classes **stay open**: the first
campaign's TC-006 fix holds on the stack for grant to PUBLIC, trigger, policy, default privileges, extension create and upgrade, function body,
owner, index and column. Two caveats. (1) After the first out-of-band change every later migration lists its **own** new objects as `object_added`
drift (4 findings per migration) until a human runs `drift.accept`: correct by design, noisy in practice. (2) A **comment-only** change is not seen by
the fingerprint at all (`oob=clean`), so it is neither adopted nor detected (PARTIAL, P3). A real `drift.accept` (attributed, planned) was exercised
in `I9-exits.sh accept` only up to its verification, not as the way back to `clean`.

| out-of-band change | verdict | what the drift check still holds after two unrelated verified migrations |
|---|---|---|
| add_column | PASS | object_added column public.t1.oob |
| grant_public | PASS | object_changed table public.t1 |
| trigger | PASS | object_added function public.oob_tf(); object_added trigger public.t1.oob_trg |
| policy | PASS | object_added policy public.t1.oob_p; object_changed table public.t1 |
| default_privileges | PASS | object_added default privileges for lab_owner in public on r |
| extension_upgrade | PASS | object_added extension pg_trgm |
| function_body | PASS | object_changed function public.f1() |
| owner_change | PASS | object_changed table public.t1 |
| index_added | PASS | object_added index public.oob_idx |
| comment_only | PARTIAL | not detected at all (the fingerprint does not see this class);  clean=clean oob=clean afterB2=clean afterB3=clean |


## 4. Failure injection around apply (`F-matrix.sh`, `F-disk.sh`)

Cell = (bundle kind, phase, injection) on a fresh PostgreSQL 16 target. `tx`: transactional bundle (counter `nextval`, `CREATE TABLE f_a`,
`pg_sleep(8)`, `CREATE TABLE f_b`); `nontx`: DDL only (the policy refuses data statements and function calls in a non-transactional
bundle): `CREATE TABLE`, `CREATE INDEX CONCURRENTLY` (held by an older out-of-band transaction), `CREATE TABLE`. Phases: `before_plan`, `between` (plan
and apply), `lock` (operation `running`), `mid` (inside the statement), `incommit` (COMMIT sent and flushed, never answered: a missing synchronous
standby), `commit` (after the target's commit, before the Control Store mirror write: the mirror table is locked), `verify` (catalog of 1,500
tables so the verification takes seconds). "first stmt started" counts server-log lines of the first statement for transactional cells (more
than 1 = automatic re-execution) and `nontx_started` events for non-transactional ones.

| cell (bundle:phase:injection) | verdict | Control Store state | CLI/REST state | ledger | objects | first stmt started | next plan | product pointer | seconds | judgement |
|---|---|---|---|---|---|---|---|---|---|---|
| tx:mid:kill9_worker | PASS | failed apply=not_applied verify=not_applicable | failed apply=not_applied verify=not_applicable | 0 | exec_seq | 1 | succeeded | retryable=false next=replan err=OUTCOME_UNKNOWN | 34 | consistent; no re-execution; next plan succeeded |
| tx:commit:kill9_worker | PASS | succeeded apply=applied verify=passed | succeeded apply=applied verify=passed | 1 | exec_seq+f_a+f_b | 1 | succeeded | retryable=false next=none err=OUTCOME_UNKNOWN | 34 | consistent; no re-execution; next plan succeeded |
| tx:verify:kill9_worker | PASS | succeeded apply=applied verify=passed | succeeded apply=applied verify=passed | 1 | exec_seq+f_a+f_b | 1 | succeeded | retryable=false next=none err=null | 47 | consistent; no re-execution; next plan succeeded |
| nontx:verify:kill9_worker | PASS | succeeded apply=applied verify=passed | succeeded apply=applied verify=passed | 1 | exec_seq+f_a+f_b | 1 | succeeded | retryable=false next=none err=null | 134 | consistent; no re-execution; next plan succeeded |
| nontx:mid:pg_immediate | PARTIAL | needs_attention apply=unknown verify=pending | needs_attention apply=unknown verify=pending | 0 | exec_seq+f_a | 1 | plan_refused(?) | retryable=false next=inspect err=OUTCOME_UNKNOWN | 25 | next plan on the target: plan_refused(?);needs_attention (retryable=false next=inspect err=OUTCOME_UNKNOWN) |
| tx:verify:pg_immediate | PASS | succeeded apply=applied verify=passed | succeeded apply=applied verify=passed | 1 | exec_seq+f_a+f_b | 1 | succeeded | retryable=false next=none err=null | 40 | consistent; no re-execution; next plan succeeded |
| tx:mid:pg_immediate | PASS | failed apply=not_applied verify=not_applicable | failed apply=not_applied verify=not_applicable | 0 | exec_seq | 1 | succeeded | retryable=false next=replan err=TARGET_UNAVAILABLE | 25 | consistent; no re-execution; next plan succeeded |
| tx:incommit:pg_immediate | PARTIAL | needs_attention apply=unknown verify=pending | needs_attention apply=unknown verify=pending | 1 | exec_seq+f_a+f_b | 1 | queued(blocked) | retryable=false next=inspect err=OUTCOME_UNKNOWN | 33 | next plan on the target: queued(blocked);needs_attention (retryable=false next=inspect err=OUTCOME_UNKNOWN) |
| tx:between:kill9_serve | PASS | succeeded apply=applied verify=passed | succeeded apply=applied verify=passed | 1 | exec_seq+f_a+f_b | 1 | succeeded | retryable=false next=none err=null | 27 | consistent; no re-execution; next plan succeeded |
| tx:mid:kill9_agent | PASS | succeeded apply=applied verify=passed | succeeded apply=applied verify=passed | 1 | exec_seq+f_a+f_b | 1 | succeeded | retryable=false next=none err=null | 13 | consistent; no re-execution; next plan succeeded |
| tx:mid:kill9_gateway | PASS | succeeded apply=applied verify=passed | succeeded apply=applied verify=passed | 1 | exec_seq+f_a+f_b | 1 | succeeded | retryable=false next=none err=null | 14 | consistent; no re-execution; next plan succeeded |
| tx:incommit:kill9_worker | PASS | succeeded apply=applied verify=passed | succeeded apply=applied verify=passed | 1 | exec_seq+f_a+f_b | 1 | succeeded | retryable=false next=none err=OUTCOME_UNKNOWN | 37 | consistent; no re-execution; next plan succeeded |
| tx:incommit:terminate_backend | PASS | succeeded apply=applied verify=passed | succeeded apply=applied verify=passed | 1 | exec_seq+f_a+f_b | 1 | succeeded | retryable=false next=none err=OUTCOME_UNKNOWN | 22 | consistent; no re-execution; next plan succeeded |
| tx:mid:pg_fast | PASS | failed apply=not_applied verify=not_applicable | failed apply=not_applied verify=not_applicable | 0 | exec_seq | 1 | succeeded | retryable=false next=replan err=TARGET_UNAVAILABLE | 16 | consistent; no re-execution; next plan succeeded |
| tx:mid:kill9_serve | PASS | succeeded apply=applied verify=passed | succeeded apply=applied verify=passed | 1 | exec_seq+f_a+f_b | 1 | succeeded | retryable=false next=none err=null | 16 | consistent; no re-execution; next plan succeeded |
| tx:mid:terminate_backend | PASS | failed apply=not_applied verify=not_applicable | failed apply=not_applied verify=not_applicable | 0 | exec_seq | 1 | succeeded | retryable=false next=replan err=TARGET_UNAVAILABLE | 14 | consistent; no re-execution; next plan succeeded |
| tx:mid:control_restart | PASS | succeeded apply=applied verify=passed | succeeded apply=applied verify=passed | 1 | exec_seq+f_a+f_b | 1 | succeeded | retryable=false next=none err=null | 14 | consistent; no re-execution; next plan succeeded |
| tx:commit:control_restart | PASS | succeeded apply=applied verify=passed | succeeded apply=applied verify=passed | 1 | exec_seq+f_a+f_b | 1 | succeeded | retryable=false next=none err=OUTCOME_UNKNOWN | 35 | consistent; no re-execution; next plan succeeded |
| tx:incommit:control_restart | PASS | succeeded apply=applied verify=passed | succeeded apply=applied verify=passed | 1 | exec_seq+f_a+f_b | 1 | succeeded | retryable=false next=none err=null | 24 | consistent; no re-execution; next plan succeeded |
| tx:mid:sigterm_worker | PASS | succeeded apply=applied verify=passed | succeeded apply=applied verify=passed | 1 | exec_seq+f_a+f_b | 1 | succeeded | retryable=false next=none err=null | 13 | consistent; no re-execution; next plan succeeded |
| nontx:mid:sigterm_worker | PARTIAL | verification_failed apply=partially_applied verify=partial | verification_failed apply=partially_applied verify=partial | 0 | exec_seq+f_a | 1 | plan_refused(?) | retryable=false next=resume err=VERIFICATION_FAILED | 13 | next plan on the target: plan_refused(?) |
| tx:mid:net_drop | PASS | failed apply=not_applied verify=not_applicable | failed apply=not_applied verify=not_applicable | 0 | exec_seq | 1 | succeeded | retryable=false next=replan err=OUTCOME_UNKNOWN | 50 | consistent; no re-execution; next plan succeeded |
| tx:verify:net_drop | PASS | succeeded apply=applied verify=passed | succeeded apply=applied verify=passed | 1 | exec_seq+f_a+f_b | 1 | succeeded | retryable=false next=none err=null | 134 | consistent; no re-execution; next plan succeeded |
| tx:mid:net_delay | PASS | succeeded apply=applied verify=passed | succeeded apply=applied verify=passed | 1 | exec_seq+f_a+f_b | 1 | succeeded | retryable=false next=none err=null | 51 | consistent; no re-execution; next plan succeeded |
| tx:between:sigterm_serve | PASS | succeeded apply=applied verify=passed | succeeded apply=applied verify=passed | 1 | exec_seq+f_a+f_b | 1 | succeeded | retryable=false next=none err=null | 27 | consistent; no re-execution; next plan succeeded |
| tx:before_plan:kill9_worker | PASS | succeeded apply=applied verify=passed | succeeded apply=applied verify=passed | 1 | exec_seq+f_a+f_b | 1 | succeeded | retryable=false next=none err=null | 26 | consistent; no re-execution; next plan succeeded |
| tx:between:kill9_worker | PASS | succeeded apply=applied verify=passed | succeeded apply=applied verify=passed | 1 | exec_seq+f_a+f_b | 1 | succeeded | retryable=false next=none err=null | 26 | consistent; no re-execution; next plan succeeded |
| tx:lock:kill9_worker | PASS | failed apply=not_applied verify=not_applicable | failed apply=not_applied verify=not_applicable | 0 | exec_seq | 0 | succeeded | retryable=false next=replan err=OUTCOME_UNKNOWN | 36 | consistent; no re-execution; next plan succeeded |
| tx:mid:retry_same_key | PASS | succeeded apply=applied verify=passed | succeeded apply=applied verify=passed | 1 | exec_seq+f_a+f_b | 1 | succeeded | retryable=false next=none err=null | 13 | consistent; no re-execution; next plan succeeded |
| tx:mid:retry_new_key | PASS | succeeded apply=applied verify=passed | succeeded apply=applied verify=passed | 1 | exec_seq+f_a+f_b | 1 | succeeded | retryable=false next=none err=null | 13 | consistent; no re-execution; next plan succeeded |
| nontx:mid:kill9_worker | PARTIAL | needs_attention apply=unknown verify=pending | needs_attention apply=unknown verify=pending | 0 | exec_seq+f_a | 1 | plan_refused(?) | retryable=false next=inspect err=OUTCOME_UNKNOWN | 35 | next plan on the target: plan_refused(?);needs_attention (retryable=false next=inspect err=OUTCOME_UNKNOWN) |


### What the matrix shows

- **Nothing was ever re-executed automatically** (31 cells; the first statement started once in every cell; `retry_same_key` and `retry_new_key` produced exactly one operation for the plan, the second request returned the existing operation).
- **Transactional bundles are all-or-nothing under every injection**: kill -9 of the worker (mid-statement, after the target's commit, during verification, before plan, between plan and apply), `pg_ctl restart` immediate and fast mid-statement (`failed not_applied TARGET_UNAVAILABLE`, ledger 0, nothing left), `pg_terminate_backend`, packet DROP for 45 s (`failed not_applied`), a Control Store restart (the apply survived and ended `succeeded`), SIGTERM of the worker (a 13 s apply was drained and ended `succeeded`).
- `serve`, `gateway` and the node agent are not in the SQL apply path: killing them mid-apply changes nothing (E7), `kill -9 serve` between plan and apply only delays the request.
- **The one real gap in the matrix is the lost COMMIT reply with a target restart** (`tx:incommit:pg_immediate`): the change is committed (ledger 1, both tables), the operation parks `needs_attention apply=unknown`, is not reconciled after the target is back, holds the schema domain, and the next plan on the target queues behind it (P2 in the findings; the exit, `migration verify`, exists only because the ledger row is there). Killing the worker or terminating the session in the same window is reconciled correctly (`succeeded`).
- **Non-transactional bundles** parked in `needs_attention apply=unknown` (kill -9 of the worker, `pg_ctl restart` during the index build) or `verification_failed apply=partially_applied` (SIGTERM); the target refuses new plans until `migration resume`. Resume works **with `--cleanup`** (the stopped CIC left an INVALID index: applied and verified, the parked operation closed, locks released); without `--cleanup` the plan is denied with the generic rule `migration.lint-errors` and no hint (P3).
- **Stale error codes**: operations that ended `succeeded` still carry `errorCode OUTCOME_UNKNOWN` after a worker kill, a terminated session or a Control Store restart in the commit window; `failed not_applied` operations carry it as well (P3, truthful state, misleading code).
- Verification interrupted by a worker kill, a `pg_ctl restart -m immediate` or a 45 s packet drop resumes and ends `succeeded` for migration.apply (`tx:verify:*`); for rollback, reconcile and accept it parks without an exit (section 2).

### Not run, and why

- **Clock step (`clock_fwd3h`, `clock_back3h`)**: one cell was run (`tx:mid:clock_fwd3h`): the apply failed `not_applied` at the step (ledger 0, nothing left), and **after the clock was put back the audit chain refused every event for the next 2 h 54 min** (finding P1). The Control Store had to be rebuilt to continue testing; the remaining clock cells (`between`, `before_plan` +3 h and -3 h, `nontx`) were therefore not run: each would brick the audit chain again. The node agent's clock guard was not exercised.
- **Disk full on the target, non-transactional bundle**: the policy denies the data-producing statement (`migration.procedural-nontransactional`), so the bundle could not be planned. **Transactional bundle: PASS** (ENOSPC mid-statement ends `failed MIGRATION_EXECUTION_FAILED`, not_applied, nothing left).
- **Disk full on the Control Store** (`F-disk.sh control`): written, not run (time).
- **Disk full with WAL on the target**, **netem loss on the node link**, **a kill of the node agent during a node operation**: not run.
- Cells of the plan that were not reached are absent from the table; the table lists only cells that ran.

### [P1] One lock-blocked operation starves every younger operation: the worker re-claims the oldest waiter on every tick
- **Area:** `packages/operations` (`leases.ts`, `driver.ts`, `locks.ts`), `apps/server/src/composition/operations-loop.ts`
- **Block:** C
- **Reproduction:** static (`C/graceful-life.md` §6 step 1; to be confirmed on the stack): park an operation on target A in `needs_attention` (recipes of `E/state-machines.md` SM-1); queue plan P1 on A, then P2 on target B; watch `operation list --state queued` for 5 minutes and count the `operation_events` of P1 by kind.
- **Expected:** an operation waiting for a busy exclusivity domain does not prevent unrelated operations (other targets, kinds) from starting.
- **Actual (by code):** `claimNextOperation` takes the single oldest un-leased candidate (`ORDER BY created_at, operation_id LIMIT 1 FOR UPDATE SKIP LOCKED`, `leases.ts:52-65`). A queued operation whose locks are taken writes `lease_acquired` (`leases.ts:84-92`) and `locks_waiting` (`locks.ts:90-100`), releases the lease (`leases.ts:194-206`, `driver.ts:224-230`) and returns `waiting`; 2 s later it is the oldest un-leased row again, so P2 is never claimed. With the `needs_attention` dead end, one parked operation stops every later operation of the installation (a second worker only shifts the problem). Side effect: about 2 event rows and 2 operation-row updates per 2 s per waiter, 86,400 rows a day, 31.5 M a year.
- **Evidence:** `C/graceful-life.md` §4; `C/observability.md` row 10. **Reproduced on the stack by S1 (head-of-line blocking confirmed):** P2 on target B stayed `queued` for 73 s while P1 wrote 70 operation_events in 72 s (37 lease_acquired, 37 locks_waiting); after P1 was canceled P2 ran at once (`B/failure/C1-hypotheses.sh hol`, `B/failure/RESULTS.md` section 2).
- **Root cause:** the claim query has no notion of "recently found blocked"; one candidate per tick.
- **Proposed fix:** make blocked operations ineligible until their blocker ends (`blocked_until`/`waiting_for` on the row) or iterate candidates until one can take its locks; write `locks_waiting` only when the blocker changes.
- **Acceptance test:** two operations in disjoint domains, the older blocked by a parked `needs_attention` operation: the younger reaches `succeeded` within one poll, and the blocked one's events stay at most 3 over 60 simulated ticks.

### [P2] A killed or crash-looping process counts as live for 45 s, so a restart loop shorter than that reads operational
- **Area:** `packages/control-store/src/heartbeats.ts`, `packages/application/src/installation-health.ts`, `apps/server/src/composition/role.ts` (`liveWorkerCheck`), `roles/run-role.ts`
- **Block:** C
- **Reproduction:** static (`C/observability.md` step 8): `docker kill -s KILL worker; sleep 20; docker start worker` in a loop for 3 minutes while polling `GET /installation/health` and `/healthz/detail`; also `docker stop --time 5 worker` during an apply.
- **Expected:** a dead or restarting worker does not make "workers" operational; a crash loop is visible.
- **Actual (by code):** `liveProcesses` counts rows with `stopped_at IS NULL AND heartbeat_at > now() - 45 s` (`heartbeats.ts:63-85`). `markStopped` runs only in `services.stop()`, which a worker blocked in `stopLoops()` by a running operation does not reach before the 25 s bound (`run-role.ts:101-108`, `operations-loop.ts:74-82`), and never after SIGKILL or OOM. Installation health `workers` stays operational and serve's `workers` check stays `pass` (`role.ts:268-279`). No restart counter exists.
- **Evidence:** `C/observability.md` §1.3 item 4, row 3.
- **Root cause:** liveness is heartbeat age only; no stop marker for a hard kill; no start-rate signal.
- **Proposed fix:** report instances started in the last 15 minutes in `workers.values` and degrade at 3 or more; add a process start-time gauge.
- **Acceptance test:** register three worker rows within a minute without `markStopped`; `readInstallationHealth(...).workers.state` is `degraded` with reason `restart_loop`.

### [P2] A Control Store outage, a read-only store or a full disk is answered 500 INTERNAL, and pool exhaustion is reported as "unreachable"
- **Area:** `packages/control-store/src/errors.ts`, `apps/server/src/interfaces/http/request.ts` (`errorCodeOf`), `packages/contracts/src/errors.ts`, `apps/server/src/composition/role.ts`
- **Block:** C
- **Reproduction:** static (`C/fail-closed.md` steps 2-5): `ALTER DATABASE exponetdb_control SET default_transaction_read_only = on` and terminate backends; `docker pause cs`; fill the data volume; 200 concurrent reads against a slow store. Record status, problem code, log line, readiness.
- **Expected:** `503 CONTROL_PLANE_DEGRADED` (retryable, "ExponetDB itself is not ready") with a reason; read-only and full are classified.
- **Actual (by code):** `errorCodeOf` returns only catalog codes (`request.ts:152-162`); every `ControlStoreError` code is outside the catalog, so the answer is 500 INTERNAL "An unexpected error occurred" (`errors.ts:1425-1430`). `CONTROL_PLANE_DEGRADED` is raised only for the role/scope catalog (`api.ts:2184`, `mcp/edge.ts:482`). SQLSTATE 25006, 53100, 53200, 53400 map to `control_store_query_failed` (`errors.ts:75-120`); only 08*, 57P01-03, 53300 map to unavailable. A pool connect timeout (5 s, `store.ts:365`) is reported as "The Control Store is unreachable" although the store is up. Readiness probes share the application pool, so saturation gives `check_timeout`, `not_ready`, an unhealthy container, and serve leaves Traefik: a spike becomes an outage. Readiness `control_store` is `SELECT 1` (`role.ts:88-93`) and passes on a read-only store; only the failed heartbeat write detects it, about 45-50 s late.
- **Evidence:** `C/fail-closed.md` §2-3; `C/observability.md` row 5.
- **Root cause:** the interface maps catalog codes only; a short SQLSTATE list; probes share the application pool.
- **Proposed fix:** map unavailable, timeout, read-only, full and pool errors to `CONTROL_PLANE_DEGRADED` with `reason`; classify the SQLSTATEs; give readiness its own connection and a write probe (`SHOW transaction_read_only`).
- **Acceptance test:** integration tests with a read-only, an unreachable and a pool-starved store assert 503 with the reason, `not_ready` within one evaluation for read-only, and `ready` again after a pool spike clears.

### [P2] The shipped metrics cannot alert on most failures: every API request is route="/unmatched" and the documented operational metrics do not exist
- **Area:** `apps/server/src/interfaces/http/app.ts`, `packages/observability`, `10-observability/self-observability.md` §3
- **Block:** C
- **Reproduction:** static (`C/observability.md` steps 1-2): scrape `/metrics` of serve, worker and gateway after calling `/api/v1/targets`, `/fleet`, `/nodes` ten times each.
- **Expected:** route-template series and the §3 metrics (`exdb_operations_total`, `exdb_operation_step_duration_seconds`, `exdb_policy_decisions_total`, `exdb_sampler_lag_seconds`, `exdb_sample_failures_total`, `exdb_agent_connected`, `exdb_agent_job_duration_seconds`, `exdb_lock_wait_seconds`).
- **Actual:** `base()` records `routes.includes(c.req.path) ? c.req.path : '/unmatched'` (`app.ts:107-110`) and the list holds only probes, `/mcp`, two schema URLs and the OpenAPI path (`app.ts:176-181`); the test pins `route="/unmatched"` (`apps/server/test/http.test.ts:91`). Eleven metrics exist in all. Nothing counts targets by health, nodes offline, certificate expiry, backup age, operations by state or age, approvals waiting, sampler lag or restarts. Registries are per role; `/metrics` is unauthenticated and loopback-bound by default with no runbook for scraping.
- **Evidence:** `C/observability.md` §1.1, §2.1.
- **Root cause:** Wave 2 foundation metrics were never extended; the route template is not used by the middleware.
- **Proposed fix:** record the matched route template after `next()`; register the §3 metrics; worker-refreshed gauges for targets and nodes by state, soonest certificate expiry, oldest waiting operation and last backup age; document the scrape set-up.
- **Acceptance test:** three API calls produce three route-template series; a coverage test that every metric named in §3 is registered by some role.

### [P2] Backup and drill signals are not produced: the drill-finding generator is never run and the catalog is never refreshed on a schedule
- **Area:** `packages/backups/src/findings.ts`, `apps/server/src/composition/worker-tasks.ts`, `packages/backups/src/protection.ts`, `09-backups-and-restore/{architecture,adoption}.md`
- **Block:** C
- **Reproduction:** static (`C/observability.md` steps 12-13): let a host-timer backup fail and a drill fail; wait 15 and 30 minutes; read `GET /clusters/{id}/backups` and `/findings?state=all`; then call `maintainDrillFindings` by hand.
- **Expected:** `findings.ts` says `backup_drill_never_run|overdue|failed` and `restore_scratch_left` are computed by "a worker task"; `architecture.md:123` and `protection.ts:12` say the mirror is refreshed every 10 minutes.
- **Actual (by code):** `maintainDrillFindings` has no caller except `apps/server/test/http-backups.int.test.ts:368`; `WORKER_TASKS` (`worker-tasks.ts:176-314`) has no backup task. Catalog refresh is a person-started operation (`backup.catalog.refresh`; `adoption.md:69` "[PLANNED] a scheduled refresh"; `plans.ts:308` "ExponetDB starts no scheduled run"). After 30 minutes without a refresh the cluster reads `catalog_stale`/`at_risk`; host-timer failures are invisible until a refresh; a failed drill leaves no finding.
- **Evidence:** `C/observability.md` rows 8, 9.
- **Root cause:** Part B built the generator and the read model but not the scheduler.
- **Proposed fix:** worker tasks `backups.findings` (5 min) and `backups.catalog` (10 min per cluster with a live repository), or amend the documents; findings for `catalog_stale` and `wal_archive_failing`.
- **Acceptance test:** a failed drill record yields an open critical `backup_drill_failed` finding within one task interval; a stale catalog is refreshed without a person.

### [P2] No signal exists for an expiring certificate: certificate_expiring and tls_expiring are documented and typed but nothing produces them
- **Area:** `07-node-agent/enrollment.md:145-146`, `10-observability/health.md:121`, `packages/diagnostics/src/reducer.ts`, `packages/nodes`, `installation-health.ts`
- **Block:** C
- **Reproduction:** static (`C/keys-certs-time.md` steps 5, 10, 11): advance the node host clock into the renewal window with the agent stopped; register a target whose server certificate expires in 5 days; read `GET /findings`, `/nodes/{id}`, `/targets/{id}/health`, `/installation/health`.
- **Expected:** a node whose renewal keeps failing is `degraded` with `certificate_expiring` and a finding (`enrollment.md:145-146`); a target certificate within 30/7 days gives `tls_expiring` (`health.md:121`; in the contract enum `resources.ts:177` and Web `health-model.ts:52`).
- **Actual:** no code produces either string (`node-runbook.md:233-237` and OD-62 say the node finding is "not built", contradicting `enrollment.md`). The reducer's only TLS condition is `plaintext_connections` (`reducer.ts:393`); the agent sends no `serverCertificateExpiresAt` (R2). The gateway certificate and the CAs (5 and 10 years, no rotation command; `node-pki` has only init, postgres-ca and job-key) are never warned about. A node down for the 24 h renewal window reads `offline` with the same `NODE_CERTIFICATE_REFUSED` as any refusal. Installation health `gateway` is operational unless all nodes are offline, so one expired node of ten is invisible. (The live node's certificate renewed itself on 2026-10-29, consistent with `enroll.go:303-312` and `agent.go:446-470`; the gap is the missing warning, not the renewal.)
- **Evidence:** `C/keys-certs-time.md` §1.
- **Root cause:** signals designed and left unbuilt; OD-62 covers only the node part.
- **Proposed fix:** worker task `certificates.check` opening subject findings for node certificates (24 h or less without renewal), gateway and CA expiry and target server certificates (30 and 7 days from the peer certificate); count offline nodes in the gateway component state; fix the contradicting document.
- **Acceptance test:** a node certificate expiring in 6 h with an agent that cannot renew gives an open finding; `tls_expiring` appears for a target certificate with 20 days left.

### [P2] Time-based checks mix the process clock with the database clock and there is no skew check
- **Area:** `packages/operations/src/plans.ts:166-176`, `accept.ts:179-184`, `packages/nodes/src/tokens.ts:79`, `views.ts:58-71`, `gateway.ts:119-125,279-285`, `packages/operations/src/driver.ts:96-110`
- **Block:** C
- **Reproduction:** static (`C/keys-certs-time.md` steps 6-8): serve clock +2 h: create a `critical` plan, compare `expiresAt` with `SELECT clock_timestamp()`, apply 90 minutes later; read `GET /nodes` with +2 min; step the worker clock back 5 minutes after a failed lease renewal.
- **Expected:** a plan lives at most its class limit in one time base; node offline uses one clock; lease belief is monotonic.
- **Actual (by code):** a plan's `created_at`/`expires_at` come from the creator's `nowMs()` and the database `CHECK (expires_at <= created_at + 2 hours)` is relative to the same wrong `created_at`; `acceptPlan` and `plans.expire` judge with the database clock. A serve ahead by delta gives delta extra lifetime in database time (a 15 minute critical plan lives a day at +1 day); behind, it expires early. The same pattern holds for the enrollment-token reveal window. `stateOf` compares serve's `Date.now()` with a heartbeat written by `clock_timestamp()` (`nodes/up.sql:620`), so a skewed serve flaps all nodes. The worker's lease belief uses `Date.now()` (`driver.ts:96-110`). `self-observability.md:91` lists a skew check; `:107` says it is not built.
- **Evidence:** `C/keys-certs-time.md` §3.
- **Root cause:** plan and token times are computed in the application and hashed into the plan body, but judged in database time.
- **Proposed fix:** read the database time before hashing, or refuse creation when the process clock differs from the database by more than a bound; use `performance.now()` for lease belief; add the skew check with a readiness warning above 5 s.
- **Acceptance test:** with a fake clock +1 day, creating a plan fails with a named error (or the stored `expires_at - clock_timestamp()` is at most the class limit); a stepped wall clock does not change the lease-abort decision.

### [P2] Documented retention classes have no pruning code, and every drift check rewrites every open finding
- **Area:** `02-control-plane/data-retention.md`, `packages/operations`, `packages/diagnostics/src/{drift,findings,snapshots}.ts`, `packages/auth/src/sessions.ts`, `worker-tasks.ts`
- **Block:** C
- **Reproduction:** static (`C/graceful-life.md` step 8): after a week count rows and `min(created_at)` of `operations.operations/plans/plan_bodies/operation_events`, `auth.sessions`, `stepup.step_ups`, `nodes.enrollment_tokens`, `observation.drift_checks/schema_snapshots` and resolved `observation.findings`; import a 14k-object schema, run 10 drift checks, compare `n_tup_upd` and WAL of `observation.findings`.
- **Expected:** `data-retention.md` §1: plans 90 d, no-effect operations 400 d, event detail 90 d, resolved findings 400 d, drift documents 90 d, sessions expiry + 30 d; "nothing grows without a rule".
- **Actual (by code):** the only deletions are auth challenges and rate limits, OAuth state, idempotency keys, process heartbeats, health and statement partitions and the manual audit prune (`rg "DELETE FROM|drop_expired"`). Plans, bodies, operations, events, approvals, step-ups, tokens, sessions, snapshots, drift checks and resolved findings are never deleted. `upsertFinding` does `ON CONFLICT DO UPDATE SET occurrences = occurrences + 1, last_seen_at = ...` for every open finding on every drift check (`findings.ts:143`; indexed column, so no HOT update): the first campaign's live target had 13,968 open findings, about 1.3 M updates a day for a prod target at the 15 minute cadence (`drift.ts:725`).
- **Evidence:** `C/graceful-life.md` §5.
- **Root cause:** the table was written as design; only the Wave 2-4 classes got tasks.
- **Proposed fix:** a `retention.prune` task per class with the documented bounds and audited summaries; update an open finding at most once a day or on state change.
- **Acceptance test:** per-class tests that old rows go and referenced rows stay; 1,000 open findings produce at most 1 write per finding per day.

### [P2] The audit gate is invisible to probes: a missing audit partition fails every mutation with a plain 500 while /healthz/ready stays ready
- **Area:** `packages/audit/src/writer.ts`, `apps/server/src/composition/role.ts`, worker task `audit.partitions`
- **Block:** C
- **Reproduction:** static (`C/fail-closed.md` step 1): detach the current monthly partition of `audit.audit_events`; call any mutation; read `/healthz/ready`, `/installation/health`, the log.
- **Expected:** mutations stop (they do) and the operator is told: a readiness reason such as `audit_unwritable` and a named error.
- **Actual (by code):** the append is in the mutation's transaction (`writer.ts:57-134`), so the gate works. No readiness check appends or inspects partitions; `AuditWriteError` is outside the catalog and becomes 500 INTERNAL; heartbeats, samples, drift checks and sessions keep writing. Partitions run 3 months ahead from a 6 h worker task (`lock_timeout 5s`), so it needs a long worker outage or a Control Store restored from an older dump into a later month.
- **Evidence:** `C/fail-closed.md` §1, §2 row "Audit append impossible".
- **Root cause:** audit health comes from export and verification outcomes, not appendability.
- **Proposed fix:** a readiness check requiring partitions for now and now + 7 d (warn under 30 days of margin); map `audit_append_failed` to `CONTROL_PLANE_DEGRADED` with reason `audit_unavailable`.
- **Acceptance test:** detaching the current partition makes readiness degraded or not_ready within one interval and a mutation returns 503 with the reason.

### [P2] Bundle ingest is an unaudited, unthrottled, permanent write
- **Area:** `packages/application/src/migrations.ts:93-113`, `packages/migrations-engine/src/store.ts`, `packages/contracts/src/actions.ts:720-725`
- **Block:** C
- **Reproduction:** static (`C/fail-closed.md` step 6): with a `migrations.plan` token ingest 50 distinct 600 KB bundles; compare `max(seq)` of `audit.audit_events` before and after; repeat 100 times; try to delete rows.
- **Expected:** every mutation audited and stopped when audit fails; permanent data has a bound.
- **Actual (by code):** `ingest` runs `ingestBundles` with no `appendAuditEvent`; class `record`, permission `migrations.plan`; revisions are immutable by trigger and cannot be removed; 32 MiB per request; `/api/v1` has no rate limit; the "never planned: 90 days" rule of `data-retention.md` cannot be enforced. A holder can fill the Control Store, which then fails every write. This contradicts the invariant "if audit cannot be written, mutations stop".
- **Evidence:** `C/fail-closed.md` §1.1.
- **Root cause:** ingest treated as a draft store outside the audit gate.
- **Proposed fix:** append `migration.bundle.ingested` (ids, checksums, bytes) in the same transaction; a per-identity quota and a general REST rate limit; allow pruning never-planned revisions.
- **Acceptance test:** ingest writes an audit event; an audit failure rolls back the ingest; the 51st request in a window gets `RATE_LIMITED`.

### [P2] A redeploy interrupts a running apply although upgrades.md says workers stop at step boundaries; Docker's default stop time is shorter than the 25 s timeout
- **Area:** `apps/server/src/composition/operations-loop.ts:74-82`, `roles/run-role.ts:101-108`, `12-operations/{upgrades,deployment}.md`
- **Block:** C
- **Reproduction:** static (`C/graceful-life.md` step 2; to be confirmed on the stack): run a 90 s `pg_sleep` migration (transactional and non-transactional); `docker stop --time 60 worker` after 10 s, then with the default 10 s; record exit code, `process.stopped{ok}`, the heartbeat row, the target session, the ledger and the operation events after restart.
- **Expected:** `upgrades.md:24-26` "workers stop at step boundaries and reconcile on start"; a documented way to redeploy without cutting an apply.
- **Actual (by code):** `stop()` sets a flag and awaits the whole `drive()`; the abort signal exists only for a lost lease (`driver.ts:85-117`); an execute step is not interruptible. After 25 s the process exits 1 mid-execute (earlier under Docker's 10 s default, which no deploy file or runbook changes). The target session dies (a transactional bundle rolls back; a non-transactional one gives `MIGRATION_INCOMPLETE`); reconcile happens after the 30 s lease. `services.stop()` is skipped so the heartbeat is not marked stopped. No runbook step says to wait until nothing is `running` or `verifying`.
- **Evidence:** `C/graceful-life.md` §1. **Measured by S3 on the new release** (`C/upgrade/scripts/80-sigterm.sh`): with Docker's default stop time the worker was killed at 11.3 s, with `--time 60` it exited 1 at 26.2 s; both times the apply was lost, the operation ended `failed/not_applied` 19 to 26 s after restart (via `needs_reconciliation`), no half-apply for a transactional bundle, the heartbeat row kept `stopped_at IS NULL`, and the target session kept running after the worker died. S1 saw the same (`B/failure/RESULTS.md`). Non-transactional variant: NOT RUN (the plan is denied by lint).
- **Root cause:** graceful stop waits instead of draining; the document describes an intent.
- **Proposed fix:** on SIGTERM stop claiming, let the running step finish within a drain window while `not_ready`, set the stop grace period in the deployment record, add a drain step to `upgrades.md`.
- **Acceptance test:** SIGTERM during a 60 s apply with a 120 s drain window ends `succeeded` with exit code 0; with a 5 s window the operation reaches a reconciled state and the heartbeat row is marked stopped.

### [P3] Master-key rotation has no role order, and the wrong order takes serve out of service
- **Area:** `08-auth-and-security/secrets.md` §3, `12-operations/deployment.md` §2, `composition/{role,commands}.ts`
- **Block:** C
- **Reproduction:** static (`C/keys-certs-time.md` step 2): restart the worker with the new keyring first, wait 11 minutes, then check serve readiness and a TOTP login.
- **Expected:** a runbook that cannot be followed in a damaging order.
- **Actual (by code):** `keyring add-key` makes the new key active; the worker's `secrets.rewrap` (every 10 minutes, `worker-tasks.ts:226`) re-wraps as soon as the worker has the key; a serve on the old keyring fails readiness `keyring_missing_key` (critical) and `secret_key_unavailable` on `auth` secrets. No document gives the order or says the keyring has no age or expiry.
- **Evidence:** `C/keys-certs-time.md` §1.
- **Root cause:** rotation steps stop at the key file.
- **Proposed fix:** document the order (all roles hold both keys and are ready before the rewrap); make the rewrap wait until every live process reports the new key id.
- **Acceptance test:** a stack test of the rotation in the wrong order asserts the documented recovery.

### [P3] A data read runs on the target before its audit event is written
- **Area:** `packages/application/src/queries.ts:249-256,333-345`
- **Block:** C
- **Reproduction:** static (`C/fail-closed.md` step 7): make the append fail, run a query with a marker, read `pg_stat_statements` on the target.
- **Expected:** for customer data the audit precedes the read, or the read is refused while the append is impossible.
- **Actual:** `#audit` is written after the result exists; when it fails the caller gets 500 but the statement ran (in a read-only transaction), and that read has no audit trail.
- **Evidence:** `C/fail-closed.md` §1.1.
- **Root cause:** the event carries the outcome (rows, bytes).
- **Proposed fix:** write a `requested` event first and a `completed` event after (both phases exist).
- **Acceptance test:** with the append failing, the read is not executed on the target.

### [P3] The maintenance loop has no per-task deadline and tasks cannot renew their lease
- **Area:** `apps/server/src/composition/worker-tasks.ts:338-370`, `packages/control-store/src/maintenance.ts:30-76`
- **Block:** C
- **Reproduction:** static: hang `health.sample` on a blackholed target, or run `audit.verify_full` over a large chain with two workers.
- **Expected:** a slow task does not stop plan expiry, checkpoints or node binding; a long task keeps its lease or is bounded.
- **Actual (by code):** a serial loop, `await task.run(ctx)`, a 300 s lease that is never renewed: a hung task blocks the others on that worker; with a second worker a task over 300 s runs twice. The only signal is `tasks_overdue` after 15 minutes in authenticated installation health.
- **Evidence:** `C/graceful-life.md` §5.
- **Root cause:** designed for short tasks.
- **Proposed fix:** a per-task deadline, lease renewal and a longest-running-task metric.
- **Acceptance test:** a task that never resolves is abandoned at its deadline and the next task runs.

### [P3] An oversized JSON request body is refused without naming the limit
- **Area:** `apps/server/src/interfaces/http/api.ts:2124-2145`, `request.ts:196-214`
- **Block:** C
- **Reproduction:** `C/graceful-life.md` step 7: send 100 MB and 100 KB JSON bodies.
- **Expected:** the detail names the limit as raw bodies do (`/body`, `too_large`, "At most N bytes.").
- **Actual:** `readBody` throws a bare `VALIDATION_FAILED`; the problem shows `{path: '', code: 'invalid', message: 'The request is not valid.'}`.
- **Evidence:** `C/graceful-life.md` §3.
- **Root cause:** two body readers written separately.
- **Proposed fix:** the same detail in `readBody`.
- **Acceptance test:** a 100 KB body to a 64 KiB route returns `errors[0] = {path: '/body', code: 'too_large'}`.

# C1 / observability: what an operator can see at 3 a.m.

Block C, static part (tester C1). Tree `T` = `/home/david/Development/ExponetDB-verify` at `d51da5d0`.
Everything below is **STATIC** (read from code and documents, no server was run) unless it says
"ran". Paths are relative to `T`. Findings are referenced as **C1-n** and written out in
`../F/findings-C1.md` (or in the lead's copy of the final message).

## 1. What ships: metrics, logs, probes

### 1.1 Metrics (Prometheus text, one registry per process, `GET /metrics` on the role's internal listener)

Internal listener: `EXPONETDB_INTERNAL_LISTEN`, default `127.0.0.1:9464` (`apps/server/src/roles/run-role.ts:79-82`,
`apps/server/src/interfaces/http/app.ts:222-240`). It is unauthenticated, so a scraper outside the container
needs `0.0.0.0` plus a network rule; the Docker `HEALTHCHECK` uses the same listener
(`Dockerfile:38-39`, `apps/server/src/commands/index.ts:449-462`). Every role has its **own** registry
(`runtime.ts:40-47`): a scrape of `serve` never shows worker or gateway metrics.

Complete list of registered metrics (grep `registry.counter|gauge|histogram` over `apps` and `packages`, excluding tests):

| Metric | Type | Labels (closed set or capped pattern) | Role | Source |
|---|---|---|---|---|
| `exdb_build_info` | gauge | `role` | all | `composition/runtime.ts:43` |
| `exdb_http_requests_total` | counter | `route`, `method`, `status_class` | serve, worker, gateway | `interfaces/http/app.ts:52` |
| `exdb_http_request_duration_seconds` | histogram | `route`, `method` | same | `app.ts:57` |
| `exdb_control_store_query_duration_seconds` | histogram | `role`, `query_class`, `outcome` (`ok`/`error`/`timeout`) | all | `packages/control-store/src/store.ts:83` |
| `exdb_mcp_requests_total` | counter | `era`, `status_class` | serve | `interfaces/mcp/edge.ts:112` |
| `exdb_mcp_tool_calls_total` | counter | `tool`, `outcome` (`ok`, `input_required` or an error code), `era` | serve | `edge.ts:116` |
| `exdb_mcp_tool_call_duration_seconds` | histogram | `tool` | serve | `edge.ts:126` |
| `exdb_mcp_denied_total` | counter | `reason` (closed set `MCP_DENIALS`) | serve | `edge.ts:131` |
| `exdb_audit_chain_verified` | gauge | `scope` (`incremental`, `full`) | worker | `composition/worker-tasks.ts:135` |
| `exdb_maintenance_task_runs_total` | counter | `task` (all 24 task names), `outcome` (`succeeded`/`failed`/`skipped`) | worker | `worker-tasks.ts:327` |
| `exdb_operations_loop_total` | counter | `outcome` (`idle`, `waiting`, `lease_lost`, `done`, `error`) | worker | `composition/operations-loop.ts:25` |

**Documented in `10-observability/self-observability.md` §3 but not shipped:** `exdb_operations_total`,
`exdb_operation_step_duration_seconds`, `exdb_policy_decisions_total`, `exdb_sampler_lag_seconds`,
`exdb_sample_failures_total`, `exdb_agent_connected`, `exdb_agent_job_duration_seconds`, `exdb_lock_wait_seconds`.
The document §7 says "the other metrics come with the waves that build their subjects"; waves 4, 5, 6, 9 are built and
none of them registered one. Nothing in the metrics can say how many targets are unreachable, how many nodes are offline,
when a certificate expires, how old the last backup is, how many operations wait for approval or for a lock.

Three properties that limit alerting even on what exists:

* **C1-4** `route` is a label of the request counter, but `base()` records `routes.includes(c.req.path) ? c.req.path : '/unmatched'`
  (`app.ts:107-110`) and the list holds only `/healthz/*`, `/mcp`, the two schema URLs and the OpenAPI path (`app.ts:176-181`).
  Every `/api/v1/*`, `/auth/*`, `/oauth/*` and Web App request is `route="/unmatched"`. The test pins it
  (`apps/server/test/http.test.ts:91`). Only a whole-process 5xx ratio and one blended latency histogram can be built.
* `exdb_audit_chain_verified` is set when a verification **runs** (hourly and daily); after every worker restart the series is
  absent for up to 24 h (`scope="full"`), so `== 0` alerts do not fire and `absent()` alerts fire falsely.
* Counters reset with the process, there is no restart counter, and `exdb_build_info` is the only per-process gauge:
  a crash loop shows as resets of `exdb_operations_loop_total` and nothing else.

### 1.2 Log events (structured JSON, field allowlist `packages/observability/src/logger.ts:76-146`)

Complete list of event names found with `rg -U "(logger|log)\??\.(info|warn|error)\(\s*'…'"` outside tests (60 names). The ones
that matter for the ten failures: `process.starting|started|stopping|stopped|forced_exit|start_refused`, `heartbeat.failed`,
`control_store.pool_error`, `startup.control_store_unreachable|unreadable`, `http.request_failed`, `maintenance.task_failed`,
`maintenance.loop_failed`, `operations.step_threw`, `operations.loop_failed`, `audit.checkpoint_export_failed`,
`audit.chain_verification_failed`, `secrets.rewrap_unreadable`, `health.sample_failed`, `drift.check_failed`,
`registry.credential_verification_failed`, `nodes.bind.undecided`, `gateway.identity.renew_failed`,
`gateway.agent_listener.failed`, `gateway.pki_missing`, `agent.refused`, `agent.tls_refused`.

The allowlist has `operationId`, `planId`, `jobId`, `targetId`, `clusterId`, `nodeId`, `tokenId`, `processId`, `secretId`,
`auditId`, `migrationId`, `keyId`, `seq`, `count`, `task`, `check`, `reason`, `code`, `state`, `outcome`. It has **no**
`backupId`, `restoreId`, `drillId`, `approvalId`, `findingId`, `certificateId`. A log line about a backup, restore or drill
can name only the operation, cluster or node.

There is **no** log line for: an operation changing state (`operation.step.finished` of the document does not exist), a
target changing health state, a node going offline, a plan expiring, a request being refused with 4xx (apart from the
concealed-denial line), a successful REST request (no access log). Success and 4xx traffic is visible only as counters.

### 1.3 Probes: do `/healthz/*` tell the truth?

| Probe | Where | What it checks | Verdict |
|---|---|---|---|
| `GET /healthz/live` | public (serve) and internal | the event loop answers (`app.ts:123`) | truthful and minimal |
| `GET /healthz/ready` | public (serve), internal (every role) | the **cached** report of the last evaluation, re-evaluated every 5 s (`role.ts:250`); critical checks `control_store` (`SELECT 1`, 3 s), `role_credential`, `installation`, `schema`, `keyring`, `heartbeat` (a write in the last 45 s); degrading checks serve `workers`, `role_catalog`, `scope_catalog`; worker `audit_export`, `audit_chain`, `maintenance`; gateway `agent_listener` (critical) | see below |
| `GET /healthz/detail` | internal only | the same report with check names and reasons (`app.ts:227-234`) | the only place a reason is visible without authentication |
| `GET /installation/health` | authenticated, `nodes.read` | components `control_store`, `workers`, `maintenance`, `samplers`, `data_reads`, `gateway`, `keyring`, `audit_chain`; `unobserved` list (`packages/application/src/installation-health.ts:317-355`) | the richest, but pull-only and behind a session |

What the readiness verdict hides (all STATIC):

1. **`degraded` is HTTP 200** (`health.ts:205-207`: 503 only for `not_ready`). Docker, Traefik and every uptime monitor see
   green for: no live worker (`role.ts:271-279`, `warn('no_live_worker')`), audit export failing/lagging/unconfigured,
   audit chain unverified, three consecutive maintenance task failures. The body says `{"status":"degraded"}` and nothing more
   (`health.ts:200-202`). This is by design (`health.md` §8) but means an alert needs the internal `/healthz/detail` or the metric
   `exdb_maintenance_task_runs_total`.
2. **`control_store` is `SELECT 1`** (`role.ts:88-93`). A read-only or full Control Store passes it. What catches the write failure is
   the `heartbeat` check: `UPDATE control.process_heartbeats` fails (`heartbeat.failed` warn), `lastBeat` ages, 45 s later the check
   fails (`heartbeat_stale`, critical) and the next 5 s evaluation makes the role `not_ready`. Then Docker needs three failed
   `HEALTHCHECK`s (15 s interval, 3 retries, `Dockerfile:38`) before it marks the container unhealthy. Worst case from the first
   failed write to "unhealthy": about 45 + 5 + 45 s = 95 s. `serve` then leaves Traefik's rotation, so **reads stop too** (see
   `fail-closed.md` §3).
3. **No check proves that audit can be appended.** Every mutation appends in its own transaction (`packages/audit/src/writer.ts:57-134`);
   a missing monthly partition (`audit.ensure_partitions`, 3 months ahead, run every 6 h by the worker task `audit.partitions`,
   `worker-tasks.ts:176-182`) makes every audited mutation fail with `AuditWriteError('audit_append_failed')` (answered as 500
   `INTERNAL`, `request.ts:152-162`) while all probes stay green and heartbeats, samples and drift checks keep writing. C1-10.
4. **A dead process is "live" for 45 s.** `liveProcesses` counts rows with `stopped_at IS NULL AND heartbeat_at > now() - 45 s`
   (`packages/control-store/src/heartbeats.ts:63-85`). `markStopped` runs only on a clean stop, and the SIGTERM path of a busy
   worker skips it (`run-role.ts:101-108`, see `graceful-life.md` §1). A worker that is OOM-killed or crash-looping with a period under
   45 s keeps `installation/health.workers = operational` and serve's `workers` check at `pass`. C1-2.
5. **Per-node outage is averaged away.** `gateway` is `degraded` only when **no** agent is connected, `operational` when 1 of 10
   is offline (`installation-health.ts:262-266`, counts in `values`, not in the state).

## 2. The ten failures

Legend. **Signal** = what exists today. **Ids** = does it carry what an operator needs to act (object id, time). **Alert** = can one be built
from the shipped metrics endpoint alone (M), from the authenticated API by polling (API), from a log line (LOG), or not at all (NONE).

| # | Failure | Signal today | Ids | Alert |
|---|---|---|---|---|
| 1 | **Node offline** | `GET /nodes`, `GET /nodes/{id}` state `offline`, derived at read time: active/degraded and last heartbeat older than 4 × 15 s (`packages/nodes/src/views.ts:11,58-71`); `target_health` shows `unreachable` for its clusters; `installation/health.gateway.values.connectedNodes` (`history.ts:agentConnections`). No log line, no audit event, no metric, no finding. | node id in the API view; `lastHeartbeatAt` yes; the **reason** no: expired certificate, stopped service, network all read `offline` | API only (poll `GET /nodes`). The derived state uses the **process** clock against a DB-written heartbeat time (`views.ts:58-71` vs SQL `clock_timestamp()` in `nodes/up.sql:620`): a skewed serve host flaps every node. NONE for metrics. |
| 2 | **Certificate near expiry** (node cert 72 h, renewed by the agent at two thirds) | `exponetdb-node status` on the host prints remaining life or `EXPIRED … ago` (TC-042 fix, R2 verdict). `GET /nodes/certificates` (REST, `packages/nodes/src/history.ts:191-247`) lists CA and per-node `certificateExpiresAt` for nodes in `pending_binding|active|degraded`. Documented `certificate_expiring` degraded state and finding (`07-node-agent/enrollment.md:145-146`) **does not exist** in code (grep: no hit in `packages`, `apps`, `agent`); `node-runbook.md:233-237` says "not built (OD-62)". The gateway's own certificate (72 h, minted in memory) is recorded nowhere (`health.md:298-300`). Agent-side `certificate renewed` log on the host only. | node id and expiry in the API; nothing for the gateway cert; CA expiry (root 10 y, CAs 5 y, `pki.ts:92-110`) only in the same list | API poll of `/nodes/certificates` (`certificateExpiresAt - now < 24 h`) is the only possible alert. Because the agent renews at 48 h and retries every loop turn, a node whose renewal fails shows nothing until it has been silent for 72 h and then reads `offline`. C1-6. |
| 3 | **Worker crash loop** | container restart count (Docker/Coolify, outside ExponetDB); log `process.starting` / `process.start_refused{reason}` per attempt; `control.process_heartbeats` gets one row per start; `installation/health.workers` says `operational` while a row beats within 45 s (see 1.3 item 4). | `processId` in the log line and the heartbeat row; `reason` code on a refused start | LOG (`process.starting` rate). Metrics cannot see it (no restart counter, per-process registry). C1-2. |
| 4 | **Audit sink / export down** (S3 or the local audit volume) | worker task `audit.export` (5 min) and `audit.checkpoint` (1 h) fail: log `audit.checkpoint_export_failed{seq,count}`; metric `exdb_maintenance_task_runs_total{task="audit.export",outcome="failed"}`; worker readiness `degraded` (`audit_export_failing`, `worker-tasks.ts:404-415`); `installation/health.audit_chain.reasons` `export_failing`/`export_lagging`/`checkpoint_stale`. The exporter drops the cause: `catch { return {exported, failed: seq} }` (`packages/audit/src/checkpoints.ts:96-100`), so the log has no HTTP status or errno. Mutations are **not** blocked (`checkpoints.ts:12-14`: "export failures never block audit writes"); only retention is blocked. | `seq` of the first failing checkpoint; no sink name, no cause | M: `increase(exdb_maintenance_task_runs_total{task="audit.export",outcome="failed"}[15m]) > 0` works; LOG works. `export_unconfigured` is a `skipped` outcome, not a failure, and readiness `degraded` only. |
| 5 | **Control Store read-only or full** | writes fail with SQLSTATE `25006` / `53100` / `53200`, which `toControlStoreError` maps to `control_store_query_failed` (`packages/control-store/src/errors.ts:80-120`, only `08*`, `57P01-03`, `53300` map to `unavailable`); REST answers **500 INTERNAL** (the code is outside the catalog, `request.ts:152-162`), log `http.request_failed{errorName,code,causeCode=25006|53100,route}` (`api.ts:2358-2365`) and `heartbeat.failed{code}`; role goes `not_ready` after ~50 s (1.3 item 2); `exdb_control_store_query_duration_seconds{outcome="error"}`; `exdb_http_requests_total{status_class="5xx"}`. | `requestId`, route template, SQLSTATE; no table or disk name | M: 5xx ratio of `exdb_http_requests_total`, `outcome="error"` of the store histogram, and the container health state. No metric separates "full" from "unreachable". C1-3. |
| 6 | **Target unreachable** | `target_health` state `unreachable` with `source`/`observedAt`/reasons (`health.md` §1-3, `diagnostics/src/health.ts`); `GET /fleet` counts by state; log `health.sample_failed` (worker). No finding is opened for a state, no audit/log line for the transition, no metric of target states. `identity_mismatch` and `plaintext_connections` do open findings. | `targetId` in the API; `health.sample_failed` carries `targetId` when the sample row cannot be written | API poll of `GET /fleet` or `GET /targets/{id}/health` only. NONE for metrics. A transition history exists as `observation.health_samples` (14 days). |
| 7 | **Ledger divergence** | `LEDGER_DIVERGENCE` is raised when someone **plans** (`packages/migrations-engine/src/divergence.ts`, `planner.ts`); `migrations.ledger_state.divergent` is "information, not a gate" (`ledger.md` §5). The documented periodic reconciliation and finding do not exist (E1 `DC-037`, `F/findings-E1.md` "Ledger divergence is not monitored"). | `migrationId`s in the refusal details; the CLI hides most of them (`F/findings-E1.md`, CLI details) | NONE until a plan is attempted. |
| 8 | **Backup failed** (a run started by ExponetDB, or by the host's own timers) | for an ExponetDB run: operation `failed` / run record `failed` (`backups.runs.state`), audit `backup.*`, `exdb_operations_loop_total` (no kind label); for a **host timer** run: nothing until someone refreshes the catalog (`backup.catalog.refresh` is an operation started by hand; "ExponetDB starts no scheduled run in this wave", `packages/backups/src/plans.ts:308`; `adoption.md:69` "[PLANNED] a scheduled refresh"). After 30 min without a refresh the protection state reads `catalog_stale` / `at_risk` (`protection.ts:13`, `computeProtection`), which is a read-time computation: no finding, no event, no metric. | operation id, cluster id; no backup id in logs or audit refs (`audit.ts:79-96`) | API poll of `GET /clusters/{id}/backups` (`backup.overview`) state; NONE for metrics. The docs say the policy hooks read a refresh younger than 10 minutes (`architecture.md:123`): with nobody refreshing, hooks see "no backup" after 10 min. C1-5. |
| 9 | **Restore drill failed** | drill record `outcome=failed`, restore state `failed`/`needs_attention`, operation state; `restore.drill` audit. The finding generator `maintainDrillFindings` (`packages/backups/src/findings.ts:93`) that would open `backup_drill_failed` (critical), `backup_drill_overdue`, `backup_drill_never_run`, `restore_scratch_left` is called **only from a test** (`apps/server/test/http-backups.int.test.ts:368`); no worker task runs it (`worker-tasks.ts:176-314`). The read model computes `drill_never` at read time only (`C/live-mcp-reads.md` of campaign 1 shows `reasons: drill_never`). | operation id, cluster id; drill id only in the API | API poll of `GET /clusters/{id}/drills`; NONE for findings and metrics. C1-5. |
| 10 | **Plan or approval stuck** | `awaiting_approval` has no deadline (E1 SM-3, `F/findings-B1.md`); visible in `GET /approvals`, `GET /fleet` (operations part: newest 500, `lowerBound`), Web App badge. A `queued` operation waiting for a lock: operation events `locks_waiting{domain,blockingOperationId}` (`packages/operations/src/locks.ts:90-100`) and `exdb_operations_loop_total{outcome="waiting"}`; **no** age. A plan that expired is marked by the worker every minute (`plans.expire`), audit `plan.expired`. | operation id, blocking operation id in `operation show` | M: `rate(exdb_operations_loop_total{outcome="waiting"}[5m]) > 0` for a long time is the only metric signal, and it cannot tell one stuck operation from healthy lock contention; API poll of the operation list for age. C1-1. |

### 2.1 Alert feasibility summary

| Buildable from the shipped `/metrics` | Not buildable from it |
|---|---|
| process 5xx ratio and latency (blended, C1-4); Control Store statement errors/timeouts by query class; MCP denials and tool errors; worker maintenance task failures by task name (audit export, chain verification, rewrap, partitions); `exdb_audit_chain_verified == 0`; operations loop `error`/`lease_lost`/`waiting`; process restarts only indirectly | node offline; certificate expiry; target unreachable; ledger divergence; backup age, failed backup, failed drill; operations waiting for approval; operation age; worker liveness; sampler lag; crash loop; disk or connection pressure of the Control Store; audit append failure specifically |

## 3. STACK STEPS (a later agent runs these on a disposable stack; `S` = serve internal `127.0.0.1:9464`, `W` = worker internal, `G` = gateway internal)

Read every result against the "expected" column; paste only the matching lines into the evidence.

1. **Metrics inventory.** `curl -s http://$S/metrics | grep '^# TYPE'`, same for `$W`, `$G`. Expected: exactly the table of 1.1 (serve: build_info, http_*, control_store_*, mcp_*; worker: build_info, http_*, control_store_*, audit_chain_verified after the first run, maintenance_task_runs_total, operations_loop_total; gateway: build_info, http_*, control_store_*). Any metric outside the list, or a missing one, corrects this file.
2. **`/unmatched` (C1-4).** With a valid token call `GET /api/v1/targets`, `GET /api/v1/fleet`, `GET /api/v1/nodes` ten times each; `curl -s http://$S/metrics | grep exdb_http_requests_total`. Expected: one series `route="/unmatched",method="GET",status_class="2xx"` with 30, no `/api/v1/targets` series.
3. **Readiness hides degraded.** Stop the worker (`docker stop worker`); after 50 s `curl -s -o /dev/null -w '%{http_code}\n' http://$S/healthz/ready` and `curl -s http://$S/healthz/detail`. Expected: `200`, detail shows `workers` check `warn` reason `no_live_worker`; `docker inspect --format '{{.State.Health.Status}}' serve` stays `healthy`.
4. **Control Store read-only (C1-3).** `psql -c "ALTER DATABASE exponetdb_control SET default_transaction_read_only = on"` then `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='exponetdb_control' AND pid<>pg_backend_pid()` (pools reconnect with the new default). Then: (a) `curl -i -X POST -H 'authorization: Bearer …' …/api/v1/…` for any mutating call, expected status `500` and `code INTERNAL` in the problem body, not 503; (b) `docker logs serve | grep http.request_failed` expected `causeCode:"25006"`; (c) log `heartbeat.failed` at 15 s steps; (d) time from the first failure to `curl $S/healthz/ready` = 503 (expected ≈ 45-50 s), and to `docker inspect … Health.Status = unhealthy` (expected ≈ +45 s); (e) a read `GET /api/v1/targets` while still `healthy`: expected 200 with data. Undo with `ALTER DATABASE … RESET default_transaction_read_only`.
5. **Disk full.** On a tmpfs-backed tablespace or by `fallocate` filling the data volume until `53100` appears, repeat 4 (a)-(c); expected `causeCode:"53100"`, 500 INTERNAL, `exdb_control_store_query_duration_seconds_count{outcome="error"}` rising.
6. **Audit export down (4).** Point `EXPONETDB_AUDIT_S3_ENDPOINT` at a stopped container (or `chmod 000` the file sink), restart the worker. Wait 6 min. Expected: log `audit.checkpoint_export_failed`, `curl $W/healthz/detail` shows `audit_export` `warn audit_export_failing`, `curl $W/metrics | grep 'task="audit.export",outcome="failed"'` ≥ 1, `GET /installation/health` `audit_chain.reasons` contains `export_failing`; **and** a mutation (`plan apply` of a trivial plan, or `exponetdb ...` role binding) still succeeds. Record whether the log line contains any cause.
7. **Audit append failure (C1-10).** As the `exdb_audit_maint`/owner role: `ALTER TABLE audit.audit_events DETACH PARTITION audit.audit_events_yYYYYmMM` for the current month (disposable stack only), then try any mutation. Expected: 500 INTERNAL, log `errorName=AuditWriteError`, **and** `/healthz/ready` still `ready`, heartbeats and health samples still written. Re-attach after.
8. **Worker crash loop (C1-2).** `while true; do docker kill -s KILL worker; sleep 20; docker start worker; sleep 5; done` for 3 minutes (kill period < 45 s). Poll every 10 s `GET /installation/health` and `curl $S/healthz/detail`. Expected: `workers` stays `operational` (liveWorkers ≥ 1) for the whole loop; count `SELECT count(*) FROM control.process_heartbeats WHERE role='worker' AND stopped_at IS NULL AND heartbeat_at > now() - interval '45 s'`.
9. **Node offline and certificate.** On the host stage: `systemctl stop exponetdb-node`; after 61 s `GET /api/v1/nodes/{id}` expect state `offline` with `lastHeartbeatAt`; `GET /api/v1/nodes/certificates` expect the node row with `certificateExpiresAt`; `GET /installation/health` expect `gateway` still `operational` when a second node is connected (C1-6). Then set the node host clock +80 h (`timedatectl set-ntp false; date -s '+80 hours'` on the **host**, node stopped), start the agent: expect `403 NODE_CERTIFICATE_REFUSED` in the agent log and the same refusal text for a revoked node; `exponetdb-node status` prints `EXPIRED`. Check `grep -rn certificate_expiring` finds nothing in `GET /findings`.
10. **Target unreachable (6).** `iptables -A OUTPUT -d <target ip> -p tcp --dport 5432 -j DROP` on the worker host; wait 30 s; `GET /api/v1/targets/{id}/health` expect `unreachable`, `source`, `observedAt`; `GET /api/v1/findings` expect **no** new finding for the transition; `docker logs worker | grep health.sample_failed` expected only if the sample row cannot be written; metric: none. Remove the rule.
11. **Ledger divergence (7).** `INSERT INTO exponetdb.schema_migrations …` by hand on a staging target (copy a row with a new id); wait 15 min; `GET /findings`, `target show`: expect nothing; then `migration plan`: expect `LEDGER_DIVERGENCE` and read which details the CLI prints.
12. **Backup failed on a host timer (8).** On the node host make the pgBackRest backup command fail (wrong repository permission) and let the host timer run; do **not** refresh. After 30 min `GET /clusters/{id}/backups`: expect `catalog_stale`/`at_risk`, not `failed`; then run `exponetdb backup refresh <cluster>` and watch whether the failed host run appears with an id.
13. **Drill findings (9).** Run a restore drill that fails (corrupt the repository's newest backup), wait 15 min, `GET /api/v1/findings?state=all` and `GET /clusters/{id}/findings`: expect no `backup_drill_failed` (C1-5); then call the helper from a Bun REPL in the worker container (`maintainDrillFindings(tx, Date.now())` inside `store.transaction`) to prove the generator works when called.
14. **Plan/approval stuck (10).** Apply a production plan that needs approval and leave it 5 h: `operation show` still `awaiting_approval`, `GET /fleet` operations part counts it, no event. Then block the target schema domain (park an operation in `needs_attention`) and queue two plans on two **different** targets; expect (C1-1) both stay `queued`, `exdb_operations_loop_total{outcome="waiting"}` rises by ~0.5/s, and `SELECT count(*) FROM operations.operation_events WHERE kind IN ('locks_waiting','lease_acquired') AND operation_id = …` grows by about 2 rows every 2 s.
15. **Metric scrape reachability.** From another container on the Coolify network `curl http://serve:9464/metrics` with the default config; expected connection refused (loopback bind). Set `EXPONETDB_INTERNAL_LISTEN=0.0.0.0:9464` and check that `/metrics` and `/healthz/detail` answer with no credential (document as a finding if no network rule is advised in `deployment.md`).

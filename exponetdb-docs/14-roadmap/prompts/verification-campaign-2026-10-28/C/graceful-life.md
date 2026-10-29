# C1 / graceful life: signals, startup, limits, growth

Block C, static part (tester C1). `T` = `/home/david/Development/ExponetDB-verify` at `d51da5d0`. **STATIC** throughout; the
numbers of the growth model are estimates from the code's writes and are marked as such. Findings **C1-n** are in `../F/findings-C1.md`.
New evidence used: `B/conformance/RESULTS.md` and `F/findings-B2.md` (event-loop blocking parse, memory bounded per parse and not
per request, advisory unlock), `F/findings-E1.md`, `F/findings-R2.md`.

## 1. SIGTERM per role

Common code: `apps/server/src/roles/run-role.ts:86-109`, `lifecycle.ts`. Sequence on the first SIGTERM/SIGINT (`lifecycle.ts:83-97`;
a second signal exits 130 at once): `readiness.markStopping()` (the probes answer 503 `stopping`) → public listener `close(timeout/2)` →
role loops stop → `services.stop()` (heartbeat row `stopped_at`, pool close, keyring wipe) → internal listener `close(1 s)`; all inside
`bounded(…, EXPONETDB_SHUTDOWN_TIMEOUT_MS)`, default **25 s** (`env.ts:355`). On timeout the role returns exit code 1 and `main.ts:12-15`
calls `process.exit(code)` 100 ms later. `Dockerfile:37` sets `STOPSIGNAL SIGTERM`. No document or deploy file sets a stop grace period
(`rg stop_grace|stop-timeout` over `exponetdb-docs/12-operations` and `deploy/`: no hit), so Docker's default of **10 s** to `SIGKILL`
is shorter than the 25 s the code waits. C1-12.

| Role | On SIGTERM | In-flight work | Consequence |
|---|---|---|---|
| **serve** | stops accepting; `closeIdleConnections()` at once, `closeAllConnections()` after 12.5 s (`lifecycle.ts:62-77`); pool closed after the listener (`role.ts:253-262`) | a REST request gets ≤ 12.5 s; an MCP stream (up to 90 s) is cut; a transaction in progress rolls back with the pool | clients retry; one `serve` instance only (`deployment.md:54-59`), so a restart is an outage of the Web App, REST and MCP for the start-up time (≈ 5-30 s: gate, heartbeat, first readiness evaluation, Docker `start-period 30s`) |
| **worker** | `data-read` worker unregisters, then `operations.stop()`: sets `stopped`, clears the poll timer and **`await running`** (`composition/operations-loop.ts:74-82`); then `maintenance.stop()`; `services.stop()` | **an operation in `execute` is never asked to stop**: the abort signal exists only for a lost lease (`driver.ts:85-117`), `processNextOperation` has no stop check between steps; the loop waits until the whole `drive` returns (execute + verify) or the 25 s bound passes | after 25 s (or 10 s under Docker's default) the process exits mid-step: transactional bundle → target connection drops → rolled back; non-transactional → partial (`MIGRATION_INCOMPLETE`); the operation stays `running` with a lease that expires after 30 s, a later worker moves it to `needs_reconciliation` and reconciles against the target ledger. Because the timeout fires inside `stopLoops()`, `services.stop()` never runs: the heartbeat row keeps `stopped_at IS NULL` and counts as a live worker for 45 s. `upgrades.md:24-26` ("workers stop at step boundaries and reconcile on start") is therefore not what the code does. C1-12 |
| **gateway** | `listener.close(12.5 s)` (`composition/gateway.ts:111-116`) | agent long polls (≤ 25 s) are cut after 12.5 s; a job dispatched but not yet fetched returns to `pending` after the 60 s start deadline (`ADR-0024 §4`) | agents reconnect with backoff 1–60 s plus jitter (`agent.go:296-326`); no job is lost |
| **node agent** (`exponetdb-node`) | `signal.NotifyContext(SIGINT, SIGTERM)` cancels the run context (`cmd/exponetdb-node/main.go:64`); unit has `TimeoutStopSec=30s`, `Restart=on-failure` (`packaging/systemd/exponetdb-node.service:20-23`) | a capability run gets its context cancelled: before the effect point the outcome is `canceled`, after it `failed` with "stopped on a cancel request after the effect point" (`agent.go:775-790`); the journal on disk records `inFlight`; the next `hello` reports it and the Control Plane judges | no job is repeated: replay state is on disk (`journal init` runbook) |
| **node helper** | its own unit, `TimeoutStopSec=11min` (`exponetdb-node-helper.service:18`) because backup and restore engines run as transient units that systemd stops with SIGTERM then SIGKILL (`ops_backup.go:1090`) | long runs survive an agent restart | fine |

Rolling restart: with a single `serve` and a single `worker` there is none. A Coolify "rolling update" of `serve` starts a second
container only if the application has a health check and the platform setting is on; the image's `HEALTHCHECK` is the **internal**
readiness, so the new container is routed only after its first green evaluation. In-memory MCP rate limits restart at zero
(`rate-limit.ts`, `deployment.md:61-65`). **Nothing in `upgrades.md` or `deployment.md` says "wait until no operation is `running` or
`verifying` before redeploying the worker"**; the safe moment is not visible in the CLI except `operation list --state running`.

## 2. Startup order and readiness

* Gate (`role.ts:204-241`): Control Store unreachable → log `startup.control_store_unreachable`, **keep running**, not ready.
  Wrong or privileged login, installation mismatch, schema `newer` or `mismatch`, keyring `mismatched` → throw `StartupRefused` → log
  `process.start_refused{reason}` → exit 3. Pending/unverified schema → running, not ready (`schema_pending`, `schema_unverified`).
* Upgrade order (E1 DC-048): `control-store migrate` (separate one-shot), then `worker`, `serve`, `gateway`. A role of the old release
  that is still running when the schema moves ahead does **not** stop: `compareSchema` is evaluated at start and every 5 s for
  readiness, so the old role turns `not_ready` (`schema_newer`) but keeps its pool and its loops. The old worker therefore keeps
  claiming operations and maintenance tasks with an old kind registry until it is stopped (STATIC; the readiness check does not stop
  the loops, `role.ts:102-131` vs `operations-loop.ts`). Stack step 6.
* Readiness truth: see `observability.md` §1.3. Summary: cached 5 s, `degraded` is 200, `control_store` is `SELECT 1`.

## 3. Pools, timeouts, limits (every limit and its named error)

| Layer | Limit | Value | What the caller gets | Source |
|---|---|---|---|---|
| Control Store pool | connections per process | 10 (`openStore` default; the library default would be 5) | wait for a connection | `runtime.ts:60-66`, `store.ts:370` |
| | connect timeout, statement timeout, idle-in-transaction | 5 s, 30 s, 60 s | `control_store_unavailable` (pool timeout message), `control_store_timeout` (`57014`, `55P03`, `25P03`) → both **500 INTERNAL** | `store.ts:363-365`, `errors.ts:75-110` |
| | queue of waiters | unbounded | latency until the 5 s timeout | `pg.Pool` defaults |
| Managed clusters | connections per cluster | serve ≤ 3, worker ≤ 5 | `TARGET_UNAVAILABLE`/queueing | `deployment.md:262-264` |
| HTTP listeners (serve, worker/gateway internal) | headers / whole request / keep-alive | 20 s / 120 s / 5 s | socket closed (no named error) | `lifecycle.ts:32-38` |
| | total connections | **no cap** on the public listener (the agent listener has `MAX_CONNECTIONS`, `interfaces/gateway/agent-listener.ts:502`) | file-descriptor exhaustion at the container limit | |
| REST body | default | 64 KiB | `VALIDATION_FAILED` (422). For raw bodies the detail is `{path:/body, code:too_large, message:"At most N bytes."}`; for **JSON bodies the refusal carries no detail** and the problem says "The request is not valid." (`api.ts:2106-2145`, `request.ts:196-214`): the limit is not named | `routes.ts:304` |
| | saved query / avatar / migrations / legacy import | 320 KiB / 256 KiB / 32 MiB / 16 MiB | same | `routes.ts:311,1136,2334,2390,2413,2518` |
| | content-length lie, chunked | counted as the stream arrives (`readLimitedBytes`, `request.ts:215-245`) | same | |
| REST concurrency | legacy-import requests in flight | 2 | `RATE_LIMITED`, `Retry-After: 5` | `api.ts:361-367` |
| REST rate limit | **none** for `/api/v1` apart from login failures and device flow | n/a | n/a | grep `RATE_LIMITED` in `api.ts` |
| Auth failures | per account / identity / IP | delay after 3 / 3 / 20, lock at 10 / 10 / 100 in 15 min, lock 15 min | `RATE_LIMITED` before the credential is checked | `auth/src/ratelimit.ts:36-60` |
| OAuth | device-ip 30 / 10 min, device-idn 10 / 10 min, DCR pending 50 (3 per requester), client metadata 5 KiB | | `RATE_LIMITED`, registration refusals | `oauth/limits.ts:32-33`, `protocol.ts:107-115` |
| MCP request | body 256 KiB (bundle tools 16 MiB, 2 large bodies per grant on the legacy era), JSON depth 32, 50,000 elements | | 413 with `data.maxBytes` | `contracts/src/mcp/protocol.ts:69-92`, `edge.ts:521-563` |
| MCP time | headers 10 s, body 30 s, request 90 s (`504`), tool call 50 s | | 408 / 504 | `protocol.ts:80-91` |
| MCP rate (per grant; identity ×2) | read 20/s burst 100, plan 2/s burst 5, apply 1/s burst 2, data 5/s burst 10 | in process, reset by a restart, multiplied by instances | `rate_limited` denial, `RATE_LIMITED` with `retryAfterSeconds` | `protocol.ts:98-110`, `rate-limit.ts` |
| MCP concurrency | data reads 2 per grant / 3 per target / 8 total, streams 4 per grant | | refused at once | `protocol.ts:113-118` |
| Data read | agent 500 rows, human 5,000, 5 MiB, 60 s; sealed request 1 MiB, result 16 MiB; lane 2 per owner, 3 per target, 8 total | | `QUERY_RESULT_TOO_LARGE`, `RATE_LIMITED`, `QUERY_CANCELED` | `data-read/lane.ts:68-79,401-404` |
| SQL classifier | 64 KiB | | `VALIDATION_FAILED` | `resources.ts:2405` |
| Bundles | 4 MiB per file, 200,000 tokens per parse, 50 bundles per request, 32 MiB body | **per parse, not per request** (B2: 6 dense bundles kill a 259 MiB heap; nested comments block the event loop 38 s at 160 KB; cubic lint over chains) | `too_large`/`MIGRATION_*`, or an OOM exit 134 | `F/findings-B2.md` |
| Node protocol | request 1 MiB, enroll 16 KiB, heartbeat 64 KiB, body within 10 s, claim wait ≤ 25 s, one claim per node | | `RATE_LIMITED` for a second concurrent claim | `node-protocol/messages.ts:51-72`, `gateway.ts:336-340` |
| Process memory | serve and worker 512 MiB, heap 259 MiB (`--liftoff-only`) | | kernel OOM kill, no log line | `deployment.md` §2a |

**MCP sessions.** `/mcp` is stateless (`edge.ts:56`: "answers carry no session id, no cookie"). There is no session table and no per-session
memory, so "1,000 concurrent sessions" is bounded by: Node sockets (no cap), the token-bucket map (one entry per grant × class and per
identity × class: ≈ 8 entries per active grant, swept after 10 idle minutes every 1,000 calls, `rate-limit.ts:62-78`; 1,000 grants ≈ 8,000
tiny entries), the stream limit (4 per grant → up to 4,000 open response streams of ≤ 90 s) and the 512 MiB container. Per-request memory
is bounded only per parse (B2 P1). The expected failure is the file-descriptor limit or CPU on the single event loop, not memory per
session. Not measurable statically: Stack step 4.

**A slow client** is cut by the header (20 s) and request (120 s) deadlines for REST and by 10/30/90 s on `/mcp`; the response side of
a stream is not bounded by the listener (`lifecycle.ts:20-24`), only by the MCP request timeout.

**A 100 MB body**: for every route except bundle/legacy routes, `content-length` above the route limit is refused before reading
(`request.ts:218-222`); chunked bodies are cancelled at the limit; bundle routes accept up to 32 MiB then parse synchronously (B2). The
refusal for JSON routes is the unnamed `VALIDATION_FAILED` above.

## 4. Head-of-line blocking of the operations loop (C1-1)

`processNextOperation` is called once per tick (every 2 s) and `claimNextOperation` selects **the oldest un-leased candidate** (`ORDER BY
created_at, operation_id LIMIT 1 FOR UPDATE SKIP LOCKED`, `leases.ts:52-65`). A `queued` operation whose exclusivity domain is held by
another operation takes the lease, fails to take the locks, writes the events `lease_acquired` (`leases.ts:84-92`) and `locks_waiting`
(`locks.ts:90-100`), releases the lease (`releaseQueuedLease`, `leases.ts:194-206`) and returns `waiting` (`driver.ts:224-230`). At the next
tick it is again the oldest un-leased candidate. Younger queued operations, for other targets and of other kinds, are never reached while the
oldest one waits. Combined with the dead end in E1/B1 (an operation in `needs_attention` holds its domains for ever), **one parked operation
stops all later operations of that worker** (a second worker only helps while the first holds a lease). The same loop writes about 2 event rows
and 2 `operations.operations` updates per 2 s per waiting operation: ≈ 86,400 rows/day, ≈ 31.5 M rows/year, per waiter.

## 5. Retention and growth over a simulated year

Assumptions (estimates, to be replaced by measurement in the stack steps): 20 targets (10 prod, 10 nonprod), 3 nodes, 10 people,
100 operations/day (each with a plan), 50 agent data reads/day, 3 logins/person/day. Rows per operation counted from the code: audit ≈ 5
(`plan.created` `plans.ts:227`, acceptance `accept.ts:249`, ≥ 3 transitions `transitions.ts:200`; +1 to +3 with approvals), `operation_events` ≈ 12-16
(`created` `accept.ts:246`, `lease_acquired`, `locks_acquired`, 2 per step `driver.ts:130`, transitions), one `operations.operations`, one
`operations.plans`, one `plan_bodies` row.

What the code **deletes** (all `DELETE FROM`/drop sites): auth challenges and rate limits (`auth.prune`), OAuth requests, codes, tokens,
device codes, assertions, rate limits, unapproved DCR clients (`oauth.prune`), idempotency keys (`idempotency.prune`), process heartbeats
(`heartbeats.prune`), health-sample partitions (14 d), statement-delta partitions (30 d), audit partitions only by the manual
`exponetdb audit prune` (default permanent), data-read lane rows. **Nothing else is ever deleted.**

| Table / class | Written by | Rows per year (assumptions) | Documented retention | Pruned in code? | Becomes a problem |
|---|---|---|---|---|---|
| `audit.audit_events` | every audited mutation | ≈ 750/day → 275k/yr (≈ 0.4 GB); busy agent (5,000 data reads/day) ≈ 4.4 M/yr (≈ 6 GB) | permanent | manual only | the **daily full chain verification** reads and re-hashes the whole chain inside a 300 s task lease (`worker-tasks.ts:344`, `claimDueTask(…, 300)`); once a verify needs more than 300 s the lease lapses, a second worker starts again from seq 1 and no outcome is recorded (`full_verification_not_recorded`). Throughput is unmeasured; at ~30k events/s that is ≈ 9 M events (≈ 2 years of the busy case, > 30 years of the base case). Stack step 8 |
| `operations.operation_events` | driver, locks, leases | 100/day × 14 ≈ 0.5 M/yr; **+31.5 M/yr per waiting operation** (C1-1) | detail 90 d, summaries permanent | no | with one parked operation and any waiter: a 4-6 GB/yr table and 43k updates/day on its operation row within the first month |
| `operations.operations`, `plans`, `plan_bodies` | accept, plan | 36.5k each/yr; `plan_bodies` holds the canonical plan (a migration plan with analysis may be tens of KB; unmeasured) ≈ 1-2 GB/yr | denied/expired/withdrawn 90 d, no-effect operations 400 d | **no** (`expirePlans` changes state, never deletes) | storage and the `fleet.operations` scan (newest 500) are unaffected; vacuum/backup time and dump size grow linearly; years, not months |
| `observation.drift_checks`, `schema_snapshots` | `drift.schedule` every 15 min (prod) / 60 min (nonprod) per target (`drift.ts:725`) | 10×96×365 + 10×24×365 ≈ 438k rows each/yr (≈ 0.3 GB) | schema documents from drift checks 90 d | **no** | slow; documents are stored once per fingerprint, up to 64 MiB compressed each (`observation/up.sql:22-37`), so a schema that changes daily adds one document a day per target forever |
| `observation.findings` update amplification | every drift check upserts each still-open finding (`findings.ts:143`, `occurrences + 1`, `last_seen_at` is in an index so no HOT update) | the first campaign's live target had **13,968 open findings**: 13.7k updates per check → 1.3 M/day per prod target, 0.33 M/day per nonprod | resolved findings 400 d | resolved rows never deleted | WAL and index bloat from day one on a freshly imported unmanaged schema; autovacuum must keep up with ≈ 1.3 M dead tuples per day per target |
| `observation.health_samples` | `health.sample` every 15 s per target | 20 × 5,760 × 14 d ≈ 1.6 M steady | 14 d | **yes** (partitions) | none; if the worker is down > 2 days the next partitions are missing and samples are lost (not the status) |
| `observation.statement_deltas` | `statements.sample` every 5 min, top 200 per target | 20 × 57,600 × 30 d ≈ 35 M rows steady (≈ 3-4 GB) | 30 d | yes (partitions) | steady state, not growth; this is the largest steady table |
| `auth.sessions`, step-ups, reauth events, `nodes.enrollment_tokens` | logins, CLI step-ups | ≈ 11k sessions/yr | sessions expiry + 30 d | **no** | none for years |
| `migrations.bundle_revisions` | plan, **unaudited ingest** | unbounded for a `migrations.plan` holder: 32 MiB per request, no rate limit, no delete | never-planned 90 d | cannot be (immutable by trigger) | **minutes** under abuse (C1-11), otherwise slow |
| `oauth.tokens` | MCP clients re-mint every 10 min | pruned 1 d after expiry | | yes | none |
| `control.process_heartbeats` | 3 roles × 5,760 updates/day (+ one row per start) | 7 d | | yes | a crash loop writes one row per start |
| `nodes.nodes.heartbeat` | UPDATE per heartbeat per node (15 s) | 5,760 updates/day/node | latest only | in place | none |
| `backups.*` catalog | refresh, runs | small | records permanent | no | none |

## 6. STACK STEPS

1. **Head-of-line blocking (C1-1).** Register two targets A and B. Park an operation on A in `needs_attention` (cut the node connection during `verifying` of `postgres.hba.apply`, or kill the worker after `execute` of a migration whose reconcile returns `unknown`; E1 gives both recipes). Queue plan P1 on A (`migration apply`) and then plan P2 on B (different target and kind). `watch -n5 "exponetdb operation list --state queued"` for 5 min. Expected (the finding): P2 stays `queued` although B is free. Also `docker exec cs psql -c "SELECT kind, count(*) FROM operations.operation_events WHERE operation_id = '<P1>' GROUP BY 1"` at 0, 5 and 10 minutes: expect `lease_acquired` and `locks_waiting` rising by 150 per 5 min each, and `curl $W/metrics | grep operations_loop_total` `outcome="waiting"` rising 1 per tick.
2. **SIGTERM during an apply (C1-12).** Start a 90 s `pg_sleep` migration (`-- non-transactional` variant and a transactional one). `docker stop --time 60 worker` after 10 s and record: time to exit, exit code (`docker inspect … ExitCode`), log lines `process.stopping`, `process.stopped{ok:false}`, `process.forced_exit`; the `control.process_heartbeats` row (`stopped_at IS NULL`?); the target (`SELECT pid, state, query FROM pg_stat_activity` on the target: is the session gone?); the ledger; then after restart the operation states and events (`lease_taken_over`, `needs_reconciliation`, result). Repeat with default `docker stop` (10 s). Expected: `ok:false`, exit 1 (or 137), heartbeat row not stopped, reconcile result consistent with the target ledger.
3. **SIGTERM per role.** For `serve`: run `hey -z 30s -c 20` against `/api/v1/targets` and `docker stop --time 30 serve`: count requests that failed and the time to exit (expected ≤ 13 s, the closed-connection count, 0 5xx from in-process handlers). For `gateway`: keep a node connected and `docker stop gateway`; read the agent log for the reconnect timing (backoff) and verify `GET /nodes/{id}` returns to `active`. For the agent: `systemctl stop exponetdb-node` during a slow capability; read `journalctl`, the job outcome, and the journal on restart.
4. **1,000 concurrent MCP "sessions".** With 1,000 grants (service accounts or a replay of one grant) keep 1,000 open `POST /mcp` `tools/list` streams plus a 5 req/s `targets_list` per grant: record `process_resident_memory`, open file descriptors (`ls /proc/<pid>/fd | wc -l`), event-loop lag (`monitorEventLoopDelay` via a debug build or `curl` latency of `/healthz/live` during the load), `exdb_mcp_requests_total` by status class, and the size of the rate-limit map (add a debug print, or compare RSS before/after 10 idle minutes). Expected: no per-session growth; the first limit hit is fds or CPU. Also check the `504` at 90 s.
5. **Pool exhaustion and readiness (C1-3).** See `fail-closed.md` step 5; additionally record `exdb_control_store_query_duration_seconds` buckets for `readiness.ping` during saturation.
6. **Old worker after schema moves.** Start a worker from `d0229550` against a Control Store, run `control-store migrate` from `d51da5d0`, leave the old worker running and queue an operation: expected the old worker's `/healthz/detail` shows `schema_newer` but its operations loop keeps claiming (`exdb_operations_loop_total{outcome="done"}` rises) with the old kind registry.
7. **Body limits.** `head -c 104857600 /dev/zero | curl -s -o /dev/null -w '%{http_code} %{time_total}\n' -H 'content-type: application/json' --data-binary @- $API/api/v1/saved-queries` (expect 422 quickly, read the problem body: no limit named for JSON); same with `Transfer-Encoding: chunked` and with a 31 MiB bundle body to `migration lint` (expect the parse cost, B2). `curl --limit-rate 100 …` for a slow client: expect the connection closed at 20 s (headers) or 120 s (body).
8. **Growth.** Load 1 M synthetic audit events through the writer (`appendAuditEvent` in a loop, 10k per transaction), run `exponetdb audit verify` and time it; extrapolate against the 300 s lease. Insert 36,500 realistic plans and `SELECT pg_size_pretty(sum(pg_column_size(body))) FROM operations.plan_bodies`. Import a 14k-object schema as a target, run `drift check` 10 times and read `n_tup_upd`, `n_dead_tup` and WAL bytes for `observation.findings` from `pg_stat_user_tables` and `pg_stat_wal`.
9. **Crash-loop liveness.** See `observability.md` step 8.

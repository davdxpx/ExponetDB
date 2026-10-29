# C1 / fail closed, but loudly

Block C, static part (tester C1). `T` = `/home/david/Development/ExponetDB-verify` at `d51da5d0`. **STATIC** throughout:
nothing here was run against a server. Findings **C1-n** are in `../F/findings-C1.md`. Principle 4 (fail closed for writes when
safety state is unknown) and principle 5 (a failed read is an error, never an empty list) are the yardsticks.

## 1. How "audit cannot be written, mutations stop" is implemented

* The audit append is **in the caller's Control Store transaction** (`packages/audit/src/writer.ts:57-134`): it takes the global
  transaction-level advisory lock `AUDIT_CHAIN_LOCK`, reads the chain head and the DB clock, hashes (`ac1`) and inserts; any failure
  becomes `AuditWriteError('audit_append_failed')` and rolls back the whole mutation. The audit sink is therefore **the same
  database** as the state: "audit cannot be written" means the Control Store cannot take that insert (no space, read-only,
  missing monthly partition, chain-guard refusal `EXA*`, lock or statement timeout), not "the S3 export is down".
* The export to S3 or the file volume is **decoupled** and never blocks a mutation (`packages/audit/src/checkpoints.ts:12-14`);
  it blocks only audit retention (a partition is dropped only when an exported checkpoint covers it, `retention.ts:13-18`).
* The lock is held until commit and serializes every audited mutation of the installation (one writer at a time). A waiter
  hits the pool's `statement_timeout` of 30 s (`packages/control-store/src/store.ts:363`) and fails with SQLSTATE `57014`
  (`control_store_timeout`). Throughput bound, not a safety problem.
* An `AuditWriteError`, like every error whose `code` is not in the public catalog, is answered **500 `INTERNAL`**
  (`apps/server/src/interfaces/http/request.ts:152-162`) and logged as `http.request_failed{errorName,errorCode,causeCode,route}`
  (`api.ts:2358-2365`). The caller sees "An unexpected error occurred. Quote the request id" (`errors.ts:1425-1430`).

### 1.1 Mutation paths and the audit gate

Method: every `store.transaction('<class>', …)` call site outside `control-store`, `postgres` and `migrations-engine` (108 literal
sites plus the dynamic ones in `registry/kind-base.ts:164`, `auth/access/operations.ts:646`, `nodes/kinds.ts:75`,
`nodes/gateway.ts:151`, `backups/kinds.ts:525`), then a check whether the same transaction (or the helper it calls) reaches
`appendAuditEvent` (`rg appendAuditEvent|appendAudit` gives 47 files). Classification:

| Class | Paths | In the audit gate? |
|---|---|---|
| **Plans, operations, approvals** | plan create (`operations/src/plans.ts:227`), acceptance (`accept.ts:249`), every state transition (`transitions.ts:200`), plan end/withdraw/expire (`plans.ts:366`, worker `plans.expire`), approvals/rejections (`auth/src/approvals.ts:500-574`), cancel, retry-verification (`application.ts:1944,2018`) | **yes**, same transaction |
| **Identity and access** | login/logout/reauth/enrollment/recovery/self-service (`auth/src/ceremonies/*` via `auth/audit.ts:66`), step-up (`stepup.ts`), invite/disable/erase/role bindings (`auth/src/access/*`), OAuth consent/device/token/revoke/clients/service accounts/API keys (`auth/src/oauth/*`) | yes |
| **Registry, nodes, backups, migrations engine** | `registry/src/apply.ts`, `kind-base.ts`, `credentials.ts`; `nodes/src/kinds.ts`, `capability-kinds.ts`, `binding.ts`, `gateway.ts` (enroll, renew), `pki.ts`; `backups/src/kinds.ts` and the offline drill record (`application/src/backups.ts:594-640`); migrations `kind.ts` | yes (through the operation or its own event) |
| **Observation with a human trigger** | advisors run (audit in the run's transaction, `advisors/run.ts:44`), drift accept (`drift-accept.ts`), connections terminate/lease (`connections.ts`), saved queries, profiles, break-glass review, raw statement lookup (`raw-statements.ts:133`), audit export download (`application.ts:1202`) | yes |
| **Data reads** | `query.run`/`query.explain`: the audit event is written **after** the read ran and before the result is returned (`application/src/queries.ts:249-256,333-345`, "must be written before anything is returned") | gate on the **answer**, not on the read: the SELECT has already executed on the target when the audit append fails (C1-10) |
| **Maintenance** | `secrets.rewrap` (`worker-tasks.ts:150-166`), `retention.prune` (`retention.ts:177`), PKI init and job-key commands | yes |
| **Bundle ingest** | `POST /projects/{id}/migrations/bundles` → `application/src/migrations.ts:93-113` → `ingestBundles` writes **permanent, immutable** `migrations.bundle_revisions` (no DELETE, B1/E1) | **no audit event anywhere on the path**, no plan, no operation; permission `migrations.plan` (`contracts/src/actions.ts:720-725`); 32 MiB per request, 50 bundles, no REST rate limit. C1-11 |
| **Telemetry and observation without a person** | process and node heartbeats (`heartbeats.ts`, `nodes.heartbeat()` SQL), health samples and `target_status` (`diagnostics/src/health.ts:368`), statement samples (`statements.ts:285`), scheduled drift checks, snapshots and findings (`drift.ts:367,478`), registration snapshot, credential verification results (`registry/credentials.ts:455`), idempotency keys, rate-limit buckets (audited in aggregate at 5, 10, 20… failures, `ratelimit.ts:62-68`), grant last-use (once a minute, `oauth/usage.ts:33`), session `last_seen` (once a minute, `sessions.ts:45`), data-read lane rows (`lane.ts:153`), maintenance task leases | **no**, by design: these keep writing while audit appends fail (a missing audit partition leaves them all green) |

`CLAUDE.md` states the invariant without exception; `self-observability.md` §6 states it for "mutations". The honest reading is
"every mutation of managed state, access control and operations", and the two real exceptions are the **bundle ingest** and the
**post-read audit of data reads**.

## 2. Dependency by dependency

"Mutations" = what a person or agent can change. "Reads" = what still answers truthfully. "Operator sees" = status, error, log,
probe. All STATIC.

| Dependency down | Mutations that stop | Reads | Operator sees | Recovery |
|---|---|---|---|---|
| **Audit export (S3 or file volume down or full)** | none (`checkpoints.ts:12-14`) | all truthful | worker task `audit.export` fails every 5 min (`audit.checkpoint_export_failed`, metric `exdb_maintenance_task_runs_total{task="audit.export",outcome="failed"}`), worker readiness `degraded` (HTTP 200), `GET /installation/health` `audit_chain` `export_failing`/`export_lagging`; no cause in the log (`checkpoints.ts:96-100` swallows it); retention blocked | fix the sink; the next 5-minute run exports all pending checkpoints oldest first (`exportPendingCheckpoints`, limit 100 per run) |
| **Audit append impossible** (missing monthly partition after the worker was down more than 3 months or `audit.ensure_partitions` failing, chain-guard refusal) | **every audited mutation**, including plan creation, apply, login, logout, token issue; `500 INTERNAL` | reads that are not data reads keep answering; data reads are refused at the end (audit before answer) | log `http.request_failed` with `errorName=AuditWriteError`; **`/healthz/ready` stays `ready`** (no readiness check appends audit); heartbeats, samples and drift checks keep writing | create the partition (`audit.ensure_partitions` as the worker or `exdb_audit_maint`), no restart needed. C1-10 |
| **Control Store unreachable** (network, `57P01-03`, `53300`, pool timeout) | all (every mutation needs the store); in-flight operation steps continue on the target but cannot record: `running` with an expiring lease → another worker reconciles after 30 s | **REST/MCP/Web reads fail with 500 INTERNAL**, never an empty list (principle 5 holds; the code is wrong, C1-3) | serve/worker/gateway: `heartbeat.failed`, `control_store.pool_error`, readiness `control_store` fail → `not_ready` within 5 s; Docker unhealthy after 3×15 s; `serve` leaves Traefik | automatic once the store answers; roles that started while the store was down stay running and not ready and recover by themselves (`role.ts:204-241`: unreachable at startup is logged, not fatal) |
| **Control Store read-only** (`default_transaction_read_only`, hot standby, `25006`) | all writes: `25006` is mapped to `control_store_query_failed`, 500 INTERNAL | `SELECT`s work; REST reads answer | readiness `control_store` is `SELECT 1` and **passes**; the heartbeat write fails → `heartbeat_stale` after 45 s → `not_ready`; `serve` leaves Traefik, so even reads stop at the proxy; `heartbeat.failed` and `http.request_failed{causeCode:"25006"}` | restore write mode; roles recover on their own |
| **Control Store full** (`53100`, `53200`) | all writes (same mapping) | reads work | same as read-only with `causeCode:"53100"` | free space; the append-only audit table cannot be vacuumed away, so recovery is storage or an `audit prune` of expired partitions (permanent by default: nothing to prune) |
| **Control Store pool exhausted** (10 connections per process, no queue bound, 5 s connect timeout, `store.ts:365-370`, `runtime.ts:60`) | the request that times out: `pool.connect()` errors map to `control_store_unavailable` ("The Control Store is unreachable") although the store is up (`errors.ts:55-60`) → 500 | same | the readiness probes need a pool connection too (`control_store` 3 s, `role_credential`, `installation`, `schema`, `keyring`), so saturation → `check_timeout` → `not_ready` → Docker unhealthy → Traefik removes serve: a load spike becomes a total outage until the pool drains. C1-3 | automatic |
| **Node unreachable / offline** | node-capability plans and operations fail at plan time or dispatch: `NODE_OFFLINE` 503 (catalog); a dispatched job not started within 60 s returns to `pending`; a running job whose node vanishes ends `outcome_unknown` → operation `needs_reconciliation` → `needs_attention` (E1 SM-1) | target and cluster reads from SQL sessions continue; node-reported fields are marked `agent_reported` with their age (but R2: unreported fields read `false`/`null`) | node `offline` after 60 s; `GET /nodes`; no push | node returns: hello reports `journal.inFlight`, the Control Plane judges |
| **Target DNS failure / connection refused / timeout** | plans and applies on that target: `TARGET_UNAVAILABLE` 503 (E/errors.md), no write | health `unreachable` with the probe class; last good data carries `source: cached` and its age; `unknown` after 8 sampling intervals (`health.md` §3, never shown as fresh healthy) | `GET /targets/{id}/health`, `/fleet`; log `health.sample_failed` | automatic at the next 15 s sample |
| **Target TLS failure** (`tls_expired`, hostname, CA) | same, error `TARGET_TLS_FAILED` | health `unreachable`, probe class names the TLS cause | as above; no advance warning (`tls_expiring` is never produced, C1-6) | fix the certificate or the CA bundle (plan) |
| **Target credential invalid** | `TARGET_CREDENTIAL_INVALID` 503 | health `unknown` reason `no observer credential` or `unreachable` with `authentication` class | `registry.credential_verification_failed` log | submit a new credential (write-only endpoint) |
| **Keyring invalid at start** | the role exits with code 3 (`run-role.ts:57-68`, `StartupRefused('keyring_invalid')`) | n/a | `process.start_refused{reason:keyring_invalid}`; container restart loop | fix the file/variable |
| **Keyring valid but a referenced master key is missing** (removed too early, or the worker rewrapped to a key `serve` lacks) | not refused at start (only `mismatched` refuses, `role.ts:236-238`); secret reads fail `secret_key_unavailable`; readiness `keyring` critical `keyring_missing_key` | reads not needing secrets work, but the role is `not_ready` and leaves the proxy | `/healthz/detail` shows the reason; `keyring status` lists `missing` | restore the old key into the keyring, restart |
| **Secret store unreadable for one data key** | operations that need that secret end `not_applied` (`INTERNAL`, `secrets.md` §4); rewrap task fails with `secrets.rewrap_unreadable` | other secrets work | log + failing task | resubmit the credential |
| **Installation marker mismatch / schema newer / checksum mismatch** | the role refuses to start (exit 3) | n/a | `process.start_refused{reason}` | roll forward / restore (E1: upgrade cannot be rolled back) |
| **No live worker** | operations are accepted (`queued`) and never progress; plan expiry does not run (the apply path still checks the DB clock, so no stale plan is applied); no health samples → `unknown`/`sampler_lagging` | truthful | serve readiness `degraded` (**HTTP 200**), `installation/health.workers degraded no_live_worker` | start a worker; queued work runs |
| **No data-read worker** | agents' data reads `CAPABILITY_UNAVAILABLE` (never empty) | n/a | `installation/health.data_reads` | worker |
| **Gateway down** | node jobs are not dispatched | n/a | `gateway_not_live` in installation health | restart |
| **Role matrix / scope catalog unverified** | `serve` answers `503 CONTROL_PLANE_DEGRADED` on `/api/v1` and `POST /mcp` (the only place the catalog code is used, `api.ts:2184`, `mcp/edge.ts:482`) | probes only | readiness `role_catalog`/`scope_catalog` | migrate / fix |

## 3. What stands out

1. **The catalog code `CONTROL_PLANE_DEGRADED` (503, retryable) is used only for the role/scope catalog case.** A Control Store that
   dies while `serve` is running yields `500 INTERNAL` for reads and writes: the status and the title say "bug in ExponetDB", the
   operator-facing text says "Quote the request id", and clients that distinguish 5xx classes treat an outage as a defect. For read-only
   and full stores the SQLSTATEs `25006`, `53100`, `53200`, `53400` are not even classified as unavailable
   (`packages/control-store/src/errors.ts:75-120`; only `08*`, `57P01`, `57P02`, `57P03`, `53300` are). C1-3.
2. **Fail-closed is silent for the audit partition case** (C1-10): no probe, no metric names it.
3. **Reads stop at the proxy before they stop in the process.** Because Docker's `HEALTHCHECK` is the readiness endpoint
   (`Dockerfile:38-39`) and Traefik drops unhealthy containers, a write-only failure of the Control Store (read-only, full)
   takes the reads down too, about 95 s after the first failed write. "Reads still tell the truth" holds in the process; it does not
   hold at the public endpoint. The Web App cannot show a banner "read-only mode" because it is gone.
4. **One bypass of the audit gate** (bundle ingest, C1-11) and one inverted order (data read, C1-10).

## 4. STACK STEPS

All on the disposable stack; the Control Store is a container so each step can be undone. `T0` = time of the first induced failure.

1. **Audit-partition outage (C1-10).** `docker exec cs psql -U postgres exponetdb_control -c "ALTER TABLE audit.audit_events DETACH PARTITION audit.audit_events_y<YYYY>m<MM>"` for the current month. Immediately: (a) `curl -i -X POST $API/api/v1/…` any mutation, expect 500 and body `code":"INTERNAL"`; (b) `docker logs serve --since 1m | grep http.request_failed`, expect `errorName":"AuditWriteError"` (record the actual field names); (c) `curl -s -o /dev/null -w '%{http_code}' $S/healthz/ready` expect 200 `ready`; (d) `GET /installation/health`: all `operational`, `audit_chain` without a reason; (e) wait 2 min: `SELECT count(*) FROM observation.health_samples WHERE …` still growing; (f) `GET /api/v1/targets` 200. Restore with `ATTACH PARTITION … FOR VALUES FROM (…) TO (…)`; first mutation after: 2xx.
2. **Read-only Control Store.** `ALTER DATABASE exponetdb_control SET default_transaction_read_only = on;` then terminate the roles' backends. Record at `T0+n`: status of a mutation (expect 500 INTERNAL), `GET /api/v1/targets` (expect 200), `/healthz/ready` (expect 200 until ≈45 s, then 503), `docker inspect … Health.Status` (expect `unhealthy` ≈ 45 s later), Traefik: `curl -i https://<host>/api/v1/targets` (expect 503/404 from the proxy once unhealthy), `grep heartbeat.failed`. Undo and record the time until `ready` and until Traefik routes again.
3. **Disk full.** Mount a 200 MB tmpfs as the Control Store data directory (or `fallocate` the volume), fill it by creating plans in a loop (bundle ingest of 4 MiB files, 8 per request, see step 6; the Traefik behaviour toward an unhealthy container is expected from its Docker provider and is to be confirmed in step 2) until `53100`. Expect step 2's outcomes with `causeCode:"53100"`; try `audit.ensure_partitions`, `VACUUM`, and `exponetdb audit prune` to document what a full audit table allows.
4. **Control Store unreachable.** `docker pause cs` (or `iptables DROP`); expect `500 INTERNAL` (not 503) on reads, `heartbeat.failed`, `control_store.pool_error`; `docker unpause`; expect automatic recovery of serve, worker and gateway without restart; record the `running` operation of an in-flight apply (start a 2 min `pg_sleep` migration, pause the store for 40 s, unpause): expect `needs_reconciliation` then a reconcile result, no second execution.
5. **Pool exhaustion.** `ab`/`hey` 200 concurrent `GET /api/v1/targets` against a slow Control Store (`pg_sleep` in a view is not available; instead `SELECT pg_advisory_lock(…)` held by the test on the table the read needs, or `tc netem delay 300ms` on the store). Expect 500s with `control_store_unavailable`, then `curl $S/healthz/ready` 503 `check_timeout`, `/healthz/detail` names the failing checks; measure the time until Traefik drops serve.
6. **Bundle ingest unaudited (C1-11).** With a `migrations.plan` token: `POST /api/v1/projects/{id}/migrations/bundles` with 50 distinct 600 KB bundles; `SELECT max(seq) FROM audit.audit_events` before and after: expected **unchanged**; `SELECT count(*) FROM migrations.bundle_revisions` +50; repeat 100 times and watch `pg_total_relation_size('migrations.bundle_revisions')`; try to delete (expect refused).
7. **Data read before audit (C1-10).** Make `audit.append.insert` fail (`REVOKE INSERT ON audit.audit_events FROM exdb_serve` as the table owner, or the detach of step 1) and run `exponetdb query` on a nonprod target with `pg_stat_statements` reset marker (`SELECT pg_stat_statements_reset()` before): after the 500, `SELECT calls FROM pg_stat_statements WHERE query LIKE '%<marker>%'` on the target: expected 1 (the read ran).
8. **Node unreachable.** `systemctl stop exponetdb-node-helper exponetdb-node` on the host; plan `postgres.reload` on its cluster: expect `NODE_OFFLINE` 503 at plan time; then stop the node **after** a job was dispatched (use a slow capability) and record the job state (`outcome_unknown`) and the operation state progression.
9. **DNS failure and TLS failure on a target.** Change the registered endpoint host to a name that does not resolve (registry plan); then to a host with a certificate for another name; record error codes `TARGET_UNAVAILABLE` / `TARGET_TLS_FAILED`, health state and probe class, and whether any plan can be applied (expect no).
10. **Keyring cases.** (a) empty `EXPONETDB_KEYRING`: exit 3 and the log reason; (b) a keyring lacking a referenced key: role runs, `/healthz/detail` shows `keyring_missing_key`, a TOTP login fails with `secret_key_unavailable`, `GET /api/v1/targets` works; (c) a keyring with a different key under a known id: exit 3 `keyring_mismatch`.
11. **No worker.** `docker stop worker`, apply a plan: expect `queued` indefinitely; `/healthz/ready` of serve stays 200 `degraded`; after restarting the worker the operation runs; the `plans.expire` sweep does not run meanwhile but an apply after expiry is still refused (`PLAN_EXPIRED`).

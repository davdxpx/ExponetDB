### [P1] A full Control Store disk is a PostgreSQL PANIC and a dead control plane, and any holder of `migrations.plan` can cause it with a few unaudited, undeletable requests
- **Area:** `packages/application/src/migrations.ts:93-113` (bundle ingest), `packages/migrations-engine/src/store.ts`, Control Store operations
- **Block:** C
- **Reproduction:** `C/stack/scripts/fc3-disk.sh` and `fc3b-disk-recovery.sh`. Control Store data directory on a 420 MB loop-mounted ext4 (74 MB used). With the CLI token (scope `migrations.plan` only): `POST /api/v1/projects/{id}/bundles`, once with 50 x 600 KB, then 8 x 3 MB per request. Then `DELETE FROM migrations.bundle_revisions` as the superuser and as `exdb_serve`.
- **Expected:** a bounded, audited, per-identity write; a full volume refuses writes and keeps reading; there is a way to free space; the operator is warned before.
- **Actual:** five successful ingests (29 MB, then 4 x 24 MB, about 1 s each) took free space from 296 MB to 53 MB, with no audit event (`max(seq)` 289 before and after) and no rate limit. The next request answered 500; the log shows `PANIC: could not write to file "pg_wal/xlogtemp.59": No space left on device` on COMMIT, `terminated by signal 6`, then `FATAL ... xlogtemp.119` in recovery and `shutting down due to startup process failure`, all within 9 s of the PANIC. The container exited and a plain restart fails again. The roles went `not_ready`, then ECONNREFUSED. Rows cannot be removed (`migrations.bundle_revisions is append-only (DELETE refused)` even for the superuser), so only more disk helps. After growing the volume PostgreSQL accepted connections 1.4 s after `docker start`, the roles were ready 2.4 s later without a restart, `audit verify` was ok with 415 events, and nothing committed was lost. No readiness, metric or finding watches Control Store disk. The lead classed it P1 because there is no data loss and the managed databases keep serving applications (control plane, not data plane); the actor needs only `migrations.plan`, so the owner may count it as an outage-by-low-privilege-actor (P0) on `reos-01`, where the Control Store shares a host with other services. This subsumes `F/findings-C1.md` "Bundle ingest is an unaudited, unthrottled, permanent write".
- **Evidence:** `C/stack/fail-closed-results.md` steps 3 and 6; logs `fc3.out`, `fc3b.out` on vc-1 (index in `C/stack/README.md`).
- **Root cause:** ingest sits outside the audit gate and any quota; revisions are immutable with no purge path; no disk watch; PostgreSQL PANICs on a failed WAL write.
- **Proposed fix:** audit every ingest in the same transaction; a per-identity daily byte quota plus a general REST rate limit; an audited human-only purge of never-planned revisions (the 90-day class of `data-retention.md`); a Control Store volume component in installation health (warn at 80 percent, refuse ingest at 90 percent); a separate WAL volume and restart policy in the deployment record; a "Control Store will not start: ENOSPC" runbook.
- **Acceptance test:** with a 50 MB free budget the quota answers before the volume is full; every ingest writes an audit row; a purge frees space; installation health shows the warning.

### [P2] After a failed write path clears, the roles stay not_ready until their pooled sessions die; a database-level read-only default stops nothing but the heartbeat
- **Area:** `packages/control-store/src/store.ts` (pool; `BEGIN ... READ WRITE` at line 158), heartbeat in `apps/server/src/composition/role.ts`
- **Block:** C
- **Reproduction:** `C/stack/scripts/fc2-readonly.sh`: `ALTER DATABASE exponetdb_control SET default_transaction_read_only = on`, terminate the 23 backends, mutate and read for 130 s; then RESET it (from the `postgres` database; from the store database it fails with `cannot execute ALTER DATABASE in a read-only transaction`). Real read-only variant: `fc2b-standby.sh`.
- **Expected:** a freeze either stops mutations or is ignored consistently; the roles recover when the store is writable ("automatic once the store answers").
- **Actual:** (a) mutations kept succeeding (plans at 2, 21, 64, 127 s exist) because every write transaction starts with an explicit READ WRITE; only autocommit statements fail with 25006 (heartbeat, grant last-use, worker `dataread.tick_failed` at roughly 200 to 300 lines a minute). After 32 s serve, worker and gateway were all 503 (`heartbeat_stale`, `no_live_worker`) and installation health was `down`, while the worker loop still wrote. (b) After the RESET the roles stayed 503 for 4 min 36 s, until the backends were terminated (ready 9 s later): the failed heartbeat does not evict the pooled session. (c) On a real read-only store (an unpromoted standby): mutations 500, then after about 44 s every API call 503 `CONTROL_PLANE_DEGRADED`; the CLI cannot refresh its token (`oauth_server_error`), so reads turn 401 after the 10 minute token life. Promotion recovered everything in 8.4 s.
- **Evidence:** `C/stack/fail-closed-results.md` step 2; logs `fc2.out`, `fc2-undo2.out`, `fc2b.out`.
- **Root cause:** the pool keeps clients after session-state errors (25006); the heartbeat is a single autocommit statement while writes use explicit transactions.
- **Proposed fix:** destroy the client on 25006 and other class 25 and 57 errors; run the heartbeat in a `BEGIN READ WRITE` transaction like every other write; document that `default_transaction_read_only` is not a freeze.
- **Acceptance test:** set the default, terminate backends, reset it: all roles ready within one heartbeat interval without terminating backends; with the default on, a mutation fails closed or the roles stay ready (decide, then test).

### [P2] One MCP client can push serve far past its 512 MiB container limit: 1,000 concurrent requests, 98 percent rejected 429, RSS 156 to 583 MB
- **Area:** `apps/server/src/interfaces/mcp/edge.ts`, `interfaces/http/lifecycle.ts`, `12-operations/deployment.md` §2a
- **Block:** C
- **Reproduction:** `C/stack/scripts/gl-mcp.sh` (token from `mcp-token.sh`: a DCR public client, authorization code + PKCE, six read scopes), `load.mjs --c 1000 --seconds 30` of `POST /mcp tools/list` (99 KB answer).
- **Expected:** the per-grant limiter and a connection cap keep memory bounded; a request over the limit costs almost nothing.
- **Actual:** 31,953 requests in 30 s: 709 x 200 and 31,244 x `429 RATE_LIMITED` (named, `retryAfterSeconds`). RSS 156 to 583 MB, about 1,080 descriptors, `/healthz/live` 12 to 28 ms, RSS 229 MB ten seconds later. `deployment.md` gives serve 512 MiB (heap 259 MiB): the kernel would kill it here (the stack has no cgroup limit, so the kill itself was not observed). An unauthenticated flood (86,471 x 401 in 30 s) cost +143 MB and about 1,700 descriptors. A single 31 MiB bundle request costs +180 MB. The public listener has no connection cap.
- **Evidence:** `C/stack/graceful-life-results.md` steps 4 and 7; logs `gl-mcp.out`, `gl-limits.out`.
- **Root cause:** no cap on concurrent connections or in-flight requests per grant or IP; limiting runs after the request is accepted and read.
- **Proposed fix:** `maxConnections` plus a per-grant in-flight cap checked before the body is read; a global in-flight byte budget for bundle routes; document the container memory with the measured peak.
- **Acceptance test:** 1,000 concurrent `tools/list` from one grant keep serve RSS under 350 MB and `/healthz/live` under 100 ms; 429 answers carry `Retry-After`.

### [P3] An established gateway session is never re-checked against the certificate's end, and a refused node leaves one info log line
- **Area:** `apps/server/src/interfaces/gateway/agent-listener.ts`, `packages/nodes/src/gateway.ts:265,497`, RB-13
- **Block:** C
- **Reproduction:** `C/stack/scripts/kt0-faketime-setup.sh`, `kt-gw.sh`, `kt-gw2.sh`, `kt-rb13.sh` (libfaketime on the gateway only; the agent is a Go binary and ignores `LD_PRELOAD`; the VM clock was not touched).
- **Expected:** an expired certificate is refused and the operator is told why (`enrollment.md`, RB-13).
- **Actual:** with the gateway clock +125 h the connected node stayed active, heartbeated every 15 s and received another certificate (expiry is judged at the handshake only). A new handshake at +200 h is refused with `403 NODE_CERTIFICATE_REFUSED: The client certificate is not the node's current certificate, or the node's state does not allow the request.` (the same text for expired, replaced and revoked). The node reads `offline` after 60 s. The only server-side trace is `info agent.refused` (7 lines for 7 attempts): no audit event, finding or metric; `exponetdb-node status` on the host still says "in 2d23h". Back at real gateway time the node healed itself in about 90 s. RB-13 works: 37 s, 8 scripted actions, a new node active 18 s after the start. During renewal the node row flapped offline and active for about a minute.
- **Evidence:** `C/stack/keys-certs-time-results.md` step 5; logs `ktgw.out`, `ktgw2.out`, `ktrb13.out`.
- **Root cause:** TLS verification once per connection; the application-level check compares fingerprints, not validity; refusals are logged at info.
- **Proposed fix:** check `notAfter` per request; log `agent.refused` at warn with node id and reason (`expired`, `superseded`, `revoked`); count refusals in a metric.
- **Acceptance test:** a node past its certificate end is refused on an open session at its next request, with `reason=expired` in a warn log and a metric increment.

### [P3] The audit export failure never says why
- **Area:** `packages/audit/src/checkpoints.ts:96-100`, worker task `audit.export`
- **Block:** C
- **Reproduction:** `C/stack/scripts/afc-export.sh`: `chmod 000` on the export directory; S3 (versitygw) stopped, then restarted without its bucket.
- **Expected:** a log line naming the sink and the cause.
- **Actual:** the signals are right (task failed, worker `degraded` 200 with `audit_export_failing`, metric `outcome="failed"`, installation health `export_failing`, mutations still 200, recovery 25 s after the fix), but the only log is `audit.checkpoint_export_failed seq=372 count=0`. After S3 came back without its bucket the export stayed failing and nothing says `NoSuchBucket`.
- **Evidence:** `C/stack/observability-results.md` step 6; log `afc.out`.
- **Root cause:** `catch { return {exported, failed: seq} }` drops the error.
- **Proposed fix:** log the error class and message (no secrets) and the sink kind.
- **Acceptance test:** an export to a missing bucket logs `cause=NoSuchBucket sink=s3`.

### [P3] Target TLS failures share one class, and a serve clock behind the certificates makes every target unreachable without naming the clock
- **Area:** `packages/postgres/src/errors.ts`, diagnostics health reducer, clock handling
- **Block:** C
- **Reproduction:** `C/stack/scripts/fc9-target-tls.sh` (lab-CA certificates: expired, other name, 5 days left) and `kt1-serve-clock.sh` (serve at -2 h).
- **Expected:** classes `tls_expired`, hostname, untrusted CA; `tls_expiring` at 30 and 7 days (`health.md:121`).
- **Actual:** expired and wrong-name both give `unreachable`, probes `failed:target_tls_failed`, `migration plan` gives `TARGET_TLS_FAILED` (once `TARGET_UNAVAILABLE` on the second try), no finding, no worker log. The 5-day certificate is healthy with no condition. With serve 2 h behind, every plan fails `TARGET_TLS_FAILED` (fresh certificates are "not yet valid") with no hint of the clock.
- **Evidence:** `C/stack/fail-closed-results.md` step 9; `C/stack/keys-certs-time-results.md` steps 6 and 11; logs `fc9.out`, `kt1.out`. **Also (S7):** the first call after a TLS failure gives `TARGET_TLS_FAILED` with no remedy and empty details; later calls and `target show` (Health: unreachable) say `TARGET_UNAVAILABLE` "cannot connect" because the circuit breaker (3 failures in 60 s, open 30 s) is cause-less (`packages/postgres/src/budget.ts`, `CircuitBreaker.check`); a certificate with 2 days left works with no finding, health condition or log line (`D/security/network-review.md` section 4).
- **Root cause:** one class for all TLS verify errors; no skew self-check.
- **Proposed fix:** keep the verify reason code in the probe; produce `tls_expiring`; add the process-versus-database clock-skew check.
- **Acceptance test:** an expired certificate shows `tlsReason=expired`; a serve clock 10 minutes off the database turns readiness degraded with `clock_skew`.

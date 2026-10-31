# C / stack results (tester S6): certificates, keys and time; fail closed but loudly; graceful life; observability; I11

Block C, dynamic part. Tester S6 executed the STACK STEPS that C1 wrote after reading the code (`../observability.md`,
`../keys-certs-time.md`, `../fail-closed.md`, `../graceful-life.md`). One result bullet per step is in the four `*-results.md`
files of this folder (copies of C1's files; C1's own files are unchanged). The I11 (portability) run is in `i11-portability-results.md`. Findings S6-1 to S6-8 and the
open decisions are in tester S6's final message (the harness refused a write of `F/findings-S6.md` and `F/decisions-S6.md`; the lead files them).

* Commit under test `d51da5d0d8832ebc569f23985c7e5176e4d450ad`. Server `vc-1` only (Ubuntu 24.04, 4 vCPU, 8 GB, UTC).
* Stack: S1's kit with S3's two patches (copy in `/srv/work/s6-infra`), stack name `s6`: Control Store PostgreSQL 17.11 in Docker,
  `serve`, `worker`, `gateway` as systemd units of the product's bundle, targets PG16/17/18, the node agent adopting PG17.
  Ports 58480 (serve) and 58481-83 (internal probes), Control Store 58432.
* Totals (steps of the four files): CONFIRMED 30, NOT RUN 7, PARTIAL 9, REFUTED 2.

## Result per step

| step | result | in one line |
|---|---|---|
| fail-closed 1 | CONFIRMED | CONFIRMED (C1-10), measured. Current month partition audit_events_y2026m10 detached at 21:08:07 (233 rows). (a) any audited mutation: 500 INTERNAL, bo |
| fail-closed 2 | REFUTED | REFUTED as written (the injection does not make the store read-only for the product); a different, worse behaviour found |
| fail-closed 2 | CONFIRMED | CONFIRMED (C1-3), the real read-only store: a hot standby that was not promoted |
| fail-closed 3 | PARTIAL | PARTIAL: confirmed worse than C1 expected: a full Control Store disk is not "writes fail, reads work" but a crash |
| fail-closed 4 | PARTIAL | PARTIAL: the first 14 s are 500 INTERNAL as C1 predicted, then it becomes 503 CONTROL_PLANE_DEGRADED (C1 said never) |
| fail-closed 5 | CONFIRMED | CONFIRMED (C1-3), with numbers. Baseline: 200 concurrent GET /api/v1/targets for 10 s = 4,002 requests, all 200, p50 496 ms, p99 701 ms. Then LOCK TAB |
| fail-closed 6 | CONFIRMED | CONFIRMED (C1-11). POST /api/v1/projects/{id}/bundles with the CLI token (scope migrations.plan only; the real path is /projects/{id}/bundles, not ... |
| fail-closed 7 | CONFIRMED | CONFIRMED (C1-10, P3 stands). With the partition detached (step 1) POST /api/v1/targets/{dev18}/queries with select 's6mark...' returned 500 INTERNAL  |
| fail-closed 8 | PARTIAL | PARTIAL (offline half CONFIRMED; the dispatched-then-vanished half NOT RUN) |
| fail-closed 9 | PARTIAL | PARTIAL (TLS and unreachable CONFIRMED; DNS see the DNS bullet) |
| fail-closed 10 | CONFIRMED | CONFIRMED with corrections to the exit codes |
| fail-closed 11 | CONFIRMED | CONFIRMED. Worker stopped; a trivial migration applied on a fresh nonprod target: operation queued apply=not_started at t=5, 30, 55 and 80 s (never pr |
| keys-certs-time 1 | CONFIRMED | CONFIRMED (the key's life cycle) with a test device |
| keys-certs-time 2 | CONFIRMED | CONFIRMED (C1-8, P3 stands), loud and fast |
| keys-certs-time 3 | CONFIRMED | CONFIRMED. keyring rotate-mcp-key --purpose audit.pseudonym_key and --purpose auth.rate_limit_key: exponetdb: invalid arguments, exit 2 (not rotatable |
| keys-certs-time 4 | NOT RUN | NOT RUN (the run was invalid). kx2-mcpkey.sh rotated mcp.cursor_key twice (versions 2 and 3, five and a half minutes apart, the refresh interval of se |
| keys-certs-time 5 | PARTIAL | PARTIAL: renewal CONFIRMED through the gateway's clock; the agent's own clock NOT RUN; expiry/refusal CONFIRMED; RB-13 recovery see below |
| keys-certs-time 6 | CONFIRMED | CONFIRMED (C1-7). serve with +2 h (libfaketime, serve only): migration plan on a nonprod target created a plan with createdAt 2026-10-30T00:33:56Z whi |
| keys-certs-time 7 | CONFIRMED | CONFIRMED (C1-7). serve +120 s (libfaketime): the only node reads offline (was active); back to +0: active; serve -120 s: active. Raw: kt1.out. |
| keys-certs-time 8 | REFUTED | REFUTED in this one run (C1's abort was not reproduced) |
| keys-certs-time 9 | NOT RUN | NOT RUN. The gateway re-mints its in-memory TLS identity on a 24 h timer (IDENTITY_REFRESH_MS), and a monotonic timer does not follow a faked wall clo |
| keys-certs-time 10 | CONFIRMED | CONFIRMED (R2 finding stands). GET /api/v1/nodes/certificates: four authorities: root_ca notAfter 2036-10-26, issuing_ca 2031-10-28, gateway_server_ca |
| keys-certs-time 11 | CONFIRMED | CONFIRMED (C1-6). A target server certificate with 5 days left (signed by the lab CA): health healthy, conditions: [], no finding after 40 s: no tls_e |
| keys-certs-time 12 | PARTIAL | PARTIAL. nodes.enrollment_tokens: the one token (used at enrollment) has state = used and an expires_at 30 min after creation that is long past: expir |
| graceful-life 1 | NOT RUN | NOT RUN here; reproduced by S1 (F/findings-C1.md evidence line: P2 on target B stayed queued for 73 s while P1 wrote 70 operation_events in 72 s, 37 lease_acquired and 37 |
| graceful-life 2 | NOT RUN | NOT RUN here (worker SIGTERM during an apply was assigned to S1/S3 and measured by them) |
| graceful-life 3 | CONFIRMED | CONFIRMED / PARTIAL. serve: 20 concurrent GET /api/v1/targets for 25 s and systemctl stop (SIGTERM) after 8 s, twice: stopped in 12.6 s, exit status 0 |
| graceful-life 4 | CONFIRMED | CONFIRMED (stateless, no per-session memory) and a finding: concurrency costs memory before the limiter answers |
| graceful-life 5 | CONFIRMED | CONFIRMED. See fail-closed step 5 (200 concurrent reads against a locked hot table: 580 x 500 INTERNAL (571 control_store_unavailable, 10 control_stor |
| graceful-life 6 | NOT RUN | NOT RUN. It needs an old-release worker running while control-store migrate of the new release moves the schema; the stack has one Control Store at th |
| graceful-life 7 | CONFIRMED | CONFIRMED (C1: unnamed JSON limit) with the numbers |
| graceful-life 8 | PARTIAL | PARTIAL (operations and audit sizes and list times measured; chain verification not at 10 M) |
| graceful-life 9 | CONFIRMED | CONFIRMED (C1-2). See observability step 8. |
| observability 1 | CONFIRMED | CONFIRMED with one correction. serve: build_info, control_store_query_duration_seconds, http_request_duration_seconds, http_requests_total, mcp_denied |
| observability 2 | CONFIRMED | CONFIRMED (C1-4). After 30 API calls (/api/v1/targets, /fleet, /nodes x10) serve exposes exdb_http_requests_total{method="GET",route="/unmatched",stat |
| observability 3 | CONFIRMED | CONFIRMED. Same measurement as fail-closed step 11: with the worker stopped serve readiness stays 200 (body degraded), the public listener answers 200 |
| observability 4 | CONFIRMED | CONFIRMED in parts, with the injection caveat of fail-closed step 2 |
| observability 5 | CONFIRMED | CONFIRMED in parts. Disk full: 500 INTERNAL on the request that hit the PANIC, then ECONNREFUSED/control_store_unavailable and readiness 503; there is |
| observability 6 | CONFIRMED | CONFIRMED (C1 row 4), file sink and S3 (versitygw) |
| observability 7 | CONFIRMED | CONFIRMED (C1-10). Detached partition: mutation 500 INTERNAL, log http.request_failed ... errorName=AuditWriteError errorCode=audit_append_failed caus |
| observability 8 | CONFIRMED | CONFIRMED (C1-2). Seven SIGKILL / restart cycles of the worker over ~170 s (killed 3 s after each start, down ~12 s, restarted): serve's /healthz/deta |
| observability 9 | PARTIAL | PARTIAL. Node part: see fail-closed step 8 (offline after 60 s, NODE_OFFLINE at plan time, no finding, no log, no audit event; GET /nodes/certificates |
| observability 10 | CONFIRMED | CONFIRMED. iptables DROP to the target port for 35 s: GET /targets/{id}/health unreachable (conditions probe_simple_failed ..., probes target_unavaila |
| observability 11 | CONFIRMED | CONFIRMED in substance: no signal, and the plan is not refused |
| observability 12 | NOT RUN | NOT RUN (partly answered). The stack has no backup repository, so a failing host-timer backup could not be produced. What was read on the stack: the w |
| observability 13 | NOT RUN | NOT RUN (partly answered). No backup, no drill on this stack (see step 12). The absence of any backup/drill task in control.maintenance_tasks is obser |
| observability 14 | CONFIRMED | CONFIRMED (the first half; the 5-hour wait was not done) |
| observability 15 | PARTIAL | PARTIAL. ss: the three internal listeners are 127.0.0.1:58481-58483 (loopback bind is the default; the unit environment sets only the port). Public li |

## How time was handled (no VM clock step)

S1's first P1 shows that a whole-VM clock step breaks the audit chain, so the VM clock was never moved. (1) `libfaketime` on
`serve`, `worker` and `gateway` only, with the offset in a file (`/srv/work/s6/ft-<role>`, re-read on every call, monotonic clocks
not faked): `scripts/kt0-faketime-setup.sh`. (2) The node agent is a Go binary and ignores `LD_PRELOAD` (it reads the vDSO), so the
node certificate was exercised through the **gateway's** clock (`scripts/kt-gw.sh`); the agent's own `DueForRenewal` (agent clock)
was therefore not exercised. (3) Things judged on the database clock (API key, step-up, enrollment token expiry) were checked by
ageing the rows as the superuser (`session_replication_role = replica`), because the database clock cannot be moved without
breaking the audit chain. (4) The certificate lifetime (72 h) is a constant (`NODE_PROTOCOL_LIMITS.certificateHours`), not
configurable.

## Corrections to C1's static analysis

* The Control Store opens every write transaction with an explicit `READ WRITE` (`packages/control-store/src/store.ts:158`):
  `ALTER DATABASE ... SET default_transaction_read_only = on` does **not** stop mutations (fail-closed step 2). A real read-only store
  needs a standby.
* A full Control Store disk is not "writes fail, reads work": PostgreSQL PANICs on the WAL write, crash recovery fails and the
  container exits (fail-closed step 3).
* `CONTROL_PLANE_DEGRADED` (503) is also what `serve` answers once the role/scope catalog checks cannot be verified, which happens when
  the Control Store is unreachable or read-only, after the first 5-15 s of `500 INTERNAL` (fail-closed steps 2, 4, 5).
* Missing `EXPONETDB_KEYRING` is exit 2 ("Configuration refused"), malformed is exit 3 `keyring_invalid` (fail-closed step 10).
* The worker has a twelfth metric, `exdb_data_reads_total` (observability step 1).
* The bundle ingest route is `/api/v1/projects/{id}/bundles`.

## Changes to the kit (S6 copy `/srv/work/s6-infra`, nothing in `D/infra` was edited)

* S3's two fixes are reused (`cs_status` with only `EXPONETDB_CONTROL_STORE_URL`; the confirm field of a step-up is `userCode`, called with `human call`).
* `human.ts` of the throwaway `stack-kit` package in the S6 checkout: the consent lifetime can be set with `EXSTACK_CONSENT_DAYS` (a DCR client
  may not be given 30 days) and a refused consent prints the problem body. Not part of the product tree.
* New helpers in `scripts/lib6.sh`; `libfaketime` and `apache2-utils` were installed with apt on `vc-1`.
* A traps list for the next tester: `pkill -f <name>` inside an `ssh '...'` command line kills the ssh shell itself (use `pkill -f '[n]ame'`);
  a bare `wait` in a script that did `exec > >(tee ...)` waits for the `tee` for ever; `human call` signs in with a passkey on every call, so a
  broken audit chain makes it fail at the login; after a Control Store data directory is swapped back to an older copy the CLI grant is revoked by
  refresh-token reuse detection (`cli_login`); the unit environment files hold the keyring in single quotes.

## Not run, and why

See the NOT RUN bullets in the four result files. The recurring reasons: no backup repository on the stack (observability 12, 13;
the backup agents' runs are in `../backup-restore*.md`), no Traefik/Docker HEALTHCHECK on the stack (proxy effects are read from the
readiness codes), the head-of-line and worker-SIGTERM cases were already reproduced by S1/S3 and are cited, not repeated.

## Raw logs (on `vc-1`, `/srv/work/logs-s6`, never committed) and scripts (`scripts/`)

| Log | Script | What |
|---|---|---|
| `obs-1.out` | `obs-1-metrics.sh` | metric inventory per role, `/unmatched`, bind addresses |
| `fc1.out`, `fc1.ready` | `fc1-audit-partition.sh` | audit partition detached; data read before audit |
| `fc2.out`, `fc2-undo2.out` | `fc2-readonly.sh` | `default_transaction_read_only` and its undo |
| `fc2b.out` | `fc2b-standby.sh` | Control Store as an unpromoted hot standby, promotion |
| `fc3.out`, `fc3b.out` | `fc3-disk.sh`, `fc3b-disk-recovery.sh` | disk full through the bundle ingest, PANIC, recovery |
| `fc4.out` | `fc4-pause.sh` | Control Store paused; in-flight apply |
| `fc5.out`, `fc5.load` | `fc5-pool.sh`, `load.mjs` | 200 concurrent reads against a locked table |
| `fc8.out`, `fc8b.out` | `fc8-node.sh`, `fc8b-job.sh` | node agent stopped / frozen |
| `fc9.out`, `fc9b.out` | `fc9-target-tls.sh`, `fc9b-dns.sh` | target TLS (expired, wrong name, 5 days), DNS, blocked port |
| `fc10.out` | `fc10-keyring.sh` | keyring start-up cases |
| `fc11.out` | `fc11-noworker.sh` | no worker |
| `afc.out` | `afc-export.sh` | audit export: file sink and S3 (versitygw) down |
| `kr.out` | `kr-rotate.sh` | master key rotation, wrong then right order |
| `ka1.out` | `ka1-expiry.sh` | API key, step-up, enrollment token expiry |
| `kt1.out`, `kt1-late.out` | `kt1-serve-clock.sh` | serve clock +2 h / -2 h / +2 min |
| `ktgw.out` | `kt-gw.sh` | node certificate through the gateway clock |
| `kx.out` | `kx.sh` | certificate overview, `keyring status`, MCP key purposes |
| `obs-seed.out`, `obs-seed2.out`, `obs-read.out`, `obs-crash.out` | `obs-seed*.sh`, `obs-read.sh`, `obs-crashloop.sh` | ledger divergence, parked approval, crash loop |
| `gl-sigterm.out`, `gl-limits.out`, `gl-mcp.out` | `gl-*.sh` | SIGTERM per role, body limits and slow clients, MCP load |
| `i11.out` | `i11-portability.sh` | Control Store stopped: CLI offline, ledger with psql only |
| `gl-growth.out`, `gl-growth-audit.out` | `gl-growth.sh`, `gl-growth-audit.sh` | synthetic growth of operations and audit |
| `ktlease.out` | `kt-lease.sh` | worker clock step plus a blocked lease renewal during an apply |
| `ktrb13.out` | `kt-rb13.sh` | RB-13 rehearsal: decommission, move state, enroll again |
| `kx2.out` | `kx2-mcpkey.sh` | MCP cursor across one and two key rotations |
| `chain*.log` | `chain1.sh` ... `chain5.sh` | run order of the scripts |

`scripts/lib6.sh` holds the helpers (readiness timeline, the audited-mutation probe `mut`, the bearer header file); `build_results.py` and
`build_readme.py` assemble the result files from `scripts/results_data.py`. No script prints a secret: tokens go through a 0600 file
under `/dev/shm`, keyrings stay in the unit environment files.

## Clean-up

At the end the containers (`exs6-control`, `s6-s3`), loop devices, the `faketime` drop-ins, the iptables chain and the S6 stack
(`stack-down.sh`) were removed; `/srv/work/logs-s6` stays as the log store.

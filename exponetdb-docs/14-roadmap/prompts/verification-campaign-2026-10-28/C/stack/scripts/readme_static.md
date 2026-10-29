# C / stack results (tester S6): certificates, keys and time; fail closed but loudly; graceful life; observability; I11

Block C, dynamic part. Tester S6 executed the STACK STEPS that C1 wrote after reading the code (`../observability.md`,
`../keys-certs-time.md`, `../fail-closed.md`, `../graceful-life.md`). One result bullet per step is in the four `*-results.md`
files of this folder (copies of C1's files; C1's own files are unchanged). The I11 (portability) run is in `i11-portability-results.md`. Findings S6-1 to S6-8 and the
open decisions are in tester S6's final message (the harness refused a write of `F/findings-S6.md` and `F/decisions-S6.md`; the lead files them).

* Commit under test `d51da5d0d8832ebc569f23985c7e5176e4d450ad`. Server `vc-1` only (Ubuntu 24.04, 4 vCPU, 8 GB, UTC).
* Stack: S1's kit with S3's two patches (copy in `/srv/work/s6-infra`), stack name `s6`: Control Store PostgreSQL 17.11 in Docker,
  `serve`, `worker`, `gateway` as systemd units of the product's bundle, targets PG16/17/18, the node agent adopting PG17.
  Ports 58480 (serve) and 58481-83 (internal probes), Control Store 58432.
* Totals (steps of the four files): @@COUNTS@@.

## Result per step

@@TABLE@@

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

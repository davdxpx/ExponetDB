# Backup and restore on a real systemd host (tc-node-2), test campaign 2026-10-27

Tester: backup-restore-e2e agent. Host: Hetzner cx33, Ubuntu 24.04, systemd 255, PostgreSQL 17 cluster `17/exdbnode`
(port 55417, 2.7 GB `app` database), pgBackRest 2.60.0 (posix repository, `aes-256-cbc`), restic 0.16.4.
Software under test: origin/main `d0229550`, release binaries `exponetdb-node` and `exponetdb-node-helper` 0.7.0
(commit `d02295503`) from `/root/dist-0.7.0`, installed as the packaging says (sysusers, tmpfiles, units, `/usr/sbin`).
Evidence: `backup-restore-e2e/logs/` and `backup-restore-e2e/scripts/` next to this file (redacted: the generated
pgBackRest passphrase and restic password were grepped for in every copied file, zero hits; the string `wrongwrong...`
in the scripts is the deliberately wrong test key). On the server the same files are in `/root/lab/logs` and `/root/lab`.

## How the tests were driven (exactly)

1. **Helper level, shipped sandbox, real systemd (scripts `t1`..`t11`).** The release helper ran as the shipped
   `exponetdb-node-helper.socket/.service` (`ProtectSystem=strict`, `PrivateNetwork=yes`, restricted caps). A small
   Go client `labctl` (`scripts/labctl.go`, built inside `/root/exdb/agent/node/cmd/zz-labctl`) signs a job with a
   lab key (written into `/etc/exponetdb-node/helper-trust.json`) and sends it over the helper socket as the
   `exponetdb-node` user (SO_PEERCRED). Every capability (`backup.run/list/verify/expire`, `run.status/cancel`,
   `restore.prepare/execute/verify/discard`) therefore ran through the real helper and real `systemd-run` transient
   units with the real engines. Host mode, binding and repository files were set under `/etc/exponetdb-node/repositories/<id>/`.
2. **Control Plane path (scripts `zz-backup-e2e*.host.test.ts`).** New scenario tests reusing `hostScenario/HostWorld`:
   real serve/gateway/worker in process, real agent and helper as systemd units, REST with the owner session. The
   shipped harness cannot drive backups; three changes were made to the throwaway copy `/root/exdb/apps/server/test/support/host-world.ts`:
   `backupExecution: {backups:'nonprod', restores:'scratch'}` on serve and worker, the helper unit's `ReadWritePaths`
   extended by `/etc/exponetdb-node -/var/lib/exponetdb-node-engine` (the harness replaces the shipped list and would
   make run records unwritable), and the serve logger written to a file. Cluster `freshCluster:false`.
3. **Shell level** for the C-35 runbook (run by the postgres OS user from the downloaded script) and for the restic runbook variant.

Not done: the owner's real setup (T-ADV-1 against an existing production setup), a passing control-plane drill with a measured RTO
(see D-01, D-02; the run that would have proven it with a fresh backup was stopped when the session restarted), S3/R2 repositories.

## Results per item

Verdicts: PASS, FAIL, PARTIAL, NOT RUN. Durations are wall clock on this host.

### (1) pgBackRest posix repository, encrypted, on `17/exdbnode` (M-4)

| Step | Verdict | Command / path | Evidence | Duration |
|---|---|---|---|---|
| stanza, archiving, adoption of the existing repository read-only, catalog mirror (T-ADV-1 on the lab setup) | PASS | REST `POST /clusters/{id}/backup-repositories`, `POST .../backups/refresh` | `logs/b-evidence-run3.log` (B1): record `adopted_observed`, catalog mirrored, md5 of `/etc/pgbackrest`, `conf.d`, systemd units and the timer count identical before and after | adopt 2 s, refresh 3.2 s |
| full backup through `backup.run@1`, `run.status@1` until done | PASS (helper) | `labctl call backup.run`, host mode `owned` | `logs/t1-full.log` | 200 MB: 5 s run, 6 s total; 2.7 GB: 46 s (about 63 MB/s) |
| differential, incremental through `backup.run@1` | PASS (helper) | same | `logs/t1b-diff-incr-list.log`, `logs/t4-host-modes.log` | 2.6 s, 3.7 s (200 MB database) |
| the same kinds through the Control Plane | PARTIAL | REST `POST .../backup-runs` | `logs/b-evidence-run3.log` (B3): incremental on `adopted_runs` succeeded in 36 s (30 s of it the first status poll); `full` and `differential` plans are `deny`; ownership `owned` is refused `CAPABILITY_UNAVAILABLE` (D-10) | 36 s |
| `backup.list` | PASS | `labctl call backup.list` | `logs/t1b-diff-incr-list.log`: labels, kinds, LSNs, sizes, archive range, `cipher aes-256-cbc`, `systemIdentifier` | 0.1 s |
| expire at the retention boundary, kept label never expired | PASS (helper) | `backup.expire`, `keepLabels` | `logs/t1c-expire.log`: `fullCount=1` with the oldest, the second newest, or a differential of the oldest chain in `keepLabels` is refused before the engine ran (".. cannot be shown to keep .."), catalog unchanged; `fullCount=2` with the two newest kept removed the oldest chain only; WAL range moved up. No REST route for expiry exists (D-10) | 0.3 to 1.5 s |
| `backup.verify` detects a corrupt archive | **FAIL** | `backup.verify` with a flipped byte range in a WAL segment | `logs/t7-corrupt-wal-wrongkey.log`, `logs/b-evidence-run3.log` (B7 `backup verify with a corrupt WAL segment: succeeded / passed`): run `succeeded`, `verifyErrors 0`, while the excerpt says `invalid result ... Data corruption detected ... status: error` (D-03) | 20 s helper, 35 s via REST |

### (2) Supervised runs under real systemd units (T-NODE-1)

| Check | Verdict | Evidence |
|---|---|---|
| run starts as a transient unit `exponetdb-run-<runId>.service`, finishes, `run.status` terminal | PASS | `logs/t1-full.log` |
| `run.cancel@1` during a 2.7 GB full | PASS (with the documented caveat) | `logs/t2-cancel-helperkill.log`: cancel at 3.2 s, "stopping", terminal after 4.4 s as `failed` ("stopped on a cancel request after the engine began its effect", exit -1), as ADR-0037 §4 says (never `canceled` after the effect began). No pgBackRest or unit left, `pgbackrest check` ok, catalog without a partial backup. A following full resumed the aborted label (pgBackRest `resume`, label `...202504F` reused): informational |
| run record root-owned | PASS | run dir `root:postgres 0750`, `record.json root:postgres 0640`, `result.json` and `cancel.json root:root 0600`, `work/ postgres 0700`; 99 run dirs checked, zero deviations (`logs/t12-secrets-leaks.log`) |
| unit properties vs ADR-0037 and capabilities.md | PARTIAL | `logs/t1-full.log` (`systemctl show`): `User=postgres`, `NoNewPrivileges`, `PrivateTmp`, `PrivateDevices`, `ProtectSystem=strict`, `ProtectHome`, `LimitCORE=0`, `UMask=0077`, `KillMode=control-group`, `CPUWeight=IOWeight=50`, `TasksMax=256`, `MemoryMax` 2G/4G, `RuntimeMaxSec` 12 h/1 d, `TimeoutStopSec` 90 s, `Restart=no`, `StandardOutput/Error=null` match. Differences: `ReadWritePaths` also holds the repository, `/var/log/pgbackrest`, `/var/spool/pgbackrest` for every run kind, restores and reads included (ADR says only the run dir and scratch); `IPAddressDeny/Allow` empty (documented residual R-NODE-3), no `RestrictAddressFamilies`/`SystemCallFilter` (D-12) |
| `--wait --pipe` reads from inside the helper sandbox, `EnvironmentFile=` | PASS (pgBackRest reads); the restic `EnvironmentFile` was passed (`logs/t8-restic-logical.log`) |

### (3) Crash and reboot (T-NODE-2)

| Check | Verdict | Evidence |
|---|---|---|
| `kill -9` of the root helper mid-run, socket reactivation, run continues | PASS | `logs/t2-cancel-helperkill.log` (C): run unit stayed active, helper restarted by the socket (new pid), run ended `succeeded` |
| kill -9 of helper and agent mid-run through the Control Plane | PASS | `logs/b-evidence-run3.log` (B9): unit `exponetdb-run-...` active and alive after the kill, node back online, operation `succeeded`, 35 s |
| `systemctl reboot` mid-run | PARTIAL | `logs/t3-reboot-pre.log`, `t3-reboot-post.log`: the run is **`failed`** (finished 11 s after the reboot began, excerpt "terminated on signal SIGTERM / stopped on a cancel request after the engine began its effect", although no cancel was requested), not `lost` as ADR-0037 and T-NODE-2 say. Nothing restarted by itself. After boot the helper answered `job_invalid` to every job for about 30 s (clock not yet synchronized) |
| hard reset (sysrq `b`) mid-run | PASS with a delay | `logs/t3b-hardreset-post.log`: first status after boot `starting`, `lost` only 121 s after the start (`startGrace` 2 min, ops_backup.go:305), nothing restarted, PostgreSQL crash-recovered |

### (4) Host mode file states (T-NODE-3)

| Check | Verdict | Evidence |
|---|---|---|
| absent, `adopted_observed`: full, incremental refused `precondition_failed`; `adopted_runs`: full and differential refused, incremental runs, expiry refused; `owned`: all | PASS (helper) | `logs/t4-host-modes.log`; no run dir created on any refusal (run dir count unchanged) |
| unsafe owner, 0666, 0664, unknown word, case, trailing word, empty file, symlink, repository directory 0775, binding missing / other stanza / repo 2 / wrong owner / world-writable | PASS | same log, 14 refusals, nothing written |
| the same through the Control Plane | PARTIAL | `logs/b-refused-start-job.json`, `logs/b-evidence-run1.log`: the helper answers `precondition_failed: the host's repository mode adopted_observed does not allow ...` in 0.1 s, but the operation ends `failed / not_applied / OUTCOME_UNKNOWN` after 99.5 s (D-05) |

### (5) Restore preparation refusals (T-NODE-4, M-7)

| Check | Verdict | Evidence |
|---|---|---|
| existing scratch directory | PASS | `logs/t5-restore-refusals.log` (1): `scratch_exists` at prepare, `precondition_failed` at execute, directory content and counts unchanged |
| too little space | **FAIL** at execute | `logs/t11-space-wrongkey.log`: engine dir on a 512 MB tmpfs: `restore.prepare` answers `space_insufficient` (4.4 GB required) but `restore.execute` of the same run is **accepted** and fills the filesystem to 512M/512M (D-08) |
| another cluster's stanza | PASS | `t5-restore-refusals.log` (8): backup.run, expire, verify, restore.execute refused "stanza does not belong to cluster"; prepare `system_identifier_mismatch`; `backup.list` returns the foreign `systemIdentifier` so the Control Plane can compare (by design) |
| wrong node | PASS (helper `job_invalid`); control-plane `RESTORE_TARGET_MISMATCH` NOT RUN | `t5` (2) |
| wrong cluster id | PASS | `t5` (3) `precondition_failed ... another system identifier`; unknown local name `not_configured` |
| duplicate restore | PASS | `t5` (5): same run id again refused "was started already" |
| concurrent job | PASS | `t5` (6, 7): second restore, second backup and expire during a backup refused "a run of this cluster is active"; a backup during a restore is allowed (separate domains) |
| stale source | PARTIAL | `t5` (4): `prepare` says `label_not_found`, but `restore.execute` for the expired label **starts** and fails in pgBackRest (leaves a scratch dir until discard). Control-plane `PLAN_STALE` NOT RUN (my attempt to change the verification used a table name that does not exist, `logs/b-evidence-run1.log`) |
| WAL gap (segment removed) | PARTIAL | `t7` gap section: PITR across the hole fails (run `failed`); a restore to the end silently stops short and reports `succeeded` (D-04). Control-plane `RESTORE_SOURCE_INVALID` NOT RUN |
| duplicate/concurrent drills through REST | PARTIAL | `logs/b-evidence-run1.log` (B6): two drill plans applied together were both accepted (202) and both ended `VERIFICATION_FAILED` (D-01), so the second was not shown to be refused |

### (6) Restore to scratch, PITR, drills, discard (T-NODE-5, M-6)

| Check | Verdict | Evidence | Duration |
|---|---|---|---|
| restore to scratch, latest (newest backup + WAL) | PASS (helper) | `logs/t6-restore-pitr.log`: 330/330 rows, `recovery_target_reached`, probes, `row_counts` passed, scratch postmaster gone, no TCP listener | 17 s (13 s engine) |
| PITR to a time target | PASS (helper) | same: targets TS1 → 310 rows, TS2 → 320 rows, replay stopped at the last commit before the target | 17 to 18 s |
| `restore.verify` on the stopped scratch | PASS | `logs/t5b-verify-discard.log` | 7 s |
| drill end to end, selection **latest** | **FAIL** | `logs/b-evidence-run3.log`, `b3-evidence.log`: every drill ends `verification_failed`; the restore run fails in 0.05 s: `ERROR: [031]: option 'target-timeline' not valid without option 'type' in ('default', ...)` (D-01) | 6.5 s |
| selection **older** | **FAIL** | same cause | 6.4 s |
| selection **pitr_random** and explicit **pitr** | **FAIL** | `logs/b2-evidence-run1.log`, `b3-evidence.log`: restore, `recovery_target_reached`, probes pass, `amcheck: not_run` ("826 indexes checked in 5 of 7 databases; amcheck is missing in the others") fails the drill (D-02). `pitr_random` needs `wal.archive_status@1` observed and two or more verified backups (else `no_backup_selectable`, 409) | 34 to 37 s; once 97 s |
| no drill passed, so no `measuredRtoSeconds` | NOT RUN (a fresh backup after amcheck everywhere was prepared, `zz-backup-e2e4`, stopped by the session restart) | | |
| discard: only inside the scratch root, registered cluster untouched | PASS | `t5b`: removed in 0.3 s; idempotent; unknown id and a backup run id → `removed:false`, backup run dir intact; malformed id `job_invalid`; scratch path replaced by a symlink to a decoy directory: the link was removed, the decoy kept; discard while the run is active is refused ("cancel it first"); registered cluster pid, system identifier, row count and file count unchanged before and after | 0.3 s |
| leaks | PASS | `logs/t12-secrets-leaks.log`: no `exponetdb-run-*` unit, no scratch postmaster, no port 554xx listener except the two real clusters (55417, 55430). 6 scratch dirs remain from failed or aborted runs I did not discard (they stay until `restore.discard`, as documented) |

### (7) Corrupt WAL segment and passphrase (M-4)

| Check | Verdict | Evidence |
|---|---|---|
| corrupt segment inside a PITR range | PASS | `logs/t7-corrupt-wal-wrongkey.log`: run `failed`, PostgreSQL "startup process exited with exit code 1" (the restore does not promote) |
| corrupt segment hit by a restore to the end | **FAIL** at the node | `logs/t7c-corrupt-latest.log`: run `succeeded`, `recovery_target_reached passed ("recovery ended and the cluster was promoted")`, replay stopped at `0/E20030D0` while the archive ended at `E4`: 20 committed rows missing, nothing flagged by the node. The only guard is the Control Plane's `replayShort` comparison (kinds.ts:1358), which could not be observed because of D-01 (D-04) |
| wrong key | PASS | `logs/b-evidence-run3.log` (B2): refresh fails; the operation has `errorCode null` but the repository is `degraded` with reconciliation `BACKUP_REPOSITORY_UNAVAILABLE` and the finding `backup_repository_unreadable` opens. Helper level (`t11`): `backup.list`, `backup.run`, `backup.verify` → `failed "catalog is not readable"`, `restore.prepare` → `engine_cannot_read`. Key restored, repository `ok` again |

### (8) restic / pg_dump logical run and restore (M-5)

| Check | Verdict | Evidence |
|---|---|---|
| logical run (`pg_dump` + globals to a posix restic repository) through `backup.run@1` | **FAIL** | `logs/t8-restic-logical.log`: run `failed` after **234 s**: `Save(<lock/..>) returned error, retrying ... open /var/lib/restic-repo/locks/..: read-only file system`; `backup.list` empty; `backup.verify` (`restic check`) fails the same way (D-06). Passwords/keys: not in the run dir, result or journal |
| restore with the runbook's restic variant | PARTIAL | `logs/t8b-restic-runbook.log` (repository populated by hand with the same dump layout): data restored (370 accounts, 16,000,000 rows), but globals are not applied, `pg_restore --exit-on-error` stops at `GRANT .. TO reader: role "reader" does not exist`, script exit 1 (D-07). 45 s |
| missing globals file: the runbook stops | **FAIL** | same log: a snapshot without `globals.sql` does not stop the script for the missing file (D-07) |
| over- or under-privileged restore role refused | PARTIAL | the script has no restore-role concept. As root `initdb: cannot be run as root` (rc 1), as `nobody` `mkdir: Permission denied` (rc 1): OS level only |
| wrong restic password, non-empty `TARGET_DIR` | PASS | `Fatal: wrong password or no key found`, rc 1, no target dir; "TARGET_DIR exists and is not empty", rc 1 |

### (9) C-35 offline restore (T-C35-1)

| Check | Verdict | Evidence |
|---|---|---|
| runbook generated and downloaded, audited | PASS | `logs/b-evidence-run3.log` (B8): digest, 7 placeholders, 6,209 bytes, `backup.runbook.downloaded` audit row = 1, no secret in the script |
| Control Plane roles stopped (gateway and worker), script run as `postgres` into an empty directory | PASS | `logs/b3-evidence.log`: cluster started, recovery ended (`pg_is_in_recovery = f`), **370 rows = source 370** (all WAL, including the last switched segment), 31.7 s (an earlier identical run 26.6 s, `b2-evidence.log`) |
| non-empty `TARGET_DIR` refused | PASS | "TARGET_DIR exists and is not empty: refusing to restore over it" |
| wrong passphrase file for the pgBackRest runbook | NOT RUN (script `t9_c35.sh` was written but not executed when the session restarted); the restic variant's wrong password was refused |
| `exponetdb drill record-offline` (REST `POST /clusters/{id}/drills/offline`) | **FAIL** | `logs/b2-evidence-run1.log`, `b3-evidence.log`: HTTP 500 `INTERNAL` for a valid request, with the roles running and stopped; only the wrong-digest call answers 422 (D-09) |

### (10) RTO and durations (2.7 GB database, 4 vCPU, local disk)

| Operation | Time |
|---|---|
| full backup 200 MB / 2.7 GB | 6 s / 46 s |
| differential, incremental (small change) | 2.6 s, 3.7 s |
| incremental through the Control Plane (1.5 GB changed) | 35 s (30 s is the first status poll) |
| expiry | 0.3 to 1.5 s |
| `pgbackrest verify` of the whole repository | about 20 s helper, 35 s via REST |
| restore to scratch + checks (helper) | 15 to 18 s (pgBackRest 13 s) |
| PITR restore | 17 to 18 s |
| control-plane drill (pitr_random / pitr / latest) | 34 to 37 s wall, none passed, so no measured RTO |
| C-35 offline restore | 26.6 to 31.7 s |
| restic runbook restore (1.8 GB dump, pg_restore of a 2.7 GB table) | 45 s |
| `run.cancel` to terminal | 4.4 s |
| hard reset: `lost` visible | 121 s after the run started |

### Other observations (surprises)

- No secret found: the generated pgBackRest passphrase is not in the journal (all boots), run records, results, excerpts (`--repo1-cipher-pass=<redacted>`), unit properties, pgBackRest logs, vitest logs or evidence logs; it exists in `/etc/pgbackrest/pgbackrest.conf` (by design) and in my `/var/lib/c35/pass` copy. The environment of the C-35 postmaster (`PGBACKREST_REPO1_CIPHER_PASS`, by design of the script) was not inspected (no process running at the end).
- Run records are never garbage collected (99 after this session), scratch directories of failed runs stay until discarded.
- Test harness: `HostWorld` cannot drive backups as shipped (no `backupExecution`, the swapped helper `ReadWritePaths` drops the engine directory, `HelperBinary` is fixed to `/usr/sbin/exponetdb-node-helper`); with `freshCluster:false` every world leaves an `exdbtest_staging_*` database behind.
- CP polling: a run of 3 s costs about 35 s of operation time (first poll at 30 s). Informational.

## Defects

Severity: P0 data loss/security/outage, P1 wrong result or blocked core flow, P2 degraded with workaround, P3 polish.

### D-01 (P1) `latest` and `older` drills always fail on a real host

- Reproduction: `scripts/zz-backup-e2e.host.test.ts` B4 (or `t10_target.sh`): adopt, verify the newest backup, `POST /clusters/{id}/drills {selection:{kind:"latest"}}`, apply. Helper-level: `restore.execute` with target `{label:"<newest>", time:null, lsn:null, timeline:1}`.
- Expected: the drill restores the newest backup and replays the WAL to the end of the archive, passes, is discarded, RTO measured.
- Actual: `restore.execute` fails in 0.05 s, `ERROR: [031]: option 'target-timeline' not valid without option 'type' in ('default','lsn','name','standby','time','xid')`, exit 31 (`logs/b-evidence-run3.log` DIAG, `logs/t10-restore-target-semantics.log`). Operation `verification_failed`, drill `failed`. Even without the timeline (`label` only) the node builds `--type=immediate`, which stops at the end of the backup (reached `1/5C000208`, archive end `1/62...`), so the Control Plane's `replayShort` check (kinds.ts:1358) would fail it too. Only `time` targets (`pitr_random`, `pitr`) reach the checks.
- Root cause: `agent/node/internal/helper/restore.go:70-97` (`restoreTypeArgs`: a label alone means `--type=immediate`, and `--target-timeline` is appended for any type) and `packages/backups/src/kinds.ts:1088-1101` (`restoreTarget` sends the backup label plus `timeline` for `latest` and `older`, so the node cannot tell "this backup, replay to the end").
- Fix: for `latest` send no `time` and use `--type=default --set=<label>` (never `immediate` for a drill that must reach `walTo`); append `--target-timeline` only for `default`, `time`, `lsn`. Keep `immediate` as an explicit selection.
- Acceptance: pglab test running `restoreTypeArgs` outputs against real pgBackRest 2.60 for {default, label, label+timeline, time, lsn} × {timeline set, unset}; a host scenario where drills `latest`, `older`, `pitr_random` end `passed` with `measuredRtoSeconds` set.

### D-02 (P1) `amcheck: not_run` fails every drill unless the extension exists in every restored database

- Reproduction: `zz-backup-e2e2/3` C2: any drill whose restored cluster has a database without `amcheck` (a template database, an application database, or any backup older than the extension).
- Expected: RB-08 says "amcheck where installed"; a missing extension is not a failed restore.
- Actual: node returns `amcheck: not_run` ("497 indexes checked in 3 of 5 databases; amcheck is missing in the others"); the Control Plane requires every configured check to be `passed` (`configured.every(... 'passed')`), so the drill ends `VERIFICATION_FAILED`, `recovery_target_reached` and probes passed (`logs/b2-evidence-run1.log`, `logs/b3-evidence.log`: even after installing the extension in all databases, the scratch from an older backup lacks it).
- Root cause: `packages/backups/src/plans.ts:536` always lists `amcheck`; `packages/backups/src/kinds.ts:1362-1367` (`allPassed`); node: `agent/node/internal/helper/restore.go:711` returns `not_run` when any database lacks the extension.
- Fix: list `amcheck` only when the cluster reports it installed everywhere, or treat `not_run` for a check the node reports as unavailable as "not applicable" and surface it as a warning (drill `passed` with reduced assurance), or have the node create the extension in the scratch cluster with the shipped binaries (the scratch cluster is disposable).
- Acceptance: drill on a cluster with one database lacking the extension → `passed` with an `amcheck` note, or, if policy wants it strict, the plan is refused up front with a named reason; integration test with the real node check output.

### D-03 (P1) `backup.verify` never detects corruption

- Reproduction: flip bytes in one archived WAL segment (`t7_corrupt.sh`); run `backup.verify` (helper) or `POST /clusters/{id}/backups/{id}/verify` (REST).
- Expected: the run fails or reports `verifyErrors > 0`; a verified backup must not rest on a corrupt archive (`restore.source-verified`).
- Actual: run `succeeded`, `verifyErrors 0`, operation `succeeded / passed` (`logs/b-evidence-run3.log` B7); the engine excerpt says `invalid result ... Data corruption detected`, `status: error`. `pgbackrest verify` exits 0 even when it reports errors.
- Root cause: `agent/node/internal/helper/engine.go:448-466` (`pgbrVerify`): `VerifyErrors = 0` whenever the exit code is 0.
- Fix: parse the text output (`status: error`, `invalid result`, `missing`, per-backup `status`) and set `verifyErrors` to the count; fail the run when greater than 0.
- Acceptance: pglab test with a corrupted segment and a deleted segment: run state `failed` (or `verifyErrors > 0`), Control Plane verification `failed`.

### D-04 (P2) A restore to the end of the archive succeeds when the replay stops short

- Reproduction: corrupt or remove a segment after the newest backup, run a `latest`-style restore (`t7c_corrupt_latest.log`).
- Expected: never "good enough".
- Actual: node reports `succeeded`, all checks passed, replay ended before the archive end, 20 rows lost. Guard exists only in the Control Plane (`kinds.ts:1358`), unobservable until D-01 is fixed.
- Root cause: `restore.go checkRecovery` default branch ("recovery ended and the cluster was promoted") compares nothing with the archive end.
- Fix: pass the expected `walTo` to `restore.execute` (or `restore.prepare` result) and fail `recovery_target_reached` in the node when `pg_last_wal_replay_lsn` is below it.
- Acceptance: pglab corrupt-segment test expects the run `failed`.

### D-05 (P2) A refused start is reported as `OUTCOME_UNKNOWN` after about 100 s

- Reproduction: host mode file absent, plan and apply `POST /clusters/{id}/backup-runs {kind:"incremental"}` on an `adopted_runs` record (`logs/b-evidence-run1.log`, `logs/b-refused-start-job.json`).
- Expected: `failed / not_applied` with a precondition code within seconds (T-NODE-3: `PRECONDITION_FAILED`).
- Actual: the start job carries `helper refused (precondition_failed): ...` after 0.1 s, but the effect step is recorded `running`, the worker waits for reconciliation and ends `OUTCOME_UNKNOWN` after 99.5 s; the run row is `lost`.
- Root cause (suspected): the agent marks the `start_run` step before the helper answers and maps a helper refusal on an `observable` capability to an unknown outcome instead of `not_applied` with the helper code (agent job executor, `reconcile: observable`).
- Fix: map `precondition_failed`/`job_invalid` helper refusals to a definitive failed job with the code; reserve `outcome_unknown` for transport loss.
- Acceptance: host scenario with absent mode file: operation ends in under 15 s with the precondition code.

### D-06 (P1) Logical backups to a local (posix) restic repository cannot run under the shipped sandbox

- Reproduction: provision `/etc/exponetdb-node/repositories/<id>/{repository,password,mode}` with a directory repository, `backup.run` `kind logical` (`t8_restic.sh`).
- Expected: dump and snapshot succeed; M-5 setup is "restic repository directory".
- Actual: after 234 s of lock retries the run fails, `open /var/lib/restic-repo/locks/..: read-only file system`; `restic check` (`backup.verify`) fails likewise.
- Root cause: `agent/node/internal/helper/ops_backup.go:569-572` adds repository paths to `ReadWritePaths` only for pgBackRest; for restic `ProtectSystem=strict` makes a local repository read-only. The lab test (`pglab_test.go`) runs engines unsandboxed, so it never saw this.
- Fix: add the local repository path (from the `repository` file, if it is a path) to `spec.Optional`, or refuse local restic repositories at start with a clear code; cut the lock retry (`--retry-lock`/short timeout).
- Acceptance: host scenario: logical run to a directory repository succeeds, snapshot listed, `restic check` passes.

### D-07 (P2) The restic runbook neither restores globals nor stops without them

- Reproduction: `t8b_restic_runbook.sh`.
- Expected (M-5): databases and globals restore; a missing globals file stops the runbook.
- Actual: `globals.sql` is only announced ("review ... before applying it"); a dump with grants fails mid-restore at `pg_restore --exit-on-error` (`role "reader" does not exist`, rc 1) leaving a half-restored database; with no `globals.sql` in the snapshot the script does not stop on that fact.
- Root cause: `packages/backups/src/runbook.ts:337-345`.
- Fix: stop with a clear message when no `globals*.sql` exists; apply it (or print an explicit manual step and exit before `pg_restore`) before restoring databases.
- Acceptance: runbook test with a snapshot lacking the globals file exits non-zero before touching the target; with globals, roles exist after the run.

### D-08 (P2) `restore.execute` does not re-check space and can fill the filesystem

- Reproduction: engine directory on a 512 MB tmpfs (`t11_space_wrongkey.sh`): `restore.prepare` says `space_insufficient`; `restore.execute` for the same run starts and writes until the filesystem is full.
- Expected: refusal at execute; nothing written (T-NODE-4).
- Actual: run accepted, tmpfs 512M/512M. On a normal host the scratch root and the data directory usually share a filesystem, so a stale prepare can fill the filesystem under the registered cluster.
- Root cause: `ops_backup.go:876` (`restoreExecute`) does not repeat the checks of `restorePrepare` (space, `label_not_found`, `target_outside_window`).
- Fix: run the prepare checks again at execute and refuse; consider a quota or `LimitFSIZE`.
- Acceptance: helper test: execute with insufficient space and with an expired label is refused with the named code, no run dir, no scratch dir.

### D-09 (P1) `POST /clusters/{id}/drills/offline` returns HTTP 500

- Reproduction: any valid request after downloading the runbook (`zz-backup-e2e3` C3; request ids `req_01M5ZMQ3WT4Z5NJPXXJEVS1XDG`, `req_01M5ZMR5R6QNHF3RSABRFSA5CV`).
- Expected: 201 with the attested drill (T-C35-1, PG-14).
- Actual: `500 INTERNAL`, with the roles running and stopped; the wrong digest gives 422.
- Root cause (suspected, traced, not confirmed by the Postgres error; the serve logger wrote nothing and the scenario database was dropped): `packages/application/src/backups.ts:614-630` inserts into `backups.drills` with the serve store, but `packages/control-store/migrations/01M5X840BK55NGFGQ5G3Z1C5NH_backup-catalog/up.sql:584-585` grants `INSERT` on `backups.drills` to `exdb_worker` only (serve has `SELECT`). The CLI/Web tests mock the call, `http-backups.int.test.ts` never calls it.
- Fix: grant the INSERT to `exdb_serve` with a guard, or write the attestation as an operation through the worker; log 5xx causes in serve.
- Acceptance: REST integration test with the real role set: record-offline returns 201, appears in `GET /drills` as `offline_runbook / attested`, audit row exists.

### D-10 (P2) M-4 and RB-06 describe flows the Control Plane cannot start

- Reproduction: `POST /backup-repositories/{id}/ownership {to:"owned"}` → `CAPABILITY_UNAVAILABLE`; `POST .../backup-runs {kind:"full"|"differential"}` on `adopted_runs` → `deny`; no REST route for `backup.expire` in `apps/server/src/interfaces/http/api.ts`.
- Expected: M-4 ("a repository with mode `owned`", "runs through `exponetdb backup run`", "expire at the boundary") and RB-06 ("backup run --kind full where the repository is owned") work end to end.
- Actual: full, differential and expire only exist at helper level with a host mode file `owned`; verified there, not reachable through the product.
- Fix: decide: build the `owned` path or rewrite M-4/RB-06 (adopted only, incremental, host schedule takes fulls); track expiry as a planned capability.
- Acceptance: updated test matrix whose rows are executable.

### D-11 (P3) Reboot and hard reset state reporting differs from the docs

- Orderly reboot: `failed` with "stopped on a cancel request" although no cancel was made (`engine.go:345`, `ops_backup.go:311`); docs (ADR-0037 §2/§4, T-NODE-2) say `lost`. Hard reset: `starting` for up to 121 s (`startGrace`, `ops_backup.go:305`), then `lost`. For `failed`, the Control Plane will not use the `needs_attention` path the ADR table prescribes for expire/restore.
- Fix: write a distinct outcome text for a systemd stop ("host shutdown") and document it, or make shutdown `lost`; shorten the grace when the boot id changed.
- Acceptance: host test with `systemctl reboot` mid-run asserts the documented state.

### D-12 (P3) Unit hardening is looser than documented

- `ReadWritePaths` holds the repository, log and spool for every unit including restores and read-only `info`; no `IPAddressDeny` (documented residual R-NODE-3); `RestrictAddressFamilies`/`SystemCallFilter` unset; run records accumulate (99).
- Fix: read-only repository for reads and restores, `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`, record retention.

### D-13 (P3) Polish

- Message grammar "does not allow a incremental backup run" (`ops_backup.go:794`).
- For about 30 s after boot the helper refuses every job as `job_invalid` while the clock is not yet synchronized; a distinct code (`clock_untrusted`) would save an incident.
- Control-plane polling makes a 3 s run cost about 35 s.

## Verdict summary

- PASS: helper-level full/differential/incremental/list/expire, supervision and cancel, helper kill, agent+helper kill via the Control Plane, hard-reset `lost`, host modes (28 refusals), restore to scratch, PITR, discard and its safety, wrong key, C-35 offline restore (31.7 s, all WAL), concurrency and duplicate refusals.
- FAIL: `backup.verify` on corruption (D-03), all control-plane drills (D-01, D-02), logical restic backup (D-06), record-offline (D-09), execute-side space check (D-08).
- PARTIAL: control-plane backup kinds (D-10), reboot `lost` (D-11), start refusals (D-05), restic runbook (D-07), corrupt segment on latest (D-04).
- NOT RUN: passing drill with measured RTO, control-plane `RESTORE_TARGET_MISMATCH`, `scratch_exists`, `PLAN_STALE`, `RESTORE_SOURCE_INVALID`, wrong passphrase file for the pgBackRest runbook, owner's real setup, S3 repositories.

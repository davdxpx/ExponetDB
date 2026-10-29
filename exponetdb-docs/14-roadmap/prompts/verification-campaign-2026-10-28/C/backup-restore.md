# Backup, restore, PITR and drills at 7.5 GB (tester S2, block C)

Commit under test `d51da5d0` (fix PR #46), release binaries `exponetdb-node` / `exponetdb-node-helper` 0.7.0 built from it, pgBackRest 2.60.0
(posix repository, `aes-256-cbc`, `compress-type=zst`, `process-max=2`), restic 0.16.4, PostgreSQL 17.11 (PGDG), versitygw v1.8.0 (S3, TLS).
Server `vc-2` (4 vCPU, 8 GB, local disk, UTC). Lab: privileged systemd container `s2-host` (shipped agent and root helper units, real engines,
PostgreSQL cluster `17/exdbnode`), a second container `s2-host2` for the "other host" restore, `s2-s3` (versitygw). Raw logs stay on the server in
`/srv/work/s2/logs` (index: `C/backup-restore/logs-index.md`); the scripts are in `C/backup-restore/`. Status: final (the lead's session restarted once; the run was continued from the logs, nothing was measured twice). Section 9 is the verdict table, section 10 the findings.
Times in the logs are UTC; the first part of the work ran on 2026-10-28, the rest on 2026-10-29.

## 0. Dataset

`pgbench -i -s 400` (40,000,000 `pgbench_accounts` rows, 5,981 MB) plus `blobs` (1,000 rows of 512 KiB random `bytea`, 520 MB, incompressible),
`docs` (250,000 rows of about 2 KiB text, 689 MB), a one-row-per-second `marker` table and three roles (`s2_owner`, `s2_reader`, later `s2_app` with a password).
`pg_database_size('app')` = 7,198 MB (7,547,737,779 bytes), 12 GB cluster directory including `pg_wal`. Built in 107 s
(`pgbench -i`: 42.7 s, of which client-side generate 31.0 s and primary keys 11.1 s). Compression ratio of the data is high (7:1 for the whole database with zstd), so repository sizes are small;
throughputs are therefore given against the *source* size and against the repository size.

Verification instruments used in every restore: (a) the `marker` table (one row per second, `id`, `ts`; the writer logs the client return time of every commit;
the PITR target is "return time of row N plus 0.3 s", so the expected row count is exactly N; count, `sum(id)` and `md5(string_agg(id||ts))` are compared with the source);
(b) md5 of every `blobs` and `docs` row and `count/sum(aid)/sum(bid)` of `pgbench_accounts` against the source; (c) the TPC-B invariant
`sum(abalance) = sum(tbalance) = sum(bbalance)` (the history table is truncated at every pgbench start, so it is not part of the invariant).

## 1. Backups through the shipped helper (`backup.run@1`, host mode `owned`), WAL archiving under pgbench

| step | result |
|---|---|
| archiving switched on, `stanza-create`, `check` | works; `archive_timeout=60` |
| FULL, idle database | **19.2 s** wall (engine 17.8 s), 7.57 GB read, **1.11 GB** in the repository (6.8:1); 394 MB/s source throughput |
| INCREMENTAL under `pgbench -R 500` + marker | 14.5 s, 6.29 GB copied (file level: every 1 GB segment of `pgbench_accounts` is touched by random updates), 292 MB added to the repository |
| DIFFERENTIAL under load | 18.95 s, 7.52 GB copied, 1.12 GB added |
| FULL under load | 21.2 s, 7.60 GB, 1.13 GB; 358 MB/s |
| pgbench `-R 500` while the backups ran | 482 to 510 tps before, **467 to 495 during** (min 466.8), latency average 1.86 ms idle load, 2.2 to 2.6 ms during backups (max 3.6 ms), 0 failed transactions |
| WAL archiving, `-R 500` for 7 minutes | 170 segments archived, largest archive age (now minus `last_archived_time`, sampled every 15 s) 14.4 s, `failed_count` 0, backlog of `.ready` files at most 1 |
| WAL archiving, unthrottled `pgbench -c 8` for 150 s | 4,268 tps, **34.6 MiB/s of WAL (5.45 GB)**, 317 segments archived in 150 s, archiver lag at most 0.9 s, `.ready` backlog at most 1, `failed_count` 0; the repository grew by 419 MB for 5.45 GB of WAL (13:1) |

Product-reported value (`run.status`: `startedAt` .. `finishedAt`) and the stopwatch around the helper call agree to the second; the engine reports its own `completed successfully (17775ms)`.
Note: `backup.run` through the Control Plane is limited to `incremental` on an `adopted_runs` repository (see section 3); the full and differential numbers above are helper level.

## 2. Restore through the shipped helper (`restore.prepare@1`, `restore.execute@1`, scratch root, product checks plus my own verification)

All runs `succeeded`; for every run the restored cluster was started again by hand and compared with the source (section 0 instruments): **all equal, no row after the target, no row missing**.

| target | wall (prepare+execute) | product phases (restore / recover / verify / stop) | reached (product) | rows |
|---|---|---|---|---|
| end of archive, `{label:<newest>, timeline:1}` (what the Control Plane sends for `latest`) | **67.3 s** (product 67.8 s) | 8.4 / 18.1 / 39.6 / 0.6 s | timeline 2, last commit 21:00:24Z | marker 502 = source 502 |
| PITR T0 (marker 185, 20:54:21.121967) | 39.8 s | 8.5 / 7.0 / 22.0 / 1.0 | 20:54:21.121150Z (last commit before the target) | 185 = 185 |
| PITR T1 after the incremental (marker 199, 20:54:35.753400) | 40.9 s | 8.5 / 8.0 / 23.0 / 0.8 | 20:54:35.752355Z | 199 = 199 |
| PITR T2 after the differential (marker 260) | 49.8 s | 8.3 / 6.0 / 33.3 / 1.2 | 20:55:39.404611Z | 260 = 260 |
| PITR T3 after the second full (marker 324) | 51.9 s | 8.3 / 2.0 / 40.4 / 0.8 | 20:56:46.194464Z | 324 = 324 |
| PITR T4 60 s later (marker 381) | 57.3 s | 8.9 / 5.0 / 41.2 / 0.9 | 20:57:45.666752Z | 381 = 381 |

Restore of 7.6 GB into the scratch root: 8.4 s (about 900 MB/s, page-cache assisted). `restore.prepare` answered in 0.08 to 0.1 s with `spaceRequiredBytes` 7,595,789,229 and `walContinuous: null` (the node does not judge WAL continuity, see section 6).
The product-reported `recoveryReachedAt` is the commit time of the last replayed transaction; it lies 0.8 ms to 3.5 ms before the requested target in every PITR run, as it must.


## 3. The Control Plane at 7.6 GB (REST owner session, serve/gateway/worker in process, agent and helper as systemd units)

Repository adopted (`l1_physical`, pgBackRest, posix), ownership `adopted_runs`, `backup refresh` 2.9 s, five backups mirrored.

**Product verification** (`POST /clusters/{id}/backups/{id}/verify`, label scoped `pgbackrest verify`): all five `succeeded / passed`. The engine run takes 1 to 2 s per backup
(`backup runs`: STARTED/FINISHED 1 s apart); the REST operation needs 3.9 to 35.7 s because the node job is polled (see finding about polling).

**Drills (REST `POST /clusters/{id}/drills`, human session with fresh re-authentication).** Product values from `GET /drills` and `GET /restores`; the stopwatch is the outside sampler
`watch.log` (0.5 s samples of "pgbackrest restore process / scratch postmaster / scratch directory exists"), restore start to scratch postmaster gone:

| selection | source (restore record) | outcome | RTO reported (`measuredRtoSeconds`) | RTO by stopwatch | phases (restore / recover / verify) | apply accepted to operation `succeeded` |
|---|---|---|---|---|---|---|
| `latest` | newest full, WAL 2/9000000 .. 4/D4000000 (715 segments, 11.4 GB of WAL after it: 4 min of the load session, 21 h of autovacuum, the 5.45 GB burst) | passed | **105 s** | 104.3 s | 8.5 / 92.2 / 4.2 s | 217.9 s |
| `older` | the differential, WAL 1/EE000000 .. 4/D4000000 (11.8 GB) | passed | **112 s** | 111.7 s | 9 / 99 / 5 s | 219.7 s |
| `backup:<oldest full>` | WAL 1/7C000000 .. 4/D4000000 (13.7 GB) | passed | **131 s** | 130.7 s | 7.4 / 122 / - s | 220.0 s |
| `pitr_random`, `pitr:<T1>`, `pitr:<T3>` | - | **plan refused, 409** `REGISTRY_CONFLICT` reason `no_backup_selectable` / `point_in_time_outside_window` (see finding F-S2-2) | - | - | - | - |

The reported RTO equals the stopwatch to within 1 s in all three drills: the number is real. It is the time from the start of the restore to the end of verification; the operation as a whole needs 2.1 times as long, because the
worker only issues the `discard` step about 108 s after the verification ended (the 7.6 GB scratch directory stays on disk for that time). RTO scales with the WAL that must be replayed (112 to 124 MB/s here), not with the data size: 105 s for 11.4 GB of WAL, 131 s for 13.7 GB. A fresh full backup makes the same drill take 35 s (section 6).
A drill record carries `selection`, `mode control_plane`, `outcome`, `measuredRtoSeconds`, `startedAt`, `finishedAt` and `restoreId`; the restore record carries phases, source walFrom/walTo and the checks.
It does **not** carry the recovery point that was reached (no LSN, no commit time): the only statement is the check `recovery_target_reached passed: "recovery ended and the cluster was promoted"`. The RPO a drill achieved is therefore not measurable from the product's records (it is from the helper's `run.status`: `recoveryReachedAt`).
The checks a drill runs through the Control Plane are `recovery_target_reached`, `probe_simple`, `probe_extended`, `amcheck` (`not_run`: "177 indexes checked in 1 of 3 databases; amcheck is missing in the others"), `fingerprint` and `ledger_head` (`not_run`: "needs a Control Plane read of the scratch cluster (not in V1)"); **no row count or data comparison is configured**, so a drill passes with an unverified data set (see section 5).

**Offline runbook (C-35).** `GET /clusters/{id}/restore-runbook?repository=` (6,209 bytes, 7 placeholders, digest `sha256:...`, no secret in the script). Run by `postgres` into an empty directory with `CIPHER_PASS_FILE`:
**101.5 s** for the whole script on the same host (end of the archive, 502 marker rows = source, 40,000,000 accounts). `POST /clusters/{id}/drills/offline` now returns **201** (`mode offline_runbook`, `outcome attested`, `measuredRtoSeconds null`, listed by `drill list`: "MODE: offline (attested)"; TC-013 is fixed);
the wrong digest answers 422 `VALIDATION_FAILED` ("The request does not match the contract.", without naming the digest as the cause).

**CLI as a real process** (`bun apps/cli/src/main.ts`, API key of a service account with role `operator`): `backup overview`, `backup list`, `backup repositories`, `backup runs`, `drill list` work in text and JSON (0.3 to 0.4 s each).
`drill plan --selection latest` produces a plan with `decision deny`, exit code 4 `PLAN_DENIED: Policy denies this plan; it cannot be applied.` (restore apply is human only, restore.md section 8, so a CLI driven by an API key can plan but never run a drill;
a human needs the browser re-authentication). `restore runbook` with the same key: exit 3 `PERMISSION_DENIED` (`restore.runbook.get` is `humanOnly`), while `restore.execute` cannot even be delegated to a key (`SCOPE_NOT_DELEGABLE`). Neither is stated in `15-cli/reference.md`
(it lists the scope `restore.plan` for the runbook). So a real passing drill from the CLI as a process could not be produced in this lab; drills were run through REST with the owner session, exactly the calls the Web App makes.

## 4. Restore on another host from the repository only

`s2-host2` is a second container (same image, no cluster, no ExponetDB agent) with the repository mounted **read-only** and only the cipher passphrase file and the downloaded runbook:

| target | wall | result |
|---|---|---|
| end of archive (default type) | **101.0 s** | 502 = 502 marker rows, md5 of `blobs` and `docs` equal, 40,000,000 accounts, TPC-B sums equal |
| `RESTORE_TYPE=time`, T3 (marker 324) | 20.9 s | 324 = 324, md5 of the marker rows equal |
| `RESTORE_TYPE=time`, T1 (marker 199) | 25.5 s | 199 = 199, equal |

The repository was not modified by the restore (read-only mount). PASS.

## 5. Failure cases at 7.7 GB (newest full `20261029-190316F`, 263 to 273 archived segments after its stop segment)

Helper level (`backup.verify`, `restore.execute` of the end of the archive with `row_counts` on the marker table); the Control Plane level follows in section 6.
`verifyErrors` of the whole-repository verify; "label" is the label-scoped verify of the newest full, the only form the Control Plane runs.

| damage | whole repo `backup.verify` | label-scoped verify | restore to the end of the archive | data |
|---|---|---|---|---|
| 16 bytes flipped in a data file of the newest full | `failed`, verifyErrors 4 ("invalid checksum ...16427.zst", "checksum invalid: 1") 16.8 s | `failed` 4 (1.4 s) | `failed`, exit 29, 23 s: `ERROR: [029]: ... zst error: [-20] Data corruption detected` | nothing restored, scratch left until discard (`restore.discard` 0.6 s) |
| 16 bytes flipped in a MIDDLE WAL segment (not holding commits) | `failed`, 2 to 3 (17.9 s) | `succeeded` 0 (outside the backup's range) | `execute` ended `succeeded` at the process level, recovery "reached 5/66816678 ... promoted"; the marker `row_counts` check **failed** ("1 of 4 tables are outside their bounds") | rows after the hole missing |
| middle WAL segment DELETED | **`succeeded`, 0** (16.8 s) | `succeeded` 0 | recovery ended at the hole, `recovery_target_reached passed`, `row_counts failed` | rows after the hole missing |
| newest WAL segment DELETED (it held the last 12 commits) | **`succeeded`, 0** | `succeeded` 0 | **`succeeded`, all checks passed** (with the marker row_counts omitted, as the Control Plane does) | **12 committed rows missing (656 of 668)** |
| newest WAL segment corrupted (16 bytes flipped; it held the last commits) | `failed`, 2 (17.9 s) | `succeeded` 0 | **`succeeded`, all checks passed**, reached `5/F30020D0` inside the damaged segment | **4 committed rows missing (652 of 656)** |
| the STOP segment of the newest full DELETED | **`succeeded`, 0** | **`succeeded` 0** | `failed` in 11 s: `FATAL: WAL ends before end of online backup` | the newest full cannot be restored at all, while verify says it is fine |

So the corrected `backup.verify` now catches corruption of backup files and of WAL files (TC-011 fixed) but still passes **every deleted WAL segment**, including the stop segment of a backup (the residual R1 found; reproduced at 7.7 GB with all three positions).
The newest-segment cases are the dangerous ones: the restore reports success and loses committed data; the Control Plane compares the reached position with the start of the newest segment, which these runs exceed (section 6).

**Wrong cipher passphrase** (host configuration changed): `backup.list`, `backup.verify`, `backup.run` answer at once `{"code":"failed","message":"pgBackRest's catalog is not readable"}` (the run never starts, nothing is left); `restore.prepare` answers `refusals: ["engine_cannot_read"]`
(and still assigns a port); `pgbackrest info` says `FormatError: key/value found outside of section` (the file is read as plain text). WAL archiving to the encrypted repository keeps going only with the right key: with the wrong key `archive-push` failed (`failed_count` rose to 6 within 20 s).
After the configuration was restored: `check` clean. Safe state: yes (nothing was written). Way forward: restore the key from the offline copy; the message does not say "wrong key", only "catalog not readable".

**Repository deleted** (archive and backup directories moved away): `backup.list` answers **`{"backups":0}` with no error** (an empty list for a repository that does not exist; `pgbackrest info` says `status: error (missing stanza path)`);
`backup.verify` / `backup.run` are refused `precondition_failed: the stanza does not belong to cluster 17/exdbnode (system identifier)` and `restore.prepare` says `system_identifier_mismatch`: both texts describe a foreign stanza, not a missing repository.
Archiving fails (`failed_count` 6, `last_failed_wal` named). Moving the directories back: `check` clean, archiving resumes, no backlog.

## 6. The same damage through the Control Plane (REST, repository adopted as `adopted_runs`; baseline = newest full `20261029-190316F` with a fresh archive)

Baseline: product verify `passed`; drill `pitr_random` (a random time inside the window, picked 19:13:57 and 19:18:12) **passed twice, `measuredRtoSeconds` 35 s against 34.5 s by stopwatch** (restore 9.5 s, recover 21 s, verify 4 s; the check text names the last replayed commit, so this drill does report its recovery point).
With a fresh full the same drill takes 35 s instead of 105 s: the RTO is dominated by the WAL since the last backup.

| injected damage (and repair afterwards: file moved back, config restored) | product `backup verify` of the newest full | `drill latest` | what the operator sees |
|---|---|---|---|
| newest WAL segment **deleted** (held the last committed rows) | `succeeded / passed` | **`passed`**, `measuredRtoSeconds` 35, all reported checks passed | nothing; 12 committed rows are missing from the restored data (helper-level proof in section 5) |
| newest WAL segment **corrupted** (16 bytes) | `succeeded / passed` | **`passed`**, RTO 35 s | nothing; 4 committed rows missing |
| a MIDDLE WAL segment corrupted | `succeeded / passed` (the segment is outside the backup's own range) | `failed` / operation `verification_failed` / `VERIFICATION_FAILED`: check `recovery_target_reached failed: "replay reached 5/6C8035C0, the archive the plan counted on ends at 5/F5000000"`; scratch discarded; 38 s | clear, ids and positions named |
| a data file of the backup corrupted | **`verification_failed` / `VERIFICATION_FAILED`**, catalog verification `failed` (7.3 s) | a drill plan for `latest` or `backup:<id>` is answered `201 decision deny` (the backup is not verified), no restore is attempted | clear; repaired file verifies again |
| wrong cipher passphrase | `backup refresh` ends `failed / not_applied` with **`errorCode null`**; repository `degraded`, reconciliation `BACKUP_REPOSITORY_UNAVAILABLE`; protection `unknown`, reason `repository_unreadable`; `backup verify` needs **102.5 s** and ends `failed / OUTCOME_UNKNOWN` (the engine run is recorded `lost`, although the helper refused the start at once with "pgBackRest's catalog is not readable") | `failed / not_applied / RESTORE_SOURCE_INVALID` after 3.2 s | state is true, the cause (key) is not named, the 100 s wait is the D-05 shape again |
| repository deleted | same as the wrong key: refresh `failed` with `errorCode null`, `repository_unreadable`; verify 102.4 s `OUTCOME_UNKNOWN`, run `lost` | `failed / not_applied / RESTORE_TARGET_MISMATCH` after 3.4 s (the helper says `system_identifier_mismatch`: the code names a foreign stanza, not a missing repository) | misleading code |

After every repair the next `backup verify` passed again and the protection reasons lost `repository_unreadable`: the Control Plane recovers without manual state surgery. Nothing the Control Plane did touched the repository.
The protection state itself never reaches "protected" in this lab because the repository is posix, which the product never counts as off-host (`not_off_host`, `no_verified_backup`, `rpo_unknown`, PITR window `none`); the achievable RPO can therefore not be read from the product here (NOT RUN, would need an S3 pgBackRest repository).

## 7. restic logical path: local repository and S3 (versitygw v1.8.0 over TLS), with globals

Setup as the runbooks document it: `/etc/exponetdb-node/repositories/<id>/{repository,password,mode,env}` provisioned by root (S3 keys only in the 0600 `env` file), `restic init` by hand, then `backup.run kind logical databases ["app"]` through the shipped helper (the TC-012 sandbox fix works: no read-only file system).

| step | local repository | S3 (TLS, self-signed CA in the system store) |
|---|---|---|
| logical backup of `app` (7.7 GB): `pg_dump -Fc` + `pg_dumpall --globals-only`, restic snapshot | **100.0 s** (product 100.4 s), `app.dump` 1.03 GB, `globals.sql` 1,128 bytes, repository 947 MB; 77 MB/s source | **103.3 s** (product 101.5 s), repository 947 MB |
| `backup.list` | 0.5 s, snapshot listed (`kind logical`, `sizeBytes null`: restic sizes are not reported) | same |
| `backup.verify` (`restic check --read-data-subset=1/10`) | 1.3 s, `succeeded`, verifyErrors 0 | 1.3 s, same |

Control Plane: both repositories adopt (`l2_logical`, engine `restic`, provider `posix` / `s3_compatible`; an endpoint host ending in `.test`, `.local`, `.internal`, `.example`, `.invalid` is refused `VALIDATION_FAILED` without a reason, and the endpoint cannot carry a port or `http`,
so a plain-HTTP or non-443 S3 endpoint can neither be adopted nor appear in the generated runbook). `backup refresh` lists the snapshots; `POST /backup-runs {kind:"logical"}` is answered `201 decision deny` for both repositories (the Control Plane does not start logical runs; they are started on the host, as the first campaign noted).

**Restore from the generated runbook (re-check of TC-045 / D-07), small snapshots first, then 7.7 GB:**

| case | result |
|---|---|
| snapshot WITH `globals.sql` (tiny database owned by one role, `GRANT ... TO s2_reader`) | the script prints `runbook: review .../globals.sql before applying it (roles without passwords)` and goes on; `pg_restore --exit-on-error` stops at `GRANT SELECT ON TABLE public.t TO s2_reader`: **`role "s2_reader" does not exist`**, exit 1; the cluster keeps running, database `tiny` exists half restored, no role was created |
| snapshot WITHOUT a globals file | the script does not stop for the missing file; it fails the same way at the same `GRANT`, exit 1 |
| the real 7.7 GB snapshot, local repository | `restic restore` + `initdb` + start + `pg_restore`: **80.7 s** until it stopped with the same error (exit 1); the database exists with 40,000,000 accounts and 680 marker rows loaded, but the script never reports success and the roles are missing |
| the real 7.7 GB snapshot, S3 repository | NOT RUN (time); the S3 snapshot is intact (restic check passes), the script differs from the local one only in the repository URL and the two key-file placeholders |

So TC-045 / D-07 is **not fixed**: the runbook neither applies the globals nor stops without them; with roles in the dump it always ends with exit 1 and a half-restored, running cluster. The logical restore itself is fast (80.7 s for 7.7 GB when the roles exist; I did not run the manual `psql -f globals.sql` workaround to completion).

## 8. Repository full, restore without space, retention, concurrency

**Repository full** (a fresh repository on a 1.7 GB loop filesystem as `repo1`; the helper has to be restarted to see a mount made after it started, which is why my first two attempts failed to start runs at all: `START FAILED`):
full 26.6 s (1.19 GB), differential 12.4 s (+346 MB), then the incremental: **`failed`, exit 64 after 46 s**:
`ERROR: [064] ... unable to write '.../20261029-201007F_20261029-201257I/pg_data/base/16385/16415.3.zst': [28] No space left on device` (pgBackRest retried twice, 18 s each; the message comes from the engine excerpt, the helper adds nothing).
The repository is left safe: `pgbackrest info` still lists only the completed full and differential (`status: ok`); the aborted incremental directory stays and is resumed or cleaned by the next backup. WAL archiving fails at the same time:
`archive command failed with exit code 104` every second, `failed_count` 43 to 103, `.ready` backlog 20 and growing, `pg_wal` 136 files, `pgbackrest check` `ERROR: [082] WAL segment ... was not archived before the 60000ms timeout`. Way forward (documented in RB-06): free or grow the repository, then the backlog drains by itself.
After the filesystem was grown online (`truncate`, `losetup -c`, `resize2fs`) the backlog drained to 0 within the minute, `failed_count` stopped at 133, and the next incremental `succeeded` in 14.5 s (it resumed over the aborted directory). Repository-level safe state: yes; documented way forward: RB-06 (names the symptom, not the cause "repository full"; the product itself would show `wal_archive_failing`/`archive_stale` after a refresh; I did not wire the Control Plane to the loop repository, NOT RUN).

**Restore without disk space** (TC-046 / D-08): with a filler file leaving 5.0 GB free where 7.74 GB (+10 %) are needed, `restore.prepare` answers `refusals: ["space_insufficient"]` (spaceRequired 7,742,276,705, available 5,368,692,736) but
`restore.execute` with the same run id is **accepted and starts writing: the free space fell from 5.0 GB to 349 MB in 4 s**; my guard stopped the unit (exit 63) - without it the filesystem would have filled. D-08 (no re-check at execute) is **not fixed**.
Also: `restore.prepare` measures the free space of the *engine directory*, not of the scratch directory where the data is written (a separate scratch filesystem of 2.9 GB was reported as 38.7 GB available).
The Control Plane never calls execute after a refused prepare, so the exposure is a stale plan or a hand-made job; the filesystem under a registered cluster can still be filled that way.

**Retention** (helper `backup.expire`, no Control Plane route exists; the host config says `repo1-retention-full=3`, there were 3 fulls plus chains): `fullCount=1` while `keepLabels` names the oldest full is refused before anything runs
("the retention would remove, or cannot be shown to keep, backup ..."); `fullCount=1` keeping the newest full succeeds in 1.3 s (the engine runs a dry run first) and removes **three full chains and all WAL before the kept backup**: the archive window shrank from `...7C` to `5/FF .. 6/13`.
Effect on the PITR window: `restore.prepare` for the two earlier PITR targets (T1, T3) before the expiry: no refusal; after: `refusals: ["target_outside_window"]`, `walContinuous: false`. PITR to a time before the oldest remaining backup is impossible afterwards, as it must be; the refusal is clear.

**Concurrency** (helper level): a restore started 3 s after a full backup began: both `succeeded` (the restore used the previous complete backup, total 39 s); a backup started 10 s into a restore: both `succeeded`; a second backup started 2 s after another one: both `succeeded` (the first finished within 0.8 s, so no overlap was proven: PARTIAL).

## 9. Verdict per sub-item of the task

| # | item | verdict | one line |
|---|---|---|---|
| 1 | full, differential, incremental, WAL archiving under pgbench load, with time and size | **PASS** | 14.5 to 21.2 s for 7.6 GB (358 to 433 MB/s), 1.11 to 1.19 GB in the repository; archiving kept up with 34.6 MiB/s of WAL (lag <= 0.9 s, 0 failures); pgbench lost no transaction |
| 2a | restore to the end of the archive | **PASS** | 67 s (helper, with checks), 101 s on another host; data equal to the source |
| 2b | PITR to a recorded time with a marker table | **PASS** | five targets, exact marker counts and checksums, last replayed commit 0.8 to 3.5 ms before the target |
| 2c | restore on another host from the repository only | **PASS** | s2-host2, read-only repository, offline runbook, 101 s / 20.9 s / 25.5 s |
| 3a | restic logical path to a local repository | **PASS** backup and verify, **FAIL** restore | 100 s backup; the generated runbook cannot complete (globals) |
| 3b | restic logical path to S3 | **PASS** backup and verify, restore **NOT RUN** | 103 s backup, TLS endpoint; plain-HTTP or ported endpoints cannot be adopted |
| 3c | globals (roles) restored; runbook stops without them | **FAIL** | TC-045 / D-07 not fixed |
| 4 | every drill kind via the product | **PARTIAL** | `latest` 105 s, `older` 112 s, `backup:<id>` 131 s, `pitr_random` 35 s all `passed` with RTO equal to the stopwatch within 1 s; offline attested; explicit `pitr:` selections were refused at plan time; the CLI as a process can plan but not apply a drill (human only, by design); the achieved recovery point is reported only for time targets |
| 5a | corrupt backup file | **PASS** | detected by verify (4 errors), restore fails with exit 29, Control Plane `VERIFICATION_FAILED`, later drills denied |
| 5b | corrupt WAL segment | **FAIL** (newest segment) / PASS (middle) | the middle hole is caught by the drill; a damaged newest segment passes the drill with committed rows lost |
| 5c | deleted WAL segment (middle, end, stop segment) | **FAIL** | whole-repo and label verify pass in all three positions; the newest-segment case passes the drill with 12 rows lost |
| 5d | wrong key | **PARTIAL** | helper clear; Control Plane: errorCode null on refresh, 102 s `OUTCOME_UNKNOWN` on verify |
| 5e | repository full | **PASS** | engine message names the device error, repository stays safe, recoverable |
| 5f | repository deleted | **PARTIAL** | state is true (`degraded`, `unknown`) but codes mislead, `backup.list` helper answer is an empty success |
| 5g | retention vs PITR window | **PASS** | expire refuses to drop a kept label; early PITR targets become `target_outside_window`; no Control Plane route for expire |
| 5h | restore without disk space | **FAIL** | D-08 not fixed |
| 5i | restore while a backup runs | **PASS** | separate domains, both succeed |
| 6 | numbers table | **PASS** | `C/backup-restore-numbers.md` |
| - | repeat on PostgreSQL 16 and 18 | **NOT RUN** | no time in the budget; the lab image carries PostgreSQL 17 packages only; the helper and pgBackRest code paths are version-independent except `restoreTypeArgs` (covered by R1's Go tests) |
| - | achievable RPO as the product reports it | **NOT RUN** | the product counts only off-host repositories; a posix repository gives `rpo_unknown`, `pitrWindow null` by design; an S3 pgBackRest repository was not wired in |
| - | Control Plane `backup verify` of the "stop segment deleted" case, and a drill on it | **NOT RUN** | helper-level result only |

## 10. Findings (the harness refused a write to `F/findings-S2.md`; they are returned as text and kept here)

1. **[P1] A drill passes, and so does the restore, while committed data is missing: damage to the newest archived WAL segment** (area `packages/backups` `replayShort`, `selection.ts:98`, `kinds.ts:1356`; helper `restore.execute`). Reproduction: a 1 Hz marker table, `pg_switch_wal()`, wait for the archive, delete (or flip 16 bytes in) the newest segment, run `restore.execute` to the end of the archive and `POST /clusters/{id}/drills {selection:{kind:"latest"}}`. Expected: restore or drill fails, or at least reports the position reached against the last archived position. Actual: helper run `succeeded`, all checks passed, Control Plane drill `passed` with `measuredRtoSeconds 35`; the restored `marker` has 12 (deleted) or 4 (corrupted) committed rows fewer than the source. Root cause: the check compares the reached position with the *start* of the newest segment, and the drill configures no row count; `fingerprint` and `ledger_head` are `not_run`. Fix: compare with the end of the newest segment, take the archive end from `pg_stat_archiver.last_archived_wal` of the node (the node knows what it archived last), and add a mandatory data check (a count or checksum the node computed on the source at the backup's stop time). Acceptance test: host scenario with the marker table, delete / corrupt the newest segment, drill must end `failed`.
2. **[P1] `backup.verify` passes after any deleted WAL segment, including the stop segment of the newest backup, which makes it unrestorable** (residual of TC-011, reproduced at 7.7 GB: middle, newest and stop segment all `verifyErrors 0`; the stop-segment backup restores to `FATAL: WAL ends before end of online backup` while its verification is `passed`; the Control Plane's label-scoped verify also passed with the newest segment deleted). Root cause as R1: pgBackRest does not report gaps; the helper does not compute them. Fix: list the archive segment names and compute gaps; fail the verification for a gap inside a backup's start..stop range and set `walContinuous`. Acceptance: delete each of the three positions, verify must fail.
3. **[P2] The restic runbook does not apply globals and does not stop without them (TC-045 / D-07 not fixed)**: with `GRANT ... TO role` in the dump `pg_restore --exit-on-error` ends exit 1 after loading the data, leaving a running half-restored cluster; a snapshot without any globals file is not detected. Reproduced on tiny snapshots and on the 7.7 GB snapshot (80.7 s). Fix: stop before `pg_restore` when no `globals*.sql` exists, create the roles (or print the manual step and exit), refuse to continue past errors.
4. **[P2] `restore.execute` does not re-check space (D-08 not fixed) and `restore.prepare` measures the engine directory, not the scratch directory** (5.0 GB free, 7.74 GB needed: prepare refuses, execute is accepted and writes 4.6 GB in 4 s). Fix: repeat the prepare checks at execute and measure the filesystem of `scratch/`.
5. **[P2] Wrong key or deleted repository: `backup verify` needs 102 s and ends `OUTCOME_UNKNOWN` (run `lost`) although the helper refused the start at once; `backup refresh` ends `failed` with `errorCode null`; the deleted repository is reported as a foreign stanza** (`precondition_failed: the stanza does not belong to cluster`, `system_identifier_mismatch`, `RESTORE_TARGET_MISMATCH`), and the helper's `backup.list` answers `{"backups":0}` with no error. Fix: map the helper refusals (`failed`, `precondition_failed`) to definitive failures with their code, return an error for a missing stanza path, name "key" and "missing repository".
6. **[P2] `pitr_random` is refused (409 `no_backup_selectable`) while a verified backup exists until a `wal.archive_status@1` observation exists; `backup refresh` does not make it; in one world (all five backups verified, observation present) even explicit `pitr:` plans were refused `point_in_time_outside_window`.** The reason text does not say what to do; the protection state shows no PITR window. Fix: let the refresh record the archive's newest segment time, or name the missing observation in the refusal.
7. **[P3] A drill's record does not carry the recovery point reached for `latest` / `older` / `backup:` (only time targets name the last replayed commit), no data comparison, `fingerprint` and `ledger_head` are `not_run`, `amcheck` covers 1 of 3 to 7 databases.** The number the lead asked for (RPO achieved) cannot be read from the record.
8. **[P3] Latency: a drill's operation takes 2.1 times its RTO (the scratch directory is discarded 60 to 108 s after the verification), REST verify operations take 3.9 to 38 s for a 1 to 2 s engine run (node job polling).**
9. **[P3] CLI: `restore runbook` (human only) and drill apply cannot be driven with an API key (`PERMISSION_DENIED` generic text, `SCOPE_NOT_DELEGABLE`); `15-cli/reference.md` lists `restore.plan` for the runbook and does not say human only.** Also `backup run --kind logical` and `backup expire` have no Control Plane path (`decision deny`, no route).
10. **[P3] S3 adoption limits: endpoint hosts under `.test`, `.local`, `.internal`, `.example`, `.invalid` are refused with `VALIDATION_FAILED` and no reason; no port, no `http`, so lab or private S3 endpoints cannot be adopted or put into the runbook.**

Open decisions for the owner (not findings): (a) should `backup.verify` compute WAL gaps itself (D-R1-2 stands); (b) must a drill carry a data check (count or checksum from the source) before `passed`, and is `amcheck: not_run` acceptable at 1 of 7 databases (OD-60); (c) should drills be drivable from a headless CLI (a human OAuth session) or stay browser-only.

Comparison with the first campaign (same host class): drills now produce a passing record with a measured RTO (the first campaign had none): 105 / 112 / 131 / 35 s against stopwatch values within 1 s. Fixed since: TC-009 (drill `latest`/`older`), TC-010 (`amcheck` advisory), TC-011 (corrupt files and WAL counted), TC-012 (local restic repository), TC-013 (`drills/offline` 201). Not fixed: D-05 shape (100 s `OUTCOME_UNKNOWN`), D-07, D-08, D-10 (full / differential / expire / logical through the Control Plane).

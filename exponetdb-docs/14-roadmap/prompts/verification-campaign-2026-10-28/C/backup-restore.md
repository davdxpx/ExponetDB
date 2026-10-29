# Backup, restore, PITR and drills at 7.5 GB (tester S2, block C)

Commit under test `d51da5d0` (fix PR #46), release binaries `exponetdb-node` / `exponetdb-node-helper` 0.7.0 built from it, pgBackRest 2.60.0
(posix repository, `aes-256-cbc`, `compress-type=zst`, `process-max=2`), restic 0.16.4, PostgreSQL 17.11 (PGDG), versitygw v1.8.0 (S3, TLS).
Server `vc-2` (4 vCPU, 8 GB, local disk, UTC). Lab: privileged systemd container `s2-host` (shipped agent and root helper units, real engines,
PostgreSQL cluster `17/exdbnode`), a second container `s2-host2` for the "other host" restore, `s2-s3` (versitygw). Raw logs stay on the server in
`/srv/work/s2/logs` (index: `C/backup-restore/logs-index.md`); the scripts are in `C/backup-restore/`. Status of this file: **work in progress, updated as results arrive**;
the verdict table at the end is authoritative.

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

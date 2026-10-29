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

(sections 3 onward are appended below as they are measured)

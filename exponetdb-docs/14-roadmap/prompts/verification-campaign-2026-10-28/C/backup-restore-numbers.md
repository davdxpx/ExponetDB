# Backup, restore and drill numbers at 7.2 to 7.7 GB (tester S2)

Dataset: PostgreSQL 17.11, database `app` 7,198 MB (`pg_database_size` 7,547,737,779 bytes; 7.6 to 7.7 GB as pgBackRest counts it with the later load): `pgbench -s 400` (5,981 MB), `blobs` 520 MB random, `docs` 689 MB text.
Host: cx33 equivalent, 4 vCPU, 8 GB RAM, local SSD, container with systemd. Compression ratio about 6.8:1 (zstd), so repository sizes are small.
"Product-reported" = what the shipped helper (`run.status` startedAt/finishedAt, phases) or the Control Plane (drill record, restore record) says; "measured" = my stopwatch around the call, or the outside sampler `watch.log` (0.5 s samples of the restore process and the scratch postmaster).
Throughput is against the source size unless it says repository.

## Backups (helper level, mode `owned`)

| operation | dataset | duration (measured) | throughput | product-reported | verdict |
|---|---|---|---|---|---|
| FULL, idle | 7.57 GB source, 1.11 GB repository | 19.2 s | 394 MB/s source, 58 MB/s repository | 18.3 s (second-resolution start), engine 17.8 s | PASS |
| INCREMENTAL under `pgbench -R 500` | 7.59 GB, 6.29 GB copied (file level), +292 MB repository | 14.5 s | 433 MB/s | 14.2 s | PASS |
| DIFFERENTIAL under load | 7.59 GB, 7.52 GB copied, +1.12 GB | 19.0 s | 399 MB/s | 19.3 s | PASS |
| FULL under load | 7.60 GB, +1.13 GB | 21.2 s | 358 MB/s | 20.8 s | PASS |
| FULL (second baseline) | 7.69 GB, +1.18 GB | 20.2 s | 381 MB/s | 19.9 s | PASS |
| pgbench `-R 500` tps during the three backups | - | idle 482 to 510, during 467 to 495 | - | - | no failed transaction; latency 1.86 ms idle, 2.2 to 2.6 ms during |
| WAL archiving, `-R 500`, 7 min | 170 segments | max archive age 14.4 s (15 s samples), failed 0, backlog <= 1 | - | `pg_stat_archiver` | PASS |
| WAL archiving, unthrottled `pgbench -c 8` 150 s | 5.45 GB WAL, 317 segments | max archive age 0.9 s, failed 0, backlog <= 1 | 34.6 MiB/s WAL, 4,268 tps; repository +419 MB (13:1) | `pg_stat_archiver` | PASS |
| `backup.verify` label scoped (engine), clean | one 7.6 GB backup | 1.4 s | - | helper run 1 to 2 s | PASS |
| `backup.verify` whole repository, clean | 7.7 GB x 6 backups + 280 segments | 16.8 s | - | - | PASS |
| `backup.verify` through the Control Plane (REST) | one backup | 3.9 to 38 s (node job polling dominates) | - | operation `succeeded / passed` | PASS (latency note) |

## Restores (helper level, `restore.prepare` + `restore.execute` with product checks; plus my own data verification)

| operation | dataset | duration (measured) | throughput | product-reported | verdict |
|---|---|---|---|---|---|
| restore to the end of the archive (newest full + 3.5 min of WAL) | 7.6 GB | 67.3 s | 8.4 s restore (905 MB/s), 18.1 s recover, 39.6 s verify | 67.8 s; phases 8.4 / 18.1 / 39.6 / 0.6 | PASS, data equal to the source (502 marker rows, md5 of `blobs` and `docs`, 40,000,000 accounts, TPC-B sums) |
| PITR T0 (marker 185) | 7.6 GB | 39.8 s | - | 38.8 s | PASS, 185 = 185 exact |
| PITR T1 (marker 199) | 7.6 GB | 40.9 s | - | 41.2 s | PASS, exact |
| PITR T2 (marker 260) | 7.6 GB | 49.8 s | - | 49.4 s | PASS, exact |
| PITR T3 (marker 324) | 7.6 GB | 51.9 s | - | 52.1 s | PASS, exact |
| PITR T4 (marker 381) | 7.6 GB | 57.3 s | - | 56.3 s | PASS, exact |
| restore on another host, end of archive (offline runbook, read-only repository) | 7.6 GB, 11.4 GB of WAL | 101.0 s | - | (script, no product value) | PASS, data equal |
| restore on another host, PITR T3 / T1 | 7.6 GB | 20.9 s / 25.5 s | - | - | PASS, exact |
| offline runbook on the same host, end of archive | 7.6 GB | 101.5 s | - | - (attestation `measuredRtoSeconds null`) | PASS |

## Drills through the Control Plane (REST, human session; the CLI could not apply a drill, see the narrative)

| drill | dataset | RTO measured (stopwatch: restore start to scratch postmaster gone) | RTO reported (`measuredRtoSeconds`) | RPO / recovery point reported | operation wall (apply to `succeeded`) | verdict |
|---|---|---|---|---|---|---|
| `latest` (11.4 GB of WAL after the newest full, replayed at 124 MB/s) | 7.6 GB | 104.3 s | 105 s | not reported (check text "recovery ended and the cluster was promoted") | 217.9 s | PASS: number is real; 2.1x wall |
| `older` (differential, 11.8 GB of WAL) | 7.6 GB | 111.7 s | 112 s | not reported | 219.7 s | PASS |
| `backup:<oldest full>` (13.7 GB of WAL) | 7.6 GB | 130.7 s | 131 s | not reported | 220.0 s | PASS |
| `pitr_random` (random time inside the window) | 7.7 GB | 34.5 s | 35 s | reported ("last replayed commit ..." in the check detail) | 99 s | PASS |
| `pitr:<time>` / `pitr_random` right after a `pg_switch_wal` | - | - | - | - | 409 at plan time | see finding |
| offline attestation | 7.6 GB | 101.5 s (script) | none (`null`) | - | - | PASS (as designed) |


## Logical path (restic, helper level, 7.7 GB database)

| operation | dataset | duration (measured) | throughput | product-reported | verdict |
|---|---|---|---|---|---|
| `backup.run logical` to a local restic repository | 7.7 GB -> `app.dump` 1.03 GB + `globals.sql`; repository 947 MB | 100.0 s | 77 MB/s source | 100.4 s | PASS |
| `backup.run logical` to S3 (versitygw v1.8.0, TLS) | same | 103.3 s | 75 MB/s | 101.5 s | PASS |
| `backup.verify` (restic check, 1/10 of the data) | 947 MB | 1.3 s (both) | - | `succeeded`, verifyErrors 0 | PASS |
| restore from the generated restic runbook, local repository | 7.7 GB | 80.7 s until it stopped | - | script exit 1: `role "s2_reader" does not exist` (globals not applied) | **FAIL** (D-07 not fixed); data loaded, roles missing, cluster left running |
| restore from the generated restic runbook, S3 | - | - | - | - | NOT RUN (time) |

## Failure cases

| case | dataset | duration | product-reported | measured / observed | verdict |
|---|---|---|---|---|---|
| backup data file corrupted | 7.7 GB | whole-repo verify 16.8 s, label verify 1.4 s, restore stops after 23 s | verify `failed`, verifyErrors 4; restore exit 29 `zst error [-20]`; Control Plane `VERIFICATION_FAILED`, later drill plans denied | no restore, nothing silently wrong | PASS |
| middle WAL segment corrupted | 7.7 GB | restore 55 s | whole-repo verify `failed` (2), label verify `passed`; helper restore `failed` only because of the marker row count; Control Plane drill `failed`: "replay reached 5/6C8035C0, the archive the plan counted on ends at 5/F5000000" | rows after the hole missing, detected by the drill | PASS (drill) / PARTIAL (label verify blind) |
| middle WAL segment deleted | 7.7 GB | restore 52 s | whole-repo verify **`succeeded`, 0 errors**; restore reached the hole and promoted | rows after the hole missing | **FAIL** (verify) |
| newest WAL segment deleted | 7.7 GB | restore 54 s | verify `succeeded` 0; restore `succeeded`, all checks passed; Control Plane drill **`passed`**, RTO 35 s | **12 committed rows missing** | **FAIL (P1)** |
| newest WAL segment corrupted | 7.7 GB | restore 60 s | whole-repo verify `failed` (2), label verify `passed`; restore `succeeded`; Control Plane drill **`passed`** | **4 committed rows missing** | **FAIL (P1)** |
| STOP segment of the newest full deleted | 7.7 GB | restore fails after 11 s | verify (whole repo and label) **`succeeded`, 0 errors**; restore `FATAL: WAL ends before end of online backup` | the backup is unrestorable | **FAIL** (verify) |
| wrong cipher passphrase | - | helper refuses at once; Control Plane verify 102.5 s | helper: "pgBackRest's catalog is not readable"; Control Plane: refresh `failed` with `errorCode null`, verify `OUTCOME_UNKNOWN` after 102.5 s, drill `RESTORE_SOURCE_INVALID` after 3.2 s | repository `degraded`, protection `unknown`; repaired by restoring the key | PARTIAL |
| repository deleted | - | Control Plane verify 102.4 s | helper `backup.list` `{"backups":0}` without error, runs refused "stanza does not belong to cluster"; Control Plane refresh `failed`, drill `RESTORE_TARGET_MISMATCH` | WAL archiving fails (`failed_count` rises); repaired by putting the directories back | PARTIAL |
| repository full (1.7 GB loop) | 7.7 GB | incremental fails after 46 s | helper run `failed`, exit 64, "[28] No space left on device"; archive command exit 104, backlog 20 and growing, `check` ERROR 082 | repository safe (`info` ok, aborted directory left); growing the filesystem drained the backlog, next incremental 14.5 s | PASS (clear, safe, recoverable) |
| retention at the boundary | 4 chains | expire 1.3 s | refused when it would drop a kept label; otherwise removes older chains and WAL | PITR targets before the oldest backup: `target_outside_window` | PASS |
| restore without disk space | 7.74 GB needed, 5.0 GB free | prepare 0.07 s; execute started | prepare `space_insufficient`; **execute accepted**, free space 5.0 GB to 349 MB in 4 s (guard stopped it) | filesystem would fill | **FAIL** (D-08 not fixed) |
| restore while a backup runs / backup while a restore runs | 7.6 GB | 39 s | both `succeeded` | separate domains | PASS |

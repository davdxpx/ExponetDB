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

(restic, repository-full, restore-without-space, retention and the remaining failure rows follow)

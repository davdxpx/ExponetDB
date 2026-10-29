# Index of raw logs (kept on the server, not in this repository)

Server `vc-2`, directory `/srv/work/s2/logs/` (scripts: `/srv/work/s2/scripts/`, copies in this folder). The lab container is `s2-host` (privileged, systemd, shipped agent and
root helper units, PostgreSQL `17/exdbnode`); `s2-host2` is the second host; `s2-s3` is versitygw v1.8.0 with TLS. Secrets (cipher passphrase, restic password, S3 keys) were generated per run, live
only in root-owned 0600 files and were never printed or copied here.

| what | log files |
|---|---|
| dataset | `dataset.log` |
| A1 full backup, archiving on | `a1-full.log`, `bk-run_*.result.json` (the helper's complete `run.status` answer per backup) |
| A2 load session: incremental, differential, full under `pgbench -R 500` and a 1 Hz marker | `a2-load.log`, `a2.out`, `pgbench-a2.log` (5 s progress lines), `archiver.csv` (every 15 s: time, LSN, archived_count, last WAL, last time, failed_count, age, ready backlog, repository bytes), `marker.log`, `targets.tsv` (the PITR targets and the exact marker ids), `targets.tsv.final` |
| A3 unthrottled burst | `a3-burst.log`, `a3.out`, `archiver-burst.csv`, `pgbench-a3.log` |
| B restores (end of archive, five PITR targets), with verification | `b-restores.log`, `b.out`, `rs-run_*.result.json` (helper result per restore incl. phases), `scratch-run_*.log` (postmaster log of the manual start), `srcref.txt` |
| numbers appended by the scripts | `numbers.tsv` (ts, phase, detail, seconds, bytes, note) |
| C1 restic local and S3 (helper level) | `c-restic.log`, `c1.out`, `logical-*.result.json` |
| Control Plane, main run (REST + CLI as a real process + the three drills that planned) | `cp-main.log` (one JSON line per step; `drills.py` prints the drill records), `cp-main.vitest`, `watch.log` (0.5 s samples of "restore process, scratch postmaster, scratch directory": the outside stopwatch; `watch.py` prints the episodes) |
| Control Plane, offline runbook (REST, CLI refusal, run on the same host, record) | `cp-offline.log`, `cp-offline.vitest`, `offline-run.out` |
| Control Plane, restic (adopt, runbooks, globals check on tiny snapshots, 7.7 GB local restore) | `cp-restic.log`, `cp-restic.vitest`, `rb-*.out` |
| Control Plane, pitr_random plan conditions | `cp-window.log` |
| restore on another host | `d-host2.log`, `d.out`, `host2-*.out` |
| failure cases, helper level: backup file (first run), WAL mid/last/deleted, stop segment | `e1-fail-helper.log` (all runs appended), `e1.out`, `e1b.out`, `e2-last.log` / `e2.out` (newest-segment cases with committed rows in the newest segment), `e3-key.log` / `e3.out` (wrong key, deleted repository) |
| failure cases, Control Plane | `cp-fail.log`, `cp-fail.vitest` |
| repository full | `f1c-repofull.log`, `f1c.out`, `pgbench-f1c.log` (earlier attempts `f1-repofull.log`, `f1b-repofull.log`, `f1all*.out` failed to start runs because the helper did not see the late mount; see the narrative) |
| restore without space | `f2c-space.log`, `f2c.out` (the earlier loop-filesystem attempts `f2-space.log`, `f2b-space.log` were invalid: the helper runs in its own mount namespace) |
| restore and backup concurrently | `f3-concurrent.log`, `f-concurrent.out` |
| retention | `f4-retention.log`, `f-retention.out` |
| the case injector | `/srv/work/s2/scripts/s2-inject.sh` (reversible; originals under `/srv/work/s2/xfer/saved`, removed at the end) |

### [P1] A drill passes, and the restore succeeds, while committed data is missing when the newest archived WAL segment is deleted or corrupted
- **Area:** `packages/backups` (`replayShort`, `selection.ts:98`, `kinds.ts:1356`), helper `restore.execute`, Control Plane drills
- **Block:** C
- **Reproduction:** on a 7.7 GB PostgreSQL 17 dataset with a 1 Hz marker table: `pg_switch_wal()`, wait for the archive, delete (or flip 16 bytes in) the newest archived segment, run `restore.execute` to the end of the archive, and `POST /clusters/{id}/drills {selection: {kind: "latest"}}` (scripts in `C/backup-restore/`, section 5 and 6 of `C/backup-restore.md`).
- **Expected:** the restore or the drill fails, because replay did not reach the end of the archive the plan counted on.
- **Actual:** the helper restore succeeded and all its checks passed with 12 rows missing (segment deleted) or 4 rows missing (segment corrupted). The Control Plane drill `latest` ended `passed` with `measuredRtoSeconds` 35, and the label-scoped `backup verify` also passed. The drill configures no data check (`fingerprint` and `ledger_head` are `not_run`). S2's caveat: the newest segment holds commits here because `archive_timeout=0`; with `archive_timeout=60` and background WAL noise it usually holds none, but a real workload can hit the same condition.
- **Evidence:** `C/backup-restore.md` §5, §6, §10; `C/backup-restore-numbers.md`; scripts and the log index in `C/backup-restore/`.
- **Root cause:** `replayShort` compares the reached LSN with `walTo = segmentLsn(c.maxSegment)`, the START of the newest segment (`selection.ts:97-98`, `kinds.ts:1348-1356`, checked by the lead), not with the archive end the node reports; the drill adds no row-count or checksum comparison with the source. R1 found the same comparison statically.
- **Proposed fix:** compare with the archive end the node reports (`last_archived_wal`, or the end of the newest segment) and add a mandatory data check (count or checksum from the source) before a drill can be `passed`.
- **Acceptance test:** delete or flip the newest archived segment; the drill must end `failed` with a named reason, and the helper restore must not report success.

### [P1] backup.verify passes after any deleted WAL segment, including the stop segment of the newest backup, which then cannot be restored
- **Area:** `packages/backups` (`backup.verify`), helper, `wal_coverage.gaps`
- **Block:** C
- **Reproduction:** delete a WAL segment in the middle, the newest one, and the stop segment of the newest full backup, one at a time; run the whole-repository `backup.verify` and the label-scoped verify; then restore (`C/backup-restore.md` §5, §6).
- **Expected:** verification fails (or reports a gap) whenever the archive is not continuous or the backup's stop segment is missing.
- **Actual:** all three positions give `verifyErrors 0` and `passed`. For the stop segment, whole-repo and label verify say 0 errors, yet the restore dies with `FATAL: WAL ends before end of online backup`. The Control Plane's label-scoped verify also passed with the newest segment deleted.
- **Evidence:** `C/backup-restore.md` §5, §6; `F/findings-R1.md` first P1 (the same defect at small scale).
- **Root cause:** pgBackRest 2.60 reports no gaps and the helper computes none; `wal_coverage.gaps` is never written, so `wal_gap` can never fire.
- **Proposed fix:** compute WAL continuity and the presence of each backup's stop segment in the helper (or run a restore-to-end-of-archive dry run) and fail the verify.
- **Acceptance test:** for each of the three positions the verify ends `failed` with the segment name; a continuous archive still passes.

### [P2] The restic runbook does not apply globals and does not stop without them (TC-045 / D-07 not fixed)
- **Area:** `12-operations/backup-runbooks.md` (logical path), restic restore flow
- **Block:** C
- **Reproduction:** restore a restic logical snapshot whose dump contains `GRANT ... TO role` into a fresh cluster (tiny snapshot and the 7.7 GB snapshot).
- **Expected:** the runbook stops before `pg_restore` when no `globals*.sql` exists, creates the roles or prints the manual step.
- **Actual:** `pg_restore --exit-on-error` ends with exit 1 after 80.7 s (7.7 GB), leaving a running half-restored cluster (data loaded, roles missing); a snapshot without any globals file is not detected.
- **Evidence:** `C/backup-restore.md` §7.
- **Root cause:** the runbook steps do not include the globals dump and restore.
- **Proposed fix:** stop before `pg_restore` when no `globals*.sql` exists; create the roles first; refuse to start the restored cluster after a failed restore.
- **Acceptance test:** a runbook-lab test restoring a snapshot with a role grant ends `ok` with the roles present, and a snapshot without globals stops with a named message.

### [P2] restore.execute does not re-check space (D-08 not fixed), and restore.prepare measures the engine directory, not the scratch directory
- **Area:** `restore.prepare@1`, `restore.execute@1`
- **Block:** C
- **Reproduction:** 5.0 GB free, 7.74 GB needed: prepare answers `space_insufficient`; an execute is accepted anyway.
- **Expected:** execute repeats the prepare checks and measures the filesystem of the scratch directory.
- **Actual:** free space fell to 349 MB in 4 s (4.6 GB written); S2's guard stopped it.
- **Evidence:** `C/backup-restore.md` §8.
- **Root cause:** the space check is in prepare only, and it measures the wrong directory.
- **Proposed fix:** repeat the checks at execute; measure `scratch/`.
- **Acceptance test:** an execute with insufficient space is refused before any write.

### [P2] Wrong key or deleted repository: backup verify needs 102 s and ends OUTCOME_UNKNOWN although the helper refused at once; errors carry no code
- **Area:** Control Plane `backup verify` and `backup refresh`, helper `backup.list`
- **Block:** C
- **Reproduction:** `C/backup-restore.md` §6: configure a wrong cipher key, then delete the repository; run verify, refresh and `backup.list`.
- **Expected:** the helper's refusal reaches the operation immediately as a named failure; a deleted repository is reported as missing.
- **Actual:** verify takes 102 s and ends `OUTCOME_UNKNOWN` (run `lost`); `backup refresh` ends `failed` with `errorCode null`; a deleted repository shows as a foreign stanza (`RESTORE_TARGET_MISMATCH`, `system_identifier_mismatch`); the helper's `backup.list` returns `{"backups":0}` with no error.
- **Evidence:** `C/backup-restore.md` §6.
- **Root cause:** helper refusals are not mapped to operation outcomes; a missing repository is not distinguished from an empty one.
- **Proposed fix:** map the helper refusals (`failed`, with a code); report `repository_missing`.
- **Acceptance test:** a wrong key ends `failed` with a named code within seconds; a deleted repository reports `repository_missing`.

### [P2] pitr_random drills are refused until a wal.archive_status observation exists, and explicit pitr: plans stayed refused in one world
- **Area:** drill selection, `backup refresh`
- **Block:** C
- **Reproduction:** a cluster with verified backups and no `wal.archive_status@1` observation: plan a `pitr_random` drill; in a second world (all five backups verified, observation present) plan explicit `pitr:` targets.
- **Expected:** a plan, or a reason that says what to do.
- **Actual:** 409 `no_backup_selectable` until an observation exists, and `backup refresh` does not create it; in one world explicit `pitr:` plans stayed 409 `point_in_time_outside_window`. The reason text does not say what to do; the protection state shows no PITR window. S2 could not isolate the cause of the second case.
- **Evidence:** `C/backup-restore.md` §3, §6.
- **Root cause:** the window is derived from an observation that refresh does not record.
- **Proposed fix:** let the refresh record the archive's newest segment time, or name the missing observation in the reason.
- **Acceptance test:** after a refresh a `pitr_random` plan is selectable; the refusal names the missing observation.

### [P3] A drill record carries no recovery point for latest, older and backup: targets, and no data comparison
- **Area:** drill records, `restore.execute` checks
- **Block:** C
- **Reproduction:** read the drill records of S2's drills.
- **Expected:** the RPO achieved is readable; a data comparison runs.
- **Actual:** only time targets name the last replayed commit; `fingerprint` and `ledger_head` are `not_run`; `amcheck` covers 1 of 3 to 7 databases.
- **Evidence:** `C/backup-restore.md` §3, §10.
- **Root cause:** the record keeps only what the node reports.
- **Proposed fix:** record the last replayed commit time for every selection and run a count or fingerprint check.
- **Acceptance test:** every drill record names the recovery point.

### [P3] Latency: a drill's operation takes 2.1 times its RTO, and REST verify operations take 3.9 to 38 s for a 1 to 2 s engine run
- **Area:** drill and verify operations (node job polling)
- **Block:** C
- **Reproduction:** `C/backup-restore-numbers.md`: operation time against the product-reported RTO.
- **Expected:** operation time close to the engine time.
- **Actual:** the scratch directory is discarded 60 to 108 s after the verification; verify operations wait on job polling.
- **Evidence:** `C/backup-restore-numbers.md`.
- **Root cause:** polling intervals and a discard delay.
- **Proposed fix:** push the result, shorten the discard delay.
- **Acceptance test:** verify operation time is under 2 times the engine run.

### [P3] The CLI cannot drive restore runbook or a drill apply with an API key, and the reference does not say so; logical backup and expire have no Control Plane path
- **Area:** `apps/cli`, `15-cli/reference.md`
- **Block:** C
- **Reproduction:** run `restore runbook` and a drill apply with an API key; run `backup run --kind logical` and `backup expire`.
- **Expected:** a clear refusal and documentation.
- **Actual:** `PERMISSION_DENIED` generic text with `SCOPE_NOT_DELEGABLE` (human only); the reference lists `restore.plan` for the runbook without saying human only; `backup run --kind logical` is denied and expire has no route. In S2's run the drills were applied through REST with the owner session.
- **Evidence:** `C/backup-restore.md` §3, §10.
- **Root cause:** human-only actions are not marked in the CLI reference.
- **Proposed fix:** mark human-only commands in the reference and in `--help`; decide whether drills can be driven from a headless CLI.
- **Acceptance test:** the reference lists the human-only commands.

### [P3] S3 adoption refuses endpoint hosts under .test, .local, .internal, .example and .invalid with an unexplained VALIDATION_FAILED, and allows no port or http
- **Area:** S3 repository adoption
- **Block:** C
- **Reproduction:** adopt a repository with an S3 endpoint such as `s3.lab.internal`.
- **Expected:** a named reason; lab and private endpoints possible.
- **Actual:** `VALIDATION_FAILED` without a reason; no port, no `http`, so lab or private S3 endpoints cannot be adopted or put into the runbook.
- **Evidence:** `C/backup-restore.md` §7.
- **Root cause:** hostname validation without a message.
- **Proposed fix:** name the rule in the error and document the allowed forms.
- **Acceptance test:** the refusal names the rule.

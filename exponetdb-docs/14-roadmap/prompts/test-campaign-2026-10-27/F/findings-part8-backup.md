### [P1] `latest` and `older` restore drills always fail on a real host (D-01)
- **Area:** restore drills, node helper `restore.execute`, Control Plane drill planning
- **Block:** D (backup/restore end to end, M-6, T-NODE-5)
- **Reproduction:** on a real systemd host with pgBackRest 2.60.0 (`D/backup-restore-e2e/host-tests/zz-backup-e2e.host.test.ts` B4, or `scripts/t10_target.sh`): adopt a repository, verify the newest backup, `POST /clusters/{id}/drills {selection:{kind:"latest"}}`, apply. Helper level: `restore.execute` with target `{label:"<newest>", time:null, lsn:null, timeline:1}`.
- **Expected:** the drill restores the newest backup, replays the WAL to the end of the archive, passes, is discarded, RTO is measured.
- **Actual:** `restore.execute` fails in 0.05 s: `ERROR: [031]: option 'target-timeline' not valid without option 'type' in ('default','lsn','name','standby','time','xid')`, exit 31; the operation ends `verification_failed`, the drill `failed`. Without the timeline (label only) the node builds `--type=immediate`, which stops at the end of the backup (reached `1/5C000208`, archive end `1/62...`), so the Control Plane's `replayShort` check (`kinds.ts:1358`) would fail it as well. Only `time` targets (`pitr_random`, `pitr`) get past this step. No drill passed in the campaign, so no RTO was measured through the Control Plane.
- **Evidence:** `D/backup-restore-e2e.md` D-01; `D/backup-restore-e2e/logs/b-evidence-run3.log`, `logs/t10-restore-target-semantics.log`.
- **Root cause:** `agent/node/internal/helper/restore.go:70-97` (`restoreTypeArgs`: a label alone means `--type=immediate` and `--target-timeline` is appended for any type) and `packages/backups/src/kinds.ts:1088-1101` (`restoreTarget` sends the backup label plus `timeline` for `latest` and `older`, so the node cannot tell "this backup, replay to the end").
- **Proposed fix:** for `latest` send no `time` and use `--type=default --set=<label>` (never `immediate` for a drill that must reach `walTo`); append `--target-timeline` only for `default`, `time` and `lsn`; keep `immediate` as an explicit selection.
- **Acceptance test:** a `pglab` test that runs the `restoreTypeArgs` outputs against real pgBackRest 2.60 for {default, label, label plus timeline, time, lsn} x {timeline set, unset}; a host scenario in which drills `latest`, `older` and `pitr_random` end `passed` with `measuredRtoSeconds` set. Add `-tags pglab` to CI (see the CI wiring finding).

### [P1] `amcheck: not_run` fails every drill unless the extension exists in every restored database (D-02)
- **Area:** drill verification (`packages/backups`), node `restore.verify`
- **Block:** D
- **Reproduction:** `zz-backup-e2e2.host.test.ts` / `zz-backup-e2e3.host.test.ts` C2: any drill whose restored cluster has a database without `amcheck` (a template database, an application database, or any backup older than the extension). Even after installing the extension everywhere, the scratch of an older backup lacks it.
- **Expected:** RB-08 says "amcheck where installed"; a missing extension is not a failed restore.
- **Actual:** the node returns `amcheck: not_run` ("497 indexes checked in 3 of 5 databases; amcheck is missing in the others"); the Control Plane requires every configured check to be `passed`, so the drill ends `VERIFICATION_FAILED` although `recovery_target_reached` and the probes passed.
- **Evidence:** `D/backup-restore-e2e.md` D-02; `D/backup-restore-e2e/logs/b2-evidence-run1.log`, `logs/b3-evidence.log`.
- **Root cause:** `packages/backups/src/plans.ts:536` always lists `amcheck`; `packages/backups/src/kinds.ts:1362-1367` (`allPassed`); node `agent/node/internal/helper/restore.go:711` returns `not_run` when any database lacks the extension.
- **Proposed fix:** list `amcheck` only when the cluster reports it installed everywhere, or treat `not_run` for a check the node reports unavailable as "not applicable" and surface a warning (drill `passed` with reduced assurance), or let the node create the extension in the disposable scratch cluster with the shipped binaries (owner decision on strictness).
- **Acceptance test:** a drill on a cluster with one database lacking the extension ends `passed` with an `amcheck` note (or, if policy wants it strict, the plan is refused up front with a named reason); an integration test with the real node check output.

### [P1] `backup.verify` never detects corruption (D-03)
- **Area:** backup verification (`pgbackrest verify`), `restore.source-verified`
- **Block:** D (M-4)
- **Reproduction:** flip bytes in one archived WAL segment (`scripts/t7_corrupt.sh`); run `backup.verify` (helper) or `POST /clusters/{id}/backups/{id}/verify` (REST).
- **Expected:** the run fails or reports `verifyErrors > 0`; a verified backup must not rest on a corrupt archive.
- **Actual:** the run `succeeded`, `verifyErrors 0`, the operation `succeeded / passed`, although the engine output says `invalid result ... Data corruption detected`, `status: error` (`pgbackrest verify` exits 0 even when it reports errors).
- **Evidence:** `D/backup-restore-e2e.md` D-03; `D/backup-restore-e2e/logs/b-evidence-run3.log` (B7).
- **Root cause:** `agent/node/internal/helper/engine.go:448-466` (`pgbrVerify`): `VerifyErrors = 0` whenever the exit code is 0.
- **Proposed fix:** parse the text output (`status: error`, `invalid result`, `missing`, per-backup `status`) and set `verifyErrors` to the count; fail the run when greater than 0.
- **Acceptance test:** a `pglab` test with a corrupted segment and one with a deleted segment: run state `failed` (or `verifyErrors > 0`) and the Control Plane verification `failed`; a clean repository still passes.

### [P1] Logical backups to a local (posix) restic repository cannot run under the shipped sandbox (D-06)
- **Area:** node helper backup runs (restic, `pg_dump`), units
- **Block:** D (M-5)
- **Reproduction:** provision `/etc/exponetdb-node/repositories/<id>/{repository,password,mode}` with a directory repository, `backup.run` `kind logical` (`scripts/t8_restic.sh`).
- **Expected:** dump and snapshot succeed (M-5 setup is a restic repository directory).
- **Actual:** after 234 s of lock retries the run fails with `open /var/lib/restic-repo/locks/..: read-only file system`; `restic check` (`backup.verify`) fails likewise. The lab test runs the engines unsandboxed, so it never saw this.
- **Evidence:** `D/backup-restore-e2e.md` D-06; `D/backup-restore-e2e/logs/t8-restic-logical.log`.
- **Root cause:** `agent/node/internal/helper/ops_backup.go:569-572` adds repository paths to `ReadWritePaths` only for pgBackRest; for restic `ProtectSystem=strict` makes a local repository read-only.
- **Proposed fix:** add the local repository path (from the `repository` file, when it is a path) to the unit's writable paths (`spec.Optional`) or refuse local restic repositories at start with a clear code; cut the lock retry (`--retry-lock` or a short timeout).
- **Acceptance test:** a host scenario: a logical run to a directory repository succeeds, the snapshot is listed and `restic check` passes.

### [P1] `POST /clusters/{id}/drills/offline` returns HTTP 500 (D-09)
- **Area:** REST drills offline record (C-35 attestation, PG-14)
- **Block:** D (T-C35-1)
- **Reproduction:** any valid request after downloading the runbook (`zz-backup-e2e3.host.test.ts` C3; request ids `req_01M5ZMQ3WT4Z5NJPXXJEVS1XDG`, `req_01M5ZMR5R6QNHF3RSABRFSA5CV`); the roles running and stopped; a wrong digest correctly gives 422.
- **Expected:** `201` with the attested drill (listed in `GET /drills` as `offline_runbook / attested`, audited).
- **Actual:** `500 INTERNAL`. The C-35 offline restore itself works (27 to 32 s, 370 of 370 rows, a non-empty `TARGET_DIR` is refused), so the attestation path is the only broken step.
- **Evidence:** `D/backup-restore-e2e.md` D-09 (cause traced, not confirmed by the Postgres error; the serve logger wrote nothing and the scenario database was dropped).
- **Root cause:** (suspected) `packages/application/src/backups.ts:614-630` inserts into `backups.drills` with the serve store, but `packages/control-store/migrations/01M5X840BK55NGFGQ5G3Z1C5NH_backup-catalog/up.sql:584-585` grants `INSERT` on `backups.drills` to `exdb_worker` only (serve has `SELECT`). The CLI/Web tests mock the call and `http-backups.int.test.ts` never calls it.
- **Proposed fix:** grant `INSERT` to `exdb_serve` through a guarded additive bundle (the backup-catalog bundle is frozen), or write the attestation as an operation through the worker; log the cause of every 5xx in serve.
- **Acceptance test:** a REST integration test with the real role set: record-offline returns 201, appears in `GET /drills` as `offline_runbook / attested`, the audit row exists; a unit test that a serve-side 5xx logs its cause.

### [P2] A restore to the end of the archive reports success when the replay stops short (D-04)
- **Area:** node `restore.execute` verification
- **Block:** D (M-4, M-7)
- **Reproduction:** corrupt or remove a WAL segment after the newest backup and run a restore to the end of the archive (`scripts/t7c.sh`, `logs/t7c-corrupt-latest.log`). A corrupt segment inside a PITR range correctly fails the restore (PASS).
- **Expected:** never "good enough".
- **Actual:** the node reports `succeeded`, all checks passed, the replay ended before the archive end, 20 rows lost. The only guard is in the Control Plane (`kinds.ts:1358`), unobservable until the `latest` drill bug is fixed.
- **Evidence:** `D/backup-restore-e2e.md` D-04.
- **Root cause:** `agent/node/internal/helper/restore.go` `checkRecovery` default branch ("recovery ended and the cluster was promoted") compares nothing with the archive end.
- **Proposed fix:** pass the expected `walTo` to `restore.execute` (or return it from `restore.prepare`) and fail `recovery_target_reached` in the node when `pg_last_wal_replay_lsn` is below it.
- **Acceptance test:** a `pglab` corrupt-segment test expects the run `failed`; a clean restore to the end passes.

### [P2] A refused backup start is reported as `OUTCOME_UNKNOWN` after about 100 seconds (D-05)
- **Area:** node job executor, Control Plane reconciliation
- **Block:** D (T-NODE-3, M-7)
- **Reproduction:** host mode file absent; plan and apply `POST /clusters/{id}/backup-runs {kind:"incremental"}` on an `adopted_runs` record (`logs/b-evidence-run1.log`, `logs/b-refused-start-job.json`).
- **Expected:** `failed / not_applied` with a precondition code within seconds.
- **Actual:** the start job carries `helper refused (precondition_failed): ...` after 0.1 s, but the effect step is recorded `running`, the worker waits for reconciliation and ends `OUTCOME_UNKNOWN` after 99.5 s; the run row is `lost`.
- **Evidence:** `D/backup-restore-e2e.md` D-05.
- **Root cause:** (suspected) the agent marks the `start_run` step before the helper answers and maps a helper refusal on an `observable` capability to an unknown outcome instead of `not_applied` with the helper code (agent job executor).
- **Proposed fix:** map `precondition_failed` and `job_invalid` helper refusals to a definitive failed job with the code; reserve `outcome_unknown` for transport loss.
- **Acceptance test:** a host scenario with an absent mode file: the operation ends in under 15 s with the precondition code.

### [P2] The restic runbook neither restores globals nor stops without them (D-07)
- **Area:** `packages/backups/src/runbook.ts`
- **Block:** D (M-5)
- **Reproduction:** `scripts/t8b_restic_runbook.sh`: a dump with grants fails mid-restore at `pg_restore --exit-on-error` (`role "reader" does not exist`, rc 1) leaving a half-restored database; with no `globals.sql` in the snapshot the script does not stop on that fact.
- **Expected:** databases and globals restore; a missing globals file stops the runbook (M-5).
- **Actual:** `globals.sql` is only announced ("review ... before applying it").
- **Evidence:** `D/backup-restore-e2e.md` D-07.
- **Root cause:** `packages/backups/src/runbook.ts:337-345`.
- **Proposed fix:** stop with a clear message when no `globals*.sql` exists; apply it (or print an explicit manual step and exit before `pg_restore`) before restoring databases.
- **Acceptance test:** a runbook test with a snapshot lacking the globals file exits non-zero before touching the target; with globals the roles exist after the run.

### [P2] `restore.execute` does not re-check space and can fill the filesystem (D-08)
- **Area:** node helper restore preparation/execution
- **Block:** D (T-NODE-4)
- **Reproduction:** engine directory on a 512 MB tmpfs (`scripts/t11_space_wrongkey.sh`): `restore.prepare` says `space_insufficient`; `restore.execute` for the same run starts and writes until the filesystem is full (tmpfs 512M/512M).
- **Expected:** refusal at execute; nothing written.
- **Actual:** run accepted; on a normal host the scratch root and the data directory usually share a filesystem, so a stale prepare can fill the filesystem under the registered cluster.
- **Evidence:** `D/backup-restore-e2e.md` D-08.
- **Root cause:** `agent/node/internal/helper/ops_backup.go:876` (`restoreExecute`) does not repeat the checks of `restorePrepare` (space, `label_not_found`, `target_outside_window`).
- **Proposed fix:** run the prepare checks again at execute and refuse; consider a quota or `LimitFSIZE`.
- **Acceptance test:** a helper test: execute with insufficient space and with an expired label is refused with the named code, no run directory and no scratch directory are created.

### [P2] M-4 and RB-06 describe backup flows the Control Plane cannot start (D-10)
- **Area:** backup runs through the product, `backup.expire`, ownership
- **Block:** D (M-4, W9-05 hand-over)
- **Reproduction:** `POST /backup-repositories/{id}/ownership {to:"owned"}` -> `CAPABILITY_UNAVAILABLE`; `POST .../backup-runs {kind:"full"|"differential"}` on `adopted_runs` -> `deny`; no REST route for `backup.expire` in `apps/server/src/interfaces/http/api.ts`.
- **Expected:** M-4 ("a repository with mode `owned`", "runs through `exponetdb backup run`", "expire at the boundary") and RB-06 work end to end.
- **Actual:** full, differential and expire exist only at helper level with a host mode file `owned` (verified there: kept label never expired); through the Control Plane only incremental on `adopted_runs` works.
- **Evidence:** `D/backup-restore-e2e.md` D-10.
- **Root cause:** the hand-over to `owned` is not built (W9-05) and `backup.expire` has no route.
- **Proposed fix:** owner decision: build the `owned` path and the expire route, or rewrite M-4 and RB-06 to the adopted-only flow and mark expiry as a planned capability.
- **Acceptance test:** an updated test matrix whose rows are all executable; an integration test for whichever path is chosen.

### [P3] Reboot state reporting, unit hardening and polish of the backup runs (D-11, D-12, D-13)
- **Area:** node helper supervision, units, messages
- **Block:** D (T-NODE-1, T-NODE-2)
- **Reproduction:** (D-11) `systemctl reboot` mid-run: the run ends `failed` with "stopped on a cancel request" although no cancel was made (`agent/node/internal/helper/engine.go:345`, `ops_backup.go:311`); the docs (ADR-0037 sections 2 and 4, T-NODE-2) say `lost`; a hard reset leaves `starting` for 121 s (`startGrace`, `ops_backup.go:305`) then `lost`; for `failed` the Control Plane does not take the `needs_attention` path the ADR table prescribes. (D-12) `ReadWritePaths` holds the repository, log and spool for every unit including restores and read-only `info`; no `IPAddressDeny` (documented residual R-NODE-3); `RestrictAddressFamilies` and `SystemCallFilter` unset; run records accumulate (99). (D-13) "does not allow a incremental backup run" (`ops_backup.go:794`); for about 30 s after boot the helper refuses every job as `job_invalid` while the clock is not yet synchronized (a distinct `clock_untrusted` would save an incident); control-plane polling makes a 3 s run cost about 35 s.
- **Expected:** documented states and tight units.
- **Actual:** as listed. Passing: cancel ends `failed` as documented, run records are root-owned, helper kill and agent plus helper kill recover, nothing restarts by itself.
- **Evidence:** `D/backup-restore-e2e.md` D-11 to D-13.
- **Root cause:** as cited.
- **Proposed fix:** write a distinct outcome text for a systemd stop ("host shutdown") and document it, or make shutdown `lost`, and shorten the grace when the boot id changed; read-only repository for reads and restores; `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`; record retention; fix the grammar.
- **Acceptance test:** a host test with `systemctl reboot` mid-run asserts the documented state; `verify-units.sh` asserts the tightened directives.

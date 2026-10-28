# Findings of tester R1 (block R, TC-001 to TC-013)

Commit under test `d51da5d0`, pre-fix `d0229550`. Pinned toolchain on a disposable cx33 (Node 24.22.1, Bun 1.4.4, Go 1.26.10, Ubuntu 24.04, UTC); real pgBackRest 2.60.0, restic 0.16.4, PostgreSQL 16/17/18 from PGDG; the node-agent lab ran in a privileged systemd container (`r1-host`) on that server. Raw logs stay on the server, indexed in `R/R1-notes/logs-index.md`. Probe sources are under `R/R1-notes/probes/`.

### [P1] `backup.verify` passes a repository with a deleted WAL segment, and no component detects WAL gaps (residual of TC-011)
- **Area:** node helper `backup.verify` (`agent/node/internal/helper/engine.go` `pgbrVerify`), backup catalog `backups.wal_coverage` (`packages/backups/src/reconcile.ts:367`), protection state `wal_gap`
- **Block:** R
- **Reproduction:** on a host with pgBackRest 2.60.0 and the released helper of `d51da5d0` (lab script `t11gap2.sh`, `t11gap3.sh`, `R/R1-notes/probes/`): take four full backups with WAL between them; delete the archived WAL segment named as the `stop` segment of the newest backup (`pgbackrest info --output=json` -> `.backup[-1].archive.stop`, here `000000010000000000000012`) from `/var/lib/pgbackrest/archive/<stanza>/17-1/0000000100000000/`; call `backup.verify` (whole repository); then `restore.execute` of that backup with target `{label:<newest>, time:null, lsn:null, timeline:null}`.
- **Expected:** the verification fails (a verified backup must not rest on an archive that cannot make it consistent); the catalog shows a `wal_gap` and `walContinuous` false; `restore.prepare` refuses or warns.
- **Actual:** `pgbackrest verify --verbose` itself prints `status: ok`, `backup: <label>, status: valid, total valid files: 1271` and exits 0 although its own DETAIL lines list two disjoint WAL ranges (`..01-..11` and `..13-..16`); the helper run is `succeeded`, `verifyErrors 0`; `restore.prepare` answers `engineCanRead true, walContinuous null, refusals []`; the restore then fails with `FATAL: WAL ends before end of online backup` (exit 1). The fix of TC-011 counts what pgBackRest reports (corrupt WAL: 3, truncated WAL: 3, corrupt backup file: 4, deleted backup file: 4 - all verified as `failed`), but pgBackRest does not report a deleted WAL segment at all, so the "deleted segment" half of the finding's acceptance test (`failed or verifyErrors > 0`) cannot be met by parsing its output. Separately `backups.wal_coverage.gaps` is never written (the only INSERT, `reconcile.ts:367-381`, sets min/max only; the column default is `[]`), so `wal_gap` in the protection state (`protection.ts:188`) and `gapEnds` in `selection.ts:82` can never fire; `architecture.md:79` documents gaps as recorded.
- **Evidence:** `R/R1-notes/TC-011.md`, probes `t11r1.sh`, `t11gap.sh`, `t11gap2.sh`, `t11gap3.sh`; server logs `/srv/work/r1/lab` (`new-t11r1.log`, `new-t11gap*.log`).
- **Root cause:** `pgbrVerify` trusts `pgbackrest verify`; pgBackRest verifies the WAL a backup needs only as the ranges it finds, and reports a hole between two ranges only when a backup's start..stop falls into it (here it did not even for the newest stop segment); the catalog has no gap computation from the segment list.
- **Proposed fix:** have the node list the archive segment names (`pgbackrest info` gives min/max only; the directory listing gives all), compute the gap ends and write them into `wal_coverage.gaps`; make `backup.verify` fail (verifyErrors += gaps inside any backup's start..stop and between the newest backup and the archive end); make `restore.prepare` set `walContinuous` from it.
- **Acceptance test:** `pglab`: delete (a) a segment between two segments after the newest backup, (b) the newest backup's stop segment, and (c) the last segment: `backup.verify` ends `failed` or `verifyErrors > 0` for (b), the catalog reports `wal_gap` for (a) and (b), `walContinuous` is false; a clean repository still passes.

### [P1] Another quadratic regular expression over bundle text: the `-- check:` directive of `verify.sql` (neighbour of TC-004)
- **Area:** `packages/postgres/src/parser/verify-checks.ts:45` (`DIRECTIVE`), reached from `analyzeVerifyFile` in the planner (`planner.ts:230`, serve), `reverify.ts:156`, `verification.ts:289` (worker) and the lint
- **Block:** R
- **Reproduction:** `analyzeVerifyFile(17, '-- check: ok' + ' '.repeat(n) + 'x\nSELECT true AS ok;\n')`, probe `R/R1-notes/probes/tc004-neighbour-verify-directive.mts`, `node --conditions=@exponetdb/source`: n = 10,000: 128 ms; 20,000: 485 ms; 40,000: 1,785 ms; 80,000: 7,071 ms (x4 per x2, quadratic). The request body limit for bundle text is 32 MiB (`MIGRATION_BODY_LIMIT_BYTES`), so 1 MiB of white space is about twenty minutes on the synchronous event loop of serve (at ingest-and-plan) and of the worker (at verification), and the bundle stays stored in the project stream.
- **Expected:** linear time; the regular expression class that TC-004 removed from `guardStrictness` does not remain elsewhere in `packages/postgres`.
- **Actual:** `(.*?)\s*$` rescans the trailing white space from every position of the lazy group.
- **Evidence:** `R/R1-notes/TC-004.md`, probe output in the same file.
- **Root cause:** `DIRECTIVE = /^--\s*(check|covers|calls|reads-view):[ \t]*(.*?)\s*$/` (lazy group followed by `\s*$`).
- **Proposed fix:** match `^--\s*(check|covers|calls|reads-view):[ \t]*(.*)$` and `trimEnd()` the captured value (linear).
- **Acceptance test:** `packages/postgres/test/verify-checks.test.ts`: a directive line followed by 1 MiB of white space is analysed in under 200 ms and the ratio time(1 MiB)/time(256 KiB) is below 8; existing directive tests unchanged.

### [P2] The recovery supersession closes the stuck operation before the recovery's own checks, and the close commits when the recovery is refused (TC-005 follow-up, the lead's check)
- **Area:** `packages/operations/src/driver.ts:178-186` (`closeSuperseded` before `acquireLocks`, `checkBindings` and `options.admit` in one transaction), `packages/operations/src/supersede.ts`
- **Block:** R
- **Reproduction:** probe `R/R1-notes/probes/r1-supersede-order.int.test.ts` (beside `driver.int.test.ts`, PostgreSQL 17): a synthetic kind ends `needs_attention`; a recovery plan names it; then (a) `checkBindings` reports a changed binding after acceptance, (b) `admit` reports `authorization` (GRANT_REVOKED, E27), (c) the recovery's second domain is held by another operation.
- **Expected:** a recovery that is refused, stale, revoked or blocked leaves the stuck operation exactly as it was (`needs_attention`, domain held).
- **Actual:** in all three cases the stuck operation is `verification_failed`, its domain released, while the recovery is `failed PLAN_STALE`, `failed GRANT_REVOKED` or still `queued` (waiting). Output of the run: `[r1] stale stuck op {"state":"verification_failed",...,"locks":[]}`, `[r1] revoked stuck op {"state":"verification_failed",...}`, `[r1] blocked stuck op {"state":"verification_failed",...}` with `blocked holder` still `needs_attention`. The start transaction returns normally for these outcomes, so it commits. The revoked case is an authority that no longer exists changing another operation's state.
- **Evidence:** `R/R1-notes/TC-005.md`.
- **Root cause:** `driver.ts:179` calls `closeSuperseded` first because the domain must be free for `acquireLocks`; every later refusal is a normal return, not a rollback.
- **Proposed fix:** run `checkBindings` and `admit` first (they do not need the domain), close the named operations only when both are empty, and roll the whole transaction back (throw) when `acquireLocks` still fails after the close.
- **Acceptance test:** flip the three assertions of the probe: the stuck operation stays `needs_attention` with its lock in the stale, revoked and blocked cases; the control case still closes it.

### [P2] Recovery by naming exists for two migration kinds only; every other operation that ends `needs_attention` with an unknown outcome still keeps its domain for ever (TC-005 neighbour)
- **Area:** `packages/operations/src/kinds.ts` (`supersedes` is optional), implemented only in `packages/migrations-engine/src/kind.ts` (`migration.apply`, by `resume`) and `reverify.ts` (`migration.verify`)
- **Block:** R
- **Reproduction:** read: `grep -rn "supersedes" packages/*/src` lists the two kinds. `restore.discard` (`packages/backups/src/kinds.ts:1572-1582`) answers `unknown` from `reconcile` whenever its job did not judge `succeeded` (also when the job failed definitively), the driver then moves the operation to `needs_attention` (`driver.ts:340-352`), and the operation keeps `cluster:<id>:backup` (`kinds.ts:1511`). `ledger.reconcile`, `migration.rollback`, `migration.baseline`, `drift.accept`, `backup.run`, `restore.execute` and the node config kinds have the same shape. The fix's own driver test (`driver.int.test.ts`, "is blocked for ever without the plan naming it") is the proof of the mechanism for a kind that does not name the operation.
- **Expected:** TC-005's acceptance "state-machine unit test that `needs_attention` with apply `unknown` has an exit" holds for the operation kinds that can be in that state, or the others are listed as an open item.
- **Actual:** the edge exists in the table; only two kinds can use it. Not reproduced end to end with a real `restore.discard` (it needs a failing discard job).
- **Evidence:** `R/R1-notes/TC-005.md`.
- **Root cause:** the fix is per kind, not an operator action (`operation.force_release` is still unbuilt).
- **Proposed fix:** an operator action (human, step-up, audited) that closes a named `needs_attention` operation for any kind, or a `supersedes` for each kind that holds a domain.
- **Acceptance test:** for each domain-holding kind a test that ends it `needs_attention` / `unknown` and then releases the domain through the action.

### [P2] The restore drill's "replay reached the end of the archive" check compares with the start of the newest segment (neighbour of TC-009 and TC-043)
- **Area:** `packages/backups/src/selection.ts:98` (`walTo: segmentLsn(c.maxSegment)`), `packages/backups/src/kinds.ts:1356-1361`
- **Block:** R
- **Reproduction:** read: `segmentLsn` returns the LSN at the start of a segment (`records.ts:323-328`); `replayShort` is true only when `reached < walTo`. In the real run of `latest` (`R/R1-notes/TC-009.md`) the replay reached `0/B000000` against a newest archived segment `..0A` (`walTo` = `0/A000000`). A replay that stops anywhere inside the newest segment (a hole or corruption in it) passes the check; D-04's scenario with the damage in the last segment is not caught.
- **Expected:** the check compares with the end of the last archived segment (or with the last record the archive holds).
- **Actual:** the check allows the replay to be short by up to one segment (16 MiB of WAL by default).
- **Evidence:** `R/R1-notes/TC-009.md` (code reading plus the real replay LSNs).
- **Root cause:** `segmentLsn` is used as an end.
- **Proposed fix:** `walTo = segmentLsn(next segment)`; require the `pg_last_wal_replay_lsn` of the scratch to reach the end of the newest segment; keep the explicit exception for a segment that is the archive's current partial segment.
- **Acceptance test:** a `pglab` test that truncates the newest archived segment: the `latest` drill ends `failed` with `replay reached ..., the archive the plan counted on ends at ...`.

### [P3] `migration.bundle.ingest` still stores a bundle with an unknown `dependsOn` silently (TC-008 residual)
- **Area:** `packages/migrations-engine/src/store.ts` (`ingestBundles`), local lint
- **Block:** R
- **Reproduction:** evidence test `tc-5.int.test.ts` j3 on `d51da5d0`: ingest with a ghost id returns `stored`; an unrelated plan now succeeds (fixed), planning the dangling bundle names `details.migrationId` and `details.missing[]` (fixed).
- **Expected:** the finding's proposal also validated `dependsOn` against stream plus submission at ingest and reported dangling stored edges; the fix recorded these as "not done".
- **Actual:** a dangling edge is accepted and only fails when something that depends on it is planned; the project stream view reports `graphErrors` (checked in `stream.ts:223`).
- **Evidence:** `R/R1-notes/TC-008.md`.
- **Root cause:** deliberate scope (commit message of `81b6b542`).
- **Proposed fix:** a warning finding at ingest naming the ghost ids.
- **Acceptance test:** ingest a dangling bundle and read the ingest answer: it names the ghost ids.

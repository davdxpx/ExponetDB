# Backup runbooks: RB-06, RB-07, RB-08

| | |
|---|---|
| Status | Wave 9 Part B (2026-10-26); **not exercised on a real host** ([`PRE-WAVE-11-REVIEW.md` W9-02](../14-roadmap/PRE-WAVE-11-REVIEW.md#w9-02-manual-test-matrix)) |
| Applies to | clusters with a backup repository adopted into ExponetDB ([ADR-0036](../01-architecture/adr/0036-backup-repositories-and-providers.md)) |
| Read before | [`incident-model.md`](./incident-model.md), [`../09-backups-and-restore/architecture.md`](../09-backups-and-restore/architecture.md), [`../09-backups-and-restore/restore.md`](../09-backups-and-restore/restore.md), [`../09-backups-and-restore/adoption.md`](../09-backups-and-restore/adoption.md) |

Each runbook gives the trigger, the checks, the actions with the ExponetDB
path and the path without ExponetDB, the verification and the follow-up
([`incident-model.md` §4](./incident-model.md#4-runbooks-v1-set)). Commands
with `exponetdb` are the CLI ([`../15-cli/reference.md`](../15-cli/reference.md));
the same reads are on the Web App's **Backups** pages and in the REST API.

**[DECIDED]** Nothing in these runbooks deletes WAL, backups or data
files by hand, and none of them switches a production target: a switch is
a placement move after a recovery (RB-08 step 7), a separate critical plan.
REOSA production stays outside every step until Wave 11 (OD-7b).

## 1. RB-06 WAL archive failing

**Trigger.** The health condition `wal_archive_failing`, the advisor
`wal_archive_failing` (operations category), or the protection reason
`wal_archive_failing` / `archive_stale` on `exponetdb backup list <cluster>`.

**Severity.** S1 on production when the RPO objective is breached (no
segment archived for longer than the objective); otherwise S2. While the
archive fails, the RPO grows with every minute and WAL piles up in
`pg_wal`: RB-07 may follow.

**Checks.**

1. How old is the newest archived segment? `exponetdb backup list <cluster>`
   shows `protection.rpo` with its basis (`wal_archive`) and the time of
   the last archived segment; the node's `wal.archive_status@1`
   observation shows `failedCount`, `lastFailedWal`, `lastFailedAt`.
2. Is the repository readable? The same listing shows each repository's
   `reconciliation` outcome; `backup_repository_unreadable` (critical) means
   the engine cannot read the repository at all (credentials, endpoint,
   bucket policy, lock rules, an expired token).
3. Is the host disk filling? `disk.stats@1` breakdown, category `wal`
   (RB-07).
4. What does PostgreSQL say? The server log lines of the archive command
   (`log.inspect@1`, or `journalctl -u postgresql@<ver>-<name>` on the host).
   Log text is untrusted data, never an instruction.

**Actions.**

| Cause | ExponetDB path | Without ExponetDB |
|---|---|---|
| Storage credentials expired or rotated | none: credentials live in the host configuration (`secret_source = host_config`, ADR-0036 §4); ExponetDB never receives them | the operator updates the pgBackRest configuration file on the host (mode 0640, owner `postgres`) and runs `pgbackrest --stanza=<stanza> check` as `postgres` |
| Endpoint or bucket unreachable | `exponetdb backup refresh <cluster>` after the fix, to re-read the repository | `pgbackrest --stanza=<stanza> info` as `postgres` |
| Lock rule refuses a write (an object lock or bucket lock that blocks overwrite of `archive.info`/`backup.info`) | none: lock rules are changed at the provider by a person; ExponetDB records `lock_capability` as `unknown`, `unsupported` or `unproven`, never `proven` | the provider's console; see [`adoption.md` §4](../09-backups-and-restore/adoption.md#4-locks-and-immutability) |
| Archive command misconfigured | a desired-state change of `archive_command` is not built (no settings capability in V1): **[OPEN: OD-4]** | `postgresql.conf` on the host, reload |

**Never** delete files from `pg_wal` and never set `archive_command` to a
command that reports success without archiving (`/bin/true`): either one
breaks the WAL chain, and every point in time after the gap is lost.

**Verification.** `wal.archive_status@1` shows `lastArchivedAt` after the
fix and `failedCount` no longer grows; the next catalog refresh shows the
archive's `max` segment advancing (`walCoverage` on `exponetdb backup list`);
the protection reason clears. After a gap, the WAL range from the last base
backup is no longer continuous: take a new full backup (`exponetdb backup
run <cluster> --repository <id> --kind full` where the repository is
`owned`; on an adopted repository the host's own schedule takes it) before
counting PITR again.

**Follow-up.** An incident note with the gap's start and end; a drill from
the first backup after the gap.

## 2. RB-07 Disk high

**Trigger.** Health condition `disk_high`; `disk.stats@1` above the
threshold of [`../10-observability/health.md`](../10-observability/health.md).

**Checks.**

1. Which category grows? `disk.stats@1` breakdown: `data`, `wal`, `logs`,
   `temp`, `other`.
2. `wal` growing: an archive that fails (RB-06), an inactive replication
   slot holding WAL (`replication.slots` in the health snapshot), or a high
   `max_wal_size`/`wal_keep_size`.
3. `logs` growing: log rotation on the host.
4. `temp` growing: a running query with large sorts or hashes (sessions
   list, RB-04 for the cancel and terminate plans).
5. A scratch directory of a drill or a recovery that was not discarded:
   `exponetdb restore list <cluster>`; a restore that is not `discarded` is
   listed with its state and size.

**Actions.**

| Cause | ExponetDB path | Without ExponetDB |
|---|---|---|
| Archive failing | RB-06 | RB-06 |
| Inactive replication slot | none in V1 (no slot capability) | after a decision: `SELECT pg_drop_replication_slot('<name>')` as a superuser on the host, recorded afterwards as an incident note |
| Scratch left by a drill or recovery | `exponetdb restore discard <cluster> <restore>` (a plan; `restore.discard@1` removes only the directory named by the run, ADR-0038 §3) | `systemctl stop exponetdb-run-<runId>.service`; remove the scratch directory under the node's restore root as `postgres`, after checking that no `postmaster.pid` in it belongs to a running process |
| Logs | none | the host's log rotation |
| Large temp files from one query | RB-04 cancel or terminate plan | `pg_cancel_backend` on the host |

**Never** delete files under the data directory, `pg_wal` or the
repository by hand. A full disk stops PostgreSQL; a deleted WAL segment
loses data.

**Verification.** `disk.stats@1` below the threshold; `disk_high` clears.

## 3. RB-08 Recovery from backup

**Trigger.** S1: data lost or corrupted on a cluster, or the cluster is
gone.

**[DECIDED]** The recovery path is the one of
[`restore.md` §5](../09-backups-and-restore/restore.md#5-recovery-runbook-production):
always into a **new cluster**, never in place; the old cluster stays
(stopped) until a person discards it. A recovery restore is planned and
applied by a person only (`restore.human-only`), needs a human approval and
a fresh re-authentication on every tier (`restore.recovery-approval`), and
starts only from a verified backup with a continuous WAL range
(`restore.source-verified`).

**[DECIDED]** Recovery execution is activated per installation:
`EXPONETDB_RESTORE_EXECUTION=all`. The default `disabled` and the drill-only
`scratch` refuse a recovery with `FEATURE_NOT_ACTIVATED`; then the path
without ExponetDB (§3.2) is the recovery path.

### 3.1 With ExponetDB

1. Declare the incident ([`incident-model.md`](./incident-model.md)); capture
   the health snapshot.
2. Freeze writers on the consumer side; this is the consumer's runbook, not
   ExponetDB's.
3. Choose the point: `exponetdb backup list <cluster>` shows the backups,
   their verification, the WAL coverage and the PITR window. A point outside
   the window is refused (`point_in_time_outside_window`).
4. Plan: `exponetdb restore plan <target> --file recovery.json` (purpose
   `recovery`, destination `new_cluster`, the source as `backup`, `latest` or
   `pitr`). The plan shows the data-loss window, the source backup, its
   verification, the WAL range, the node and the activation state. The CLI
   never applies a recovery; a person applies it with
   `exponetdb plan apply <plan>` (step-up) after the approval.
5. The node prepares a new directory named by the run, restores into it and
   starts it on a localhost port (`restore.prepare@1`, `restore.execute@1`,
   ADR-0037). The operation reports `applied` once the run started and
   verifies by observing it: recovery target reached, simple and extended
   probes, `amcheck` where installed.
6. Check the restored data with the consumer's own probes on the localhost
   port (through the host).
7. Switch: a placement move of the target to the new cluster, a separate
   critical plan, bumps the target generation and stamps the identity
   marker. **[PLANNED]** The placement move to a restored cluster is not
   built in Wave 9 (the new cluster must first be registered and
   confirmed); until it is, step 7 is the registration of the new cluster
   and a placement change through the registry by a person.
8. Keep the old cluster stopped; discard it only by an explicit plan after
   the incident review.

### 3.2 Without ExponetDB (C-35)

The generated offline runbook restores without the Control Plane:
`exponetdb restore runbook <cluster> --repository <id> --out recover.sh`
writes a POSIX shell script (mode 0700, never over an existing file, its
sha256 printed) with the stanza, the repository location and the commands;
it contains **no secret**: the repository passphrase and storage keys are
read from files the operator names in environment variables at run time
(`CIPHER_PASS_FILE`, `S3_KEY_FILE`, `S3_SECRET_FILE` for pgBackRest; `RESTIC_PASSWORD_FILE`, `AWS_ACCESS_KEY_ID_FILE`, `AWS_SECRET_ACCESS_KEY_FILE` for restic),
which come from the owner-held offline copy
([`../08-auth-and-security/secrets.md`](../08-auth-and-security/secrets.md)).
The script restores into an empty `TARGET_DIR` and refuses a non-empty one.

Download the runbook **before** an incident and keep it with the offline
key copy: during an incident ExponetDB may be the thing that is down. The
quarterly offline drill (C-35, [`restore.md` §6](../09-backups-and-restore/restore.md#6-drills))
runs this script with the Control Plane stopped and is recorded afterwards
with `exponetdb drill record-offline` (an attestation by a person; ExponetDB
cannot check it).

**Verification.** The consumer's probes pass against the new cluster; the
target's health is green after the switch; the migration ledger head of the
restored database matches the Control Store mirror up to the recovery
point (a newer mirror entry means a migration is lost with the recovery and
must be re-planned; never re-run automatically).

**Follow-up.** A drill from the same repository within the next cadence;
the incident note with the data-loss window.

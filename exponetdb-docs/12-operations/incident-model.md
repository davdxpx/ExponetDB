# Incident model and runbooks

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
| Applies to | Wave 4 onward (every runbook is written when its feature ships) |
| Read before | [`../01-architecture/failure-model.md`](../01-architecture/failure-model.md), [`../10-observability/health.md`](../10-observability/health.md) |

## 1. Incident classes

| Class | Example | First question | Who acts |
|---|---|---|---|
| **Data plane** | REOSA production database unreachable, saturated, locked | what does the database itself say (via ExponetDB **and** the consumer's own probes)? | operator, with ExponetDB as the tool |
| **Change** | a migration failed or verification failed on production | what was applied, what was verified, is the database consistent? | operator + author of the change |
| **Control plane** | ExponetDB down or degraded | are databases affected? (normally not, C-5) | ExponetDB operator |
| **Security** | leaked token, suspicious grant, audit chain break, identity mismatch | what can the credential do, since when, what did it do? | owner |
| **Backup** | archive failing, RPO breached, drill failed | how much data would be lost right now? | operator |

## 2. Severity

| Severity | Meaning | Examples |
|---|---|---|
| S1 | production data unavailable or at risk of loss | target unreachable, RPO breached with failing archive, failed production migration leaving inconsistent state |
| S2 | production degraded or protection reduced | `extended_protocol_failing`, saturation, backup failed once, verification failed with applied changes |
| S3 | nonprod affected, or Control Plane degraded without production impact | staging down, ExponetDB `serve` crash loop |
| S4 | findings that need planned work | drift, advisors, certificate expiring in 30 days |

## 3. Principles

- **ExponetDB is a tool in incidents, not a dependency.** Every runbook has a
  path that works when ExponetDB is down (direct `psql` on the host via the
  owner's SSH path, the backup engine's CLI, Coolify). ExponetDB adds speed and
  evidence when it is up.
- **No improvisation on production through side doors** when ExponetDB is up:
  emergency changes use break-glass plans, so they are recorded and the ledger
  stays truthful. When ExponetDB is down and a manual change is unavoidable, the
  change is recorded afterwards with `drift.accept` or a corrective bundle and an
  incident note ([`../03-database-model/drift-detection.md`](../03-database-model/drift-detection.md)).
- **Evidence first**: before acting, capture the health snapshot and sessions
  (one click "capture incident snapshot" stores redacted state with the incident).

## 4. Runbooks (V1 set)

Each runbook has: trigger (condition or finding), checks, actions (with the
ExponetDB path and the fallback path), verification, follow-up. Written and
tested with the feature that introduces the condition.

| Runbook | Trigger | Key actions |
|---|---|---|
| RB-01 Target unreachable | `probe_simple_failed` | distinguish node offline vs online; `postgres.status`, `log.inspect`; disk; restart plan if PostgreSQL is down |
| RB-02 Extended protocol failing | `extended_protocol_failing` | identify the path (pooler endpoint vs direct); compare probes per endpoint; consumer switches endpoint; stalled sessions → terminate plan |
| RB-03 Connection saturation | `connections_critical` | group by role/application; idle-in-transaction holders; terminate plan; role timeouts via desired state |
| RB-04 Lock pile-up | `lock_waits` | root blocker; cancel before terminate; check for a running migration (lock domain) |
| RB-05 Failed migration on production | operation `failed` / `verification_failed` | read operation record (applied vs verified); never re-run automatically; plan corrective bundle or `down.sql` (with approval); [`../04-migrations/failure-and-recovery.md`](../04-migrations/failure-and-recovery.md) |
| RB-06 WAL archive failing | `wal_archive_failing` | `wal.archive_status`; repository health; disk growth; fix destination; verify archive catches up |
| RB-07 Disk high | `disk_high` | `disk.stats` breakdown; WAL retention (slots, archive); logs; never delete data files |
| RB-08 Recovery from backup | S1 data loss/corruption | [`../09-backups-and-restore/restore.md` §5](../09-backups-and-restore/restore.md#5-recovery-runbook-production) |
| RB-09 Identity mismatch | `identity_mismatch` | target suspended; find which database answers on the endpoint; restore placement or re-stamp after decision |
| RB-10 Control Store down | Control Plane `down` | check the Coolify resource; restore from Coolify backup or the daily dump; after restore, reconcile ledgers vs mirrors (F30); steps: [`control-store-runbook.md` §4](./control-store-runbook.md#4-rb-10-control-store-down) |
| RB-11 Token or key leak | security report | revoke grant/key/session; list actions by that credential from audit; rotate affected secrets |
| RB-12 Audit chain break | self-check failure | freeze audit partition export; compare with last off-host checkpoint; escalate as security incident |
| RB-13 Node agent lost | node `offline` for > 15 min | systemd status via SSH; certificate expiry; re-enroll if needed; queued jobs expire safely |
| RB-14 Keyring lost | decryption failures | restore offline keyring copy; if lost: rotate all PostgreSQL credentials through the node agent ([`../08-auth-and-security/secrets.md` §5](../08-auth-and-security/secrets.md#5-bootstrap-secrets-and-coolify)) |

## 5. After an incident

- Incident record (Control Store) links: findings, operations, plans,
  break-glass activations, snapshots; timeline exported to the owner's notes.
- Every break-glass use gets a review entry within 7 days (policy reminder).
- A runbook that was wrong or missing is updated in the same week; a recurring
  condition gets an advisor rule or a policy.

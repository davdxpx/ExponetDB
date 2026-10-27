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
| RB-05 Failed migration on production | operation `failed` / `verification_failed` / `needs_attention` | read the operation (`exponetdb operation show <op>`: applied vs verified, per migration); never re-run automatically; `failed` with nothing applied: fix and plan again; `verification_failed`: plan a corrective bundle or `down.sql` (with approval); `needs_attention` after an applied change whose verification could not run (timeout, target unreachable): once the cause is gone, `exponetdb operation retry-verification <op>` (the change never runs again); `LEDGER_DIVERGENCE`: undo the hand change on the target ledger; [`../04-migrations/failure-and-recovery.md`](../04-migrations/failure-and-recovery.md) |
| [RB-06 WAL archive failing](./backup-runbooks.md#1-rb-06-wal-archive-failing) | `wal_archive_failing` | `wal.archive_status`; repository health; disk growth; fix destination; verify archive catches up |
| [RB-07 Disk high](./backup-runbooks.md#2-rb-07-disk-high) | `disk_high` | `disk.stats` breakdown; WAL retention (slots, archive); logs; never delete data files |
| [RB-08 Recovery from backup](./backup-runbooks.md#3-rb-08-recovery-from-backup) | S1 data loss/corruption | always into a new cluster, never in place; with ExponetDB a human-only, approved recovery plan; without it the generated C-35 offline runbook; [`../09-backups-and-restore/restore.md` §5](../09-backups-and-restore/restore.md#5-recovery-runbook-production) |
| RB-09 Identity mismatch | `identity_mismatch` | target suspended; find which database answers on the endpoint; restore placement or re-stamp after decision |
| RB-10 Control Store down | Control Plane `down` | check the Coolify resource; restore from Coolify backup or the daily dump; after restore, reconcile ledgers vs mirrors (F30); steps: [`control-store-runbook.md` §4](./control-store-runbook.md#4-rb-10-control-store-down) |
| RB-11 Token or key leak | security report | revoke grant/key/session; list actions by that credential from audit (`audit_search` or `GET /api/v1/audit-events` with `grant=` or `client=`, Wave 7; refused attempts are `authz.denied`); rotate affected secrets |
| RB-12 Audit chain break | self-check failure | freeze audit partition export; compare with last off-host checkpoint; escalate as security incident |
| [RB-13 Node agent lost](./node-runbook.md#6-rb-13-node-agent-lost) | node `offline` for > 15 min | systemd status via SSH; certificate expiry; re-enroll if needed; queued jobs expire safely |
| RB-14 Keyring lost | decryption failures | restore offline keyring copy; if lost: rotate all PostgreSQL credentials through the node agent ([`../08-auth-and-security/secrets.md` §5](../08-auth-and-security/secrets.md#5-bootstrap-secrets-and-coolify)) |
| [RB-15 MCP incident](#4a-rb-15-mcp-incident) | an agent did something unexpected, a suspected prompt injection, a leaked MCP token, an unknown client, a burst of `exdb_mcp_denied_total` or `authz.denied` | stop the client (kill switch) or the grant; list what it did by client and grant; decide waiting approvals; rotate the MCP keys if sealed state may be affected; report |

### 4a. RB-15 MCP incident

**[DECIDED]** (Wave 7, order §37) For an agent connected through `/mcp`.

1. **Stop it.** New MCP clients are approved automatically by default
   (`EXPONETDB_OAUTH_CLIENT_REGISTRATION=open`, owner decision 2026-10-13), so
   disabling is the kill switch. An administrator disables the client in the Web App
   (**Access → OAuth clients**, `/access/oauth-clients`, "Disable", confirmed with a
   passkey): every grant and token of that client ends in the same
   transaction and the next `/mcp` request answers `401`. To stop one
   person's connection only, the person revokes the grant on **Account →
   Connected applications**. A waiting production apply of the agent is
   rejected on `/approvals`; a running operation stops before its next
   migration once its grant is gone (E27).
2. **List what it did.** The internal client id is on its card
   (`cli_…`); the grant id on the person's connected applications:
   `exponetdb audit list --client cli_… --json` and
   `exponetdb audit list --grant grt_… --json` (or `audit_search` with a
   separate, healthy grant, or `GET /api/v1/audit-events?client=…&grant=…`).
   Refused high-risk attempts are `authz.denied` (with the tool it came
   through); every data read is `data.read` (target, normalized and
   redacted statement, row count; never a row value). The server log has
   one `mcp.request` line per request (tool, tool version, outcome, grant,
   client; never arguments).
3. **Rows.** If `data.read` events show rows of a sensitive target were
   read, treat the result as disclosed to the client's operator and follow
   the data-protection process of the owner.
4. **Keys.** If sealed MCP state may be affected (a leaked approval-round
   state or list cursor beyond its lifetime is harmless; a suspected key
   compromise is not), rotate:
   `exponetdb keyring rotate-mcp-key --purpose mcp.request_state_key` and
   `--purpose mcp.cursor_key` (login `exdb_serve`); serve uses the new
   versions within five minutes. A request state sealed under the version
   before still opens and a second rotation retires it; a list cursor
   names no version, so after a rotation of `mcp.cursor_key` every open
   cursor fails as invalid and the client lists again
   ([ADR-0027 §7](../01-architecture/adr/0027-mcp-protocol-layer.md)).
   **[OBSERVED]** 2026-10-13 (`apps/server/src/interfaces/mcp/cursor.ts`).
5. **Report.** The owner informs the affected people. OD-21 (notification
   channel) is open, so nothing is sent automatically.
6. **Verify and follow up.** The client's card shows `disabled`; a request
   with its token is `401`; `exdb_mcp_requests_total` for its grant stops.
   An injection that worked becomes an incident regression of the
   adversarial suite (`apps/server/test/mcp-adversarial.int.test.ts`,
   "incident regressions"), and the consent scopes of the client's grants
   are reviewed.

## 5. After an incident

- Incident record (Control Store) links: findings, operations, plans,
  break-glass activations, snapshots; timeline exported to the owner's notes.
- Every break-glass use gets a review entry within 7 days (policy reminder).
- A runbook that was wrong or missing is updated in the same week; a recurring
  condition gets an advisor rule or a policy.

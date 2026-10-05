# Failure model

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
| Applies to | every wave; each wave's acceptance gates include its rows below |
| Read before | [`control-plane-and-data-plane.md`](./control-plane-and-data-plane.md), [`../02-control-plane/operations-engine.md`](../02-control-plane/operations-engine.md) |

Principles applied in every row:

- **Truthful state** (C-28, C-29): a failure is reported as the failure it is,
  with its source and time, never as empty or healthy.
- **Fail closed for writes** (C-11): uncertainty stops changes, not visibility.
- **No double execution** (C-12): unknown outcomes are reconciled, never retried.
- **Recovery is a planned operation** (C-16).

## 1. Catalog

| # | Failure | Detection | What users/agents see | Automatic behavior | Recovery |
|---|---|---|---|---|---|
| F1 | Control Store down | readiness check fails; queries error | `CONTROL_PLANE_DEGRADED` on every authenticated call; Web App banner | `serve` stays live but not ready; workers pause at step boundaries; samplers stop (gap recorded, not zeros) | restore Control Store connectivity; workers reconcile in-flight operations; samplers resume (gaps remain gaps) |
| F2 | Managed database down | probe failures (connection refused/timeout) | target `unreachable` with last good sample time; node state shown separately | circuit breaker; plans for the target refused with `TARGET_UNAVAILABLE`; running operations reconcile when reachable | database recovery is outside ExponetDB unless a node capability applies (`postgres.status`, `postgres.restart` plan) |
| F3 | Node agent offline | heartbeat missing for 3 intervals (45 s) | node `offline`; host metrics stale; targets still sampled over SQL | jobs for the node stay queued until their `expiresAt`, then `JOB_EXPIRED`; no job is assumed done | restart agent (systemd), check enrollment and certificate; queued jobs resume or expire |
| F4 | Network partition (control plane ↔ data host) | probes and heartbeats fail together | targets `unreachable` and node `offline`; the UI states that both failed together and that this is consistent with a partition **or** a host outage | same as F2 + F3 | after recovery, agent uploads buffered heartbeat summaries, which disambiguate after the fact |
| F5 | TLS certificate expired or invalid (PostgreSQL server) | TLS verification error | `TARGET_TLS_FAILED`; finding (critical) | no fallback to weaker `sslmode` ever | `postgres.tls.rotate` via agent (agent connects locally, unaffected); external clusters: provider action |
| F6 | ExponetDB role credential invalid | auth failure `28P01` | `TARGET_CREDENTIAL_INVALID` for the affected access role only (others may still work) | the credential marked `failing`; no retries storm (backoff) | `credential.rotate` (agent-managed: verifier pushed by agent; external: human SQL) |
| F7 | PostgreSQL restart fails (after a planned restart) | agent reports `postgres.status` not running; job result failure | operation `failed`, target `unreachable`, node shows service state and last log lines (redacted) | no automatic second restart | operator investigates via `log.inspect`, `postgres.config.inspect`; plan a config revert (`postgres.config.apply` with previous values, which the restart plan stored) |
| F8 | Migration SQL fails before commit | SQL error | `MIGRATION_EXECUTION_FAILED` with SQLSTATE, statement index; `applyOutcome = not_applied` | transaction rolled back; lock released | fix bundle or wait; re-plan |
| F9 | Migration applied, verification fails | verification result | `applied`, `verificationOutcome = failed`, finding; dependent prod plans blocked | stop remaining migrations in the plan | forward fix, verify revision, or planned rollback ([`../04-migrations/failure-and-recovery.md`](../04-migrations/failure-and-recovery.md)) |
| F10 | Verification timeout | statement timeout in verifier session | `verificationOutcome = error`, operation `needs_attention` | none | `migration.verify` later or with a raised timeout |
| F11 | Advisory lock held | `pg_try_advisory_lock` false until deadline | operation `queued`/`running` with `waitingFor: op_…`; then `MIGRATION_LOCK_TIMEOUT` | backoff loop | wait for the holder; if the holder is stuck: `operation.force_release` |
| F12 | Stale migration plan | binding check | `PLAN_STALE` with changed bindings | plan invalidated | re-plan |
| F13 | Staging differs from production | lineage check | plan shows lineage `mismatch` with diff | warn or require approval (OD-14) | reconcile environments with migrations |
| F14 | Backup fails | job failure / engine exit code / size floor not met | backup `failed`; finding; policy hooks requiring a recent backup now deny | no automatic retry loop; next scheduled run proceeds | investigate repository, disk, credentials; `backup.run` manually |
| F15 | Restore fails | job failure / verification failure | restore `failed`; the destination target stays `suspended` (never auto-activated) | the source is untouched (restores go to a new or explicitly named destination) | fix cause, re-plan restore; drills record the failure as evidence |
| F16 | Disk full on database host | node metrics (free space thresholds), PostgreSQL errors `53100` | finding critical at 90 %, warning at 80 % (configurable); target `degraded` | no automatic cleanup of user data; WAL archive status checked | operator frees space (capability `disk.stats` gives breakdown: data, WAL, logs, backups); resize disk outside ExponetDB |
| F17 | WAL archive blocked | `pg_stat_archiver.failed_count` rising, `last_archived_time` old; WAL directory growth | finding critical; backup health `degraded`; RPO shown as breached | none | fix archive destination; `wal.archive_status` capability shows the failing segment and error |
| F18 | Schema fingerprint mismatch (drift) | periodic drift check | finding with diff; for security classes critical | schema plans bind to the new fingerprint (they will be stale) | `drift.accept` or corrective migration |
| F19 | OAuth unavailable (ExponetDB AS) | AS endpoints failing (they are part of `serve`) | MCP clients cannot obtain or refresh tokens; existing access tokens keep working until expiry | none | it fails together with `serve`; same recovery as F1/F25 |
| F20 | MCP client disconnects mid-call | closed stream | none for the client (it is gone) | for plan/read calls: work is abandoned; for `plan_apply`: the operation continues (it was accepted) and is visible via `operation_get` or the Web App; per MCP 2026-07-28, closing the stream counts as cancellation **of the request**, which for an already-accepted operation means "stop streaming progress", not "cancel the operation" | client re-queries the operation |
| F21 | Control Plane restart during an operation | lease expiry | operation shows `running` then `needs_reconciliation` briefly | new worker reconciles (§ operations-engine 4.2) | automatic |
| F22 | Agent restart during a job | job lease expires or agent reports in-flight job after restart from its local journal | job `running` → `outcome_unknown` or resumed | agent does not re-execute; it reports journal state; capability-specific reconciliation decides (for example `postgres.restart`: compare postmaster start time with job start) | automatic where the capability defines reconciliation, else `needs_attention` |
| F23 | Target identity mismatch | session guard | `TARGET_IDENTITY_MISMATCH`, target auto-suspended, critical finding | all writes refused | investigate (wrong DNS/placement, restored copy, second installation); `target.identity.stamp` after decision |
| F24 | Ledger divergence | mirror comparison | `LEDGER_DIVERGENCE`, schema changes blocked | none | `ledger.reconcile` with explicit decision |
| F25 | `serve` process crash loop | Coolify health checks | API unavailable | Coolify restarts; other roles unaffected | fix and redeploy; operations continue in `worker` |
| F26 | Gateway down | agents cannot connect | nodes `offline` (from the control plane's view) | agents retry with backoff and buffer heartbeats | restart gateway |
| F27 | Clock skew (agent vs control plane) | heartbeat skew field | node `degraded` above 2 s, jobs refused above 30 s | none | fix NTP on host |
| F28 | Secrets key unavailable (master key missing/wrong) | startup check in `worker` | worker not ready; operations needing credentials pause | none | provide key; see [`../08-auth-and-security/secrets.md`](../08-auth-and-security/secrets.md) |
| F29 | Backup storage unreachable | repository health check | backup health `degraded`/`failed`; restore of off-site copies impossible | none | provider/network fix; local copies may still exist |
| F30 | Control Store restored to an older state | startup reconciliation | ledgers ahead of mirrors → divergence findings per target | schema changes blocked on affected targets | operator reconciles each target |

## 2. Cross-cutting rules

- **Time-bounded everything**: every remote call (SQL, agent, storage, OAuth
  metadata fetch) has a timeout; every lock has a deadline; every job has an
  `expiresAt`.
- **Backoff, not storms**: retries of reads use exponential backoff with jitter
  and a circuit breaker per target and per node.
- **Gaps are data**: sampling gaps are recorded explicitly (with cause:
  `control_plane_down`, `target_unreachable`, `node_offline`) so that charts show
  holes, not interpolations.
- **Degraded modes are named**: the health model defines them
  ([`../10-observability/health.md`](../10-observability/health.md)).

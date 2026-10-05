# Health model

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
| Applies to | Wave 4 (target health), Wave 5 (node health), Wave 9 (backup and replication health), every UI and MCP surface that shows state |
| Read before | [`../00-product/constitution.md` C-28, C-29](../00-product/constitution.md#part-v-truthfulness), [`../03-database-model/postgres-adapter.md`](../03-database-model/postgres-adapter.md), [`../01-architecture/failure-model.md`](../01-architecture/failure-model.md) |

Health answers three questions in incident order, the same order REOSA's
`/status/database` page answers them after the outage of 2026-09-24:

1. **Can we reach it, on the path real clients use?**
2. **Does it answer correctly** (not just `SELECT 1`)?
3. **Is anything stuck or about to break?**

And one question REOSA could not answer: **is it ExponetDB that cannot see, or
the database that is down?**

## 1. Subjects and their states

**[DECIDED]**

| Subject | States | Main inputs |
|---|---|---|
| **Target** | `healthy`, `degraded`, `unhealthy`, `unreachable`, `unknown`, `suspended` | probes, activity summary, findings, identity check |
| **Cluster** | same set | per-cluster probes, replication, WAL archive, disk (via node) |
| **Node** | `active`, `degraded`, `offline`, `revoked`, `unknown` (plus `pending_enrollment` and `decommissioned` from the registry) | heartbeats, clock skew, helper status, agent diagnostics |
| **Control Plane** | `operational`, `degraded`, `down` (as seen by clients) | Control Store reachability, worker heartbeats, gateway status, sampler lag |
| **Backups** (per cluster) | `protected`, `at_risk`, `unprotected`, `unproven`, `unknown` | [`../09-backups-and-restore/architecture.md` §4](../09-backups-and-restore/architecture.md#4-freshness-rpo-and-rto-as-measured-values) |

Every state carries: `source` (`live`, `cached`, `agent_reported`,
`inferred`), `observedAt`, the **reasons** (list of named conditions below) and,
for `unknown`, why it is unknown.

Distinctions that must always be visible (C-29):

| What the user sees | Meaning |
|---|---|
| Target `unreachable`, node `active` | the database does not answer ExponetDB, but the host agent is alive: database problem (or credentials, network path to PostgreSQL) |
| Target `unreachable`, node `offline` | both paths failed together: partition **or** host outage; the UI says that it cannot tell which |
| Target `unknown` with reason `control_plane_degraded` | ExponetDB's own sampler is not running; the database may be fine |
| Target `healthy` with `source: cached` and age > 2 sampling intervals | stale; rendered as stale, never as fresh green |

## 2. Probes

**[DECIDED]** Every 15 seconds per target, from the `worker` with the observer
role, on every registered endpoint, so that the paths consumers use (direct or
through a pooler, see §4) are measured, not only ExponetDB's own direct path:

| Probe | SQL | Detects |
|---|---|---|
| `simple` | `SELECT 1` (simple query protocol) | connectivity, authentication, basic responsiveness |
| `extended` | `SELECT $1::int` with a bound parameter (parse/bind/execute) | the 2026-09-24 signature: poolers or proxies that pass simple queries but hang on the extended protocol |
| `identity` | read `exponetdb.target_identity` | wrong database behind the address (C-27) |
| `activity` | one parameter-free query over `pg_stat_activity` (client backends only) | stuck sessions, idle-in-transaction, saturation |
| `settings` | `max_connections`, `superuser_reserved_connections`, `reserved_connections`, `server_version_num` | capacity denominators |

Each probe has its own deadline (default 5 s) and is recorded separately with
duration. A probe that times out records `timeout`, not a duration. The
diagnostic connection for `activity` is **separate** from the pool used for the
other probes, because diagnostics are needed exactly when pools are jammed
(pattern from REOSA's `openDiagnosticConnection`).

## 3. Named conditions

**[DECIDED]** Conditions are machine-readable; UI text and MCP output are
derived from them. Thresholds are defaults, configurable per environment.

| Condition | Rule | Effect on state |
|---|---|---|
| `probe_simple_failed` | simple probe failed or timed out | `unreachable` (if extended also failed) |
| `extended_protocol_failing` | simple ok, extended failed or > 10× slower | `unhealthy`; explanation names the pooler/proxy path as the likely place |
| `identity_mismatch` | marker differs | `suspended` (writes refused, critical finding) |
| `connections_high` | client backends ≥ 75 % of usable slots (`max_connections − superuser_reserved_connections − reserved_connections`) | `degraded` |
| `connections_critical` | ≥ 90 % or usable = 0 | `unhealthy` |
| `stalled_sessions` | `state = active`, `wait_event = ClientRead`, query age ≥ 60 s | `degraded`; count shown |
| `idle_in_transaction` | `idle in transaction` (incl. aborted) for ≥ 10 s (warning) / ≥ 300 s (critical) | `degraded` / `unhealthy` |
| `long_running` | active, not `ClientRead`, query age ≥ 30 s (warning) / ≥ 300 s (critical) | `degraded` |
| `lock_waits` | sessions waiting on locks ≥ 10 s; blocking tree root identified via `pg_blocking_pids` | `degraded` |
| `xid_age_high` | `age(datfrozenxid)` ≥ 500 M (warning) / ≥ 1.2 B (critical) | `degraded` / `unhealthy` |
| `replication_lag` | lag over threshold, or inactive slot retaining WAL > threshold | `degraded` |
| `wal_archive_failing` | `pg_stat_archiver.failed_count` rising or `last_archived_time` older than 2× `archive_timeout` | `degraded`; backups `at_risk` |
| `disk_high` | node reports data/WAL filesystem ≥ 80 % (warning) / ≥ 90 % (critical) | `degraded` / `unhealthy` |
| `pending_restart` | settings changed that need a restart | informational |
| `tls_expiring` | server certificate expires within 30 days (warning) / 7 days (critical) | `degraded` |
| `plaintext_connections` | `pg_stat_ssl.ssl = false` for client backends from non-local addresses | finding (security) |

Rules shared between display and action: the condition that marks a session as
"stalled" in the UI is the same function the terminate plan uses as its
precondition, so "the page says stalled" equals "the plan will accept it"
(REOSA's `backend-rules.ts` pattern).

ExponetDB **does not terminate sessions automatically** in V1 (no reaper). It
detects, explains and offers a planned `connections.terminate` with
`pid + backend_start` binding. Automatic guards belong in PostgreSQL itself:
ExponetDB recommends and plans `idle_in_transaction_session_timeout` and
`statement_timeout` per role through the role desired-state manifest
([`../03-database-model/credentials-and-roles.md`](../03-database-model/credentials-and-roles.md)),
which survives dumps and restores better than an application-side reaper (the
REOSA audit found a role-level timeout that would be lost in the planned move).

## 4. Path awareness

**[DECIDED]** A target can have several registered **endpoints**: `direct`,
`pooler` (with mode: session/transaction), and per consumer the endpoint it
actually uses (declared in the registry, optionally verified by matching
`application_name` or client address in `pg_stat_activity`). Probes run on every
registered endpoint. The UI shows per endpoint: host:port (never user or
password), TLS mode and whether TLS is in use, last probe result.

Reason: REOSA's page showed only the console's own connection string, while
other apps used other paths, and unknown hosts were labeled "self-hosted, ok".
ExponetDB labels unknown or unverified paths as `unverified`, never as healthy.

## 5. Attribution of sessions

Sessions are grouped by `(usename, application_name)` with normalization rules
registered per consumer (for example a regex that maps REOSA's per-transaction
tags `reosa-tx-<…>` to `reosa-app (in transaction)`). Without a rule, groups are
shown raw and a hint suggests registering one. ExponetDB recommends that
consumers set a stable `application_name` per process role
([`../13-integrations/reosa-integration.md`](../13-integrations/reosa-integration.md)).

## 6. Failed reads and gaps

- A failed probe or sample is stored as a failure with the error class; it is
  never stored as zero sessions or zero locks (C-28).
- An unreadable list renders "could not read sessions: <reason>. This does not
  mean nothing is stuck." The empty-state text appears only after a successful
  read that returned no rows. Render tests assert this for every list.
- Truncation is explicit: lists that hit their cap return `truncated: true`
  and the cap.
- Gaps in history carry a cause (`control_plane_down`, `target_unreachable`,
  `node_offline`, `sampler_lagging`) and are drawn as gaps.

## 7. Diagnosing without adding load

- One diagnostic connection per target, reused, `max 1`, parameter-free
  queries, short `statement_timeout`; never through a consumer's pool.
- Probes use their own small pool with deadlines; a hung probe connection is
  closed and replaced, so repeated UI reloads do not pin more connections (a
  REOSA gap).
- The UI never triggers probes directly; it reads the latest samples. A manual
  "probe now" is rate-limited per target.

## 8. Control Plane health

| Component | Signal | Degraded when |
|---|---|---|
| Control Store | `serve` readiness query, worker heartbeat writes | query fails or p95 > 1 s |
| Workers | heartbeat row per worker every 15 s | no live worker for 45 s |
| Samplers | lag between scheduled and actual sample time | lag > 2 intervals |
| Gateway | agent connections, last claim time | no agent connected while nodes are enrolled |
| Keyring | keys loaded for the role | missing active key |

`/healthz/live` and `/healthz/ready` expose only up/down publicly. The detailed
Control Plane health is visible to authenticated users and in
[`self-observability.md`](./self-observability.md).

## 9. Surfaces

| Surface | Content |
|---|---|
| REST `GET /targets/{id}/health` | state, conditions, probes per endpoint, sources, timestamps |
| MCP `target_health` | same, compact; untrusted fields (application names, statement text) labeled |
| Web App target overview | three blocks in incident order (path, answers, stuck), then capacity, then history |
| Status integration for consumers | read-only health summary per target for consumer status pages (for example REOSA's `/status/database` link-out, [`../13-integrations/reosa-integration.md`](../13-integrations/reosa-integration.md)) |

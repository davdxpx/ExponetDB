# Health model

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05; Wave 2 Control Plane probes (§8) accepted with G2 on 2026-10-05; `/mcp` and readiness (§8) and the MCP surfaces (§9) noted on 2026-10-13 for Wave 7, G7 not yet accepted ([G7 record](../14-roadmap/gates/7.md)) |
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

Every state carries: `source` (`live`, `sampled`, `cached`, `agent_reported`,
`inferred`; one enum for every observed state, see
[`../06-rest-api/architecture.md` §2](../06-rest-api/architecture.md#2-resource-conventions)), `observedAt`, the **reasons** (list of named conditions below) and,
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

**[DECIDED]** (Wave 4) Each endpoint is probed on its own observer session that
opens with its guard query over the simple protocol, so a path that hangs the
extended protocol from the first message still opens and is reported as
`extended_protocol_failing`, not as down
([`../03-database-model/postgres-adapter.md` "Connectivity probe"](../03-database-model/postgres-adapter.md#connectivity-probe)).
The identity, settings and activity reads share one separate diagnostic
session on a direct path and are recorded one by one: a read that fails is a
failed probe with its class, the others still count.

### 2.1 Connection capacity (Wave 8 completion)

**[OBSERVED]** (`packages/diagnostics/src/reducer.ts` and `health.ts`) The
connections in use and the connections available were always measured, but
they reached a reader only inside a `connections_high` or
`connections_critical` condition, when a threshold was crossed. The sampler now
keeps them with the probe rows it already stores, so the latest sample answers
"how many of how many" without a threshold: the successful `activity` probe
carries `values.clientBackends`, the successful `settings` probe
`values.usableSlots` (whole numbers, no text). No Control Store column was
added; these members are not part of the public probe shape: the reader drops
them from every probe it returns, so neither REST nor MCP shows a probe
`values` member.

`GET /targets/{id}/health` derives `capacity` from the latest status row
only when **both** numbers are there, and then gives it that sample's
`observedAt` and the view's `source` (`sampled`, or `cached` when the sample is
older than two intervals; a lagging sampler still shows its last numbers with
their age, next to `unknown` / `sampler_lagging`). It is absent, never `0`,
when the latest sample did not measure them: the target was never sampled, was
unreachable, the `settings` or the `activity` read failed, or the row was
written before the numbers were stored (the next sample, within 15 seconds,
has them). `usableSlots: 0` is a measured value (and `connections_critical`).
The database size is not sampled today and is not part of the view; a probe
for it is a later decision, not part of this change.

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
| `identity_unverified` | the identity marker could not be read (the read failed; not a mismatch) | `degraded` |
| `settings_unreadable` | the capacity settings could not be read (capacity is not judged) | `degraded` |
| `activity_unreadable` | `pg_stat_activity` could not be read: "this does not mean nothing is stuck" (§6) | `degraded` |

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

**[DECIDED]** (Wave 4, `packages/diagnostics`) How the target rules are applied:

- The reducer is a pure function from one sample to a state and its
  conditions (no clock, no I/O); every rule above is a table test. A path
  whose simple probe fails is down (`probe_simple_failed`, per endpoint); all
  paths down is `unreachable`; some down is `unhealthy`. A broken pooler is
  never averaged away by a working direct path.
- An identity marker that is missing, unreadable or names another
  installation, target, generation or `system_identifier`, and an endpoint
  that now reaches another cluster or another database, are
  `identity_mismatch`: the state is `suspended`, a critical finding is opened
  (`health:identity_mismatch`, deduplicated), and the worker plans the
  target's suspension as the system actor; the Operations Engine executes it
  like any suspension (one open suspension per target, under a per-target
  lock). Nothing is re-stamped; resuming stays a human decision. Sampling
  continues for a suspended target.
- `plaintext_connections` opens a security finding
  (`health:plaintext_connections`) and does not change the state.
- When ExponetDB itself cannot probe (no observer credential, no active
  endpoint, no placement), the state is `unknown` with that reason, never
  `unreachable`.
- The latest status per target is one row the worker replaces; each sample is
  also appended to the daily partitions of `observation.health_samples`
  (created two days ahead and dropped after the retention, default 14 days,
  3 to 60). A missing partition loses that history point, never the status.
- Reads never probe. A status older than two sampling intervals (30 s) is
  served as `source: cached`; older than eight intervals (2 min) it is
  `unknown` with `sampler_lagging`; a target never sampled is `unknown` with
  `never_sampled` and `source: inferred`. None of them is ever shown as a
  fresh `healthy`.

## 4. Path awareness

**[DECIDED]** A target can have several registered **endpoints**: `direct`,
`pooler` (with mode: session/transaction), and per consumer the endpoint it
actually uses (declared in the registry, optionally verified by matching
`application_name` or client address in `pg_stat_activity`). Probes run on every
registered endpoint. The UI shows per endpoint: host:port (never user or
password), TLS mode and whether TLS is in use, last probe result.

**[DECIDED]** (Wave 4, G4 record §5 D5) In the registry a `direct` path is
an endpoint of kind `private`, `public` or `local_socket` (the domain
model's kinds); a `pooler` endpoint has its mode. Every active endpoint of
the target's cluster is probed with both protocols. Declaring which
endpoint each consumer uses, and verifying it from `pg_stat_activity`, is
**[PLANNED]** (no consumer registry exists in Wave 4).

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
  and the cap. **[DECIDED]** (G4 correction, 2026-10-07) The session
  conditions (`stalled_sessions`, `idle_in_transaction`, `long_running`,
  `lock_waits`) carry the exact count of matching sessions from SQL and their
  own `truncated` flag in `values`; the oldest ages are computed over all
  matching sessions, not over the listed ones. Before the correction, the
  count was the length of a list capped at 50 per flag combination, and the
  flag said `truncated` only above 200 sessions (120 stalled sessions read
  as 50, `truncated: false`).
- Gaps in history carry a cause (`control_plane_down`, `target_unreachable`,
  `node_offline`, `sampler_lagging`) and are drawn as gaps.
  **[OBSERVED]** (2026-10-13, Wave 8 server batch S1;
  `packages/diagnostics/src/health-history.ts`, `GET /targets/{id}/health/history`)
  The gaps are derived when the history is read, never stored, from the
  interval without a sample (longer than 30 seconds, twice the sampling
  period) and the process heartbeats that cover it (`control.process_heartbeats`,
  complete for the last 24 hours): `control_plane_down` when no worker
  heartbeat covered the interval (`reason` `no_live_process` when serve was
  not alive either, `no_live_worker` when it was), `sampler_lagging` when a
  worker was alive and wrote no sample, and `unknown` with `heartbeats_pruned`
  when the interval lies before the heartbeats still held. A stretch shorter
  than the threshold is absorbed by its neighbor, so a worker that came up
  seconds before its first sample does not split an outage. `target_unreachable`
  is not a gap: a failed sample is a sample and shows as the state of its
  bucket. `node_offline` is not derived: a node keeps only its current state,
  so a past interval cannot be attributed to it; the answer does not guess it.
  Nothing before the first retained sample, nothing in a target that is only
  registered, and nothing after a decommissioned target stopped being sampled
  is a gap.

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

**[OBSERVED]** (2026-10-13, Wave 8 server batch S1;
`packages/application/src/installation-health.ts`, `GET /installation/health`)
The table is served for people who hold `nodes.read` as `components` with a
state (`operational`, `degraded`, `down`), the source and time of the
observation, machine-coded `reasons` and `values` (counts and ages): Control
Store (serve's own readiness checks), workers, maintenance tasks and samplers
(failing, overdue, lagging, from the task table), data-read workers, gateway
(its heartbeat and the nodes' heartbeats), keyring (the loaded keyring against
the store) and the audit chain (head, checkpoints, export progress, the
outcome of the verification tasks). What the release cannot observe is listed
in `unobserved` with a reason and never counted as operational: the gateway
while no node is enrolled and no gateway runs (`not_applicable`), a task
family no worker has registered (`never_registered`). The gateway's own TLS
certificate is minted in memory and recorded nowhere, so its expiry is not
known (`GET /nodes/certificates` says so).

`/healthz/live` and `/healthz/ready` expose only up/down publicly.
**[DECIDED]** (Wave 2) Their public body is the status and the request id,
nothing else: `{"status":"up"}` for liveness; `ready` or `degraded` (HTTP
200, still serving) or `not_ready` (HTTP 503) for readiness. No check name,
reason, build version or timing is public. The per-check detail and the build
version are on each role's internal listener (`/healthz/detail`, loopback by
default, [`deployment.md`](../12-operations/deployment.md)). The detailed
Control Plane health is visible to authenticated users and in
[`self-observability.md`](./self-observability.md).

**[OBSERVED]** (2026-10-13, Wave 7; `apps/server/src/composition/access.ts`,
`apps/server/src/interfaces/mcp/edge.ts`, `apps/server/test/mcp-protocol.test.ts`;
G7 not yet accepted) `/mcp` is part of the `serve` role and has no readiness
endpoint of its own. Its availability follows the same switch as `/api/v1`:
while the stored role matrix or the scope catalog is not verified (the
`role_catalog` and `scope_catalog` readiness checks), `POST /mcp` answers
`503` with `Retry-After` and `CONTROL_PLANE_DEGRADED` after the `Origin` and
`Host` checks and before the token is read. Refusals at the `/mcp` edge are
counted by reason in `exdb_mcp_denied_total` (reason `degraded` included) and
every request is one `mcp.request` log line
([`self-observability.md`](./self-observability.md)); the image smoke
(`tooling/smoke/roles.sh`) requires `401` with its challenge at `/mcp`. A data
read by an agent also needs a live data-read worker (a heartbeat within 30
seconds, [ADR-0028](../01-architecture/adr/0028-data-read-lane.md)); without
one the read is `CAPABILITY_UNAVAILABLE`, never an empty result
([`../01-architecture/failure-model.md`](../01-architecture/failure-model.md) F31).

## 9. Surfaces

| Surface | Content |
|---|---|
| REST `GET /targets/{id}/health` | state, conditions, probes per endpoint, sources, timestamps; **[OBSERVED]** (Wave 8 completion, additive) the optional `capacity` of the latest sample ([§2.1](#21-connection-capacity-wave-8-completion)) |
| REST `GET /fleet` and `GET /findings` (Wave 8) | the fleet overview and the findings across targets ([§10](#10-fleet-overview-and-findings-across-targets)); REST only |
| REST `GET /targets/{id}/health/history?from&to` (Wave 8) | sampled history: buckets with the worst state and the count of each state, and gaps with a derived cause ([§6](#6-failed-reads-and-gaps)); REST only |
| REST `GET /targets/{id}/sessions` (Wave 4) | live: client backends of the target's database (filters: state, minimum age, application), statements always redacted with a digest of the redaction, capped with `truncated`, the ExponetDB operation behind an `exponetdb/…` application name |
| REST `GET /targets/{id}/locks` (Wave 4) | live: waiting sessions with the pids blocking them (`pg_blocking_pids`), lock mode and relation; detection only, nothing is terminated |
| MCP `target_health` | same, compact (without the REST-only `capacity`); untrusted fields (application names, statement text) labeled. **[OBSERVED]** (2026-10-13) Served since Wave 7 through the same use case as the REST route; state, conditions and probes keep their `source` and `observedAt`, and its contract text says a failed read is an error, never a healthy state (`packages/contracts/src/mcp/tools.ts`; parity with REST in `apps/server/test/mcp.int.test.ts`) |
| MCP `sessions_list`, `locks_list` (Wave 7) | the same data as the two REST rows above; statements are redacted and at most 500 characters for MCP with `truncated` and the digest of the whole |
| Web App target overview | three blocks in incident order (path, answers, stuck), then capacity, then history; **[OBSERVED]** (Wave 8 completion, 2026-10-20) a Refresh with an "Updated" stamp, each condition with the values the server sends (slots, oldest age, transaction id age), connection capacity from `capacity` with its source and age, a Host row from the node read for agent-managed placements ("Not reported" for external clusters), history presets from 1 hour to 14 days and a custom range clamped to what the server serves |
| Web App connections and locks | **[OBSERVED]** (Wave 8 completion) a "needs attention" strip computed from the reads the page makes (blocked sessions, top blocker over the blocking tree, longest active and idle-in-transaction ages) and the server's connection conditions with their values; only the server's conditions color anything, the page compares no number with a threshold; Live, Pause and Refresh with the observation age; filters (state, blockers only, minimum age, role, application, text over the redacted statement) where a cut read sends what the server can filter and names what ran over a sample; the lock tree with each blocker's session joined by pid "as of" the sessions read |
| Status integration for consumers | read-only health summary per target for consumer status pages (for example REOSA's `/status/database` link-out, [`../13-integrations/reosa-integration.md`](../13-integrations/reosa-integration.md)) |

**[DECIDED]** (Wave 4, after the G4 adversarial review) Times of health
statuses and samples are never later than the Control Store's clock (a
worker whose clock runs ahead would otherwise write a time that reads as
fresh and blocks other workers' samples). Activity reads require
`pg_read_all_stats` (through `pg_monitor`): without it PostgreSQL hides
other roles' state and backend type, so the read fails
(`activity_unreadable`, or `PERMISSION_DENIED` for the session list and
the lock graph) instead of counting zero sessions.

## 10. Fleet overview and findings across targets

**[OBSERVED]** (Wave 8, 2026-10-13; `packages/diagnostics/src/fleet.ts`,
`packages/application/src/application.ts` `fleet`,
`apps/server/test/http-wave8-fleet.int.test.ts`) `GET /fleet` is the one request
behind the Web App's start page.

- **Who sees what.** `fleet.get` needs `targets.read`, the permission of the
  target list, and counts exactly the targets that list would show: the one
  clause `targetVisibilitySql` (grant scopes, then a delegation's target list
  and tiers) serves the list, the counts and the cross-target findings. A caller
  limited to `nonprod` gets `nonprod` counts only; nothing says how many `prod`
  targets exist.
- **Targets.** By tier, by health state (`healthy`, `degraded`, `unhealthy`,
  `unreachable`, `unknown`, `suspended`) and by source. Health is the latest
  status the sampler wrote, read as the target list reads it ([§1](#1-subjects-and-their-states)):
  no status is `unknown` with source `inferred`; a status older than eight
  sampling intervals is `unknown` with source `cached`; older than two it keeps
  its state with source `cached`. `unknown` is never counted healthy.
  Decommissioned targets are counted apart (`decommissioned`) and in no tier or
  health count. `oldestSampleAt` is the oldest status behind the health counts.
  One aggregate query.
- **Findings.** Open findings by severity over the targets the caller may read
  with `diagnostics.read`. A caller without that permission (or whose client may
  not use it) gets `{available: false, reason: "permission_denied"}` for this
  part and the rest of the overview; a part is never shown as zero when the
  caller may not see it. One aggregate query. Findings of a decommissioned
  target stay open and count.
- **Operations.** `running`, `needs_attention` and `awaiting_approval`: the
  operations `GET /operations` would list for the caller (the plan kind's read
  permission at the plan's subject, memoized per kind and subject). One query
  reads the newest 500 operations in these states; when more exist the part says
  `lowerBound: true` with `lowerBoundReason: "scan_limit"`, because the count
  covers the newest 500 only. A caller who may read none of them sees zeros: for
  operations the visible set is the answer, as in the list.
- **Truthful reads.** Every part carries `source` (`live`: read from the Control
  Store in this request), `observedAt`, `lowerBound` and `lowerBoundReason`. A
  failed read makes the whole request an error (`500`/`503` as for any read); no
  count is replaced by zero. The targets and findings counts are exact
  (`lowerBound: false`); only the operations part can be a lower bound.
- **Number of queries.** Three reads (targets, findings, operations) plus the
  authorization of the request and, for operations, one decision per distinct
  plan kind and subject, never one per target.

`GET /findings` lists the findings behind the findings count across the same
targets, newest first by finding id (a ULID), with keyset pages (the primary key
serves the order; no index and no Control Store bundle were needed). The default
is open findings; `state=all` lists both. See
[`../06-rest-api/resources.md`](../06-rest-api/resources.md) for the filters.

# Node agent capabilities

| | |
|---|---|
| Status | Baseline (Wave 0), awaiting owner approval; Wave 5 implements the inspect and core apply capabilities, Wave 9 the backup/restore ones |
| Read before | [`architecture.md`](./architecture.md), [`protocol.md`](./protocol.md), [`../02-control-plane/operations-engine.md`](../02-control-plane/operations-engine.md) |

Each capability has a name, a major version, a JSON-Schema-defined input and
output, a privilege path (agent with local socket, or helper), a reconciliation
class, and a verification step. Capabilities ending in `.inspect`, `.status`,
`.stats`, `.audit`, `.list` are read-only. Capabilities ending in `.plan` are
read-only jobs that compute the analysis a control-plane plan needs. Every
state-changing capability is executed only as a job of an operation whose plan
was authorized (C-6).

**[DECIDED]** There is no capability that accepts a shell command, a script, a
file path chosen freely by the caller, or SQL text. Arguments are typed values.

## 1. Catalog

### PostgreSQL service

| Capability | Kind | Path | Reconcile | Notes |
|---|---|---|---|---|
| `postgres.status@1` | read | agent (systemd via helper `status`, socket) | — | running, pid, postmaster start time, version, data directory, `pg_is_in_recovery`, uptime |
| `postgres.reload@1` | apply | agent (`SELECT pg_reload_conf()`) | idempotent | verification: `pg_settings` reflects pending values, `pg_file_settings.error` empty |
| `postgres.restart.plan@1` | plan | agent | — | connections that will drop (per role/application), running backups/vacuums, replication slots, `pending_restart` parameters, estimated shutdown mode |
| `postgres.restart@1` | apply | helper (`systemctl restart postgresql@17-main`, fast shutdown) | observable (postmaster start time > job start) | verification: accepts connections, version unchanged, `pending_restart` cleared |

### Configuration

| Capability | Kind | Path | Reconcile | Notes |
|---|---|---|---|---|
| `postgres.config.inspect@1` | read | agent | — | `pg_settings` (value, unit, source, sourcefile, sourceline, pending_restart, context), `pg_file_settings` (errors) |
| `postgres.config.plan@1` | plan | agent | — | for proposed changes: validity (parameter exists, type/range/enum check via `pg_settings` metadata, version support), current value and source, requires reload or restart (`context`), conflicts (set in `postgresql.conf` and would be overridden) |
| `postgres.config.apply@1` | apply | agent (`ALTER SYSTEM SET/RESET` per parameter, then `pg_reload_conf()` when reload suffices) | idempotent (target values) | verification: `pg_file_settings` has no errors; reload-context values effective; restart-context values reported `pending_restart` and the operation continues with a restart job only if the plan included it. Previous values are stored in the operation to allow a planned revert. |

**[DECIDED]** ExponetDB manages configuration exclusively through `ALTER SYSTEM`
(`postgresql.auto.conf`). It does not edit `postgresql.conf`. Parameters that are
also set in `postgresql.conf` are shown with both sources; adoption moves them.

### TLS

| Capability | Kind | Path | Reconcile | Notes |
|---|---|---|---|---|
| `postgres.tls.inspect@1` | read | agent | — | server certificate subject, SANs, issuer, expiry, key type; `ssl` settings; `ssl_min_protocol_version` |
| `postgres.tls.plan@1` | plan | agent | — | generates a **new key pair on the host** and a CSR (key stays on host, in a staging path) |
| `postgres.tls.rotate@1` | apply | helper (install cert+key into allowlisted paths with correct owner/mode), agent (`pg_reload_conf()`) | idempotent (content hashes) | verification: a fresh TLS connection presents the new certificate; old files kept as `.previous` for one rotation |

### Roles, `pg_hba`, extensions, databases

| Capability | Kind | Path | Reconcile | Notes |
|---|---|---|---|---|
| `postgres.roles.inspect@1` | read | agent | — | cluster fingerprint part: roles, attributes, memberships (admin/inherit/set), `pg_db_role_setting`, password presence and type (never the verifier) |
| `postgres.roles.plan@1` | plan | agent | — | diff desired role manifest vs actual; classification (escalations critical) |
| `postgres.roles.apply@1` | apply | agent (SQL compiled in the capability, identifiers escaped, verifiers bound as literals by the escaper) | idempotent | verification: re-inspect equals desired |
| `postgres.hba.inspect@1` | read | agent | — | `pg_hba_file_rules` (incl. errors) |
| `postgres.hba.apply@1` | apply | helper (write file from plan content to the configured `hba_file`, keep previous), agent (check `pg_hba_file_rules` for errors **before** reload; on error restore previous file and fail) | idempotent | ExponetDB-managed lines inside marked blocks; foreign lines preserved as-is and shown in plans |
| `postgres.extensions.inspect@1` | read | agent | — | per database: installed extensions (version, schema), available versions |
| `postgres.extensions.apply@1` | apply | agent (`CREATE EXTENSION … SCHEMA … VERSION …` / `ALTER EXTENSION … UPDATE TO …`; no `CASCADE` unless the plan lists every dependent extension) | idempotent | requires the package (see packages) |
| `postgres.databases.apply@1` | apply | agent (`CREATE DATABASE … OWNER … TEMPLATE template0 ENCODING … LOCALE_PROVIDER …`) | idempotent | dropping databases is not a V1 capability |

### Packages and system

| Capability | Kind | Path | Reconcile | Notes |
|---|---|---|---|---|
| `packages.audit@1` | read | helper (`apt list --upgradable`, `apt-cache policy` for allowlisted packages) | — | installed vs candidate versions, security updates flagged |
| `packages.plan_update@1` | plan | helper (`apt-get -s` simulation for the selected packages) | — | exact versions, dependency changes, whether PostgreSQL restarts; **never** a PostgreSQL major change |
| `packages.apply_update@1` | apply | helper (`policy-rc.d` prevents automatic service restarts; `apt-get install --only-upgrade pkg=version …`) | manual (partial dpkg states need a human) | the plan pairs it with an explicit `postgres.restart` step if the PostgreSQL server binary changed |
| `system.health@1` | read | agent | — | load, memory, swap, disk, inodes, NTP sync, failed systemd units (names only) |
| `system.reboot_required@1` | read | agent (`/run/reboot-required`) | — | reboots themselves are not a capability in V1 |
| `disk.stats@1`, `memory.stats@1`, `cpu.stats@1` | read | agent | — | breakdowns (data dir, WAL, logs, backups, temp) |
| `service.status@1` | read | helper (`systemctl show` for allowlisted units) | — | units: PostgreSQL clusters, agent, helper, backup timers |
| `log.inspect@1` | read | agent | — | PostgreSQL and agent logs: time window, severity, max 500 lines; **redacted on the host** before sending ([`../03-database-model/statement-redaction.md`](../03-database-model/statement-redaction.md)) |

Package allowlist (V1, Ubuntu/PGDG): `postgresql-<major>`, `postgresql-client-<major>`,
`postgresql-<major>-pgvector`, `postgresql-common`, `postgresql-client-common`,
the chosen backup engine package, `libpq5`. Anything else is outside scope (C-3).

### WAL, backups, restore (Wave 9)

| Capability | Kind | Path | Reconcile | Notes |
|---|---|---|---|---|
| `wal.status@1` | read | agent | — | current LSN, WAL dir size, `max_wal_size`, replication slots and retained WAL, `pg_stat_wal` |
| `wal.archive_status@1` | read | agent | — | `pg_stat_archiver`, last archived/failed segment and time, engine-specific archive check |
| `backup.list@1` | read | helper or agent (engine `info` command with fixed argv) | — | engine catalog: backups, sizes, LSN ranges, WAL coverage |
| `backup.run@1` | apply | helper (engine `backup` with fixed argv from repository config) | observable (engine catalog shows the backup label) | kinds: full, differential/incremental (engine-dependent), logical dump |
| `backup.verify@1` | apply (read on repository) | helper (engine `verify`/checksum command) | idempotent | |
| `backup.expire@1` | apply | helper (engine retention command) | idempotent | runs only as part of an approved retention policy; ad-hoc deletion of backups is a separate planned operation |
| `restore.prepare@1` | plan | agent/helper | — | checks space, chooses a scratch data directory and port, validates the backup and WAL range for the requested point in time |
| `restore.execute@1` | apply | helper (engine restore into the **scratch** directory, start a temporary cluster on a non-default port bound to localhost) | observable | never restores over the data directory of a running, registered cluster in V1 |
| `restore.verify@1` | apply (read on scratch cluster) | agent | idempotent | `amcheck` on indexes, fingerprint, ledger head, row counts of configured tables, recovery target reached |
| `restore.discard@1` | apply | helper (stop temporary cluster, remove scratch directory) | idempotent | |

Promoting a restored scratch cluster to serve a target is a **placement move**
(registry operation), not a node capability.

### Agent self-management

| Capability | Kind | Notes |
|---|---|---|
| `config.update@1` | apply | new gateway address, rotated job-signing public keys, capability toggles; signed like every job |
| `agent.diagnostics@1` | read | agent version, journal stats, buffer sizes, last errors |

## 2. Plan/apply pattern for node operations

```
node_plan(kind=postgres.config, changes={max_connections: 250, work_mem: '32MB'})
   → control plane dispatches postgres.config.plan job (read-only) → analysis
   → plan: current/proposed per parameter, context (reload/restart), validity, conflicts,
           affected targets (all databases of the cluster) and tier (prod), policy decision
plan_apply(pln_…) → approval (prod tier) → job postgres.config.apply (signed) → agent executes
   → verification job (config.inspect) → operation result → audit
   → if restart-context parameters changed and the plan included a restart step:
        postgres.restart job (separate exclusivity: takes every target's schema domain on the cluster)
```

Plans bind to: node id and generation of its certificate session (re-enrollment
makes plans stale), the cluster's `system_identifier`, the inspected values
(config version: a hash over the relevant `pg_settings` rows), and the agent's
capability major.

## 3. Capability availability

The control plane uses a capability only if the node reported it in `hello` and it
is enabled in the node's local configuration. Operators can disable capabilities
locally (for example `packages.apply_update` on a host managed by another
process); the control plane then answers `CAPABILITY_UNAVAILABLE` with the reason
"disabled on node".

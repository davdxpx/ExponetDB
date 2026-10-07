# Node agent capabilities

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05; Wave 5 implements the inspect and core apply capabilities, Wave 9 the backup/restore ones |
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
| `postgres.config.plan@1` | plan | agent | — | for proposed changes: validity (parameter exists, type/range/enum check via `pg_settings` metadata, version support), current value and **source file** (`postgresql.conf`, an include file, `postgresql.auto.conf`), requires reload or restart (`context`), conflicts (a value set in a file that is read later and would override ExponetDB's value, or a value ExponetDB would override) |
| `postgres.config.apply@1` | apply | per [OD-20](../00-product/open-decisions.md#od-20-postgresql-configuration-ownership-strategy) (resolved 2026-10-07): the helper atomically replaces the ExponetDB-managed include fragment; then `pg_reload_conf()` when reload suffices | idempotent (target values) | verification: `pg_file_settings` has no errors; reload-context values effective; restart-context values reported `pending_restart` and the operation continues with a restart job only if the plan included it. Previous values are stored in the operation to allow a planned revert. |

**[DECIDED]** ([OD-20](../00-product/open-decisions.md#od-20-postgresql-configuration-ownership-strategy),
resolved 2026-10-07) ExponetDB owns its configuration through a dedicated
ExponetDB-managed include fragment (for example `conf.d/99-exponetdb.conf`,
written atomically by the helper) for ExponetDB's own parameters; the existing
`postgresql.conf` stays bootstrap or foreign configuration. `ALTER SYSTEM` is
not ExponetDB's normal writer. A missing include is reported as a bootstrap
need and the apply is refused until the local administrator adds it (Wave 5);
adding it remotely needs a separate decision. These rules hold:

- ExponetDB does not edit `postgresql.conf`.
- Every plan shows each parameter's current value and source file
  (`pg_settings.sourcefile`, `pg_file_settings`).
- Existing values in `postgresql.auto.conf` are detected and never silently
  overwritten or reset. PostgreSQL reads `postgresql.auto.conf` after
  `postgresql.conf` and its includes, so such a value would win over a managed
  fragment; the plan shows it as a conflict and adopting it is an explicit
  planned step.
- Validation after a change uses `pg_file_settings` (no errors) and
  `pg_settings` (effective values, `pending_restart`).
- **[ASSUMPTION]** Debian, Ubuntu and PGDG packaging ships a `postgresql.conf`
  that includes a `conf.d` directory. This is verified on the real hosts in
  Wave 5 before the decision is applied. A host whose configuration lacks the
  include is reported, not changed by ExponetDB; the local administrator adds
  the include (OD-20).

### TLS

| Capability | Kind | Path | Reconcile | Notes |
|---|---|---|---|---|
| `postgres.tls.inspect@1` | read | agent | — | server certificate subject, SANs, issuer, expiry, key type; `ssl` settings; `ssl_min_protocol_version` |
| `postgres.tls.plan@1` | plan | agent | — | generates a **new key pair on the host** (P-256, in a staging path; the key stays on the host) and returns its public key with a proof of possession (§4) |
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

### WAL, backups, restore (WAL status: Wave 5; backups and restore: Wave 9)

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

## 4. Contract (Wave 5)

**[DECIDED]** (Wave 5 Phase 1, 2026-10-07) The Wave 5 capabilities are a
closed catalog in `packages/contracts/src/node-protocol/capabilities.ts`
(`NODE_CAPABILITIES`), generated into the node protocol JSON Schema and into
Go types (`NewCapabilityArgs`, `NewCapabilityResult`). Fixtures for every
argument and result live in `tooling/fixtures/node-capabilities` and are
validated by the Zod schemas and round-tripped through the Go types.
Capabilities outside Wave 5 (backups and restore, `packages.apply_update`,
`postgres.databases.apply`) are not in the catalog; the agent answers
`capability_unsupported`.

- **Closed and typed.** Every object is closed, and every argument string has
  a pattern, an enumeration or a format; no member is a command, script,
  SQL text or path (tested). Patterns stay within RE2, which the Go agent
  uses (tested). Values read from PostgreSQL or the host are untrusted text.
- **Instance binding.** Every cluster-bound capability takes
  `cluster: {localName, systemIdentifier}`; the agent refuses the job
  (`precondition_failed`) unless its local instance has that system
  identifier.
- **Bound to what the plan saw.** Each apply carries the digest of the state
  its plan inspected (`expectedFragmentDigest` and `configVersion`,
  `expectedFileDigest`, `expectedCurrentFingerprint`, `expectedRolesDigest`,
  `expectedExtensionsDigest`) and fails with `precondition_failed` when the
  host differs.
- **Configuration (OD-20).** `postgres.config.apply` carries the complete
  content of the managed fragment; values are one line without control
  characters. `postgres.config.plan` reports a value that
  `postgresql.auto.conf` or a later file would override as a conflict.
- **`pg_hba`.** `postgres.hba.apply` carries the complete managed block:
  `local` or `hostssl` rules only, methods `scram-sha-256`, `peer` (local,
  with an ident map) or `reject`. `protectedAccess` lists ExponetDB's own
  access (role, database, client address, method); each must still match an
  accepting rule of the written file before the reload, otherwise the
  previous file is restored and the job fails (G5 item 7).
- **TLS (OD-17).** `postgres.tls.plan` generates the P-256 key on the host
  and returns its public key with a proof of possession, an ECDSA signature
  over JCS(`{purpose: "exponetdb/pgtls-pop/v1", jobId, publicKey}`).
  The worker issues the certificate from its own fixed profile (names
  from the plan, never from the host), as the agent PKI does
  ([ADR-0024 §2](../01-architecture/adr/0024-node-trust-model.md#2-node-keys-are-bound-through-the-token-results-are-signed-od-23-b)).
  This is the Wave 5 form of OD-17's "the Control Plane signs a CSR": the
  key still never leaves the host, and the Control Plane parses no ASN.1.
- **Roles.** `postgres.roles.apply` takes typed steps; the members each step
  takes are fixed (`ROLE_STEP_MEMBERS`). Names ExponetDB manages are
  lowercase ASCII identifiers; other roles are reported as unmanaged and
  never changed. No step sets `SUPERUSER`. A verifier travels only sealed
  (`ns1`, field `verifier`); a plaintext value is refused by the schema.
- **Extensions.** Steps `create` (with a schema) and `update`, in order;
  never `CASCADE`.
- **Packages.** Audit and planning only; the helper restricts both to the
  allowlist, and a PostgreSQL major change is never planned.
- **`config.update`.** Agent-owned state only (job keys, gateway address),
  never the root-owned operator configuration; the agent keeps one to three
  job keys.
- **Cancellation.** Each apply names its effect step (`effectStep`); a
  cancel seen before it completes the job `canceled`
  ([protocol.md §4.4](./protocol.md#44-idempotency-and-restarts)).

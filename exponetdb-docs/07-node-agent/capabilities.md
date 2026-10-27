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
| `postgres.reload@2` | apply | agent (`SELECT pg_reload_conf()`) | idempotent | verification: `pg_settings` reflects pending values, `pg_file_settings.error` empty (an error text only when it is fixed text, §6); `@1` retired |
| `postgres.restart.plan@2` | plan | agent | — | connections that will drop (per role; `@1`, which also named each client's `application_name`, retired by the correction review), running backups/vacuums, replication slots, `pending_restart` parameters, estimated shutdown mode |
| `postgres.restart@1` | apply | helper (`systemctl restart postgresql@17-main`, fast shutdown) | observable (postmaster start time > job start) | verification: accepts connections, version unchanged, `pending_restart` cleared |

### Configuration

| Capability | Kind | Path | Reconcile | Notes |
|---|---|---|---|---|
| `postgres.config.inspect@2` | read | agent (fragment digest: helper) | — | `pg_settings` (value by export class, unit, source, sourcefile, sourceline, pending_restart, context), `pg_file_settings` (errors as fixed text); keyed digests (§6); `@1` retired |
| `postgres.config.plan@2` | plan | agent (fragment digest: helper) | — | for proposed changes: validity (parameter exists, type/range/enum check via `pg_settings` metadata, version support), current value and **source file** (`postgresql.conf`, an include file, `postgresql.auto.conf`), requires reload or restart (`context`), conflicts (a value set in a file that is read later and would override ExponetDB's value, or a value ExponetDB would override); what the managed fragment holds for each requested value, compared on the host (§6); `@1` retired |
| `postgres.config.apply@2` | apply | per [OD-20](../00-product/open-decisions.md#od-20-postgresql-configuration-ownership-strategy) (resolved 2026-10-07): the helper atomically rewrites the ExponetDB-managed include fragment, changing only the planned parameters (§6); then `pg_reload_conf()` when reload suffices | idempotent (target values) | verification: `pg_file_settings` has no errors; reload-context values effective; restart-context values reported `pending_restart` and the operation continues with a restart job only if the plan included it. A revert is a new plan; the fragment's previous values never leave the host (§6). `@1` retired |

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
| `postgres.tls.rotate@1` | apply | helper (install cert+key into allowlisted paths with correct owner/mode), agent (`pg_reload_conf()`) | idempotent (content hashes) | verification: a fresh TLS connection presents the new certificate; old files kept as `<name>.exponetdb-previous` for one rotation; key and certificate change together or not at all, through the helper's installation record (§5, TLS) |

### Roles, `pg_hba`, extensions, databases

| Capability | Kind | Path | Reconcile | Notes |
|---|---|---|---|---|
| `postgres.roles.inspect@2` | read | agent | — | cluster fingerprint part: roles, attributes, memberships (admin/inherit/set), `pg_db_role_setting` values by export class with host-side comparisons of expected settings, password presence and type (never the verifier); `@1` retired |
| `postgres.roles.plan@2` | plan | agent | — | diff desired role manifest vs actual; classification (escalations critical); `@1` retired |
| `postgres.roles.apply@2` | apply | agent (SQL compiled in the capability, identifiers escaped, verifiers bound as literals by the escaper) | idempotent | verification: re-inspect equals desired; `@1` retired |
| `postgres.hba.inspect@2` | read | agent (file digest: helper) | — | `pg_hba_file_rules` (options by export class, errors as fixed text); `@1` retired |
| `postgres.hba.apply@2` | apply | helper (write file from plan content to the configured `hba_file`, keep previous), agent (check `pg_hba_file_rules` for errors **before** reload; on error restore previous file and fail) | idempotent | ExponetDB-managed lines inside marked blocks; foreign lines preserved as-is and shown in plans by export class; `@1` retired |
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
| `log.inspect@2` | read | agent | — | PostgreSQL and agent logs: time window, severity, max 500 lines; message parts that quote data withheld and the rest **redacted on the host** before sending (§6; `@1` retired) ([`../03-database-model/statement-redaction.md`](../03-database-model/statement-redaction.md)) |

Package allowlist (V1, Ubuntu/PGDG): `postgresql-<major>`, `postgresql-client-<major>`,
`postgresql-<major>-pgvector`, `postgresql-common`, `postgresql-client-common`,
the chosen backup engine package, `libpq5`. Anything else is outside scope (C-3).

### WAL, backups, restore (WAL status: Wave 5; backups and restore: Wave 9)

| Capability | Kind | Path | Reconcile | Notes |
|---|---|---|---|---|
| `wal.status@1` | read | agent | — | current LSN, WAL dir size, `max_wal_size`, replication slots and retained WAL, `pg_stat_wal` |
| `wal.archive_status@1` | read | agent | — | `pg_stat_archiver`, last archived/failed segment and time, engine-specific archive check |
| `backup.list@1` | read | helper (engine `info` with fixed argv, run as the engine user through a transient unit; restic `snapshots`) | — | engine catalog: backups, sizes, LSN ranges, archive range, the stanza's `db-system-id` and cipher (Wave 9 Part B, ADR-0037) |
| `backup.timers@1` | read | helper (`systemctl list-timers`, fixed argv) | — | timers that name pgbackrest, restic or backup: discovered, never changed (adopt mode, ADR-0036 §3) |
| `backup.run@1` | apply | helper (starts a supervised engine run, ADR-0037) | observable (the run record and the unit say whether it started; the engine catalog shows the label) | kinds: full, differential, incremental, logical dump; pgBackRest always with `--no-expire-auto`; the host's repository mode must allow runs (`adopted_runs`: incremental only; `owned`: all) |
| `backup.verify@1` | apply (read on repository; starts a run) | helper (engine `verify` with fixed argv; restic `check --read-data-subset`) | idempotent | |
| `backup.expire@1` | apply (starts a run) | helper (engine retention command) | idempotent | runs only as part of an approved retention policy, only on `owned` repositories, never removing a backup named in `keepLabels`; ad-hoc deletion of backups is a separate planned operation |
| `run.status@1` | read | helper (the run record and the unit) | — | the state, progress and redacted output of a run, bound to the start job's id and `argsHash`; states the terminal outcome node-signed (ADR-0037 §1) |
| `run.cancel@1` | apply | helper (stops the unit) | observable | never claims a rollback |
| `restore.prepare@1` | plan | helper | — | checks space, chooses a scratch directory (named by the run, under the node's scratch root) and a localhost port in 55400 to 55499, validates the backup and WAL range for the requested point in time and the stanza's `system_identifier` |
| `restore.execute@1` | apply (starts a run) | helper (engine restore into the **scratch** directory, start a temporary cluster on a localhost port, run the checks) | observable | never restores over the data directory of any instance on the host in V1 |
| `restore.verify@1` | apply (read on scratch; starts a run) | helper | idempotent | `amcheck` on indexes, probes, row counts of configured tables; the fingerprint and ledger head are compared by the Control Plane from the inputs the run reports |
| `restore.discard@1` | apply | helper (stop temporary cluster, remove scratch directory) | idempotent | |

Promoting a restored scratch cluster to serve a target is a **placement move**
(registry operation), not a node capability.

**[DECIDED]** (as built, Wave 9 Part B, 2026-10-27) The host side of these
capabilities:

- **Repositories are host configuration.** A pgBackRest repository is a
  stanza and `repoN` of the host's own configuration
  (`/etc/pgbackrest/pgbackrest.conf` or `/etc/pgbackrest.conf` and their
  `conf.d`, or the operator configuration's optional `pgbackrestConfig`
  path); a restic repository (engines `restic` and `pg_dump`: logical dumps
  stored by restic) is the directory the operator provisions under
  `/etc/exponetdb-node/repositories/<repositoryId>/` with `repository`,
  `password` (`0600`) and an optional `env` (allowlisted `KEY=VALUE` lines).
  The node never takes a location, key or credential from the Control Plane.
- **Repository binding file** `/etc/exponetdb-node/repositories/<repositoryId>/pgbackrest`
  (owner `root`, `stanza=<name>` and `repo=<1..4>`): required when the mode
  allows runs; a job naming another stanza or repo index is refused. Every
  run and restore first checks that the stanza's `db-system-id` is the
  job's cluster. A merged `conf.d` is named to every engine command
  (`--config-include-path`); it must be root-owned.
- **Host mode file** `/etc/exponetdb-node/repositories/<repositoryId>/mode`
  (owner `root`, not group- or world-writable; absent means
  `adopted_observed`): runs only with `adopted_runs` (incremental only) or
  `owned`; an unsafe file refuses every job on the repository.
- **Engine directory** `/var/lib/exponetdb-node-engine/{runs,scratch,reads}`
  (root, `0711`, from `packaging/tmpfiles.d/exponetdb-node-engine.conf`);
  engines run as the engine user, never as root (ADR-0037 §2).
- **Expiry** keeps every label in `keepLabels` or refuses before the engine
  runs (a conservative survivor check, then pgBackRest's own
  `expire --dry-run`), and reads the catalog again afterwards: a kept label
  gone (a backup that completed meanwhile shifted the retention) fails the
  run for a person to reconcile; the race is narrowed, not closed; restic expiry needs `logicalDays`
  and is refused with a non-empty `keepLabels` (restic snapshots cannot be
  named there yet: a `keepSnapshots` field is **[PLANNED]**).
  `backup.verify@1` with a `snapshot` checks the whole restic repository
  (restic 0.16 `check` cannot limit itself to one snapshot).
- **Scratch restores run no restored code** (security review C-2, B-4): the
  restored `postgresql.auto.conf` is kept aside as evidence and replaced by
  the recovery target lines; the postmaster's command line disables
  preloaded libraries, logical replication and other background workers,
  WAL senders, JIT, autovacuum, recovery commands and primary connection
  settings (and event triggers on 17+); after promotion and before any
  check the run fails unless no subscription or background worker runs;
  check sessions are read-only with `search_path=pg_catalog`. **Limit:**
  the scratch postmaster keeps network access (its `restore_command`
  fetches WAL over the network in the same process tree); the overrides,
  no TCP listener and the worker check are the barrier.
- **`walContinuous`** from `restore.prepare@1` is `false` only when missing
  coverage is shown, otherwise `null`; the node never claims continuity.
- **Output** is redacted on the host and capped; an excerpt is untrusted text.
- **NOT PROVEN** on a real systemd host: the transient units, `--wait` and
  `--pipe` from the helper's sandbox, `EnvironmentFile=`, surviving helper
  and agent restarts, and `lost` after a reboot (`PRE-WAVE-11-REVIEW.md`
  T-NODE-1, T-NODE-2). The real-engine lab test
  (`internal/helper/pglab_test.go`, build tag `pglab`) runs the engines as
  direct children.

### Agent self-management

| Capability | Kind | Notes |
|---|---|---|
| `config.update@1` | apply | rotated job-signing public keys and the gateway address (agent-owned state only, never operator toggles); signed like every job; the Control Plane changes keys only ([control-plane.md §9.8](./control-plane.md#98-job-key-rotation-nodeconfigupdate)) |
| `agent.diagnostics@2` | read | agent version, journal stats, buffer sizes, last errors (the agent's own texts, never PostgreSQL's message text, §6; `@1` retired), the trusted job keys and the gateway address (the node-signed evidence of a key rotation) |

## 2. Plan/apply pattern for node operations

```
node.plan  POST /nodes/{nodeId}/plans (REST or the CLI; never MCP, OD-29)
           kind=postgres.config.apply, changes={max_connections: 250, work_mem: '32MB'}
   → control plane dispatches postgres.config.plan job (read-only) → analysis
   → plan: current/proposed per parameter, context (reload/restart), validity, conflicts,
           affected targets (all databases of the cluster) and tier (prod), policy decision
plan.apply POST /plans/{planId}/apply → approval (prod tier) → job postgres.config.apply (signed) → agent executes
   → verification job (config.inspect) → operation result → audit
   → if restart-context parameters changed and the plan included a restart step:
        postgres.restart job (separate exclusivity: takes every target's schema domain on the cluster)
```

Plans bind to: node id and generation of its certificate session (re-enrollment
makes plans stale), the cluster's `system_identifier`, the inspected values
(config version: a hash over the relevant `pg_settings` rows), and the agent's
capability major.

**[DECIDED]** (Phase 5, 2026-10-07) Refinement: the plan request does not
dispatch the read-only job itself (`serve` cannot sign jobs and a plan
request never waits for a host). The analysis comes from an earlier
node-signed observation: `node.inspect` runs `postgres.config.plan` (or the
kind's other basis capability) first, and `node.plan` binds that observation
and refuses one older than 10 minutes. At apply the worker runs the basis
capability again and fails the operation `PLAN_STALE` if it differs; a
re-enrolled node has a new node id, which makes its plans stale. The full
rules are in [`control-plane.md` §9](./control-plane.md#9-capability-operations).

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
  identifier, and the root helper checks it again itself, from the data
  directory's `global/pg_control`, before any host change
  ([architecture.md §2](./architecture.md#2-processes-and-privilege-separation)).
- **Bound to what the plan saw.** Each apply carries the digest of the state
  its plan inspected (`expectedFragmentDigest` and `configVersion`,
  `expectedFileDigest`, `expectedCurrentFingerprint`, `expectedRolesDigest`,
  `expectedExtensionsDigest`) and fails with `precondition_failed` when the
  host differs.
- **Configuration (OD-20).** `postgres.config.apply@2` carries the planned
  changes only (a value, or `null` to remove the parameter); the helper
  rewrites the managed fragment on the host and keeps every other line as it
  is (§6). Values are one line without control characters. **[DECIDED]** (Phase 4 review) A parameter that is a
  directive (`include`, `include_dir`, `include_if_exists`), runs a program,
  loads code, names a path or a connection string, or moves the socket or
  port is never written, in a fragment or as a role setting
  (`DENIED_PARAMETERS`, [architecture.md §2](./architecture.md#2-processes-and-privilege-separation));
  the plans refuse it like any invalid argument. **[DECIDED]** (Wave 6,
  G6 finding A3) The transaction-state parameters `transaction_isolation`,
  `transaction_read_only` and `transaction_deferrable` are denied too: they
  describe the current transaction, so a file or role line of one never
  runs; desired state names `default_transaction_isolation`,
  `default_transaction_read_only` or `default_transaction_deferrable`. `postgres.config.plan` reports a value that
  `postgresql.auto.conf` or a later file would override as a conflict.
- **`pg_hba`.** `postgres.hba.apply` carries the complete managed block:
  `local` or `hostssl` rules only, methods `scram-sha-256`, `peer` (local,
  with an ident map) or `reject`. `protectedAccess` lists ExponetDB's own
  access (role, database, client address, method); each must still match an
  accepting rule of the written file before the reload, otherwise the
  previous file is restored and the job fails (G5 item 7).
  **[DECIDED]** (Phase 4) The block lies between the lines
  `# BEGIN EXPONETDB MANAGED BLOCK` and `# END EXPONETDB MANAGED BLOCK`; a
  file without it gets it at the top, so no foreign rule shadows a managed
  one, and an existing block is replaced where the operator put it. Markers
  that are not exactly one BEGIN followed by one END are refused
  (`precondition_failed`), never guessed.
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
  job keys. It moves the agent and the helper toward the job's target set: a
  key already trusted (with the same public key) is not added again and a
  key no longer trusted is not retired again, so a new job converges after a
  partial update (the helper's trust written, the agent's state not).
  Reconciliation is `observable`: `agent.diagnostics@2` reports the agent's
  keys and the helper's (`trust.inspect`, read with the same signed job,
  which the helper verifies against its own keys), so a read the new key
  signed proves that both accept it.
- **Cancellation.** Each apply names its effect step (`effectStep`); a
  cancel seen before it completes the job `canceled`; the effect point is
  also passed by a journaled step with that name, and a job that stops on a
  cancel after it completes `failed`
  ([protocol.md §4.4](./protocol.md#44-idempotency-and-restarts)).

## 5. Implementation (Wave 5 Phase 5)

**[DECIDED]** (Phase 5) How the agent implements the catalog
(`agent/node/internal/capabilities`), tested on PostgreSQL 16, 17 and 18:

- **Access.** The agent's own PostgreSQL client (`internal/pgwire`, the
  standard library only): protocol 3.0 over the instance's Unix socket,
  `peer` authentication only (a request for a password is refused), the
  extended query protocol with every value bound, `search_path` pinned to
  `pg_catalog` and a statement timeout; a context that ends cancels the
  statement on the server. Server files (the fragment, `pg_hba.conf`,
  `postgresql.conf`, the certificate, the server log) are read through the
  server as the superuser reads them; nothing is read from a path a job
  names.
- **Instance binding.** Every cluster-bound capability checks the mapping
  and `pg_control_system().system_identifier` before it is accepted
  (`precondition_failed`), and the helper checks it again before a host
  change. `postgres.status` alone accepts an instance that does not answer
  and reports it not running (57P03 counts as running).
- **Configuration.** `configVersion` is a digest over `pg_settings` and
  `pg_file_settings` as the server has them: a value the agent's own session
  set reads as what the files apply, or the default. Plans validate values
  by the parameter's type, unit, range and enumeration; `context =
  internal` is `not_settable_in_file`, `postmaster` needs a restart; a value
  from `postgresql.auto.conf` or a file read later is a conflict. Apply is
  refused unless `postgresql.conf` includes the fragment (an `include_dir`
  of its directory or an include of its path) and the configuration is
  still what the plan saw; a reload waits until the server has loaded the
  files again.
- **`pg_hba`.** `pg_hba_file_rules` loses the quotes of names, so the
  lockout check parses the written file itself (first rule that applies
  wins) and fails closed on anything it cannot judge before the match (a
  group, a regular expression, a file reference, `samerole`, `samehost`, a
  host name, an include). A parse error or a protected access that would
  be lost restores the previous file before any reload; after the reload a
  fresh session of the agent's own access is probed, and a refusal restores
  and reloads again (G5 item 7).
- **Restart.** The helper restarts PostgreSQL at most once per
  `restartIntervalSeconds` of the operator configuration (default 600) on a
  host, whatever the signed jobs ask: a flood of restart jobs from a
  compromised Control Plane cannot keep PostgreSQL down (threat model T31;
  **[DECIDED]** Wave 5 Phase 6). The helper refuses before it changes
  anything, but after the agent passed the effect point, so the Control
  Plane cannot tell it from a failure after the effect: the operation waits
  the restart's settle time and is reconciled from the host (`not_applied`,
  the postmaster start time unchanged). **[ASSUMPTION]** acceptable for a
  rare operator action; a pre-effect probe is a residual for the owner
  (G5 record).
- **TLS.** Plan and rotate require the server to read the TLS files the
  operator mapped; after the install and reload, a fresh TLS session
  (SSLRequest on the TCP port) must present the installed certificate.
  **[DECIDED]** (Wave 5 review, F6) Failure and recovery of
  `postgres.tls.rotate@1`: the helper installs the key and the certificate
  as one change behind a durable installation record
  ([architecture.md §2, item 9](./architecture.md#2-processes-and-privilege-separation)),
  so PostgreSQL never finds a key that is not its certificate's after the
  helper has settled. When an error interrupts the installation, the
  helper settles it at once from the record and answers with what is on
  disk: the new pair (the result; the agent reloads and probes as usual),
  `failed` with "the previous key and certificate are in place" or
  "nothing was changed" (the agent does not reload), or `outcome_unknown`
  when even the settling failed (the record stays; the helper settles it
  when it starts and before any other change, and refuses every change
  until then). On a refusal the agent fails the job after its effect point
  and reconciliation decides from the host (the presented certificate);
  the job is never run again (`replayed`). A helper that stopped during an installation settles it when it starts
  again, without the job. A record that cannot be trusted stops every
  change until the operator resolves it
  ([node runbook §7](../12-operations/node-runbook.md#7-an-interrupted-tls-installation)).
  Tested against PostgreSQL 16, 17 and 18: a reload keeps the pair the
  server has loaded, a start with a mixed pair fails, and after the
  settling the server reloads and restarts with the resulting pair.
- **Roles.** The agent never changes a superuser role. It never grants a
  role that is, directly or through its own memberships, a superuser or
  `pg_execute_server_program`, `pg_read_server_files` or
  `pg_write_server_files` (superuser in all but name), and never grants
  anything to a predefined (`pg_*`) role, to one of ExponetDB's own roles or
  to a role one of ExponetDB's least-privilege roles is a direct or indirect
  member of (that would widen every holder of the role). Both are judged on
  the live catalog for every grant, in the plan and in the apply
  transaction (**[DECIDED]** Wave 5 Phase 5 review). **[DECIDED]** (Wave 5
  correction review) The plan classifies a step by what it hands on: a
  membership in a group that is, or is a direct or indirect member of, a
  predefined role or a role with `CREATEROLE`, `REPLICATION` or `BYPASSRLS`
  is `critical`, as is a role setting of a parameter any user may not set
  in a session (`pg_settings.context` other than `user`, or a name the
  agent's session does not know, which a module loaded later can define as
  superuser-only): PostgreSQL applies a setting the agent's
  superuser role stored with that authority at the role's login
  (`lo_compat_privileges = on` turns off large-object privilege checks for
  the role). A `role` or `session_authorization` setting changes nothing
  beyond a membership: PostgreSQL checks it at login and keeps the session's
  identity when the role may not `SET` the target (tested on 16, 17 and 18).
  Before the transaction
  the session turns off everything that would write its values to the
  server log: statement and duration logging, sampled statements and
  transactions (sampling is decided when a transaction begins), bind
  parameters in duration and error messages, and pgaudit's and
  auto_explain's logging when they are loaded. A verifier is opened from its
  `ns1` seal only when its step runs, must be a SCRAM-SHA-256 verifier, and
  reaches PostgreSQL as a session value that a `DO` block reads: it is in no
  statement text, no log and no `pg_stat_statements` entry. Every session
  of the agent sets `standard_conforming_strings` itself, so literal quoting
  never depends on the cluster's configuration.
- **Extensions.** One transaction, in order, never `CASCADE`; a version the
  server does not offer (a missing package) is refused before anything
  changes.
- **Logs.** PostgreSQL's log is the end (8 MiB) of the Debian log file of
  the cluster; the agent's and the helper's come from the journal through
  the helper. Lines are filtered by time and severity and redacted on the
  host: passwords, verifiers, password hashes, connection-string and URI
  passwords, secret JSON members, bearer and enrollment tokens, sealed
  values and IP addresses. A password given as a literal of any form
  (standard, `E''`, `U&''`, dollar-quoted, with or without space) is withheld
  from the literal to the end of its log entry, continuation lines
  included, even when the line that opened it falls outside the lines
  returned.
- **Host.** Load, memory and CPU from `/proc`, mounts by `statfs`, the
  clock rule of the agent, failed units through the helper; the inventory
  of `hello` names only instances that answer, with their identifier and
  version.
- **`config.update`** updates the helper's trust (`trust.update`) before
  the agent's state.

## 6. Confidentiality of node exports (Wave 5 correction F1)

**[DECIDED]** (Wave 5 correction F1, 2026-10-08) A value the node reads from
PostgreSQL or the host leaves the node only when its **export class**
establishes that it is safe. The rules are explicit lists and types in the
agent (`internal/capabilities/export.go`), never a pattern over the text: a
value whose safety the node cannot establish is withheld. A withheld value is
exported as `{"withheld": "secret"}` (its kind holds credentials) or
`{"withheld": "unclassified"}` (the node cannot establish that it is safe);
never as `null`, an empty string or a value as if it had been read
(`NodeWithheldValue`).

- **Parameters** (`pg_settings`, `pg_file_settings`, role and database
  settings). Values of the connection-string and command parameters
  (`primary_conninfo`, `archive_command`, `archive_cleanup_command`,
  `restore_command`, `recovery_end_command`, `ssl_passphrase_command`) are
  `secret`. A boolean, numeric or enumerated parameter is shown when its text
  parses as its type (a credential cannot be written as one); a free-text
  parameter is shown only when it is one of the listed core parameters of
  PostgreSQL 16 to 18 whose values are names, lists, paths or formats.
  Everything else (an extension's or a custom parameter, a later release's,
  a value that does not parse) is `unclassified`.
- **Errors.** A `pg_file_settings.error` or `pg_hba_file_rules.error` is
  shown only when it is one of PostgreSQL's fixed messages; a message that
  can quote the file (an included file's name, a token of the line) is
  withheld. The agent's PostgreSQL client never carries the server's message
  text into an error (`postgres error <SQLSTATE> (<severity>)`), so no job
  error, output excerpt, `lastErrors` entry or agent log line holds it.
- **`pg_hba` options** are split into name and value; `ldapbindpasswd` and
  `radiussecrets` are `secret`, the listed options whose values are names,
  hosts, numbers or flags are shown, every other option (`ldapurl`, which can
  carry user information, and any later one) is `unclassified`.
- **Logs.** **[DECIDED]** (Wave 5 correction review) The PostgreSQL server
  log is shown by an allowlist, not by patterns over its text: a message is
  shown only when it is one of PostgreSQL's own messages listed in the
  agent (`internal/capabilities/logtemplates.go`: start, stop, recovery,
  checkpoints, reloads, parameter changes, connection and authentication
  failures, statement errors by kind), whose variable parts are numbers,
  LSNs, times, process ids, fixed words or a parameter's name; a part that
  can hold a client's or a file's text (a quoted value or token, a role,
  database or relation name, a host, a path, the details of a connection
  line) is `[withheld]`, so a password sent as a user name never shows.
  Every other message is `LEVEL:  [withheld]`; `DETAIL`, `HINT`,
  `STATEMENT`, `CONTEXT`, `QUERY` and `LOCATION` parts and every line that
  continues an entry are withheld whole; a line whose prefix is not the
  Debian default with plain names (a name with white space or a colon, a
  changed `log_line_prefix`) does not parse and is withheld. The earlier
  patterns let a value through when PostgreSQL appended the error position
  (`at character N`), after `near`, in the middle of a message, with a
  quote in it, and on continuation lines (auto_explain); tested on 16, 17
  and 18 with real client errors and a failed login.
  **[DECIDED]** (correction review, rounds 2 and 3) A client can write any
  text at `LOG` or `ERROR` (`RAISE`), also from processes whose lines carry
  no session (parallel, autovacuum and other background workers run client
  code), so neither a message's form nor its prefix proves who wrote it.
  A line therefore shows only what the server itself fixes: each message is
  bound to the levels PostgreSQL writes it at; a message only the server's
  own processes write (start, stop, recovery, checkpoints, reloads) is
  matched only on a line without a session, and shows a parameter's name
  only when the server knows the parameter (`pg_settings`, read in the same
  session as the log), the start line only when it is exactly the server's
  `version()`, and checkpoint, restartpoint and redo statistics only in the
  exact formats of PostgreSQL 16 to 18; in a line of a session a
  parameter's name is `[withheld]`, and type names, network errors, signal
  names and checkpoint flags are words of fixed vocabularies (the flags each
  at most once, in PostgreSQL's order; a time zone name only as the line's
  own prefix names it; round 4). A server
  whose `log_line_prefix` is not the Debian default (`%m [%p] %q%u@%d `)
  has every line read as a session's. A read that begins inside the file
  drops its first, cut line. Tested on 16, 17 and 18 with `RAISE LOG` and
  `RAISE EXCEPTION` forgeries and a parallel worker running a client's
  function. **Residuals:** a client can still make a line appear that is
  one of these messages with numbers it chose; and PostgreSQL writes a
  client's startup user and database names into the prefix unescaped, so a
  name with a line break can start a line that reads like the server's (it
  shows no more than the above; the file itself is equally misleading; a
  `jsonlog` destination would escape it, an operator choice). The agent's and the helper's own journal lines
  keep the Phase 5 redaction (they never carry PostgreSQL's text).
- **Keyed digests (`kd1`).** Every digest over state that may hold a withheld
  value is `kd1:<hex>`, HMAC-SHA-256 under a key that never leaves the node,
  over a purpose label and the canonical content (`internal/kdigest`). The
  agent's key is derived from its node encryption secret (HKDF-SHA-256, info
  `exponetdb/node-digest-key/v1`) and keys `configVersion`, `rolesDigest`
  and the managed `pg_hba` block's digest; the root helper keys the managed
  fragment's and `pg_hba.conf`'s digests with a random key in its own state
  directory (`digest.key`, root, mode 0600, created once). A digest covers
  withheld values too, so a change of a hidden value still changes it and
  makes a plan bound to it stale; nobody off the node can test a guessed
  value against it. Without its key a component exports no digest (fail
  closed). Losing the helper's key changes every digest it exports: every
  plan bound to one is stale, nothing is judged on a guess.
- **Comparisons on the host.** The Control Plane never needs a withheld
  value back. `postgres.config.plan@2` reports, for each requested change,
  what the managed fragment holds for it (`absent`, exactly the `requested`
  value, `other`, or `held`), whether that line is the effective one in
  the files (`applied`), whether the server runs it (`loaded`: `pg_settings`
  names it as the running value's source, read before `pg_file_settings`,
  which re-reads the files in the session; for a restart-only parameter,
  PostgreSQL's own comparison of the line with the running value when it
  reads the files, since `pg_settings` keeps naming the default for a value
  that did not change; `false` when another line or a source that outranks
  every file for the whole server sets it: the command line or
  `ALTER ROLE ALL` (not an override: PostgreSQL derives such a value from
  the files at startup, as for `wal_buffers = -1`); `null` when `pg_settings` does not show
  the parameter, a custom one no loaded module defines, or when a role,
  database, client or session value of the agent's session hides the
  server's source) and
  whether it waits for a restart (`pendingRestart`, also before any
  reload: reading the files marks a restart-only change pending in the
  session; never under a source a restart does not change);
  verification and reconciliation of `postgres.config.apply` use that. A
  source that outranks every file, also one behind the agent's own
  connection or role values (`ALTER ROLE ALL`, read by name from
  `pg_db_role_setting`), is the plan conflict `source_overrides`: the plan
  is refused and such a line never verifies, reload or not; a later line
  is matched without regard to the name's case, as PostgreSQL does.
  Neither `pg_file_settings` nor the line `pg_settings` names proves a
  reload (a rewrite in place keeps the line number): a change that takes
  effect at a reload, a removal included, counts as running only with the
  apply job's own signed statement (the job reloads after its write and
  waits until the server has loaded the files), and then only when
  `loaded` is not `false`; without that statement the verification cannot
  decide (`error`), and `false` fails it (correction review, rounds 5 and
  6). With `loaded` `null` the proven reload and the effective line
  decide: a command-line value of a custom parameter, or one behind the
  agent's own connection, role or database values, is not seen
  (residual). **[DECIDED]** (Wave 6, corrections of the round-8 Lows,
  G6 findings A3 to A5) The agent reads the running postmaster's own
  arguments (`postmaster.opts`, names only, never exported): a parameter
  set there with `-c name=value`, `-cname=value` or `--name=value` is the
  conflict `source_overrides` also where `pg_settings` reports the source
  `override` because PostgreSQL recomputed the value at startup
  (`wal_buffers = -1`, the SLRU `*_buffers`, `io_max_concurrency`), so such
  a fragment line never reads as waiting for a restart; the plan looks a
  parameter up without regard to case, as PostgreSQL does, so `TimeZone`,
  `DateStyle` and `IntervalStyle` are planned and applied by their
  lower-case names like any reloadable parameter
  (`TestACommandLineValueBehindAnOverrideOutranksTheFiles`,
  `TestMixedCaseParametersArePlannedAndApplied`, PostgreSQL 16, 17, 18);
  the transaction-state parameters are denied (above). **Residual:** PostgreSQL reports a
  restart-only value its check hook refuses with the same text as one that
  waits for a restart; when an earlier change of that parameter already
  waits for a restart, the node cannot tell them apart and reports
  `pendingRestart` (the agent checks type, unit, range and enumeration
  itself, not cross-parameter limits such as the total of backends). `postgres.roles.inspect@2`
  takes the settings a verification expects (`expectSettings`) and answers
  per expectation whether it `holds`.
  **[DECIDED]** (Wave 5 correction review) Such a comparison never answers
  a guess about a withheld value: an inspection (`node.inspect`) may not
  pass `expectSettings` (only the worker's verification of a roles change
  does, for values it just set), and `postgres.roles.plan@2` plans a
  setting whose current value is withheld even when it already equals the
  requested one, so a right and a wrong guess plan the same step.
  `postgres.config.plan@2` compares only a value its export class shows; for
  a withheld one it answers `held` whatever the request (correction review,
  round 2). The verification and reconciliation of `postgres.config.apply`
  count a `held` value as the planned one only when the fragment's keyed
  digest equals the one the signed apply statement reported writing (the
  helper writes exactly the planned changes); without that statement (a
  reconciled operation) such a change is not proven and stays for a person.
- **No write-back.** `postgres.config.apply@2` carries only the planned
  changes; the helper (`config.patch_fragment`) parses the managed fragment
  on the host, changes exactly the named parameters in place (a removal
  drops the line, a new one is appended), keeps every other line byte for
  byte, and refuses a fragment with lines ExponetDB did not write. A value
  the node withheld never travels to the Control Plane and back, so it can
  never be written back as a redacted text.
- **Retired majors.** The majors that could carry unclassified host values
  are retired: `postgres.reload@1`, `postgres.config.inspect@1`,
  `postgres.config.plan@1`, `postgres.config.apply@1`,
  `postgres.hba.inspect@1`, `postgres.hba.apply@1`,
  `postgres.roles.inspect@1`, `postgres.roles.plan@1`,
  `postgres.roles.apply@1`, `log.inspect@1`, `agent.diagnostics@1` and
  (correction review: a client's `application_name`)
  `postgres.restart.plan@1`
  (`RETIRED_NODE_CAPABILITIES`), each replaced by its `@2`. The agent answers
  `capability_unsupported`; the Control Plane never creates a job for one,
  cancels one still pending, never serves a stored observation of one
  (`latestObservation`, `observationOfOperation`, `listObservations` read the
  current catalog only), and treats a stored statement of one as proving
  nothing: the operation is reconciled from the host (`judgedEnd`,
  `quarantined`). Its stored arguments are never read either.
- **Statements an earlier release still holds.** An agent of a release
  before the correction may hold statements it has not delivered (the
  result buffer). The corrected agent marks its buffer at enrollment
  (`exports-classified`); on its first start over a buffer without the
  mark (an upgraded node) it parks every statement held there before
  recovery and before anything is sent, except a bare rejection (a fixed
  reason, no result, no steps, no excerpt), then writes the mark, so the
  pass runs once. A parked statement is still its job's one statement (the
  journal states and closes the job from it, protocol.md §4.4); it is never
  sent, and the Control Plane reconciles its job from the host. A buffer
  the agent cannot check sends nothing in that process. The other way
  round, an agent of an earlier release can still finish a retired job
  handed out before the Control Plane was updated: the gateway asks
  `node_admission.job_capability` and refuses that completion for good
  (`CONFLICT`, the agent parks it) before anything is stored
  ([`control-database.md` §5d](../02-control-plane/control-database.md#5d-implementation-wave-5)).
  The bytes still reach the gateway process over mTLS once; updating the
  agents before the Control Plane avoids even that
  ([`node-runbook.md`](../12-operations/node-runbook.md)).
- **What stays stored.** Statements, observations and plan bodies that a
  retired major produced before the correction stay in the Control Store
  (append-only, the audit chain is never rewritten) and are served by no
  reader. Their remediation is the owner's
  ([OD-28](../00-product/open-decisions.md#od-28-node-exports-stored-before-the-confidentiality-correction)).


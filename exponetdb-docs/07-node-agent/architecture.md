# Node agent architecture (`exponetdb-node`)

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
| Applies to | Wave 5 |
| Read before | [`../00-product/constitution.md`](../00-product/constitution.md) C-21, C-22; [`security.md`](./security.md) |
| Decision | [ADR-0014](../01-architecture/adr/0014-node-agent-outbound-mtls.md) |

## 1. Purpose and limits

The node agent runs on every agent-managed database host. It performs the
host-level work that SQL cannot do or that needs superuser: PostgreSQL service
control, configuration, TLS material, roles and `pg_hba`, extensions, packages of
the PostgreSQL stack, backups and restores, host metrics and log inspection.

**[DECIDED]**

- The agent exposes a **finite, versioned catalog of typed capabilities**
  ([`capabilities.md`](./capabilities.md)). There is no shell, no generic command
  execution, no arbitrary SQL, no file read/write API (C-22).
- The agent has **no listening network port**. It dials out to the gateway over
  mTLS and pulls jobs (§3).
- The agent is not an orchestrator: it does not install the OS, manage users
  other than its own, run containers, or touch anything unrelated to PostgreSQL
  on that host.

## 2. Processes and privilege separation

**[DECIDED]**

```
                       ┌─────────────────────────────────────────────────────┐
  gateway (mTLS) ◀────▶│ exponetdb-node        user: exponetdb-node (no shell, no sudo) │
                       │  · protocol client, job journal, capability dispatch           │
                       │  · PostgreSQL local socket (peer → role exponetdb_node)        │
                       │  · reads /proc, statvfs, PostgreSQL logs (group adm/postgres)  │
                       └───────────────┬─────────────────────────────────────┘
                                       │ Unix socket, typed requests (no strings executed)
                       ┌───────────────▼─────────────────────────────────────┐
                       │ exponetdb-node-helper   user: root, no network       │
                       │  fixed operations only:                               │
                       │   systemctl reload|restart|status postgresql@<v>-<c>  │
                       │   install file to allowlisted path (TLS, conf. frag.) │
                       │   apt operations for allowlisted packages             │
                       │   (later) backup engine invocations with fixed argv   │
                       └─────────────────────────────────────────────────────┘
```

- **`exponetdb-node`** (network-facing, unprivileged): runs as a dedicated system
  user without login shell and without sudo. It is a member of the groups needed
  to read PostgreSQL logs and to connect over the local socket. It connects to
  PostgreSQL via the Unix socket with `peer` authentication mapped to the
  PostgreSQL role `exponetdb_node` (superuser, local only), and only executes SQL
  that is compiled into capability implementations, with parameters bound.
- **`exponetdb-node-helper`** (root, local-only): a separate small binary
  started by systemd with socket activation, accepting requests only from the
  agent's UID (checked via `SO_PEERCRED`). It implements a fixed enum of
  operations with strictly validated arguments (unit names from a pattern,
  destination paths from an allowlist, package names from an allowlist, versions
  matching a regex). It never invokes a shell; it calls `execve` with fixed argv
  arrays. Its whole job is to make "the agent is compromised" not equal "root".
- systemd hardening for both units: `NoNewPrivileges`, `ProtectSystem=strict`
  with explicit `ReadWritePaths`, `ProtectHome`, `PrivateTmp`,
  `RestrictAddressFamilies` (the helper: `AF_UNIX` only), `CapabilityBoundingSet`
  minimal, `SystemCallFilter=@system-service`.

## 3. Communication model

**[DECIDED]** Outbound only, pull-based:

1. The agent opens an HTTPS/2 connection with mutual TLS to the gateway
   (`https://<gateway>:7443`, private network in V1).
2. `hello` (identity, versions, capability report), then a loop:
   - `heartbeat` every 15 s (health, skew, in-flight jobs);
   - `claim` long-poll (up to 25 s) for jobs;
   - `progress` / `complete` for running jobs.
3. On disconnect: exponential backoff with jitter (1 s → 60 s), buffering of
   heartbeat summaries (last 24 h, downsampled) and of job results until
   delivered.

Why pull instead of the control plane connecting to the agent: no listening port
on database hosts, NAT and firewall friendliness, and the agent controls when it
takes work (it can refuse when the host is unhealthy). Why HTTPS/JSON instead of
gRPC: debuggability, one less toolchain, sufficient for the volume (a few jobs per
day, one heartbeat per 15 s). The protocol is specified in
[`protocol.md`](./protocol.md); its messages are JSON Schemas generated from
`packages/contracts`.

## 4. Local state

| Path | Content | Protection |
|---|---|---|
| `/etc/exponetdb-node/config.yaml` | gateway address, node id, CA bundle fingerprint, capability toggles | root-owned, readable by agent |
| `/var/lib/exponetdb-node/identity/` | private key (generated locally, never leaves), current and next certificate | `0600`, agent user |
| `/var/lib/exponetdb-node/journal/` | job journal (append-only file per job: claimed, started, step done, result) | `0600`, agent user |
| `/var/lib/exponetdb-node/buffer/` | undelivered heartbeats/results | `0600` |
| `/var/log/exponetdb-node/` (journald) | structured logs, redacted | journald |

The **journal** is the agent's memory against double execution: a job id that is
`completed` in the journal is never executed again; a job that is `started` but not
completed after a restart is reported as `outcome_unknown` with the steps that
completed, and the capability's reconciliation decides (§ protocol).

**[DECIDED]** (Wave 5 Phase 2, G5 record C8; implemented in `agent/node/internal`)

- **Operator configuration** (`config`): `/etc/exponetdb-node/config.json`,
  schema `exponetdb.node-config/v1`, owned by root, never writable by group
  or others, and never written by the agent or the Control Plane. It holds
  what the host operator decides: the state directory, the helper socket,
  disabled capabilities (`name@major`) and the **local instance mapping**
  (local name, systemd unit, port, socket directory, data directory,
  `postgresql.conf`, `pg_hba.conf`, the managed include). It is strict JSON
  instead of the YAML of the baseline, because the agent module uses the Go
  standard library only; duplicate or unknown members stop the agent.
- **Agent state** (`state`): in the state directory (mode `0700`, owned by
  the agent user), `state.json` holds the node's ids, the gateway address
  and server name, the pinned root certificate, the trusted job keys and the
  highest accepted `issuedAt`; `identity/keys.json` holds the TLS seed, the
  node signing seed, the node encryption secret and the current
  certificate. Both are written atomically (temporary file, fsync, rename,
  directory fsync), carry a SHA-256 checksum over their canonical content,
  and are `0600`. A damaged file stops the agent until a local operator
  repairs it or the node is re-enrolled; a missing one means not enrolled.
- **Journal** (`journal`): `journal/journal.log` is an append-only,
  hash-chained file of canonical JSON lines (`seq`, `prev`, `hash`), one per
  lifecycle record (`accepted`, `started`, `step`, `completed`, `rejected`,
  `abandoned`); each is synced before the agent acts on it. Only a job whose
  signature verified is recorded. `journal/nonces.log` is the separate nonce
  cache (7 days). A final line without its newline is a write a crash
  interrupted before the sync (nothing was acknowledged for it) and is cut
  off; any other damage, or a failed write, refuses every job with
  `journal_corrupt` until a local operator repairs it. Compaction keeps 90
  days of terminal jobs and every open job behind a checkpoint record.
- **Argument validation** (`schema`): the agent embeds the generated node
  protocol JSON Schema and validates every job's arguments with it and with
  the contract's refinements before executing anything; the validator
  refuses to load a schema that uses a keyword it does not implement.
- **Clock** (`clock`): synchronized means the kernel's `adjtimex` state
  (read only) reports neither `TIME_ERROR` nor `STA_UNSYNC`.

## 5. Implementation language

**[DECIDED]** **Go** ([OD-2](../00-product/open-decisions.md#od-2-node-agent-implementation-language),
resolved 2026-10-05) for both the daemon and the helper. Reasons: single static binary per
architecture (no runtime on database hosts), mature TLS/mTLS, strong standard
library for systemd/socket/process control, small memory footprint, easy
cross-compilation, and it keeps the database host's attack surface small. The
cost is a second language in the repository; contracts are shared via generated
types from JSON Schema, and golden vectors cover cross-language behavior (job
signature verification, canonical JSON). Alternative considered and rejected:
TypeScript compiled with Bun into a single executable (one language, larger
binary, younger toolchain for privileged system work).

## 6. Packaging, installation and upgrades

**[PLANNED]**

- Distributed as a `.deb` (Ubuntu 24.04 on `reos-db-01`), signed, from an
  ExponetDB package repository (or a release artifact with checksum and
  signature), plus static binaries for other distributions.
- Installation is an OS-level action outside ExponetDB (runbook or provisioning
  tool): install package, place `config.json` (§4), run `exponetdb-node
  enroll --token-file -` with the token on standard input. ExponetDB never
  installs its own agent remotely.
- **Upgrades**: an `agent.update` capability is **not** in V1; upgrades are
  performed by the package manager under operator control (runbook), because an
  agent that upgrades itself through its own job channel creates a bootstrap risk
  (a bad version cannot fix itself). Version compatibility: the control plane
  supports the current and previous protocol major; the agent refuses to operate
  against an unsupported control plane and reports why.
- Downgrades: allowed within the same protocol major; the journal format is
  versioned and readable by both.

## 7. Resource budget

The agent must never compete with PostgreSQL: CPU quota 10 % of one core,
memory limit 128 MiB (systemd), nice level 10, I/O class best-effort low for
non-backup work. Backups and restores run as child processes of the helper or
agent with their own, explicitly configured budgets.

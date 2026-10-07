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

**[DECIDED]** (Wave 5 Phase 4, G5 record C10) How the helper keeps "the
agent is compromised" from meaning "root":

1. **RPC** `exponetdb.helper/v1`: a Unix stream socket (systemd socket
   activation, mode `0660`, group of the agent user), one request per
   connection, a 4-byte big-endian length then strict JSON (at most 1 MiB,
   exact member names) each way, deadlines on every read and write. Without
   socket activation the helper creates the socket only in a directory of
   root's that no one else can write (Phase 4 review). Requests are served
   one at a time; one waits at most 30 s for the one before it, so an effect
   never happens long after its caller gave up.
2. **Caller**: `SO_PEERCRED` must name the agent user's uid (`agentUser` in
   the root-owned operator configuration); any other uid, root included, is
   refused before the request is read.
3. **Every operation carries its signed job.** The helper verifies the
   envelope itself with **its own trust**: a root-owned file
   (`/etc/exponetdb-node/helper-trust.json`, in a directory no one else can
   write) holding the node and the trusted job keys (and the installation,
   for the operator's reference), never the agent's state. It checks the
   signature, the node, the validity window against its own synchronized
   clock (the agent's rule), the arguments against the embedded schema, and
   that the operation is the one the job's capability needs. A compromised
   agent can only replay a signed intent, and only within its window.
4. **No free parameter.** The request names an operation and the job; every
   unit, file, package and value comes from the operator configuration and
   the signed arguments, rendered by the helper (a configuration fragment
   from typed parameters, an HBA block from typed rules, both by
   `internal/pgfiles`, which the agent also uses to inspect). Unit names,
   paths and package names are checked against patterns and allowlists
   again. **No parameter that is a directive, runs a program, loads code or
   names a path is ever written** (Phase 4 review): `include`,
   `include_dir`, `include_if_exists`, every `*_command`, `*_library`,
   `*_libraries`, `*_provider`, `*_file`, `*_dir`, `*_directory`, `*_path`
   (but `search_path`), `*_conninfo`, `*_keyfile`, `unix_socket_*`, the
   procedural languages' start-up hooks, `port`, `data_directory`,
   `hba_file`, `ident_file`, `config_file`, `allow_system_table_mods` and
   `session_replication_role`, in a fragment or as a role setting; the
   contracts, the agent's schema check and the helper's renderer apply one
   rule (`tooling/fixtures/node-parameters/denied.json`). pg_hba names are
   quoted (only `all` is the keyword) and addresses parse as CIDRs. The
   helper reads the cluster's `system_identifier` itself from
   `global/pg_control` of the mapped data directory and refuses a job whose
   cluster has another one (`precondition_failed`): it acts on the instance
   the job names or not at all.
5. **One effect per job.** The helper keeps its own hash-chained ledger
   (`/var/lib/exponetdb-node-helper/effects.log`): an effect is recorded,
   synced, right before it happens and after the operation's read-only
   preconditions held, so a failed precondition never spends the job. A job
   id that had an effect is refused (`replayed`); the HBA restore is the one
   documented second step, only right after that job's write and only while
   the file is still exactly what the write produced. Each record keeps the
   job's signed `issuedAt` and `expiresAt`: the helper's clock must not fall
   behind the highest `issuedAt` by more than 30 s (the agent's rollback
   rule), and a record is dropped only seven days after its job expired,
   with the cutoff following signed time, as the agent's journal does.
6. **Trust lifecycle**: right after enrollment the operator runs
   `exponetdb-node-helper trust --agent-state <dir> --expect-key <fp>…` as
   root, which copies the node and job keys of the freshly enrolled agent,
   prints each key's fingerprint and writes nothing unless every key is one
   the operator expected (the job key fingerprints the Control Plane shows);
   it is also the recovery if the two ever disagree, and it creates nothing
   in the agent's directory. `trust --show` prints the helper's keys. Later
   key rotations reach the helper only as a signed `config.update@1` job
   verified by its current trust (`trust.update`). The agent calls `trust.update` before it changes
   its own state, so a failure leaves the helper trusting no key the agent
   does not (fail closed).
7. **Execution**: absolute binaries from a fixed list (`systemctl`,
   `dpkg`, `dpkg-query`, `apt-cache`, `apt-get`), argv built inside the helper, an
   environment of `PATH=/usr/sbin:/usr/bin:/sbin:/bin`, `LC_ALL=C` and
   `LANG=C` plus the variables that turn off pagers, colors and prompts,
   `/` as working directory, no standard input, standard error discarded,
   a timeout (60 s, a restart 10 min; a restart that times out is
   `outcome_unknown`, since systemd's job may still run), a 1 MiB output
   cap; never a shell. A stop waits for the requests in flight; it never
   interrupts one (`TimeoutStopSec` covers a restart, Phase 6 packaging).
8. **Files**: every path is opened component by component from `/` with
   `O_NOFOLLOW` (a symlink anywhere is refused), files are read and replaced
   relative to the open directory (`openat`, `renameat`), never resolved by
   path again, so a directory swapped after the check does not redirect the
   write; reads never block (a FIFO or device in a managed file's place is
   refused as not a regular file); new content goes to an exclusive temporary file in the same
   directory, is synced, renamed into place and the directory synced; the
   previous content is kept next to it (`<name>.exponetdb-previous`), and a
   digest precondition from the signed arguments must match the current
   content first. A file the helper creates for PostgreSQL belongs to the
   owner of the data directory; only permission bits are ever written, never
   setuid, setgid or sticky.

**Residuals** (Phase 4 review, stated, not solved):

- At the trust bootstrap the agent's state is the agent's word: a
  compromised agent at that moment can plant its own job key, which is why
  the operator compares fingerprints (`--expect-key`).
- A key retirement reaches the helper only through the agent: a compromised
  agent can withhold it, and the helper keeps trusting the retired key
  until the operator compares `trust --show` with the Control Plane and
  runs the recovery.
- The agent holds a PostgreSQL superuser (§3 of security.md) and through it
  the PostgreSQL OS user; files and directories that user owns (the Debian
  configuration directory, the data directory) are within a compromised
  agent's reach. The helper's preconditions and file checks keep the agent
  from **root**, not from PostgreSQL's own files; the operator configuration
  refuses an agent user that owns a data directory.
- `tls.install` keeps the replaced key as `<key>.exponetdb-previous` (mode
  `0600`, the data directory's owner) for one rotation; a failed
  certificate write puts the previous key back.

| Operation | Authorized by | Effect | What the helper does |
|---|---|---|---|
| `service.status` | `service.status@1` | — | `systemctl show` of the mapped units, the agent and the helper; a unit that is not loaded reports its load state; `since` is the last state change |
| `service.restart` | `postgres.restart@1` | yes | `systemctl restart` of the mapped unit (fast shutdown); a timeout is `outcome_unknown` |
| `config.write_fragment` | `postgres.config.apply@1` | yes | the managed include fragment (OD-20), digest precondition, new file `0640` |
| `hba.write`, `hba.restore` | `postgres.hba.apply@1` | yes | the marked block in `pg_hba.conf` (inserted at the top when absent, foreign lines byte for byte), digest precondition; the restore as above |
| `tls.generate_key` | `postgres.tls.plan@1` | yes | a P-256 key staged root-only for a day (at most 16), its public key and proof of possession |
| `tls.install` | `postgres.tls.rotate@1` | yes | the staged key (`0600`) and the chain, after checking the key, the chain's signatures, validity and the current certificate's fingerprint |
| `packages.audit`, `packages.plan_update` | `packages.audit@1`, `packages.plan_update@1` | — | the allowlist only; `dpkg-query` (a half-installed package is an error, never "installed"), `apt-cache policy` (as of the host's last list update) and `apt-get -s` without the lock and without writing apt's caches; a downgrade is refused |
| `trust.update` | `config.update@1` | yes | the key changes of the job applied to the helper's own trust |

The operator configuration gains `agentUser` (required by the helper; it
refuses root and a user that owns a data directory) and, per instance,
`tlsCertificateFile` and `tlsKeyFile` (dedicated to the instance; without
them `postgres.tls.*` is refused `not_configured`). No managed path is used
twice, within an instance or across instances; the configuration and its
directory belong to root and no one else can write them.

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
  `abandoned`, `interrupted`); each is synced before the agent acts on it.
  Only a job whose signature verified is recorded. `journal/nonces.log` is
  the separate nonce cache (7 days). A final line without its newline is a
  write a crash interrupted before the sync (nothing was acknowledged for it)
  and is cut off; any other damage, or a failed write, refuses every job with
  `journal_corrupt` until a local operator repairs it. Compaction keeps 90
  days of terminal jobs and every open job behind a checkpoint record.
  **[DECIDED]** (Wave 5 review) The 90 days (and the nonce cache's 7) count
  back from the earlier of the host clock and the highest accepted
  `issuedAt`, never from the host clock alone (protocol.md §4.2 step 4), and
  compaction runs at most daily across reconnects.
- **Journal budget** **[DECIDED]** (Wave 5 review): each file is capped at
  64 MiB. A simple job takes about 1.6 KB (measured: `accepted`, `started`,
  one step, `completed`), so the journal holds about 41,000 jobs, about 460
  jobs a day over the 90-day retention; a capability with many steps takes
  more. Wave 5 sends jobs on demand only: health, statistics and WAL facts
  travel in heartbeats, not as jobs, and no periodic job exists. A full
  journal refuses a new job without breaking (`journal_corrupt`, a delivery
  rejection, and the reason in heartbeats) until compaction frees space; a
  later wave that schedules periodic jobs must size this budget first.
- **One process per state directory** **[DECIDED]** (Wave 5 review): `run`
  and `enroll` take an exclusive `flock` on `<state>/lock` and refuse to
  start while another process holds it, so two agents can never journal or
  execute the same job; `status` reads the journal read-only and never cuts
  a torn tail the running agent may be writing.
- **Result buffer** (`buffer/`): one signed statement per job
  (protocol.md §4.2), written once (`link(2)` of a synced temporary file)
  and never replaced; a delivery rejection is never stored, so forged
  deliveries cannot fill the disk. A statement the gateway refuses for good,
  or one the agent's own request check refuses, is parked as
  `<jobId>.refused` for the local operator.
- **Argument validation** (`schema`): the agent embeds the generated node
  protocol JSON Schema and validates every job's arguments with it and with
  the contract's refinements before executing anything; the validator
  refuses to load a schema that uses a keyword it does not implement.
- **Clock** (`clock`): synchronized means what systemd's `NTPSynchronized`
  means: the kernel's maximum error estimate (`adjtimex`, read only) is
  below 16 s. `STA_UNSYNC` is ignored, as systemd ignores it, because chrony
  and others keep it set while the clock is synchronized to stop the kernel
  from writing the RTC (Wave 5 review; the earlier text required it clear).

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

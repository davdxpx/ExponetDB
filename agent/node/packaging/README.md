# Node agent packaging (Wave 5 Phase 6)

What a host gets: two statically linked binaries and three systemd units,
nothing else. No Docker, Node.js or Bun on a database host.

| File | Installed as | Notes |
|---|---|---|
| `exponetdb-node-<version>-linux-<arch>` | `/usr/bin/exponetdb-node` | the agent; runs as `exponetdb-node` |
| `exponetdb-node-helper-<version>-linux-<arch>` | `/usr/sbin/exponetdb-node-helper` | the root helper; socket-activated |
| `systemd/exponetdb-node.service` | `/etc/systemd/system/` | no capabilities, `ProtectSystem=strict`, state in `/var/lib/exponetdb-node` |
| `systemd/exponetdb-node-helper.socket` | `/etc/systemd/system/` | `/run/exponetdb-node/helper.sock`, mode `0660`, group `exponetdb-node` |
| `systemd/exponetdb-node-helper.service` | `/etc/systemd/system/` | `CAP_CHOWN CAP_DAC_OVERRIDE CAP_DAC_READ_SEARCH CAP_FOWNER` only, no network, writes under `/etc/postgresql`, `/etc/exponetdb-node` and `/var/lib/exponetdb-node-engine` only |
| `sysusers.d/exponetdb-node.conf` | `/usr/lib/sysusers.d/` | the agent's user, no login shell |
| `tmpfiles.d/exponetdb-node.conf` | `/usr/lib/tmpfiles.d/` | `/var/lib/exponetdb-node`, the agent's user, `0700`: a fresh host enrolls the node before any unit started (TC-039) |
| `tmpfiles.d/exponetdb-node-engine.conf` | `/usr/lib/tmpfiles.d/` | `/var/lib/exponetdb-node-engine/{runs,scratch,reads}`, root, `0711`: the backup and restore runs (ADR-0037), which the helper starts as transient units through `systemd-run` |

- `build.sh <version> [dir]` builds both binaries for linux/amd64 and
  linux/arm64 from a clean commit (`-trimpath`, no build ID, version and
  commit set, never the e2e test seams), copies the units, the sysusers.d
  file and the runbook next to them and writes `SHA256SUMS-<version>` over
  all of it.
  `exponetdb-node version` prints the version and the commit.
- `verify-units.sh` checks the units with `systemd-analyze verify` in a
  scratch root, and that the agent unit names the helper socket only in
  `Wants=`/`After=` (a stopped helper must not stop the agent). Their
  behavior under systemd is tested by the host test
  (`apps/server/test/agent-capabilities.host.test.ts`, CI job `node-pg`),
  which runs the agent and the helper from these unit files.
- Backup repositories are bound on the host (ADR-0036 §4): for each
  repository id the operator creates `/etc/exponetdb-node/repositories/<id>/`
  (root, `0755`) with a `mode` file (`adopted_observed`, `adopted_runs`,
  `owned`) and, for a pgBackRest repository that may run, a `pgbackrest` file
  of the two lines `stanza=<name>` and `repo=<n>`; without it no run starts
  (`agent/node/README.md`, Wave 9 Part B).
- The managed PostgreSQL files (configuration fragment, `pg_hba.conf`, TLS
  files) must lie under `/etc/postgresql` (the Debian layout); elsewhere the
  helper's `ReadWritePaths` must be extended by a drop-in.

The host installation and enrollment are in the runbook
[`exponetdb-docs/12-operations/node-runbook.md`](../../../exponetdb-docs/12-operations/node-runbook.md),
which the release carries as `doc/node-runbook.md` (installed to
`/usr/share/doc/exponetdb-node/`, where the units' `Documentation=` points). No release PKI
exists yet: the binaries are not signed; their checksums come from the build.

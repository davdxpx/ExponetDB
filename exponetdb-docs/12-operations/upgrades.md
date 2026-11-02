# Upgrades

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
| Applies to | every release; Wave 5 (agent), later waves (PostgreSQL upgrades) |
| Read before | [`../01-architecture/versioning.md`](../01-architecture/versioning.md), [`deployment.md`](./deployment.md) |

## 1. ExponetDB server

- Releases are SemVer; contracts are versioned separately
  ([`../01-architecture/versioning.md`](../01-architecture/versioning.md)).
- Control Store bundles are additive (expand); removals (contract) ship one
  release later, after no running code reads the old shape.
- **[DECIDED]** (verification campaign fix VC-065, 2026-11-02) **The schema
  change is one way.** A role refuses to start against a Control Store that a
  newer build migrated (`process.start_refused`, reason `schema_newer`, remedy
  `deploy_the_newer_image_or_restore_the_pre_upgrade_dump`): starting the old
  image is no rollback (it exits 0.3 s after its start, a restart loop under
  `restart: unless-stopped`). The rollback is restoring the pre-upgrade dump
  (§1.1, step 9).
- No runtime role holds the migration credential; a role whose schema is
  pending, or whose store a newer build migrated, stays not ready
  ([`deployment.md` §3, §6](./deployment.md#6-releases)).
- **[OBSERVED]** (verification campaign, 2026-10-28) A plan created by the
  previous release and not yet applied is applied by the new one: the apply
  re-evaluates the policy and compares the decision and the requirements, not
  the policy version hash. A plan whose kind version the new release does not
  support expires with `PLAN_STALE`.

### 1.1 The upgrade card

Measured on a disposable stack (2026-10-28, three runs, no image pull):
`migrate` 0.8 to 1.0 s; **every running role goes not ready about 2 s after
the migration commits** and stays so until it is redeployed; serve (Web App,
REST, MCP) is down 16 to 18 s, the gateway 15 to 16 s (its graceful stop waits
for the agents' long polls), the worker 2 to 3 s; the node agents reconnect
about 6 s after the gateway.

**Before**

1. **Release notes and agents.** The node agent is not part of a server
   upgrade: check that each node's reported version is in the release's
   supported agent range (`exponetdb node list`).
2. **Preflight.** From the **new** image, with a runtime login (for example
   `exdb_gateway`), run `exponetdb control-store status` against the live
   store: `pending` lists the bundles `migrate` will apply (`current` with an
   empty list: no migration). It changes nothing.
3. **Window.** Choose a time nothing depends on the Control Plane for a
   minute (above).
4. **Drain.** Wait until no operation is `running` or `verifying`
   (`exponetdb operation list --state running`, then `--state verifying`), or
   let the worker drain: on SIGTERM it stops claiming at once and lets the
   running step finish within `EXPONETDB_SHUTDOWN_TIMEOUT_MS` (**[DECIDED]**
   VC-043: set it to 120000 on the worker and the container's stop grace
   period above it, for example 130 s; Docker's default 10 s cuts any step).
   A step cut short is reconciled after the restart; the heartbeat is marked
   stopped either way.
5. **Backup.** Dump the Control Store (`pg_dumpall` of the resource, or the
   provider's dump), copy it off the host, check it (`gzip -t`) and restore it
   once into a scratch resource with `psql -v ON_ERROR_STOP=1` before you go
   on. This dump is the rollback.

**Upgrade**

6. Run the one-shot migration resource once (`exponetdb control-store
   migrate`, login `exdb_migrate`). Record its exit status and its output:
   exit 0 and `state.status: current`, `applied` naming the bundles. It is
   audited (`control_store.migrated`, the bundles and the release).
7. Deploy `worker`, `serve` and `gateway` from the same image digest.

**After**

8. `exponetdb control-store status`: `current`, `pending` empty;
   `exponetdb keyring status`: nothing missing or mismatched;
   `exponetdb audit verify`: ok; `GET /api/v1/installation/health`; every
   node `active`; one nonprod read and one nonprod plan and apply succeed.

**If it goes wrong**

9. **Do not start the old image** (it refuses, see above). The owner decides
   within the window: roll forward (fix, a newer image) or restore. Restore:
   RB-10 with the pre-upgrade dump (about 7 s for a 1.25 MB dump on the
   stack); everything written after the dump is lost (audit events,
   operations, plans, revisions, ledger-mirror rows). Then sign in again
   (sessions after the dump are gone), reconcile every target the new release
   touched (RB-10 step 6), and expect the node agents to reconnect within
   about a minute.
10. Write the deployment record: the image digest, the migration output, the
    restart policy, the volumes and `EXPONETDB_CONTROL_STORE_VOLUME_BYTES`
    ([`deployment.md` §1](./deployment.md#1-topology)), the downtime, any rollback.

## 2. Node agent

- The server publishes a supported agent version range; agents report their
  version in heartbeats; outside the range the node is `degraded` and only read
  capabilities are dispatched.
- **No agent self-update in V1.** Updating the agent is a host package update
  done by the operator (or, once available, the `packages.apply_update`
  capability for the agent package itself is explicitly excluded: an agent does
  not replace itself).
- Protocol changes are additive within a major protocol version; capabilities
  carry their own versions (`backup.run@1`), and the server dispatches only
  versions the agent advertises.

## 3. PostgreSQL minor upgrades

Planned through node capabilities (audit and planning from Wave 5, applying updates after Wave 9):

1. `packages.plan_update` shows the PGDG candidate version, release notes link,
   whether a restart is needed, and the targets affected.
2. Policy `node.packages-soak`: production requires the same minor version to
   have been running on the evidence environment's cluster for a configurable
   time (default 3 days) **or** a break-glass reason (security releases).
3. `packages.apply_update` installs; `postgres.restart` is a separate planned
   step with the restart plan (connections that will drop).
4. Verification: `server_version_num`, health probes, extension versions,
   fingerprint unchanged.

## 4. PostgreSQL major upgrades

**[PLANNED]**, not V1 automation. A major upgrade (17 → 18) is a project:
new cluster on the new major, logical or `pg_upgrade`-based migration, a
placement move per target, verification and a fallback window. ExponetDB
supports it with: version-matrix checks of migrations and verification against
the new major (testkit), fingerprints per major (`fp1:<major>:…`), placement
moves, restore drills on the new major. The procedure is written when the first
major upgrade is due; PostgreSQL 17 is supported until November 2029.

## 5. Extension upgrades (pgvector)

Two planned steps, both node capabilities: the package update on the host
(`packages.apply_update`, later wave) and `ALTER EXTENSION vector UPDATE` in each
database (`postgres.extensions.apply`), because extension changes often need
superuser ([`../04-migrations/migration-bundles.md`](../04-migrations/migration-bundles.md)).
Only extensions a project lists as *trusted* may be created or updated inside a
migration bundle. The plan marks index rebuild needs when the extension's
release notes require them (maintained as data in the analysis rule catalog).

## 6. Exponet-wide dependencies

- When the Exponet identity service arrives, enabling federation is a
  configuration change plus a release that ships the integration
  ([`../08-auth-and-security/federation.md`](../08-auth-and-security/federation.md)).
- Moving to `exponet-01` / `exponet-db-01`: [`deployment.md` §7](./deployment.md#7-later).

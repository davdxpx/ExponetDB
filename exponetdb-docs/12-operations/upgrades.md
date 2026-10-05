# Upgrades

| | |
|---|---|
| Status | Baseline (Wave 0), awaiting owner approval |
| Applies to | every release; Wave 5 (agent), later waves (PostgreSQL upgrades) |
| Read before | [`../01-architecture/versioning.md`](../01-architecture/versioning.md), [`deployment.md`](./deployment.md) |

## 1. ExponetDB server

- Releases are SemVer; contracts are versioned separately
  ([`../01-architecture/versioning.md`](../01-architecture/versioning.md)).
- **Control Store migrations follow expand/contract**: a release only adds
  (expand); removals (contract) ship one release later, after no running code
  reads the old shape. Therefore rolling back the application by one release
  works without a schema rollback.
- A server binary refuses to start against a Control Store schema newer than it
  knows (no silent downgrade).
- Upgrade order: `worker` pre-deploy runs migrations → `worker` → `gateway` →
  `serve`. In-flight operations survive because workers stop at step boundaries
  and reconcile on start ([`../02-control-plane/operations-engine.md`](../02-control-plane/operations-engine.md)).
- Plans created by the previous version stay valid only if their plan schema
  version is supported by the new one; otherwise they expire with
  `PLAN_STALE` (reason `engine_version`).

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

Planned through node capabilities (Wave 5 and later):

1. `packages.plan_update` shows the PGDG candidate version, release notes link,
   whether a restart is needed, and the targets affected.
2. Policy: production requires the same minor version to have been running on
   the evidence environment's cluster for a configurable time (default 3 days)
   **or** a break-glass reason (security releases).
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

`ALTER EXTENSION vector UPDATE` is a migration bundle (schema change in a
database), preceded by the package update on the host (node capability). The
analysis marks index rebuild needs when the extension's release notes require
them (maintained as data in the analysis rule catalog).

## 6. Exponet-wide dependencies

- When the Exponet identity service arrives, enabling federation is a
  configuration change plus a release that ships the integration
  ([`../08-auth-and-security/federation.md`](../08-auth-and-security/federation.md)).
- Moving to `exponet-01` / `exponet-db-01`: [`deployment.md` §7](./deployment.md#7-later).

# @exponetdb/registry

The target registry of Wave 4
([`registry.md`](../../exponetdb-docs/02-control-plane/registry.md)).

**Responsibility.** The Control Store records of products, environments,
projects, servers, external clusters, endpoints, databases, credential
metadata and targets with their placements; resolving a target to a
verified session; every registry change as an Operations Engine kind with
its own plan and policy evaluation; the write-only credential submission
and the worker's verification; `target.register`, the only data-plane
write of Wave 4 (identity marker and empty ledger under the schema lock,
read back on a fresh session, registration snapshot, activation); the
subject chains the authorization engine resolves registry subjects with.

**Not its responsibility.** Observation (health, schema reads, drift:
`@exponetdb/diagnostics`); PostgreSQL wire behavior, SQL building,
introspection (`@exponetdb/postgres`); authorization decisions
(`@exponetdb/auth`, which asks this package only for subject chains);
HTTP (`apps/server`).

**Allowed dependencies** (`tooling/boundaries/graph.json`): `contracts`,
`control-store`, `secrets`, `audit`, `postgres`, `operations`, `policy`.

**Security boundary.**

- A target is a logical identity. Everything a session needs comes from
  the registry, never from a request: the placement names database and
  cluster, the cluster its CA bundle and pinned `system_identifier`, the role
  its endpoint preference and credential. No caller supplies a host, a port,
  a database name or a connection string.
- One credential per access role (observer, reader, verifier, operator,
  migrator); no fallback to another role, never a superuser. `serve`
  decrypts observer secrets only; every other role is the worker's.
- Passwords are written once through the write-only endpoint, stored as
  `se1` envelopes and never returned; views carry metadata only.
- `target.register` refuses the Control Store, a database marked by
  another installation or target, and a cluster whose address now reaches
  another `system_identifier` (no auto-pin).

**Major interfaces.** `Connector.forTarget(target, role, purpose)`;
the planners (`planProductCreate` … `planTargetRegister`,
`planTargetStateChange` for suspend, resume and decommission) and
`applyRegistryPlan`; the kinds
(`registryKinds`, `TargetRegisterKind`); `submitCredential` and
`verifyPendingCredentials`; reads (`listTargets` with bindings and grant
restrictions applied in SQL, `findTarget`, cluster, endpoint, database and
credential lists); `registryChains`; `suspendForIdentityMismatch`;
`clusterBootstrapSql`.

**Tests.** `bun run test` (validation, content) and `bun run
test:integration` (`test/registry.int.test.ts`): the full flow against a
real Control Store and TLS PostgreSQL 16, 17 and 18 from
`@exponetdb/testkit`, including the refusals, cluster identity pinning,
credential verification failures (wrong password, unknown CA, plaintext)
and the visibility of list reads.

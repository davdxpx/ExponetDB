# Registry

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
| Applies to | Wave 4 (core), Wave 5 (nodes), Wave 9/11 (placement changes) |
| Read before | [`../01-architecture/domain-model.md`](../01-architecture/domain-model.md) |
| Decision | [ADR-0004](../01-architecture/adr/0004-logical-targets.md) |

The registry is the single source of truth for what ExponetDB manages and where
it is. It answers one question for every request: *given the target a client
named, which database on which cluster, through which endpoint, with which
credential, under which policies?*

## 1. Resolution

```
"reosa/platform/production"
   │ parse path → (product, project, environment) → target tgt_…  (state must be active)
   ▼
current placement plc_… (generation 3) → database dbs_… ("reosa_production") → cluster cls_…
   ▼
endpoint selection for the access role:
   migrator / verifier / operator → direct endpoints only (private > public > local socket on agent)
   observer / reader             → direct endpoints (private > public); health probes additionally run as observer on every registered endpoint, poolers included
   ▼
credential crd_… (cluster, role, active version) → secret (observer: decrypted in worker and serve; all other roles: worker only)
   ▼
TargetSession (TLS verify-full, session guards, pinned settings)
```

**[DECIDED]**

- Resolution happens server-side only. Interfaces accept target paths or `tgt_`
  ids, never hosts or connection strings
  ([C-4](../00-product/constitution.md#c-4-logical-targets-are-stable-identities)).
- The resolved placement generation is attached to every plan and operation.
- A target in `registered` state can be inspected (with observer credentials) but
  not changed; it becomes `active` only after its identity marker is stamped and
  its credentials verified.

## 2. Registration flows

### 2.1 Agent-managed cluster (normal case for `reos-db-01`)

1. Admin creates a **server** record (`reos-db-01`, provider, location).
2. Admin creates an enrollment token; the node agent is installed and enrolls
   ([`../07-node-agent/enrollment.md`](../07-node-agent/enrollment.md)).
3. The agent reports the clusters it finds (`postgres-main`, version,
   port, data directory, `system_identifier`). The admin **confirms** each
   cluster; ExponetDB never auto-adopts a cluster. Confirmation pins
   `system_identifier`.
4. ExponetDB plans `postgres.roles.apply` for its own roles (observer, reader,
   operator, migrator, ledger owner), `postgres.hba.apply` and, if needed,
   `postgres.tls.rotate` (server certificate). Approval required (the cluster
   hosts production).
5. Admin registers **databases** (existing or to be created by the
   `postgres.databases.apply` capability).
6. Admin registers **targets**: `(project, environment) → database`. The
   `target.register` operation stamps the identity marker and initializes the
   `exponetdb` schema (ledger) as part of the same plan.

### 2.2 External cluster (no agent)

1. Admin creates a cluster record with `management_mode = external`, endpoint(s)
   and CA bundle.
2. ExponetDB generates the role-creation SQL (verifiers only) for a human to run.
3. Admin enters credentials into the write-only credential endpoint (they are
   encrypted immediately; the Web App never displays them again).
4. ExponetDB connects, pins `system_identifier`, and the target registration
   proceeds as above, minus node capabilities.

### 2.3 Implementation (Wave 4)

**[DECIDED]** (Wave 4, `packages/registry`, Control Store schema `registry`,
[`control-database.md` §5c](./control-database.md#5c-implementation-wave-4).)

- Every registry change is a stored plan of a registry kind, applied with
  `POST /plans/{id}/apply` and executed by the worker: `registry.product.create`,
  `registry.environment.create`/`.update`, `registry.project.create`/`.update`,
  `registry.server.create`, `registry.cluster.register`/`.confirm`,
  `registry.endpoint.add`/`.retire`, `registry.database.register`,
  `target.register`/`.suspend`/`.resume`/`.decommission`. A plan records the
  exact rows it will write (new ids included) and the registry state it was
  made against; the kind re-checks that state at acceptance and under the
  locks (`PLAN_STALE`). Re-authentication within 300 seconds is required
  where a change moves where ExponetDB connects (cluster registration and
  confirmation, endpoints) or the tier of an environment changes.
- The system plans exactly one registry change itself: the suspension of an
  active target whose database no longer carries its identity, or whose
  address now reaches another cluster or database (health sampler,
  [`../10-observability/health.md` §3](../10-observability/health.md#3-named-conditions)).
  The worker plans and accepts `target.suspend` as the system actor (state
  reason `identity_mismatch`, the observed field in the plan analysis), at
  most one open suspension per target; the Operations Engine executes it like
  any other. Nothing is re-stamped; resuming, re-registering and
  decommissioning stay human decisions.
- An external cluster is registered `pending` with its CA bundle (PEM
  certificates only; every certificate is parsed, a private key is refused)
  and at least one direct endpoint. A DNS host is its own TLS server name; an
  IP host names the DNS name of its certificate. An address names one
  cluster registry-wide. An endpoint is never edited: a changed address is a
  new endpoint, then the old one is retired; the last direct endpoint of a
  cluster with live targets cannot be retired.
- Credentials: the person runs the role bootstrap SQL (no password; psql
  `\password` sets each one) and submits each password once through the
  write-only endpoint (Web App, re-authentication). `serve` encrypts it at
  once as the next version of the role's `pg_credential` secret (observer:
  consumer `observer`; every other role: consumer `worker`, which `serve` may
  insert but never read) and records it `pending`; a new submission
  supersedes a pending one. The worker logs in with it over verified TLS and
  checks the role's attributes and memberships against the documented least
  privilege (no superuser, no `CREATEDB`, `CREATEROLE` or `REPLICATION`,
  `BYPASSRLS` only for reader and verifier, exactly the documented
  memberships with their inherit and set options); success activates it and
  retires the credential it replaces in one transaction. Only the observer
  can be submitted before the cluster is confirmed.
- Confirmation reads the cluster's `system_identifier` through an observer
  session on the `postgres` database and pins it once. It refuses the
  cluster that hosts the Control Store (`TARGET_REGISTRATION_REFUSED`,
  `cluster_hosts_control_store`), a `system_identifier` already pinned by
  another cluster record, and, when the person states the identifier they
  expect, any other one (`CLUSTER_IDENTITY_MISMATCH`). Every later session
  is guarded by the pinned identifier: an address that now reaches another
  cluster is refused, never re-pinned.
- A database is registered by name on a confirmed cluster; its oid, owner,
  encoding and collation are observed. Registration refuses a database whose
  oid changed since (dropped and created again under the same name).
- `target.register` is the only write to a managed database in Wave 4:
  (1) the Control Store records the target `registered` at generation 1
  and its first placement; (2) a migrator session takes the target's schema
  lock and stamps the identity marker and the empty ledger in one
  transaction, refusing a Control Store (any of its schema signs, whatever
  the database is called), another installation's or another target's
  marker, another generation and an `exponetdb` schema without a marker;
  (3) a fresh observer session reads everything back (marker field by
  field, ledger shape, cluster identity, database oid); (4) diagnostics
  takes the registration snapshot and, when complete, stores it as the
  registration baseline; (5) only then the target becomes `active`. A
  failure after the stamp leaves the target `registered` and the operation
  `verification_failed`; planning it again resumes the same target and
  placement (the stamp is then a no-op). Planning already inspects the
  database through an observer session and refuses every case above before a
  plan exists; production registration requires an approval and
  re-authentication (`target.register-prod-approval`).
- A target path names one logical target forever: a decommissioned target
  keeps it (the Control Store refuses a new target at that path).
  Decommissioning ends the placement and changes nothing in the database;
  its identity marker stays, so the database cannot be registered as
  another target by accident.
- Resumption checks the marker on the database before writes are allowed
  again. **[DECIDED]** (G4 correction, 2026-10-07) The connector hands out
  a write-capable session (migrator, operator) only for an `active` target
  (`TARGET_SUSPENDED` with the suspension's reason otherwise) and only after
  the marker proves the target (C-27); registration and resumption open
  their own sessions and prove the marker themselves. The operator, like the
  migrator, has `SELECT` on the marker for this.
- A cluster that hosts the Control Store is refused at confirmation and at
  target registration, at planning and again at execution (D11), so a
  cluster that became one after planning is never managed either.
- Authorization chains come from the registry (`registryChains`): a target
  resolves to its product, project, environment and tier; a cluster or
  server has no product chain (global bindings only) and its derived tier.
  The target list applies the caller's covering bindings and a delegated
  grant's target and tier restrictions in SQL, so neither an item nor the
  cursor names a target the caller cannot see. The product and project
  lists do the same in SQL: a global binding sees everything, a product
  binding its product and projects, a project, environment or target
  binding the product it lies in and the projects it reaches (an
  environment reaches every project of its product). A restricted
  delegation (a target list or a single tier) is refused on both lists, as
  on `product.get` and `project.get` (`restricted_scope`,
  [authorization.md §1.2](../08-auth-and-security/authorization.md)).
- Cursors are opaque, from the contract's alphabet `[A-Za-z0-9_-]`
  (`r1_` plus the base64url of the last id; `d1_` plus an offset for schema
  search); a cursor that is not one is `VALIDATION_FAILED`.

## 3. Changing where a target lives

**[PLANNED]** (Wave 9/11) A **placement move** is a `critical` operation with
steps:

1. Prepare the destination database (restore from a verified backup, or
   dump/restore, or logical replication catch-up; separate operations).
2. Verify the destination: fingerprint equals source (or explained difference),
   ledger state equal, row-count sanity per table, extension versions, roles
   (cluster fingerprint vs desired state).
3. Switch: new placement with `generation + 1`; identity marker re-stamped at the
   destination; the old database's marker is changed to `decommissioning` so that
   it can never again pass a write guard for this target.
4. All active plans for the target become stale.
5. Consumers are told the new connection details through their own deployment
   (ExponetDB does not rewrite consumer configuration); the target's status shows
   which consumer sessions still connect to the old placement (from
   `pg_stat_activity` on the old cluster) so that the cutover is observable.

## 4. Tier derivation

**[DECIDED]** Tiers are configured on environments and derived for physical
objects ([C-24](../00-product/constitution.md#c-24-production-is-its-own-authorization-tier)):

- target tier = its environment's tier;
- cluster tier = max tier of targets placed on it;
- server and node tier = max tier of clusters on it.

The derived tier is recomputed on every placement change and is part of the
authorization of every cluster, server and node operation. **[ASSUMPTION]**
`reos-db-01` will host both `reosa_staging` and `reosa_production` (REOSA's
infrastructure documents plan it; the server was not ordered as of 2026-10-04,
see [`../01-architecture/control-plane-and-data-plane.md` §2.1](../01-architecture/control-plane-and-data-plane.md#21-v1-topology));
it is then `prod` tier as a whole.

### 4.1 The declared intended tier of a cluster (OD-22)

**[DECIDED]** (owner decision 2026-10-13, [OD-22](../00-product/open-decisions.md#od-22-authority-needed-to-register-a-database-whose-intended-tier-is-unknown)
extended, S4; implemented in Wave 8 part 2) The derived tier says what a
cluster hosts; it cannot say what a cluster is *for* before its first
production database is placed. A cluster therefore also carries a
**declared intended tier**, a registry fact with its own authority:

- `declaredTier` is `prod`, `nonprod` or `null` (undeclared). A cluster
  is registered undeclared; a person declares it through the plan
  `POST /clusters/{id}/declared-tier` (`registry.cluster.declare_tier`,
  class `high`, re-authentication at apply), executed by the worker.
  The cluster view shows it next to `derivedTier`.
- Declaring or changing it always needs production authority
  (`registry.manage` at the production registry tier), whichever value is
  set: moving a cluster out of production is a production decision too.
  The plan records the tier `prod`.
- A declared tier is never removed again, a retired cluster keeps its
  own, and each declaration is its own operation (the Control Store guard
  `clusters_tier_guard`, bundle `cluster-declared-tier`).
- What it decides: registering a database of the cluster as a target
  needs production authority when the cluster is declared `prod`,
  whatever environment the database is placed in; on a cluster declared
  `nonprod` the environment's tier decides; an **undeclared** cluster
  counts as `prod` (fail closed: OD-22's rule of 2026-10-12 that a
  production registration is never allowed with nonprod authority alone,
  and the tier of an undeclared cluster is unknown). Every other cluster
  action uses the cluster's registry tier: `nonprod` only when declared
  `nonprod` and hosting no production target
  ([authorization.md §5.1](../08-auth-and-security/authorization.md#51-the-registry-tier-of-registrymanage-od-22)).
- It never changes a target's tier: a staging database on a cluster
  declared `prod` is still a `nonprod` target for migrations, policy and
  data reads (database-level actions use the target's tier, §5 of
  authorization.md). It changes who may *place* it.

Tests: `apps/server/test/http-registry-tier.int.test.ts`,
`packages/auth/test/registry-tier.test.ts`,
`packages/control-store/test/registry-schema.int.test.ts`.

### 4.2 Execution roles per environment and declared exceptions (Wave 9)

**[DECIDED]** (Wave 9 Part A, [ADR-0034](../01-architecture/adr/0034-execution-roles-for-adopted-schemas.md),
[`../03-database-model/credentials-and-roles.md` §3.1, §3.2](../03-database-model/credentials-and-roles.md#31-execution-roles-per-environment))
Two registry records refine a project's execution roles:

| Record | What it holds | Changed by |
|---|---|---|
| `registry.execution_role_bindings` | per (project, environment of the project's product, alias of the project map) the PostgreSQL role, with the operation that set it and, once replaced or removed, the operation that ended it (nothing is deleted) | `registry.execution_role_binding.set`: the environment's whole set, replaced |
| `registry.execution_role_exceptions` (`rxe_…`) | a person's declaration that one role may carry `BYPASSRLS` as an execution role of the project in one environment: role, reason, optional review date, `active` or `revoked`, a revision, who declared and revoked it | `registry.execution_role_exception.declare`, `.revoke` |

All three operations are `registry.manage` at the **environment's** tier
(the subject is the environment), high, re-authenticated and human only;
declaring or revoking on a production environment also needs an approval
(`registry.execution-role-exception-production`). An environment subject
passes only an unrestricted grant: a tier-restricted CLI grant changes
neither, and a person whose bindings do not cover the environment does not
see it (`NOT_FOUND`). Control Store guards check the environment's product,
the operation's kind, that an ended binding and a revoked declaration never
change again, that a declaration's attributes are exactly `{bypassrls}` and
that a role is never a predefined or ExponetDB role; an environment keeps
its tier while it binds execution roles or holds an active exception
(`tier_in_use`, and a trigger on the environments table). `GET
/projects/{projectId}/execution-roles` (`migrations.read` on the project)
shows the default map, each environment's bindings and effective map, and
the declarations; the CLI's `project execution-roles` and `project
role-exception` commands use it.

## 5. Registry and REOSA's infrastructure register

**[OBSERVED]** REOSA already keeps an infrastructure register in its admin
console (`infra_components` with internal addresses, Coolify server ids, backup
targets, `last_restore_verified_at`, health checks; `REOSA/reosa-docs/27-infrastructure/README.md`),
with the explicit rule that "two registers would be exactly the duplicate".

**[DECIDED]** ExponetDB does not read REOSA's register (C-2). For database
infrastructure (database servers, clusters, databases, targets, backups, restore
drills), ExponetDB's registry is the source of truth. REOSA's register may
**link** to ExponetDB objects by their stable ids and display their state through
the SDK. How REOSA restructures its register is REOSA's decision; the
recommendation is in [`../13-integrations/reosa-integration.md`](../13-integrations/reosa-integration.md).

## 6. API surface (summary)

Registry writes are admin operations (`registry.manage` at the action's
registry tier, §4.1), planned and audited.
Reads are available to `targets.read` with grant restrictions applied. See
[`../06-rest-api/resources.md`](../06-rest-api/resources.md#registry).

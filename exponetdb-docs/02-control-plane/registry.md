# Registry

| | |
|---|---|
| Status | Baseline (Wave 0), awaiting owner approval |
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
authorization of every cluster, server and node operation. **[OBSERVED]**
`reos-db-01` will host both `reosa_staging` and `reosa_production`; it is
therefore `prod` tier as a whole.

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

Registry writes are admin operations (`registry.manage`), planned and audited.
Reads are available to `targets.read` with grant restrictions applied. See
[`../06-rest-api/resources.md`](../06-rest-api/resources.md#registry).

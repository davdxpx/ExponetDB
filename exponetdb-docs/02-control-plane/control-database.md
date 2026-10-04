# Control Store (control database)

| | |
|---|---|
| Status | Baseline (Wave 0), awaiting owner approval |
| Applies to | Wave 2 (skeleton, own migrations), every later wave (tables) |
| Read before | [`../01-architecture/domain-model.md`](../01-architecture/domain-model.md), [`data-retention.md`](./data-retention.md) |
| Decision | [ADR-0005](../01-architecture/adr/0005-own-control-store.md) |

## 1. What it is

**[DECIDED]** The Control Store is a dedicated PostgreSQL database
(`exponetdb_control`) that holds all of ExponetDB's own state. It is **not**:

- REOSA's database or any consumer's database (no Control Plane state in REOSA
  production, ever);
- a managed target (V1; see §6);
- a cache: it is the source of truth for everything in the source-of-truth map
  except the per-target ledgers ([constitution](../00-product/constitution.md#source-of-truth-map)).

## 2. Hosting

**[DECIDED] V1:** a small PostgreSQL 17 resource managed by Coolify on `reos-01`,
separate from ExponetDB's application container, reachable only on the Docker
network of the ExponetDB resource (no public port).

**[PLANNED] later:** move to `exponet-db-01` (a dedicated host for Exponet's
control-plane databases) without changing the data model or the API. The move is a
dump/restore of one database plus a configuration change of ExponetDB; nothing in
the schema refers to where the Control Store runs.

Why not on `reos-db-01` next to the data plane: the Control Plane must keep
working when the data-plane host fails, because that is when it is needed most
([C-5](../00-product/constitution.md#c-5-the-control-plane-does-not-depend-on-what-it-manages)).
The trade-off is that `reos-01` is then a single point for both REOSA's apps and
ExponetDB; that is acceptable for V1 because ExponetDB failing does not stop
REOSA's applications (C-1: ExponetDB is not in their data path).

## 3. Schema outline

**[PLANNED]** Detailed DDL is written in Wave 2 and extended per wave. Tables are
grouped by owning package; each package owns its tables and migrations
(`packages/control-store` hosts the migration runner and the schema registry).

| Group (package) | Tables (outline) |
|---|---|
| kernel / control-store | `schema_migrations` (Control Store's own ledger), `installation` (installation id, created_at, key ids), `settings` |
| registry | `products`, `environments`, `projects`, `targets`, `placements`, `servers`, `nodes`, `clusters`, `endpoints`, `databases`, `certificates`, `role_manifests`, `role_manifest_versions` |
| secrets | `secret_keys` (key ids, wrapped data keys, status), `secrets` (ciphertext, AAD, version, state) |
| auth | `identities`, `identity_credentials` (password hashes, TOTP, WebAuthn), `external_subjects`, `identity_providers`, `web_sessions`, `roles`, `role_permissions`, `role_bindings`, `oauth_clients`, `oauth_client_metadata_cache`, `oauth_grants`, `oauth_authorization_codes`, `oauth_tokens` (hashes only), `api_keys` (hashes only), `reauth_events` |
| policy | `policy_settings` (scoped configuration), `maintenance_windows` |
| operations | `plans`, `plan_bodies` (canonical JSON, compressed), `operations`, `operation_events`, `operation_locks`, `approvals`, `break_glass_grants`, `idempotency_keys`, `jobs`, `job_events` |
| migrations | `migration_bundles` (content-addressed bytes), `migration_bundle_revisions` (verify revisions), `ledger_mirror`, `verification_mirror`, `evidence_records`, `legacy_import_reports`, `schema_documents` (canonical documents by fingerprint) |
| diagnostics | `health_samples` (partitioned by day), `statement_stats_samples` (partitioned), `findings`, `target_status` (latest state per target) |
| nodes | `node_heartbeats_latest`, `node_state_transitions`, `node_capability_reports`, `agent_ca` (CA certificate chain, wrapped keys) |
| backups | `backup_repositories`, `backup_policies`, `backups`, `backup_verifications`, `restores`, `restore_drills` |
| audit | `audit_events` (append-only, hash chain), `audit_chain_checkpoints` |

Conventions:

- Ids: `text` with type prefix + ULID (`tgt_01J…`), primary keys; foreign keys
  everywhere; `ON DELETE RESTRICT` by default (history is not cascaded away).
- Timestamps: `timestamptz`, set by the database (`now()` / `clock_timestamp()`).
- High-volume tables are range-partitioned by time, retention by dropping
  partitions ([`data-retention.md`](./data-retention.md)).
- JSON only for genuinely schemaless payloads (canonical plan bodies, analysis
  details); queryable facts are columns.

## 4. Roles inside the Control Store

**[DECIDED]** Each process role connects with its own database role (P-7):

| DB role | Process | Privileges (summary) |
|---|---|---|
| `exdb_serve` | `serve` (HTTP: Web App API, REST, MCP, OAuth) | read most tables; write auth/OAuth state, plans, approvals, idempotency keys, audit (INSERT only); **no** `SELECT` on `secrets` ciphertext |
| `exdb_worker` | `worker` (operations, samplers) | read/write operations, jobs, mirrors, samples, findings; `SELECT` on `secrets`; audit INSERT |
| `exdb_gateway` | `gateway` (node agent mTLS) | read/write jobs, job events, heartbeats, capability reports, node certificates; audit INSERT; **no** access to `secrets`, plans' content or OAuth tables |
| `exdb_migrate` | startup migration job | DDL on the ExponetDB schemas only |
| `exdb_audit_maint` | retention job | drop old audit partitions after checkpointing (never UPDATE/DELETE rows) |

`audit_events` grants only `INSERT` and `SELECT`; a trigger rejects `UPDATE` and
`DELETE` for every role ([`audit.md`](./audit.md)).

## 5. The Control Store's own migrations

**[DECIDED]**

- Written as ExponetDB migration bundles (same format, same checksums, same
  lints) in `packages/control-store/migrations/`, so the format is dogfooded from
  day one.
- Executed by a **bootstrap runner** embedded in the server (`exponetdb
  control-store migrate`), not by the Operations Engine: the engine depends on the
  Control Store, so it cannot be the thing that creates it.
- The runner takes a session advisory lock in the Control Store, applies pending
  bundles in DAG order, writes the Control Store's own `schema_migrations` ledger
  (same shape as a target ledger, minus target identity), runs verification
  (structural + `verify.sql`) and refuses to start the server if any migration is
  unverified.
- Server startup checks that the Control Store schema is at the version the
  binary expects (exact match for V1); a newer schema than the binary refuses to
  start (no downgrade).
- Destructive Control Store migrations follow expand/contract across releases so
  that a rollback of the ExponetDB application by one version keeps working
  ([`../12-operations/upgrades.md`](../12-operations/upgrades.md)).

## 6. Self-management boundary

**[DECIDED] V1:**

- The Control Store is **bootstrap infrastructure**. It is not registered as a
  target; the registry refuses an endpoint that resolves to the Control Store
  (`installation_id` check: the Control Store carries a marker table with the
  installation id, and target registration refuses databases that contain it).
- ExponetDB observes its own Control Store only through its readiness checks and
  self-metrics ([`../10-observability/self-observability.md`](../10-observability/self-observability.md)),
  not through the target health machinery.
- Backups of the Control Store are done by Coolify's scheduled database backups
  plus a daily logical dump shipped off-host (restic), not by ExponetDB's backup
  subsystem. Restoring the Control Store is a documented runbook
  ([`../12-operations/incident-model.md`](../12-operations/incident-model.md)).

**[PLANNED] later:** a second ExponetDB installation (or a minimal watcher) could
manage the first one's Control Store as a target. That avoids the circularity
without weakening C-5. Not before there is a real need.

## 7. Sizing and growth

**[ASSUMPTION]** For V1 (two to five targets, one node, sampling every 15 s,
dozens of operations per day) the Control Store stays well below 10 GB with the
retention defaults; to be measured after Wave 9. Largest contributors: health
samples and statement statistics samples, both partitioned and pruned.

## 8. Failure behaviour

| Failure | Effect | Behaviour |
|---|---|---|
| Control Store unreachable | No authentication (sessions, tokens are in it), no plans, no operations | `/healthz/ready` fails; API returns `CONTROL_PLANE_DEGRADED`; running operations pause at their next step and reconcile later; **managed databases keep running unaffected** |
| Control Store slow | Request latency rises | timeouts per request; samplers back off |
| Control Store restored from backup | Plans/operations after the backup point are lost; target ledgers are ahead of the mirror | Startup reconciliation compares every target ledger with the mirror; differences explained by "operations unknown to this Control Store" are raised as `LEDGER_DIVERGENCE` findings for operator review, never auto-accepted |

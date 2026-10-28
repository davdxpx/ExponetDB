# Control Store (control database)

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05; Wave 2 implementation (§4, §5, §5a) accepted with G2 on 2026-10-05 |
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
| secrets | `secret_keys` (key ids, wrapped data keys, status), `secrets` (metadata: purpose, subject, version, state), `secret_blobs_worker`, `secret_blobs_observer`, `secret_blobs_auth`, `secret_blobs_gateway` (ciphertext and AAD per consumer, [`../08-auth-and-security/secrets.md` §4](../08-auth-and-security/secrets.md#4-separation)) |
| auth | `identities`, `identity_credentials` (password hashes, TOTP, WebAuthn), `external_subjects`, `identity_providers`, `web_sessions`, `roles`, `role_permissions`, `role_bindings`, `oauth_clients`, `oauth_client_metadata_cache`, `oauth_grants`, `oauth_authorization_codes`, `oauth_tokens` (hashes only), `api_keys` (hashes only), `reauth_events` |
| policy | `policy_settings` (scoped configuration), `maintenance_windows` |
| operations | `plans`, `plan_bodies` (canonical JSON, compressed), `operations`, `operation_events`, `operation_locks`, `approvals`, `break_glass_grants`, `idempotency_keys`, `jobs`, `job_events` |
| migrations | `migration_bundles` (content-addressed bytes), `migration_bundle_revisions` (verify revisions), `ledger_mirror`, `verification_mirror`, `evidence_records`, `legacy_import_reports`, `schema_documents` (canonical documents by fingerprint) |
| diagnostics | `health_samples` (partitioned by day), `statement_stats_samples` (partitioned), `findings`, `target_status` (latest state per target) |
| nodes | `node_heartbeats_latest`, `node_state_transitions`, `node_capability_reports`, `agent_ca` (CA certificate chain, wrapped keys) |
| backups | `backup_repositories`, `backup_policies`, `backups`, `backup_verifications`, `restores`, `restore_drills` |
| audit | `audit_events` (append-only, hash chain), `audit_chain_checkpoints` |

**[DECIDED]** (Wave 3B, bundle `01M47XQ56MW0JQX3J715X2GDB8_oauth-delegation`)
The OAuth tables live in their own schema `oauth`, not in `auth` as the
outline above sketched: `scopes` (the catalog the guards decide with,
append-only, checked against the release at readiness), `clients` (first
party from the bundle, pre-registered service clients, CIMD and DCR; the
approved metadata fingerprint), `service_accounts`, `grants` (delegated and
machine; never deleted), `authorization_requests`, `authorization_codes`,
`tokens` (access and refresh, hashes only), `device_codes`,
`client_assertions` (`jti` hashes), `api_keys` (hashes only) and
`rate_limits` (keyed pseudonyms). Guards in the database repeat every
security rule of the application (catalog scopes only, non-escalation,
MCP-ineligible scopes, tiers, lifetimes, single-use codes, one live refresh
token per grant, revocation ending every token, lifecycle hooks on
`auth.identities`, deletion only of what ended). `exdb_serve` reads and
writes what the authorization server needs; `exdb_worker` may only prune
ended rows and reads no hash, key or client key; `exdb_gateway` and
`exdb_audit_maint` have no access to `oauth`
([`data-retention.md`](./data-retention.md) lists the retention).

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
| `exdb_serve` | `serve` (HTTP: Web App API, REST, MCP, OAuth) | read most tables; write auth/OAuth state, plans, approvals, idempotency keys, audit (INSERT only); ciphertext `SELECT` only on `secret_blobs_observer` and `secret_blobs_auth` |
| `exdb_worker` | `worker` (operations, samplers) | read/write operations, jobs, mirrors, samples, findings; ciphertext `SELECT` on `secret_blobs_worker` and `secret_blobs_observer`; audit INSERT |
| `exdb_gateway` | `gateway` (node agent mTLS) | read/write jobs, job events, heartbeats, capability reports, node certificates; ciphertext `SELECT` only on `secret_blobs_gateway` (issuing CA key); audit INSERT; **no** access to target credentials, the job-signing key, plans' content or OAuth tables |
| `exdb_migrate` | startup migration job | DDL on the ExponetDB schemas only |
| `exdb_audit_maint` | audit retention (`exponetdb audit prune`, one-shot) | drop old audit partitions after an exported checkpoint covers them (never UPDATE/DELETE rows) |

`audit_events` grants only `INSERT` and `SELECT`; triggers reject `UPDATE`,
`DELETE` and `TRUNCATE` for every role ([`audit.md`](./audit.md#42-privileges-and-triggers)).

## 5. The Control Store's own migrations

**[DECIDED]**

- Written as ExponetDB migration bundles (same format and checksums from Wave 2
  through `packages/migrations/format` and `graph`; the same lints once
  `migrations/lint` exists in Wave 6) in `packages/control-store/migrations/`, so
  the format is dogfooded from day one.
- Executed by a **bootstrap runner** embedded in the server (`exponetdb
  control-store migrate`), not by the Operations Engine: the engine depends on the
  Control Store, so it cannot be the thing that creates it.
- The runner takes a session advisory lock in the Control Store, applies pending
  bundles in DAG order, writes the Control Store's own `schema_migrations` ledger
  (same shape as a target ledger, minus target identity), runs verification
  (structural + `verify.sql`) and refuses to start the server if any migration is
  unverified.
- The Control Store's `verify.sql` files are ExponetDB's own reviewed code,
  shipped in the release. The runner executes them on a separate connection in a
  `READ ONLY` transaction with statement and lock timeouts, always rolled back,
  with the result contract of target verification (`ok` column,
  [`../04-migrations/verification.md` §4.4](../04-migrations/verification.md#44-result-contract));
  the parser-based admission of `verify.sql` applies to them as soon as the
  parser exists (Wave 4). The same defense-in-depth limits apply as for targets;
  none of them is a sandbox.
- Server startup checks that the Control Store schema is at the version the
  binary expects (exact match for V1); a newer schema than the binary refuses to
  start (no downgrade).
- Destructive Control Store migrations follow expand/contract across releases so
  that a rollback of the ExponetDB application by one version keeps working
  ([`../12-operations/upgrades.md`](../12-operations/upgrades.md)).
- **[DECIDED]** (G2 2026-10-05, G3A 2026-10-06, G3B 2026-10-06, G4 2026-10-07) **Shipped bundles are frozen.**
  Once the owner accepts the gate that shipped a bundle, its files never
  change again, not even a comment: a schema change is a new, additive
  bundle. The frozen bundles are listed in
  `packages/control-store/frozen-bundles.json` (append-only) and their apply
  checksums and verify digests are pinned in
  `packages/control-store/test/immutable-bundles.test.ts`. `bun run
  golden:history <base>` refuses a changed or removed list entry of the base
  and any byte change of a listed bundle's directory relative to the base
  commit, so editing a bundle together with its pins still fails in CI.
  Frozen today: the six Wave 2 bundles, `auth-identity`,
  `access-control`, `plan-approvals` (Wave 3A) and `oauth-delegation`
  (Wave 3B, frozen with G3B on the baseline `548c9a7`, after the final
  hardening edited it in place while it was still unfrozen), `registry` and
  `observation` (Wave 4, frozen with G4 on the baseline `04b2e77`, accepted
  under the owner's conditional delegation on 2026-10-07).

## 5a. Implementation (Wave 2)

**[DECIDED]** (Wave 2, `packages/control-store`.)

**Driver.** The Control Store uses `pg` (node-postgres) without an ORM. A
Wave 2 spike on Node.js 24 against PostgreSQL 17.11 showed what the Control
Store needs: explicit connections and transactions, session and transaction
advisory locks, `FOR UPDATE SKIP LOCKED`, notices, SQLSTATE and constraint
fields on errors, and multi-statement scripts with dollar quoting over the
simple query protocol. Control Store SQL is handwritten and parameterized.
This decides the Control Store driver only; the Data Plane driver for
managed targets is still the Wave 4 spike.

**Bootstrap.** The bootstrap superuser runs generated SQL once
([`../12-operations/bootstrap.md` §2](../12-operations/bootstrap.md#2-control-store)):
five login roles with SCRAM-SHA-256 verifiers (generated locally from CSPRNG
passwords; the SQL never contains a password), all `NOSUPERUSER NOCREATEDB
NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS` with connection limits;
the database `exponetdb_control` (UTF-8, `C` collation) **owned by the
bootstrap superuser**, not by any ExponetDB login, so none can drop it;
`REVOKE ALL ON DATABASE … FROM PUBLIC`; `CONNECT, CREATE` for
`exdb_migrate`, `CONNECT` for the four others; an empty `search_path` for
every login in that database (every statement qualifies its objects); no
`public` schema. Every process and command checks its own login before it
does anything else: it must be exactly the role it expects and hold no
superuser, `CREATEROLE`, `CREATEDB`, `REPLICATION` or `BYPASSRLS` attribute
and no role membership; otherwise it refuses to start
(`control_store_wrong_role`; a superuser URL is refused even for the right
database).

**Schemas.** Every object lives in one of five schemas owned by
`exdb_migrate`: `control` (installation, settings, ledger, heartbeats,
maintenance leases), `audit`, `secrets`, `policy`, `operations`. Each bundle
grants exactly the privileges its tables need, to named roles; nothing is
granted to `PUBLIC`; `ALTER DEFAULT PRIVILEGES` revokes `EXECUTE` on new
functions from `PUBLIC`. Every bundle's `verify.sql` checks ownership,
grants, triggers and the absence of `PUBLIC` privileges.

| Schema object (Wave 2) | `exdb_serve` | `exdb_worker` | `exdb_gateway` | `exdb_audit_maint` |
|---|---|---|---|---|
| `control.installation`, `control.settings`, ledger and verification history | SELECT | SELECT | SELECT | SELECT |
| `control.process_heartbeats` (row-level security: own role only) | SELECT, INSERT, UPDATE (beat columns) | same + DELETE (stale rows only) | SELECT, INSERT, UPDATE (beat columns) | none |
| `control.maintenance_tasks` | SELECT | SELECT, INSERT, UPDATE | SELECT | none |
| `audit.audit_events` (monthly partitions: no direct privilege) | SELECT, INSERT | SELECT, INSERT | SELECT, INSERT | SELECT, INSERT |
| `audit.audit_chain_checkpoints` | SELECT | SELECT, INSERT | SELECT | SELECT, INSERT |
| `audit.checkpoint_exports` | SELECT | SELECT, INSERT | SELECT | SELECT |
| `audit.partition_inventory`, `audit.ac1()` | SELECT, EXECUTE | SELECT, EXECUTE | SELECT, EXECUTE | SELECT, EXECUTE |
| `audit.ensure_partitions()` (security definer) | none | EXECUTE | none | EXECUTE |
| `audit.drop_expired_partition()` (security definer) | none | none | none | EXECUTE |
| `secrets.master_keys`, `secrets.secret_versions` | SELECT, INSERT | SELECT, INSERT | SELECT | none |
| `secrets.data_keys` | SELECT, INSERT | SELECT, INSERT, UPDATE (wrap columns) | SELECT | none |
| `secrets.secret_blobs_worker` | INSERT (write-only) | SELECT, INSERT | none | none |
| `secrets.secret_blobs_observer` | SELECT, INSERT | SELECT, INSERT | none | none |
| `secrets.secret_blobs_auth` | SELECT, INSERT | none | none | none |
| `secrets.secret_blobs_gateway` | none | INSERT (write-only) | SELECT | none |
| `policy.rule_settings` | SELECT | SELECT, INSERT | none | none |
| `operations.plans`, `operations.plan_bodies` | SELECT, INSERT, UPDATE (plan state) | SELECT, INSERT, UPDATE (plan state) | none | none |
| `operations.operations` | SELECT, INSERT, UPDATE (state and outcomes: approve or cancel before execution only, `EXO02`) | SELECT, INSERT, UPDATE (state, outcomes, lease) | none | none |
| `operations.operation_events` | SELECT, INSERT | SELECT, INSERT | none | none |
| `operations.operation_locks` (row-level security) | SELECT | SELECT, INSERT (live operations), DELETE (finished operations only) | none | none |
| `operations.idempotency_keys` (row-level security) | SELECT, INSERT, UPDATE | SELECT, DELETE (expired only) | none | none |

Each later Wave 2 bundle adds its rows to this table; the behavior behind
them is described in [`audit.md` §4](./audit.md#4-immutability-and-integrity),
[`../08-auth-and-security/secrets.md`](../08-auth-and-security/secrets.md),
[`policy-engine.md`](./policy-engine.md) and [`operations-engine.md`](./operations-engine.md).
No role holds `UPDATE`, `DELETE` or `TRUNCATE` on an audit table or a secrets
table (except the worker's re-wrap columns of `secrets.data_keys`).

**Bundles.** `packages/control-store/migrations/` holds real bundles and an
`exponetdb.project.yaml` (`project: exponetdb/control-store`, one execution
role alias `migrate: exdb_migrate`, `searchPath: [pg_catalog]`). Control Store
rules on top of the format: every bundle is transactional, has a
`verify.sql`, names every check with `-- check:`, and executes as the login
that runs the migration.

**Runner.** `exponetdb control-store migrate` connects as `exdb_migrate`
(any other login is refused), takes the session advisory lock
`(EXDB, h("control-store/migrate"))`, reads the ledger, refuses a checksum
mismatch (hard failure) and ids the release does not know (newer schema: no
downgrade), applies pending bundles in graph order (each `up.sql` and its
ledger row in one transaction, `lock_timeout`, `statement_timeout` and
`search_path` from the manifest projection), writes the installation marker
on the first run, then verifies every bundle whose latest verification did
not pass with the shipped verify digest and appends the result. It never
re-runs `up.sql` for an applied migration and never rolls anything back.

**Ledger.** `control.schema_migrations` (id, name, apply checksum, verify,
rollback and bundle digests, dependencies, applied sequence and time,
duration, engine version, PostgreSQL version) and
`control.migration_verifications` (one row per run: verify digest used,
start, end, `passed`/`failed`/`error`, a summary of check names, outcomes,
reasons and the redacted `detail` of the first failing row), both
append-only by trigger; `control.migration_status` joins the latest
verification. No SQL text is stored.

**`verify.sql` trust boundary.** The Control Store's `verify.sql` files are
shipped, reviewed ExponetDB source bound by their verify digest, not user
input. They run on a separate connection that is closed afterwards, in a
`READ ONLY` transaction that always ends in `ROLLBACK`, with statement and
lock timeouts and the bundle's search path. The parser-based admission does
not exist before Wave 4/6 and is not claimed; none of these limits is a
sandbox.

**Compatibility at startup.** Every process compares the shipped set (all
ids, checksums and verify digests, never "the latest id") with the ledger:
a checksum mismatch or a newer schema refuses to start; a missing or
unverified expected bundle is "not ready" until the runner has run.

## 5b. Implementation (Wave 3A)

**[DECIDED]** (Wave 3A, bundles `auth-identity`, `access-control`,
`plan-approvals`, depending on the Wave 2 head; the six Wave 2 bundles are
unchanged and their checksums and verify digests are pinned by
`packages/control-store/test/immutable-bundles.test.ts`.)

| Schema object (Wave 3A) | `exdb_serve` | `exdb_worker` | `exdb_gateway` | `exdb_audit_maint` |
|---|---|---|---|---|
| `auth.identity_providers` (`local` seeded, external providers cannot be enabled), `auth.external_subjects` (`(issuer, sub)` → identity) | SELECT | SELECT; DELETE subjects (erasure) | none | none |
| `auth.identities` (states `invited`, `active`, `disabled`, `erased`; label `human #n`; session epoch; authorization revision) | SELECT, INSERT, UPDATE (state, contact, recovery flag, session epoch) | SELECT without e-mail and name; UPDATE (erasure, enabling, revision) | none | none |
| `auth.factors` (passkey public keys, Argon2id strings, TOTP secret references), `auth.recovery_codes` (hashes) | SELECT, INSERT, DELETE, UPDATE (state, label, counters, last use) | SELECT of id, identity, kind, state; DELETE (erasure); no codes | none | none |
| `auth.capabilities` (one-time links: hashes, 30 minutes or 24 hours from the database clock) | SELECT, INSERT, UPDATE (redeem, invalidate) | SELECT without the hash; UPDATE (invalidate) | none | none |
| `auth.challenges` (ceremony state: WebAuthn challenges, the second-factor step, enrollments) | SELECT, INSERT, UPDATE (consume) | SELECT without handles; UPDATE (consume); DELETE (ended more than a day ago) | none | none |
| `auth.web_sessions` (token and CSRF hashes, 30-minute idle and 12-hour absolute lifetime from the database clock), `auth.reauth_events` (append-only evidence) | SELECT, INSERT, UPDATE (rotation, last seen, re-authentication, revocation) | SELECT without hashes; UPDATE (revocation) | none | none |
| `auth.rate_limits` (HMAC-keyed buckets), `auth.notifications` (outbox without content), `auth.installation_keys` (secret references) | full on limits; SELECT, INSERT, UPDATE status on notifications; SELECT, INSERT keys | prune limits; notifications status; no keys | none | none |
| `auth.roles`, `auth.role_permissions` (seeded, explicit, append-only, catalog-checked) | SELECT | SELECT | none | none |
| `auth.role_bindings` | SELECT; EXECUTE `auth.activate_bootstrap_owner` only | SELECT, INSERT, UPDATE (revocation) | none | none |
| `approvals.plan_approvals` (append-only) | SELECT, INSERT | SELECT | none | none |

Database guards (tested by attempting each forbidden change,
`packages/control-store/test/auth-schema.int.test.ts`):

- `EXU01`: identity lifecycle. `serve` may activate an invited identity or
  disable one; enabling a disabled identity and erasure are the worker's
  (planned operations); an erased identity never changes; the e-mail address
  changes only before activation or by erasure.
- `EXU02` to `EXU05`: factor material is immutable (a new value is a new
  factor), TOTP steps and signature counters never go backwards, recovery
  codes and challenges are consumed once, one-time links are redeemed or
  invalidated once and never after expiry, sessions rotate both secrets and
  advance their generation, a revoked session never changes (except that
  erasure may clear its coarse device label), a session is
  issued to an active identity only, and its re-authentication time is the
  recorded event's own time.
- `EXU06`: role bindings are created by operations and revoked once; the
  owner role is bound globally only; **the last active owner** cannot lose
  its binding or be deactivated. Every change that can remove an owner takes
  the transaction lock `(EXDB, h("control-store/owner-invariant"))` and then
  counts on a fresh snapshot, so two concurrent removals of two owners leave
  exactly one.
- `EXU07`: `auth.activate_bootstrap_owner` (security definer, `serve` only)
  creates the first owner's global binding only while no active owner
  exists, for the pending bootstrap identity, after its setup link was
  redeemed and passkey, password, TOTP and ten unused recovery codes exist;
  afterwards it refuses forever.
- `EXR01`: an approval names the plan's current hash, its operation awaits
  approval, the approver is an active human deciding through an own live
  Web App session with a passkey or TOTP re-authentication of at most 300
  seconds; `self_approval` and the not-before time are computed by the
  database (OD-9).

The `verify.sql` of these bundles check invariants that later, additive
bundles keep (named objects exist and behave, forbidden privileges are
absent); they never pin the number of tables, triggers or rows of a
schema. The exact role matrix is compared with the release's code at server
startup. Reason: the runner applies every pending bundle before it verifies,
so an earlier bundle's `verify.sql` runs against the final schema of a fresh
installation (the Wave 2 `operations` bundle pins its trigger count, which is
why approvals live in their own schema).

## 5c. Implementation (Wave 4)

**[DECIDED]** (Wave 4, bundles `01M48WRFNFYAY62E1146END05N_registry` and
`01M48WRFNGYF5WH0884N169FNH_observation`, depending on the frozen Wave 3B
head `oauth-delegation`; no frozen bundle changes. Frozen since G4 was
accepted on 2026-10-07, baseline `04b2e77`.)

The outline in §3 placed the diagnostics tables and `schema_documents` in
separate groups; Wave 4 keeps what observation needs in one schema
`observation`, and the registry in `registry` without `nodes`,
`certificates` and the role manifests (node agent and roles capability,
Waves 5 and later).

| Schema object (Wave 4) | `exdb_serve` | `exdb_worker` | `exdb_gateway` | `exdb_audit_maint` |
|---|---|---|---|---|
| `registry.products`, `environments`, `projects`, `servers`, `clusters`, `endpoints`, `databases`, `targets`, `placements` | SELECT | SELECT, INSERT; UPDATE of state and revision columns only | none | none |
| `registry.credentials` (metadata of the PostgreSQL credentials; the secret is a `pg_credential` secret version) | SELECT, INSERT (a pending submission), UPDATE (state, failure code: superseding the pending one only) | SELECT, INSERT; UPDATE (state, verification, failure code) | none | none |
| `registry.cluster_tiers`, `registry.server_tiers` (derived tier: `prod` if any live target on it is) | SELECT | SELECT | none | none |
| `observation.schema_documents` (gzip of the canonical document by fingerprint), `schema_snapshots`, `drift_checks` (append-only) | SELECT, INSERT | SELECT, INSERT | none | none |
| `observation.schema_baselines` (append-only) | SELECT | SELECT, INSERT | none | none |
| `observation.findings` (open once per target and deduplication key) | SELECT, INSERT, UPDATE (occurrence, severity, resolution) | same | none | none |
| `observation.target_status` (latest health per target), `observation.health_samples` (daily partitions) | SELECT | SELECT, INSERT; UPDATE on the status; EXECUTE the two partition functions | none | none |

Database guards (tested by attempting each forbidden change,
`packages/control-store/test/registry-schema.int.test.ts`):

- `EXG01` to `EXG06`: a product never changes; environments and projects
  keep their id, product and slug and advance their revision by one per
  change; an environment's tier does not change while a live target uses it;
  the evidence environment is in the same product and never forms a cycle; a
  server record does not change in this release.
- `EXG07`: a cluster starts `pending`; its `system_identifier` is pinned once
  by confirmation (`pending → active → retired`); id, server, management
  mode and CA bundle never change.
- `EXG08`: an endpoint starts active and is only retired, once, by an
  operation. A CHECK requires the TLS server name to equal a DNS host; an IP
  host needs an explicit name; a host is never a URL.
- `EXG09`: a database is registered on a confirmed active cluster, keeps its
  cluster and name, and is not retired while it is a current placement.
- `EXG10`: a target's path is `product/project/environment` of its own
  product and its tier is the environment's; it starts `registered` at
  generation 1; its generation only grows; it moves
  `registered → active ⇄ suspended → decommissioned` (or
  `registered → decommissioned`) and each state change names its operation
  (the registering operation itself may activate the target it recorded);
  a decommissioned target never changes and keeps its path: a path is never
  reused by another target.
- `EXG11`: a placement starts current, carries its live target's
  generation, binds a registered database and only ends, once. Unique
  partial indexes keep one current placement per target and per database
  and one live target per path and per project and environment.
- `EXG12`: a credential starts `pending` and points at a `pg_credential`
  secret version whose subject is `<cluster>/<role name>` and whose
  consumer is `observer` for the observer role and `worker` otherwise; it
  keeps its cluster, role and secret; `pending → active | failed`,
  `active → retired`; only activation records a verification. `serve`
  only supersedes a pending credential (`failed`, `superseded`); activation
  is the worker's after a verified login.
- `EXH01` to `EXH03`: a finding starts open, keeps its identity, counts one
  more occurrence when seen again and is resolved once; a baseline is a
  complete snapshot of the same target and generation (a CHECK keeps a
  snapshot with a visibility gap incomplete); a snapshot names its target's
  current generation.
- Nothing in `registry` is deleted or truncated, and the observation
  history is append-only (`control.reject_change`, `EXA01`, for every role
  including the schema owner).
- `observation.ensure_sample_partitions(days)` (1 to 14 days ahead) and
  `observation.drop_expired_sample_partitions(days)` (3 to 60 days kept,
  [`data-retention.md`](./data-retention.md)) are security-definer functions
  owned by `exdb_migrate` that only the worker may call; they serialize on
  the transaction lock `(EXDB, 1537273329)`.

## 5d. Implementation (Wave 5)

**[DECIDED]** (Wave 5 Phase 3, bundle `01M49K5NQ8ZB4W2T6Y3H7RXJMD_nodes`,
depending on the frozen Wave 4 head `observation`; not frozen until G5.)
The node agent's control plane lives in the schema `nodes`, the first one
the gateway may use (the frozen `operations-engine` and `registry` bundles
assert that it may not use theirs). Design and states:
[`control-plane.md`](../07-node-agent/control-plane.md).

| Schema object (Wave 5) | `exdb_serve` | `exdb_worker` | `exdb_gateway` | `exdb_audit_maint` |
|---|---|---|---|---|
| `nodes.pki` (agent PKI certificates, references to the gateway-consumer CA and gateway keys; one row) | SELECT | SELECT, INSERT | SELECT | none |
| `nodes.job_keys` (job-signing public keys; private keys are worker-consumer secrets) | SELECT | SELECT, INSERT; UPDATE (state) | SELECT without the secret reference | none |
| `nodes.enrollment_tokens` (no secret; the redeem hash and the bind key's worker-consumer secret from issue on) | SELECT; UPDATE (state, redeem hash, bind secret: the issue) | SELECT, INSERT; UPDATE (state: expiry) | none (redeemed through `nodes.enroll`) | none |
| `nodes.nodes` (I-6 as a partial unique index) | SELECT | SELECT; UPDATE (state, its operation and reason: binding, revocation) | SELECT of the ids, state, TLS and signing keys and certificate; never the bind proof or the encryption key | none |
| `nodes.jobs` (the signed envelope never changes) | SELECT | SELECT, INSERT; UPDATE (state, cancel flag, verdict); EXECUTE `nodes.sweep_jobs()` | none (through the functions) | none |
| `nodes.enroll`, `hello`, `heartbeat`, `renew`, `claim`, `start`, `progress`, `complete` (security definer, owned by `exdb_migrate`) | none | none | EXECUTE | none |

Database guards (tested by attempting each forbidden change,
`packages/control-store/test/nodes-schema.int.test.ts`): a token is created
without a secret, issued once within its reveal window (expiry 30 minutes
after issue, set by the database), redeemed once and only with its redeem
hash; one live node per server; a node starts `pending_binding` and is
activated only by the state change that records its binding; its id, server,
token and long-term keys never change; a revocation names its operation and
is final; a job is created only for a bound node, with columns that are its
envelope's, whose envelope never changes; a dispatched job not started
within 60 s returns to `pending` with the identical envelope, a running job
past its lease becomes `outcome_unknown`; a completion and a verdict are
recorded once. Every gateway function checks that the presented
certificate is the node's current one and that the node is served. Nothing
in `nodes` is deleted or truncated.

**[DECIDED]** (Wave 5 correction F1, bundle
`01M4DSPKRQD52Y8E9MKCYKWVFW_node-gateway-admission`, depending on `nodes`;
not frozen until G5.) The schema `node_admission` holds one function,
`node_admission.job_capability(node, certificate, job)` (security definer,
owned by `exdb_migrate`, EXECUTE for `exdb_gateway` only): after the same
current-certificate check as the gateway functions, the capability of one of
the node's jobs. The gateway refuses a completion of a major the correction
retired before `nodes.complete` stores it
([`capabilities.md` §6](../07-node-agent/capabilities.md#6-confidentiality-of-node-exports-wave-5-correction-f1)).
The gateway still reads no job directly, and the nodes bundle and its
verification are unchanged.

**[DECIDED]** (Wave 6, bundle `01M4QEE7JX03XAZJKZ2MRT8JJT_migration-engine`,
depending on `node-gateway-admission`; not frozen until G6.) The schema
`migrations` (owner `exdb_migrate`) holds the migration engine's records:

| Table | Written by | Holds |
|---|---|---|
| `bundle_revisions` | `exdb_serve` (ingestion, a person's control record) | every ingested revision of a migration id: the exact bytes of its files, its digests, the materialized manifest and the project defaults it used, a source reference as a claim; immutable |
| `ledger_mirror`, `ledger_state` | `exdb_worker` | each target's ledger rows per generation and the last observed ledger state hash; `divergent` stops schema plans ([`ledger.md` §5](../04-migrations/ledger.md#5-mirror-and-reconciliation)) |
| `verification_mirror` | `exdb_worker` | each target's verification runs; append-only |
| `operation_migrations` | `exdb_worker` | per-migration apply and verification outcomes of a migration operation, and the result of a pre-commit gate that rolled a migration back (the target's ledger has no row to hang it on) |

`registry.projects` gains `execution_roles` (alias → PostgreSQL role the
migrator may `SET ROLE` into) and `trusted_extensions`, both written by the
worker through a project change: a project file names aliases, only the
registry maps them. Nothing in `migrations` is updated or deleted except the
mirror rows the worker rewrites from the target (a revert time, a new
observation).

**[DECIDED]** (Wave 6, bundle `01M4QN37EYQ6X0NFPAQRPK5FAG_break-glass`,
depending on `migration-engine`; not frozen until G6.) The schema
`breakglass` (owner `exdb_migrate`; its own schema because the frozen
operations bundle pins the objects of `operations`) holds `grants`: a
person's time-boxed override of named rules on one target with its reason
([`operations-engine.md` §8](./operations-engine.md#8-break-glass)). `exdb_serve`
inserts a grant, counts its uses and records its review; `exdb_worker` reads
grants. A trigger (`EXO11`) refuses every other change: only `uses` grows
(never past `max_uses`), revocation and review happen once, nothing is
deleted or truncated; a grant lasts at most two hours.

**[DECIDED]** (Wave 6, bundle `01M4QPP4T3E31ANKDVSR7T3YHS_legacy-import`,
depending on `break-glass`; not frozen until G6.) Three tables in
`migrations` hold the legacy import
([`legacy-import.md` §2.2](../04-migrations/legacy-import.md#22-wave-6-implementation)):
`import_reports` (one analysis of one target: scratch target, baseline id,
hints, state, fingerprints, why it is incomplete), `import_files` (the exact
legacy files and their digests; immutable) and `import_items` (the
classification with its evidence; only an open report's decision columns
change, `EXO12`). `exdb_serve` records reports, files and decisions;
`exdb_worker` writes items and results and marks a report baselined.

**[DECIDED]** (Wave 6, bundle `01M4QT02MQ05WZ8J29C134Y45A_step-up`,
depending on `legacy-import`; not frozen until G6.) The schema `stepup`
(owner `exdb_migrate`; only `exdb_serve` uses it) holds `step_ups`, the CLI
step-ups of [ADR-0026](../01-architecture/adr/0026-cli-step-up-browser-handoff.md):
the binding (identity, OAuth client, grant, action, plan id and hash or
token id, and its digest), the user code as a hash (never the code), the
attempts, the confirmation (session, re-authentication time and method,
receipt expiry) and the redemption. A step-up lasts at most ten minutes
and its receipt 120 seconds after the confirmation. A trigger (`EXO12`)
keeps the binding unchanged and the state moving forward only (`pending`
to `confirmed` to `redeemed`, or to `expired`, `refused` or `canceled`);
nothing is deleted or truncated.

**[DECIDED]** (Wave 6, bundle `01M4R2T03VG6F43SEKX6F5ST5G_operation-authority`,
depending on `step-up`; not frozen until G6.) One column-level privilege:
`exdb_worker` reads the `scopes`, `tiers` and `target_ids` of
`oauth.grants`, so it can re-check a running operation's authority before
it starts and before each further migration
([`operations-engine.md` §10](./operations-engine.md#10-edge-cases),
failure case E27). No table and no row changes.

**[DECIDED]** (Wave 6, bundle `01M4R53PV1XDVSGDSVN86DQ3JB_verification-retry`,
depending on `operation-authority`; not frozen until G6.)
`recovery.verification_retries` holds an operator's request to verify
again an operation in `needs_attention` (who asked, when, and when the
worker started it). `exdb_serve` inserts a request (it may not move an
operation that started, `EXO02`); `exdb_worker` claims the operation,
records the start once and moves it to `verifying` under its lease. At
most one request is open per operation; a trigger (`EXO12`) lets only the
start be recorded, once; nothing is deleted or truncated.

**[DECIDED]** (Wave 6, bundle `01M4R66846BD63S51NS15EZKB1_migration-baselines`,
depending on `verification-retry`; not frozen until G6.) The snapshot
purpose and the baseline reason of `observation` accept `migration`: after
a verified migration (or rollback) the worker stores its snapshot and
records it as the target's baseline, the expected schema of drift checks
([`drift-detection.md` §7](../03-database-model/drift-detection.md#7-wave-4-implementation-kind-c)).
Only the two CHECK constraints change; the guards (`EXH02`, `EXH03`) and
append-only triggers stay.

**[DECIDED]** (Wave 7, bundle `01M4S5TDSB5ZXPJCBFKF8WRT5C_mcp-keys`,
depending on `migration-baselines`; not frozen until G7.)
`auth.installation_keys` accepts two more purposes, `mcp.cursor_key` and
`mcp.request_state_key`: the keys of the `/mcp` endpoint that seal the list
cursors handed to agents and the request state of the approval round
([ADR-0027 §7](../01-architecture/adr/0027-mcp-protocol-layer.md)). Each is
created on first use like the existing keys (a secret of consumer `auth`,
readable by `serve` only). Only the CHECK constraint changes; the table
stays append-only. **[DECIDED]** (Wave 7 Phase 9) The two MCP keys are
rotatable: `exponetdb keyring rotate-mcp-key` adds a version to the same
secret (`secrets.secret_versions`), so `auth.installation_keys` keeps one
row per purpose; serve opens a request state under the newest two
versions and a list cursor under the newest only (the cursor format names
no version, so a rotation ends open cursors;
[ADR-0027 §7](../01-architecture/adr/0027-mcp-protocol-layer.md)).

**[DECIDED]** (Wave 7, bundle `01M4S8BT93YJBDEE0Y6ZQAEH1J_grant-last-use`,
depending on `mcp-keys`; not frozen until G7.) `oauth.grant_last_use` holds
one row per grant: `last_used_at` (truncated to the minute) and
`use_class` (`read`, `plan`, `apply`, `data`, `rest`). `serve` may select,
insert and update those two columns, never delete; the row goes with its
grant (`ON DELETE CASCADE`, grants are never deleted today). It is the data
basis of "last used" (Wave 8) and an "unused grant" finding (Wave 9), never
a request log and never a decision input
([`../05-mcp/oauth.md` §5](../05-mcp/oauth.md#5-tokens)).

**[DECIDED]** (Wave 7, bundle `01M4SCEZ0HK44KYQHA1RQZFGCK_data-read-lane`;
not frozen until G7; [ADR-0028](../01-architecture/adr/0028-data-read-lane.md))
Schema `dataread`, owned by `exdb_migrate`, ciphertext only:

- `dataread.workers`: one row per worker process that executes data reads,
  with the public half of an X25519 key the process holds in memory only
  and its heartbeat. A restarted worker registers a new key; a request
  sealed to the old one is never opened.
- `dataread.reads`: one row per data read while it runs: who asked
  (identity, client and grant ids, the caller class `agent` or `human`,
  never a token), the target, the worker it is addressed to, the request
  and the result sealed with HPKE (at most 1 MiB and 16 MiB), the state
  (`waiting`, `running`, `done`, `failed`, `canceled`), an error code, the
  cancel flag and a deadline at most five minutes after creation (CHECK).
  No row value, statement text or parameter is stored in clear.
- Rights: `serve` reads the live workers, inserts, deletes and sets
  `cancel_requested`; the `worker` registers and heartbeats its key, claims
  and finishes the reads addressed to it and deletes reads past their
  deadline. **[OBSERVED]** (2026-10-13, Phase 11) `serve` deletes a row as
  soon as it has the result, and deletes a `waiting` row no worker claimed
  when it gives up; nothing stays after the deadline
  ([`data-retention.md`](./data-retention.md)).

**[DECIDED]** (owner decision 2026-10-13, a Wave 7 follow-up; bundle
`01M4T4DMYR23DXVB3SP8RF3RBZ_audit-client-grant-index`, depending on
`data-read-lane`, additive, transactional) Two partial expression indexes
on `audit.audit_events`: `audit_events_client` on the event's
`client.clientId` and `audit_events_grant` on its `client.grantId`, each
with `seq`, only over events that carry the id. They serve the audit
filter by client and by grant (audit.md §2) without a scan of the chain;
no column, row or right changes. Both are partitioned indexes, so every
monthly partition, present and created later, carries them.

**[DECIDED]** (owner decision 2026-10-13, OD-5 revised; bundle
`01M4TKQ5C3X8Y2NZ7D4B9W6F1H_oauth-open-registration`, depending on
`audit-client-grant-index`, additive) The guard of `oauth.clients` is
replaced: a CIMD or DCR client may also start `active` with an automatic
approval (no approver, the approved fingerprint equals the recorded one),
a pending one may be approved automatically, an active CIMD client may be
approved again automatically with a changed fingerprint, and an
automatically approved DCR registration older than a week may be deleted
(the foreign keys keep one in use). A rejected or disabled client still
needs a person. The worker may read `oauth.clients.approved_by_identity_id`
and `created_at` and `oauth.authorization_requests.client_id` for that
prune. No table or column changes.

**[DECIDED]** (Wave 8, order §9 endpoint 3; bundle
`01M4V4DA2W7HK9QB5NZ3XT6RME_drift-acceptance`, depending on
`oauth-open-registration`, additive, transactional; not frozen until G8) The
CHECK of `observation.schema_snapshots.purpose` accepts one more value,
`drift_accept`: the snapshot the worker records as a target's baseline when
a person's drift acceptance is applied. The baseline reason `drift_accept`
and the finding resolution `accepted` exist since the observation bundle; no
table, column, row or right changes (the worker already inserts baselines
and resolves findings; `serve` never inserts a baseline).

**[DECIDED]** (Wave 8, order §9; bundle
`01M4V1SQ7K2D9QHRZ5XW0BN3EA_saved-queries`, depending on
`drift-acceptance`, additive, transactional, not frozen) Schema
`savedq`, owned by `exdb_migrate`, with one table `savedq.saved_queries`:
the `sqy_` id, the owner (`auth.identities`), the name (1 to 120
characters, no control character), the SQL text (1 to 65,536 characters),
its digest (`sha256:` of the redacted text), the visibility (`personal`,
`project`), the scope (`project` with a project id or `target` with a
target id, CHECKed exclusive, foreign keys `ON DELETE RESTRICT`), a
revision and the created and updated times (the database's clock). A guard
keeps the id, the owner, the scope and the creation time, and lets a change
raise the revision by exactly one (`EXQ01`). Rights: `serve` selects and
inserts; it holds no `UPDATE`, `DELETE` or `TRUNCATE` and changes or
deletes a row only through the security-definer functions
`savedq.update_saved_query` (owner and revision named, `EXQ02` for a row
that is missing or someone else's, `EXQ03` for a stale revision) and
`savedq.delete_saved_query` (owner named, `EXQ02`); `worker` has no access.
The same bundle adds the partial index `audit_events_data_read_actor` on
`audit.audit_events (actor_id, seq) WHERE action = 'data.read'` for the
history of one's own data reads; the events and their chain are unchanged
([`../03-database-model/sql-execution-security.md` §2.6, §2.7](../03-database-model/sql-execution-security.md#26-query-history-wave-8)).

**[DECIDED]** (owner decision 2026-10-13, OD-22 extended, S4; bundle
`01M4V2CT4N8PJ6GZ3YQ1RWK7HD_cluster-declared-tier`, depending on
`saved-queries`, additive, transactional) `registry.clusters`
gains the declared intended tier: `declared_tier` (`prod` or `nonprod`,
NULL while undeclared), `declared_tier_at` (database clock) and
`declared_tier_by_operation_id`, recorded together (CHECK). A second
guard (`clusters_tier_guard`; the frozen `registry` bundle's guard is
untouched) refuses a cluster registered declared, a declaration on a
retired cluster, a declared tier set back to NULL, a declaration without
its own operation of the kind `registry.cluster.declare_tier`, and any
written time. Only `exdb_worker` may update the three columns; `serve`
reads them through its table-wide SELECT. The OAuth scope catalog is not
changed: the frozen `oauth-delegation` bundle's `verify.sql` pins exactly
four `:prod` and four `:nonprod` scopes and fifteen explicit-consent
scopes, so `registry.manage` stays one scope
([authorization.md §5.1](../08-auth-and-security/authorization.md#51-the-registry-tier-of-registrymanage-od-22)).
Tests: `packages/control-store/test/registry-schema.int.test.ts`
("declares a cluster tier only through its own declare_tier operation",
and the upgrade from the G3B schema through every later bundle).

**[DECIDED]** (owner decision S3, 2026-10-13; bundle
`01M4V3RV9F5XM2TB8KC6QZJ0NS_role-verifiers`, depending on
`cluster-declared-tier`, additive) Write-only storage of role verifiers
([`../03-database-model/credentials-and-roles.md` §4.1](../03-database-model/credentials-and-roles.md#41-role-verifiers-wave-8-owner-decision-s3)):
a schema of its own, `role_verifiers` (the frozen `secrets-store` bundle
pins the tables of `secrets`), owned by `exdb_migrate`, `USAGE` for
`exdb_serve` and `exdb_worker` only, with one table `verifiers`: the
`rvf_…` id, the cluster, the role (`^[a-z_][a-z0-9_$-]{0,62}$`, never
`pg_…` or `exponetdb_…`), the state (`submitted`, `consumed`,
`superseded`), the `se1` context id (`sec_…`), the sealed columns (key id,
wrap nonce, wrapped data key, nonce, ciphertext; present exactly while
`submitted`), the submitter, the times and, once consumed, the operation.
One submitted verifier per role of a cluster (partial unique index). The
guard (`EXS03`) sets the times, lets a row move once from `submitted` to
`consumed` or `superseded` and only with every sealed column cleared, keeps
its binding (id, cluster, role, context, submitter) and refuses deletes;
truncation is refused. Grants: `exdb_serve` `INSERT`, `SELECT` on the
metadata columns only (no sealed column) and `UPDATE` of the state and the
sealed columns (to clear a superseded row); `exdb_worker` `SELECT` and
`UPDATE` of the state, the sealed columns and the operation. No other
role. Nothing existing changes.

**[DECIDED]** (owner decision S10, 2026-10-13; bundle
`01M4V7PRFXK2N9QB4ZH6WD3TME_identity-profiles`, depending on
`role-verifiers`, additive, transactional, not frozen) The profile of a
person ([`../08-auth-and-security/identity.md` §12](../08-auth-and-security/identity.md#12-profile-wave-8-owner-decision-s10)):
schema `profiles`, owned by `exdb_migrate`, `USAGE` for `exdb_serve` and
`exdb_worker` only, with one table `profiles.identity_profiles`, one row per
identity (`auth.identities`, `ON DELETE RESTRICT`): `display_name` (NULL or 1
to 64 characters, no control, C1, zero-width, line-separator or
bidirectional formatting character, no leading or trailing white space),
`avatar` (bytes, at most 262,144), `avatar_media_type` (`image/png`,
`image/jpeg`, `image/webp`), `avatar_sha256` (CHECKed equal to
`'sha256:' || encode(sha256(avatar), 'hex')`), `avatar_width` and
`avatar_height` (32 to 1024), all five present or absent together, the
leading bytes CHECKed against the media type (PNG signature, JPEG SOI,
`RIFF…WEBP`), a revision and the created and updated times (the database's
clock). The guard (security definer, `EXF01`, `EXF02`) keeps the identity and
the creation time, lets a change raise the revision by exactly one, accepts
an insert or change only for an `active` human identity and a delete only
once the identity is `erased`; truncation is refused. Rights: `serve`
selects (it serves the pictures) and holds no `INSERT`, `UPDATE` or `DELETE`;
it changes a row only through the security-definer functions
`profiles.set_display_name` (identity and revision named, 0 for a profile not
yet created; `EXF03` when stale), `profiles.set_avatar` and
`profiles.clear_avatar`. `worker` holds `DELETE` and `SELECT` of
`identity_id` only, for erasure (`access.identity.erase` deletes the row and
verifies none is left); it never reads a name or a picture. Tests:
`apps/server/test/http-profile.int.test.ts` ("the Control Store"),
`packages/auth/test/access.int.test.ts` (erasure),
`packages/control-store/test/registry-schema.int.test.ts` (the upgrade
through every bundle).

**[DECIDED]** (owner decision of 2026-10-21, a long provider list with
logos; bundle `01M5F4NHFTMQRYJA43P8GKP44M_server-providers`, depending on
`identity-profiles`, additive, transactional, not frozen) The CHECK
`servers_provider_check` of `registry.servers.provider` (an unnamed column
CHECK of the frozen `registry` bundle, so PostgreSQL's name) is replaced by
one that accepts the four Wave 4 values and eighteen more, exactly the
contract's `SERVER_PROVIDERS`
([`../01-architecture/domain-model.md` §3.2](../01-architecture/domain-model.md#32-physical-layer)).
Every stored value keeps its meaning; no table, column, row or right
changes (the worker still inserts servers, `serve` does not). Tests:
`packages/control-store/test/registry-schema.int.test.ts` ("accepts exactly
the server providers of the contract": every contract value is accepted, a
near miss such as `hetzner`, `linode` or `Hetzner_Cloud` is `23514`, and
`serve` cannot insert; and the upgrade through every bundle).

**[DECIDED]** (OD-56 (a), Wave 9 Part B order of 2026-10-26; bundle
`01M5X840BP8JXGEQGS0PHPTB58_excused-value-digests`, depending on
`cluster-agent-adoption`, additive, transactional, not frozen) Keyed digests
of excused values ([`../04-migrations/legacy-import.md` Step 7](../04-migrations/legacy-import.md#step-7-verify)):
`migrations.excused_value_key` (one row: the `sec_…` id of the
installation's excused-value key, a worker secret of purpose
`migrations.excused_value_key`), `migrations.import_value_keys` (per import
report analyzed with digests, the key version `<secret id>:<version>` it
used, NULL when no failure of a value needed one) and
`migrations.import_value_digests` (per report, item and failure identity, a
SHA-256 of file, statement, kind, object and aspects, the `hmac-sha256:`
digest of the observed value). No value and no key material is stored. A
trigger (`EXO12`) refuses every change and delete. Rights: `exdb_worker`
`SELECT` and `INSERT` on the three; `exdb_serve` `SELECT` on
`import_value_keys` only (planning a baseline asks whether a report has
digests), never a digest or the key's secret id. Tests:
`packages/migrations-engine/test/legacy-baseline-verify.int.test.ts`
("excused values (OD-56 (a))"), `packages/control-store/test/registry-schema.int.test.ts`
(the upgrade through every bundle).

**[DECIDED]** (test campaign TC-005; bundle
`01M61AGQKSBZ9VN71DHYFVCQHT_operation-supersession`, depending on
`excused-value-digests`, additive, transactional, not frozen) The one new edge
of the operation state machine, `needs_attention` to `verification_failed`
([`operations-engine.md` §4.1](./operations-engine.md#41-state-machine)):
`operations.recovery_transition_allowed(from, to)` (pure, `exdb_serve` and
`exdb_worker` may execute it) and a replaced `operations.operation_guard()`
that accepts a transition either that function or the operations bundle's
`transition_allowed` allows. The frozen function and its `verify.sql` (fifteen
pairs) are untouched. Tests: `packages/operations/test/engine.int.test.ts`
(both functions against the code for every input),
`packages/operations/test/driver.int.test.ts`,
`packages/migrations-engine/test/recovery.int.test.ts`.

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

## 8. Failure behavior

| Failure | Effect | Behavior |
|---|---|---|
| Control Store unreachable | No authentication (sessions, tokens are in it), no plans, no operations | `/healthz/ready` fails; API returns `CONTROL_PLANE_DEGRADED`; running operations pause at their next step and reconcile later; **managed databases keep running unaffected** |
| Control Store slow | Request latency rises | timeouts per request; samplers back off |
| Control Store restored from backup | Plans/operations after the backup point are lost; target ledgers are ahead of the mirror | Startup reconciliation compares every target ledger with the mirror; differences explained by "operations unknown to this Control Store" are raised as `LEDGER_DIVERGENCE` findings for operator review, never auto-accepted |

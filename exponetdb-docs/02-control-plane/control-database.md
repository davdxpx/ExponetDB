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

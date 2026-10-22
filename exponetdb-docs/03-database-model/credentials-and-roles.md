# Credentials and PostgreSQL roles

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
| Applies to | Wave 4 (roles, credentials), Wave 5 (node-managed roles, TLS, `pg_hba`), Wave 10/11 (REOSA) |
| Read before | [`../00-product/constitution.md`](../00-product/constitution.md) C-20 to C-23, [`../08-auth-and-security/secrets.md`](../08-auth-and-security/secrets.md) |
| Decision | [ADR-0020](../01-architecture/adr/0020-no-superuser-in-control-plane.md) |

## 1. Principles

**[DECIDED]**

1. **One role per path.** Introspection, data reads, verification, operator
   actions and migrations use different PostgreSQL roles with different
   privileges ([C-23](../00-product/constitution.md#c-23-least-privilege-per-path)).
2. **No superuser over the network.** For agent-managed clusters the Control
   Plane holds no superuser credential; superuser work happens on the host via the
   node agent's local peer-authenticated session
   ([C-21](../00-product/constitution.md#c-21-no-superuser-credentials-in-the-control-plane-for-agent-managed-clusters)).
3. **Secrets never leave the secret boundary.** No credential is ever returned
   by any interface, logged or audited ([C-20](../00-product/constitution.md#c-20-secrets-never-leave-the-secret-boundary)).
4. **ExponetDB never learns consumer passwords.** Consumer login roles are set
   from SCRAM verifiers computed by the consumer.
5. **Role names are API.** ExponetDB's own roles are namespaced `exponetdb_*`.
   **[OBSERVED]** REOSA hard-codes role names in function bodies and policies
   (`current_setting('role') IN ('service_role','platform_admin',…)` in 8 files),
   so renaming any role is a schema change; ExponetDB must not introduce names
   that could collide.

## 2. ExponetDB's roles on a managed cluster

Roles are cluster-wide in PostgreSQL; per-database access comes from `CONNECT`
and object grants.

| Role | Login | Key privileges | Used by | Never |
|---|---|---|---|---|
| `exponetdb_observer` | yes (network, TLS) | `pg_monitor` (= `pg_read_all_settings`, `pg_read_all_stats`, `pg_stat_scan_tables`); `CONNECT` on managed databases; `USAGE` + `SELECT` on `exponetdb` | introspection, fingerprints, diagnostics, health samples, ledger reads | read application rows (it has no table privileges); write anything |
| `exponetdb_reader` | yes | `pg_read_all_data`; `BYPASSRLS`; `CONNECT`; no write privileges; no `EXECUTE` on `dblink`/`postgres_fdw` | `data.read` queries | write (enforced by privileges, then by `READ ONLY` transactions as a second layer) |
| `exponetdb_verifier` | yes | `pg_read_all_data`; `BYPASSRLS`; `CONNECT`; no write privileges; no `EXECUTE` on `dblink`/`postgres_fdw`; role settings `default_transaction_read_only = on`, `search_path = ''` | running a bundle's reviewed `verify.sql` ([`../04-migrations/verification.md` §4](../04-migrations/verification.md#4-runtime-verification-verifysql)) on dedicated, unpooled connections | write; serve `data.read` (separate credentials so each path has its own role) |
| `exponetdb_operator` | yes | `pg_signal_backend` (cancel/terminate non-superuser backends), `pg_monitor` | `connections.cancel`, `connections.terminate` | signal superuser backends (PostgreSQL refuses); anything else |
| `exponetdb_migrator` | yes | membership in the project's execution role(s) `WITH INHERIT FALSE, SET TRUE` (PostgreSQL 16+), `CONNECT`, `INSERT`/limited `UPDATE` on `exponetdb` ledger tables | migrations (`SET LOCAL ROLE <execution role>` inside the migration transaction) | own application objects itself; be a superuser; create roles |
| `exponetdb_ledger_owner` | no | owns schema `exponetdb` | nothing logs in | |
| `exponetdb_node` | local socket only (`peer`, mapped from OS user `exponetdb-node`) | superuser | node agent capabilities on its own host | network login (no `pg_hba` network line exists for it) |

Notes:

- **Why `BYPASSRLS` on the reader (and the verifier).** Without it, a reader sees zero rows in every
  table protected by tenant RLS (REOSA: policies on `current_tenant_id()`, which
  is `NULL` without the tenant GUC) and in every `FORCE ROW LEVEL SECURITY` table
  (REOSA: 82 tables after a full replay of its migrations). An empty result that is really "filtered" would be a lie
  (C-28). The reader is therefore an operator-grade read role, and the
  `data.read` permission and scope are gated accordingly
  ([`sql-execution-security.md`](./sql-execution-security.md)).
- **Why `INHERIT FALSE, SET TRUE`.** The migrator does not exercise the
  execution role's privileges implicitly; it must `SET ROLE` explicitly, which
  happens only inside the migration executor. Requires PostgreSQL 16 or newer;
  on older servers the migrator is a plain member with `NOINHERIT` on itself.
- **Reserved connections.** **[PLANNED]** On agent-managed clusters ExponetDB's
  observer and operator roles are granted `pg_use_reserved_connections`
  (PostgreSQL 16+) and `reserved_connections` is set to a small number (default
  3), so that diagnostics still connect when application pools exhaust
  `max_connections`. **[OBSERVED]** REOSA's database diagnostics run through the
  same pool they diagnose, and REOSA's usage math ignores `reserved_connections`
  (REOSA diagnostics audit, 2026-10-04).
- **Role-level guards.** ExponetDB roles carry role-level settings:
  `idle_in_transaction_session_timeout` (observer/reader/operator 30 s,
  migrator 120 s), `statement_timeout` (observer/operator 30 s), and
  `application_name` defaults. Session code sets stricter values per operation.

**[DECIDED]** (Wave 4, `packages/postgres/src/bootstrap.ts`) The bootstrap
SQL creates the five login roles and the ledger owner with exactly these
memberships (observer `pg_monitor`; reader and verifier `pg_read_all_data`
with `BYPASSRLS`; operator `pg_signal_backend` and `pg_monitor`; migrator a
`SET`-only member of the ledger owner, `INHERIT FALSE`, until Wave 6 adds
execution roles), role settings (`default_transaction_read_only = on` for
observer, reader and verifier; `search_path = ''` for the verifier;
`statement_timeout` 30 s for observer and operator;
`idle_in_transaction_session_timeout` 30 s, migrator 120 s) and connection
limits (observer and reader 8, verifier 4, operator and migrator 2). The
database part grants `CONNECT` to the login roles and `CREATE` to the
ledger owner. Credential verification refuses a role that is a superuser,
has `CREATEROLE`, `CREATEDB`, `REPLICATION` or `BYPASSRLS` where it should
not, whose memberships differ from the list, or that reaches through its
memberships any role outside that list's closure (`pg_monitor` with its
`pg_read_all_settings`, `pg_read_all_stats` and `pg_stat_scan_tables`, the
same on 16, 17 and 18): a predefined role widened behind ExponetDB's back,
such as `pg_write_all_data` granted to `pg_monitor`, fails it
(`role_attributes`; **[DECIDED]** Wave 5 Phase 5 review).
`pg_use_reserved_connections` stays **[PLANNED]** for agent-managed clusters.

**[DECIDED]** (Wave 6) The migrator may in addition be a member of the
projects' execution roles (§3): credential verification accepts a migrator
membership `<role>:-s` (`SET TRUE`, `INHERIT FALSE`) in any role that is
neither predefined (`pg_…`) nor ExponetDB's (`exponetdb_…`), and the roles
reached through it, and nothing else; an inheriting or a non-`SET`
membership, or one in a predefined or ExponetDB role, still fails it
(`packages/registry/src/credentials.ts`). Whether such a role may serve as
an execution role is decided when a plan names it (§3).

## 3. Execution roles (who owns application objects)

Migrations run as the project's **execution role**, the role that owns the
application's objects (for example `reosa_owner`). It is a `NOLOGIN` role. The
migrator switches into it with `SET LOCAL ROLE` inside the migration transaction.

**[DECIDED]** ExponetDB requires each project to declare, per environment
(the project's map is the default; an environment binding refines it, §3.1;
before Wave 9 this paragraph said "per target" while the code resolved per
project, ADR-0034 §5):

| Declaration | Example (proposed for REOSA on `reos-db-01`) |
|---|---|
| execution role(s) and their aliases | `owner → reosa_owner` |
| application login roles and what they may do | `reosa_app` (LOGIN, member of `authenticated`, `service_role`, …), `website_renderer_login`, `consent_writer_login`, `sales_login` |
| whether any login role relies on owning objects or on `BYPASSRLS` | REOSA today relies on its login role (`postgres` on the hosted provider) bypassing RLS for console and maintenance paths |
| protected and foreign-owned schemas | `auth` (owned by the auth service role), excluded from migrations |

**[DECIDED]** (Wave 6, `executionRoleProblem` in
`packages/postgres/src/migration-facts.ts`; amended in Wave 9 by
[ADR-0034](../01-architecture/adr/0034-execution-roles-for-adopted-schemas.md),
OD-51) A role is usable as an execution role only when it exists, is
`NOLOGIN`, has none of `SUPERUSER`, `CREATEROLE`, `CREATEDB`, `REPLICATION`,
`BYPASSRLS`, is not a predefined (`pg_…`) or ExponetDB role, **reaches none
of them**, nor a role with `SUPERUSER`, `CREATEROLE`, `CREATEDB`,
`REPLICATION` or `BYPASSRLS`, through its memberships (so consumer SQL never
runs as the ledger owner, with a predefined role's powers, or hands an object
to a privileged role; the privileged-role part since Wave 9, found by the
independent review of Part A), and the migrator is its direct
member with `SET TRUE` and `INHERIT FALSE`. **The one exception:**
`BYPASSRLS` is accepted for a role a person declared for that project and
environment (§3.2); nothing else is ever excused. The planner reads these
facts with the observer for the migrator; the executor reads them again
under the lock, and so do the legacy replay and, since Wave 9, the
rollback (which never checked them before; a Wave 6 defect found in Part A).
The alias → role map, its environment bindings, the declared exceptions and
the trusted extensions of a project are registry data
(`registry.projects.execution_roles`, `registry.execution_role_bindings`,
`registry.execution_role_exceptions`, `trusted_extensions`), never a
client's claim.

### 3.1 Execution roles per environment

**[DECIDED]** (Wave 9, ADR-0034 §5, the Wave 9 order D-A2) An environment
of the project's product may bind an alias of the project's map to another
role (`registry.execution_role_bindings`), so staging and production of one
project on one cluster run under their own role sets. Per alias the
environment's binding wins, else the project map; an environment never
adds an alias. One resolver (`executionRolesFor` in
`packages/migrations-engine/src/execution-roles.ts`) serves the planner,
the apply kind, resume, rollback, re-verification, the reads and the
legacy replay (which resolves for the **scratch** target's environment); a
test fails when other engine code reads the map or the bindings. A plan
binds the resolved names and apply resolves again: a change in between is
`PLAN_STALE`. `c1` hashes only the alias, so a production plan consumes the
staging evidence of the same checksum although staging ran as another
role. Setting an environment's bindings is the registry operation
`registry.execution_role_binding.set` (`registry.manage` at that
environment's tier, re-authentication, human only; a tier-restricted grant
changes no environment's roles, authorization.md §5). Nothing is deleted:
a change ends the current row of an alias and inserts its successor, so the
table keeps the history.

**[OPEN: OD-53]** fp1 includes object owners, so two environments whose
objects are owned by different roles never have equal fingerprints: for a
project that is not an imported legacy project, every production plan then
fails `migration.fingerprint-lineage` and needs an approval (fail closed;
for an imported project it stays the legacy warning).

### 3.2 Declared `BYPASSRLS` exceptions

**[DECIDED]** (Wave 9, ADR-0034 §1 to §4, OD-51) Supabase-origin schemas
keep `SECURITY DEFINER` functions owned by the schema owner that read
`FORCE ROW LEVEL SECURITY` tables; their owner needs `BYPASSRLS`. A person
declares, per project, environment and role, that this role may carry
`BYPASSRLS` as an execution role (`registry.execution_role_exception.declare`,
`registry.manage` at the environment's tier, re-authentication, human only;
on production also an approval, `registry.execution-role-exception-production`).
A declaration names the role, a reason (20 to 1000 characters) and an
optional review date; its attributes are fixed to `{bypassrls}` by the
Control Store, it is revoked once and never re-activated, and after its
review date it excuses nothing. Every plan that relies on it binds
`{exceptionId, revision}` and shows it (`migration.execution-role-exception`,
a warning); a revoked, changed or expired declaration makes such a plan
`PLAN_STALE`. An agent may apply nonprod migrations under a declaration;
production stays as before (`migration.agent-production`). The health
sampler keeps a finding open while the live role no longer matches the
declaration (`execution_role_exception_drift`,
[`health.md` §3](../10-observability/health.md)). The target state is a
dedicated definer role, so the execution role can drop `BYPASSRLS` and the
declaration can be revoked (ADR-0034 §7).

The declaration is checked continuously (drift kind E). **[OBSERVED]** REOSA's
current self-hosting plan makes the application login role `reosa_app` the owner
of the restored tables and does not give it `BYPASSRLS`; combined with 82
`FORCE ROW LEVEL SECURITY` tables that are read through the "service connection",
this would turn errors into empty results after the move (REOSA audits). ExponetDB
cannot decide REOSA's role model, but it makes the dependency explicit and its
cutover checks fail when the declared semantics are not reproduced
([`../13-integrations/reosa-integration.md`](../13-integrations/reosa-integration.md)).

## 4. Consumer roles as cluster desired state

**[DECIDED]** Roles, role attributes, memberships, role settings and login
credentials of consumers are **cluster-level desired state**, managed through the
node capability `postgres.roles.plan` / `postgres.roles.apply`, not through
migrations.

Why not in migrations:

- Roles are **cluster-wide**. On `reos-db-01`, staging and production share one
  cluster. A role created by a "staging" migration exists for production
  immediately, which defeats staging-first evidence.
- `CREATE ROLE` needs `CREATEROLE` (or superuser), which the migrator must not
  have.
- **[OBSERVED]** REOSA splits role management across a bootstrap file, nine
  `CREATE ROLE` statements in seven migrations (all inside `DO … EXCEPTION`
  guards), owner-created login roles with passwords, and an `ALTER ROLE postgres
  SET …` inside migration `0265`; one role (`agent_role_admin`) is referenced
  conditionally but never created, so policies exist on some databases and not
  on others.

The desired state is declared per cluster in a role manifest
(`exponetdb.roles.yaml`, schema `exponetdb.roles/v1`), submitted like a bundle and
stored with digests:

```yaml
schema: exponetdb.roles/v1
cluster: reos-db-01/postgres-main          # informative; the registry binds it
roles:
  - name: reosa_owner
    login: false
    attributes: { inherit: true }
  - name: authenticated
    login: false
    attributes: { inherit: false }
  - name: service_role
    login: false
    attributes: { inherit: false, bypassrls: true }
  - name: reosa_app
    login: true
    password: { scramVerifierRef: consumer-supplied }   # verifier submitted out of band, never a password
    memberOf:
      - { role: authenticated, inherit: false, set: true }
      - { role: service_role,  inherit: false, set: true }
    settings:
      - { name: idle_in_transaction_session_timeout, value: "60s" }
      - { name: statement_timeout, value: "120s", database: reosa_production }
```

`postgres.roles.plan` diffs this against the cluster fingerprint (roles,
attributes, memberships with `admin/inherit/set` options, `pg_db_role_setting`),
classifies each change (attribute escalation such as `BYPASSRLS` or `SUPERUSER`
is `critical`), and produces a plan. The cluster's tier is the highest tier of
its databases, so on `reos-db-01` every role change is a production change.

**Login role passwords.** The consumer computes a SCRAM-SHA-256 verifier locally
(`exponetdb secrets scram-verifier`, or any compliant tool) and submits only the
verifier through a dedicated, write-only endpoint. The agent applies it with
`ALTER ROLE … PASSWORD '<verifier>'`; PostgreSQL stores verifiers as-is. The
plaintext stays with the consumer's deployment configuration (for REOSA, Coolify
environment variables). ExponetDB stores the verifier only as long as needed to
apply and audit its digest. **[DECIDED]** Plaintext passwords are rejected by
the role manifest schema.

### 4.1 Role verifiers (Wave 8, owner decision S3)

**[DECIDED]** (owner decision S3, 2026-10-13; **[OBSERVED]**
`packages/nodes/src/role-verifiers.ts`, `capability-plans.ts`
`planRoleVerifierSet`, `capability-kinds.ts` `RoleVerifierSetKind`; bundle
`01M4V3RV9F5XM2TB8KC6QZJ0NS_role-verifiers`) The dedicated write-only
endpoint of §4 is `POST /api/v1/clusters/{clusterId}/role-verifiers`
(action `postgres.roles.verifier.plan`), and a role's verifier is set by
the operation kind `postgres.roles.verifier.set`:

- **What is submitted.** Only a SCRAM-SHA-256 verifier
  (`SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>`, base64, at
  least 4096 iterations, a salt of 16 to 64 bytes, keys of 32 bytes; the
  format PostgreSQL stores and `psql \password` computes), never a
  password: principle 4 of §1 holds, ExponetDB never learns a consumer
  password. A body with a `password` field is refused like any unknown
  field; a validation error names the field and never echoes its value.
  Who computes the verifier: the consumer (any compliant tool) or, in the
  Web App, the browser from the password the person types (PBKDF2, HMAC and
  SHA-256 of WebCrypto), over the same-origin session; the password never
  leaves the browser **[PLANNED]** (the form is Web App work of Wave 8).
  **[OBSERVED]** (`apps/web/src/features/infrastructure/cluster-roles.tsx`
  `planRoleVerifier`, `apps/web/test/infrastructure/clusters.test.tsx`) The
  form says "could not compute the verifier, nothing was sent" only when the
  derivation itself fails; a failure of the request (a network failure
  included) is reported through the normal error path as a request failure.
  `exponetdb secrets scram-verifier` stays **[PLANNED]**; the route's
  client kind is `web` only (re-authentication, like the credential
  submission of §5), so the CLI does not submit verifiers.
- **Who.** `nodes.operate` (like `postgres.roles.apply`: a consumer role's
  login credential is cluster desired state, §4), tiered
  `nodes.operate:<tier>` with the cluster's derived tier
  (`subject_max`), human only, re-authentication when the verifier is
  submitted and again when the plan is applied. On a production (or
  unknown-tier) cluster the operation waits for a human approval
  (`node.prod-apply-approval`, version 2). The REST resources table first
  named `registry.manage` for this route (Wave 0 placeholder); the
  roles capability's permission governs.
- **Storage.** `serve` seals the verifier at once with the existing `se1`
  envelope (`packages/secrets` `seal`; secret AAD: a fresh `sec_…` context
  id, purpose `pg_role_verifier`, subject `<cluster id>/<rvf_… id>`,
  version 1) into `role_verifiers.verifiers` (a schema of its own: only
  `serve` and the worker have `USAGE`). `serve` may insert a row, read its
  metadata (id, cluster, role, state, times, operation) and clear a
  submitted one, but has no `SELECT` on any sealed column; the worker
  reads the sealed columns. A new submission for the same role of the
  cluster supersedes the submitted one (`superseded`, cleared). The guard
  lets a row move once, from `submitted` to `consumed` (naming its
  operation) or `superseded`, and only by clearing every sealed column;
  rows are never deleted. No route, view, export or MCP tool reads a
  verifier back. The verifier is stored only until it is handed to the
  node (§4): an operation that then does not run needs a new submission.
- **Plan.** Made by `serve` from a node-signed `postgres.roles.inspect`
  observation at most 10 minutes old: the role must exist and be no
  superuser (`REGISTRY_CONFLICT` `role_missing`, `role_superuser`); a
  predefined (`pg_…`) or ExponetDB role is refused by the contract. The
  content (and so the plan hash) names the cluster's mapping, the role
  and the verifier's `rvf_…` id; the expected state binds the node, the
  mapping and the `rolesDigest`; nothing of the verifier is in the plan.
  Acceptance and the worker's dispatch admission check that the stored
  verifier is still `submitted` for this cluster and role (binding
  `roleVerifier`, `PLAN_STALE`), besides the mapping.
- **Apply.** The worker reads the roles again (a different `rolesDigest`
  is `PLAN_STALE` before anything is sent); then, in one transaction that
  holds the operation's lease and re-admits it, it opens the verifier,
  creates the `postgres.roles.apply@2` job with one `set_password` step
  whose verifier is sealed for the node (`ns1`), clears the stored row
  (`consumed`) and writes the audit event. The agent applies it with
  statement and duration logging, sampling, parameter logging, `pgaudit`
  and `auto_explain` logging off for its session, and the verifier only as
  a session value read by `ALTER ROLE … PASSWORD` (capabilities.md), so the
  verifier is not in a statement's text, `pg_stat_statements` or the server
  log.
- **Verify.** See [`../07-node-agent/control-plane.md` §9.6](../07-node-agent/control-plane.md#96-verification-by-kind):
  the role shows a SCRAM-SHA-256 verifier and the apply job's signed
  statement says the step committed. **[ASSUMPTION]** No capability reads a
  verifier back (capabilities.md §6), so which verifier the host holds is
  proven by the agent's signed statement, not by a read; a host-side
  comparison of a keyed digest would need a new capability major
  (`postgres.roles.inspect@3`), which is not built.
- **Audit.** `role_verifier.submitted` (the person; cluster, role, verifier
  id, plan id, the superseded ids) and `role_verifier.consumed` (the
  worker; cluster, role, verifier id, operation, plan and job ids), and the
  operation's own events. Never the verifier, never a password.
- `postgres.roles.apply` keeps refusing `set_password` in a plan; its
  validation message names this route.

## 5. ExponetDB's own credentials: lifecycle

**[DECIDED]**

| Step | How |
|---|---|
| Generate | 32 random bytes from the OS CSPRNG, base64url. Generated in the Control Plane worker. |
| Derive | SCRAM-SHA-256 verifier computed in the Control Plane (4096 iterations minimum, salt 16 bytes). |
| Install | Agent-managed cluster: `postgres.roles.apply` via the node agent with the **verifier only**; the agent never receives the plaintext. External cluster: the Web App shows a one-time SQL snippet containing only the verifier for a human to run with the provider's admin tools. |
| Store | Plaintext encrypted at rest in the secret store (envelope encryption, AAD bound to credential id, cluster and role; see secrets.md). Verifier not stored after install. |
| Verify | Test login with the new secret over the selected endpoint (TLS `verify-full`), record `last_verified_at`. |
| Activate | Mark the new version `active`, previous version `retired`. Connection pools drain and reconnect. |
| Rotate | Scheduled (default every 90 days), on demand, and on any suspicion. A rotation is an operation (`credential.rotate`, class `high`). Because ExponetDB is the only user of its roles, single-password rotation is sufficient: existing sessions remain valid after `ALTER ROLE … PASSWORD`, new sessions use the new password. |
| Revoke | `ALTER ROLE … PASSWORD NULL` + `NOLOGIN` via capability; credential `revoked`. |

**[DECIDED]** (Wave 4, external clusters; G4 record) Until the node agent can
install verifiers (Wave 5), the person chooses each password: the bootstrap
SQL contains no password, the person sets it with psql's `\password` (psql
sends a client-side SCRAM verifier) and submits the same password once
through the write-only endpoint (`POST /clusters/{id}/credentials/{role}`,
Web App only, re-authentication). `serve` encrypts it at once (`se1`, the
observer's for `serve`, every other role's for the worker) and stores a
`pending` credential; the worker verifies it (login over `verify-full`,
the role's attributes and memberships) and activates it, retiring the
previous one, or marks it `failed` with a code; a new submission
supersedes a pending one. **[DECIDED]** (Wave 6) The Web App's form for it
is the credentials page (`/credentials#cluster=…&role=…`,
[`information-architecture.md`](../11-ui/information-architecture.md));
the CLI never reads or sends the password: `exponetdb cluster credential
submit <cluster> <role>` opens that page and waits until the credential is
active or failed. The client kinds of `registry.credential.submit` stay
`web` only. Generation by ExponetDB, scheduled rotation and
`credential.rotate` are **[PLANNED]** with the node agent.

Rotation interval rationale: the roles are reachable only over a private network
with TLS and `pg_hba` source restrictions; the main risk is secret disclosure from
the Control Store, which rotation limits in time. 90 days balances that against
operational churn; the interval is configurable down to 1 day.

## 6. TLS to managed clusters

**[DECIDED]**

- All network connections use `sslmode=verify-full` with the cluster's CA bundle
  and the endpoint's `tls_server_name`. `sslmode=require` is never accepted for
  ExponetDB's own connections.
- **[DECIDED]** (G4 correction, 2026-10-07) A password is given only to a
  SCRAM exchange: a server that asks for it in cleartext or as MD5 receives
  nothing and the session fails with `TARGET_CREDENTIAL_INVALID`
  (`auth_method`); a pending credential then fails with
  `authentication_method`, told apart from a wrong password
  (`authentication_failed`). The cluster identity guards run after authentication,
  so the secret must not depend on them: a server that is not the
  registered cluster but holds a certificate for its name learns no
  password. The same holds for a server that starts SASL and then asks for
  the password in cleartext or as MD5: the driver caches the password after
  the first request, so the session's password is an accessor that hands
  the cached value out only while SCRAM is the only exchange asked for.
  `SCRAM-SHA-256-PLUS` (channel binding) is used whenever the server offers
  it; a pooler that offers only `SCRAM-SHA-256` still works.
  Tests: `session.int.test.ts` "the password goes only into a SCRAM exchange".
- The node agent can issue and rotate PostgreSQL server certificates
  (`postgres.tls.plan` / `postgres.tls.rotate`) from an ExponetDB-managed CA per
  installation **[DECIDED]**
  ([OD-17](../00-product/open-decisions.md#od-17-ca-strategy-for-postgresql-server-certificates),
  resolved 2026-10-07): the server's key is generated on the host and never
  leaves it; the Control Plane signs a CSR. **[DECIDED]** (Wave 5) The request
  is a public key with a proof of possession rather than a PKCS#10 CSR
  ([`capabilities.md` §4](../07-node-agent/capabilities.md#4-contract-wave-5)).
- Certificate expiry is monitored (finding at 30 days, critical at 7 days).
  **[OBSERVED]** REOSA's plan uses an own CA with 825-day server certificates and
  a calendar reminder, noting that an expired certificate "takes the whole
  platform down" (`self-hosting-04-database-and-auth.md`).
- **[OBSERVED]** REOSA's current application connections to the hosted database
  carry no `sslmode` and run in plaintext over the internet
  (`self-hosting-00-stand.md` §4.10); ExponetDB's connection-path diagnostics
  report TLS state per endpoint and per consumer session (`pg_stat_ssl`).

## 7. `pg_hba` and network restrictions

**[DECIDED]** On agent-managed clusters, `pg_hba.conf` is desired state managed by
`postgres.hba.inspect` and planned `postgres.hba.apply` operations. Rules ExponetDB enforces for its own
roles:

- only `hostssl` lines, `scram-sha-256`;
- source restricted to the Control Plane's egress address(es) on the private
  network (for V1: `reos-01`'s private address `10.8.2.2/32`); a planned
  `pg_hba` change keeps ExponetDB's roles reachable from the addresses in
  `EXPONETDB_EGRESS_ADDRESSES` (**[DECIDED]** Wave 5 Phase 5 review,
  [control-plane.md §9.6](../07-node-agent/control-plane.md#96-verification-by-kind));
- `exponetdb_node` only via `local … peer map=exponetdb`.

**[ASSUMPTION]** Containers on `reos-01` reach the private network through the
host's private address (`10.8.2.2`, as-built per REOSA's infrastructure
documents; not measured from a container), so `pg_hba` cannot distinguish
ExponetDB's connections from REOSA's by source address; separation relies on
roles and credentials. Checked when `pg_hba` is configured in Wave 5. Moving ExponetDB to its own
host later (`exponet-01`) makes source restriction meaningful.

## 8. External clusters (no node agent)

For clusters ExponetDB reaches only over the network: a self-managed
cluster without the node agent, or a hosted provider during a migration
period. The walkthrough from `server create` to an active target is
[`onboard-external-cluster.md`](../12-operations/onboard-external-cluster.md).

- ExponetDB's roles are created by a person with the bootstrap SQL that
  ExponetDB generates (§8.1). Some statements may be impossible on a hosted
  service (`BYPASSRLS` and `NOSUPERUSER` need a superuser; `pg_read_all_data`,
  `pg_signal_backend` availability).
- The registry records which paths are available; tools that need an unavailable
  path return `CAPABILITY_UNAVAILABLE` rather than degraded results.
- No role desired state, `pg_hba`, TLS or configuration management (§8.2 is
  guidance for the person who manages them).
- The ledger and migration engine work if the migrator can `SET ROLE` into the
  project's execution roles (§3); the bootstrap SQL grants that where the
  roles are fit. **[ASSUMPTION]** On REOSA's hosted databases the owner is
  the provider's `postgres` role, which a new role can be granted membership in;
  to be verified before any migration runs there through ExponetDB
  ([OD-7](../00-product/open-decisions.md#od-7-manage-reosas-current-hosted-databases-before-the-move)).
- **[OBSERVED]** `cluster register` always creates an **external** cluster
  (`packages/registry/src/kinds.ts`, the cluster insert), and the
  management mode of a cluster record never changes (a Control Store
  trigger of the Wave 4 registry bundle); every node capability on an
  external cluster is `CAPABILITY_UNAVAILABLE`
  (`packages/nodes/src/mapping.ts`). How a cluster registered external
  later gains the node agent is **[OPEN: OD-54]**
  ([open-decisions.md](../00-product/open-decisions.md#od-54-how-an-external-cluster-gains-the-node-agent)).

### 8.1 Bootstrap SQL

**[DECIDED]** (Wave 4; idempotent and registry-driven since Wave 9 order A8)
`GET /api/v1/clusters/{id}/bootstrap-sql`
(`exponetdb cluster bootstrap-sql <cluster>`) returns a script for psql,
generated by the server for this cluster
(`packages/postgres/src/bootstrap.ts`, `packages/registry/src/bootstrap.ts`).
It contains no password: after it ran, the person sets each login password
with psql's `\password <role>` (psql sends a SCRAM verifier, never the
password; `password_encryption = scram-sha-256`, the default) and submits the
same password once through the write-only credential endpoint (§5). In
order:

1. **ExponetDB's roles** (§2): each one created when missing and altered to
   the same attributes otherwise (`DO` blocks that check `pg_roles`; an
   existing password stays), then their predefined-role memberships
   `WITH INHERIT TRUE, SET FALSE`, their role settings, and the ledger owner
   granted to the migrator `WITH INHERIT FALSE, SET TRUE`.
2. **Execution roles** from the registry: every role the aliases of a
   project resolve to (the project's map, refined per environment, §3.1)
   for each environment with a target placed on this cluster, plus the
   environments of a project named in the request (`project`, optionally
   one `environment`: the script is run before that project's first target
   is registered; the caller must also be allowed
   `project.execution_roles.get` on it). Each is granted to the migrator
   `WITH INHERIT FALSE, SET TRUE` only if it exists and passes the
   planner's own checks, evaluated in the administrator's session when the
   script runs: not `LOGIN`, none of `SUPERUSER`, `CREATEROLE`, `CREATEDB`,
   `REPLICATION`, no `BYPASSRLS` unless a declared exception (§3.2) excuses
   it in an environment on this cluster, and no reach into a privileged,
   predefined or ExponetDB role. A missing role is skipped with a
   `NOTICE`, an unfit one with a `WARNING`; neither is granted. Predefined
   and ExponetDB names are refused when the script is built. The planner
   checks the role again at plan and apply in any case (T36 in the
   [threat model](../08-auth-and-security/threat-model.md)).
3. **Each database**: the registered ones and the names given with
   `database` (repeatable; the script can be generated **before** a
   database is registered): `CONNECT` for every login role and `CREATE` for
   the ledger owner, in a `DO` block that skips a database that does not
   exist yet with a `NOTICE`.
4. **Legacy ledger read** (only with `ledgers`): psql connects to each
   database (`\connect -reuse-previous=on` with a conninfo holding only
   `dbname`, single-quoted, so a name is never read as a host, a variable
   or a backquote command) and grants the observer `USAGE` on the ledger's
   schema and `SELECT` on the ledger table, where it exists:
   `supabase_migrations.schema_migrations`, `drizzle.__drizzle_migrations`,
   `public.applied_migrations` ([legacy-import.md §2](../04-migrations/legacy-import.md)).
   Nothing else is readable to the observer.

Every statement is guarded or converges (a role grant run again converges
to the stated options on PostgreSQL 16+), so the script is **run again**
after a database is added, an execution role is created or mapped, or a
legacy ledger is declared, and leaves the same state. It does not remove
what a person granted by hand beyond it (an extra membership or
attribute); the planner's checks refuse an execution role that gained one.
**[OBSERVED]** `packages/registry/test/bootstrap.int.test.ts` runs the
generated script with psql twice on PostgreSQL 16, 17 and 18: no error, the
same roles, memberships, settings and privileges after the second run; the
migrator holds `SET` without `INHERIT` on the fit roles only (a `LOGIN` role
and one reaching `pg_read_all_data` get a warning, a missing one a notice,
the `BYPASSRLS` role with a declared exception is granted); a role created
later is granted on the next run; the observer reads the declared ledger.
The test servers are shared, so the run uses the test kit's connection
limit in place of the product's (the unit tests pin those).

### 8.2 `pg_hba` and network for an external cluster

**[DECIDED]** guidance (ExponetDB does not manage these on an external
cluster; it reports TLS state per endpoint): the same rules as §7, set by
the person who manages the cluster.

- Only `hostssl` lines for ExponetDB's roles, with `scram-sha-256`; never
  `host`, `trust`, `password` or `md5` for them. ExponetDB never sends a
  password to a server that asks for it in cleartext or as MD5 (§6).
- The source of those lines is the address or addresses the Control Plane
  connects from: the worker and `serve`, the values of
  `EXPONETDB_EGRESS_ADDRESSES` ([deployment.md](../12-operations/deployment.md)).
  The databases are `postgres` (cluster identity and credential checks
  before a database is registered connect there) and the managed
  databases. Example for a Control Plane at `10.8.2.2`:

  ```text
  # ExponetDB: TLS and SCRAM only, from the Control Plane only
  hostssl  postgres,app  exponetdb_observer,exponetdb_reader,exponetdb_verifier,exponetdb_operator,exponetdb_migrator  10.8.2.2/32  scram-sha-256
  ```

- The firewall of the host allows the PostgreSQL port from those addresses
  only. The server certificate's name is the endpoint's TLS name, issued by
  the CA bundle given at `cluster register` (§6); ExponetDB connects with
  `verify-full` only.
- `max_connections` leaves room for ExponetDB's budget (serve at most 3, the
  worker at most 5 per cluster; the role connection limits of §2).

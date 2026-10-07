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
not, or whose memberships differ from the list (`role_attributes`).
`pg_use_reserved_connections` stays **[PLANNED]** for agent-managed clusters.

## 3. Execution roles (who owns application objects)

Migrations run as the project's **execution role**, the role that owns the
application's objects (for example `reosa_owner`). It is a `NOLOGIN` role. The
migrator switches into it with `SET LOCAL ROLE` inside the migration transaction.

**[DECIDED]** ExponetDB requires each project to declare, per target:

| Declaration | Example (proposed for REOSA on `reos-db-01`) |
|---|---|
| execution role(s) and their aliases | `owner → reosa_owner` |
| application login roles and what they may do | `reosa_app` (LOGIN, member of `authenticated`, `service_role`, …), `website_renderer_login`, `consent_writer_login`, `sales_login` |
| whether any login role relies on owning objects or on `BYPASSRLS` | REOSA today relies on its login role (`postgres` on the hosted provider) bypassing RLS for console and maintenance paths |
| protected and foreign-owned schemas | `auth` (owned by the auth service role), excluded from migrations |

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
supersedes a pending one. Generation by ExponetDB, scheduled rotation and
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
  network (for V1: `reos-01`'s private address `10.8.2.2/32`);
- `exponetdb_node` only via `local … peer map=exponetdb`.

**[ASSUMPTION]** Containers on `reos-01` reach the private network through the
host's private address (`10.8.2.2`, as-built per REOSA's infrastructure
documents; not measured from a container), so `pg_hba` cannot distinguish
ExponetDB's connections from REOSA's by source address; separation relies on
roles and credentials. Checked when `pg_hba` is configured in Wave 5. Moving ExponetDB to its own
host later (`exponet-01`) makes source restriction meaningful.

## 8. External clusters (no node agent)

For clusters ExponetDB reaches only over the network (for example a hosted
provider during a migration period):

- ExponetDB's roles are created by a human with SQL that ExponetDB generates
  (verifiers only). Some grants may be impossible on a hosted service
  (`pg_read_all_data`, `pg_signal_backend` availability, `BYPASSRLS` restrictions).
- The registry records which paths are available; tools that need an unavailable
  path return `CAPABILITY_UNAVAILABLE` rather than degraded results.
- No role desired-state, `pg_hba`, TLS or configuration management.
- The ledger and migration engine work if the migrator can be a member of the
  object owner role. **[ASSUMPTION]** On REOSA's hosted databases the owner is
  the provider's `postgres` role, which a new role can be granted membership in;
  to be verified in Wave 10 before any migration runs there through ExponetDB
  ([OD-7](../00-product/open-decisions.md#od-7-manage-reosas-current-hosted-databases-before-the-move)).

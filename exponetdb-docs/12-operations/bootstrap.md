# Bootstrap: from nothing to the first managed target

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
| Applies to | Wave 2 (Control Store, installation marker, keyring), Wave 3A (first owner: bootstrap command, setup link and first login), Wave 3B (first OAuth client), Wave 4 (first target), Wave 5 (first node) |
| Read before | [`deployment.md`](./deployment.md), [`../02-control-plane/control-database.md`](../02-control-plane/control-database.md), [`../07-node-agent/enrollment.md`](../07-node-agent/enrollment.md) |

ExponetDB must not assume that it already exists. This document answers, in
order: how the Control Store starts, how the first person gets in, how the
first database is registered, how the first node is enrolled, how the first
OAuth client is set up, and how credentials are rotated.

## 1. Before ExponetDB exists

The first databases ExponetDB manages (REOSA's) already exist and have a history
of migrations applied by REOSA's own tooling. Until ExponetDB takes over:

- REOSA keeps applying migrations with its current flow; ExponetDB does not
  touch REOSA databases before Wave 10 (read-only first, then legacy import,
  [`../04-migrations/legacy-import.md`](../04-migrations/legacy-import.md),
  [`../13-integrations/reosa-integration.md`](../13-integrations/reosa-integration.md)).
  Waves 4 to 9 work against test databases.
- The database host `reos-db-01` is prepared with REOSA's handbook (PostgreSQL
  from PGDG, private network, TLS). ExponetDB's agent is installed **after**
  that, on a working host; it does not provision hosts.
- The Control Store is not managed by ExponetDB, ever, in V1
  ([`../02-control-plane/control-database.md` §6](../02-control-plane/control-database.md#6-self-management-boundary)).

## 2. Control Store

1. Create the Coolify PostgreSQL resource `exponetdb-control` (PostgreSQL 17)
   on `reos-01`; not published.
2. As its superuser (only during bootstrap, inside Coolify's network), run the
   generated bootstrap SQL that creates the database `exponetdb_control`, the
   owner role `exdb_migrate` and the process roles `exdb_serve`, `exdb_worker`,
   `exdb_gateway`, `exdb_audit_maint` with SCRAM passwords generated locally.
   The superuser password stays in Coolify and is not given to ExponetDB.
3. Generate the keyring (`exponetdb keyring generate`, run locally or in a
   one-off container); store it as a Coolify secret for the ExponetDB resources
   and write the offline copy.
4. Deploy the `worker` resource once with the command
   `exponetdb control-store migrate`: the bootstrap runner applies the Control
   Store's own bundles, verifies them, and writes the installation marker with a
   new `installation_id`.
5. Deploy `serve`, `worker`, `gateway`. Readiness confirms schema version and
   keys.

## 3. First owner

**[PLANNED] Wave 3A.** The first-owner bootstrap belongs to the identity
foundation, together with identities, credentials, setup tokens and login.
**[DECIDED]** (2026-10-05, with the authorization of Wave 2) Wave 2 creates no
owner record and no auth-owned table: a record without a credential, a setup
token or a login would be half an identity system, and the command's
"only while no identity exists" rule needs the identities table that Wave 3A
owns. Wave 2 ends with a running, ready Control Plane that nobody can log in
to and that exposes no management API.

1. Inside the `serve` container: `exponetdb bootstrap owner --email <address>`.
   The command works **only while no identity exists**; afterwards it refuses.
2. It prints a single-use setup link, valid 30 minutes.
3. The owner opens the link, sets a password, registers a passkey (required)
   and a TOTP as backup factor.
4. Audit records `bootstrap.owner_created` with the container host and time.
5. The owner invites further people from the Web App; there is no self-signup.

Recovery of a lost last owner: [`../08-auth-and-security/identity.md` §6](../08-auth-and-security/identity.md#6-bootstrap-and-recovery-of-the-first-owner).

## 4. Agent root CA ceremony

1. Run `exponetdb ca init-root` on an offline or trusted machine (owner's
   workstation), producing the root key and certificate.
2. Issue the online issuing CA (`exponetdb ca issue-intermediate`), import its
   key encrypted into the Control Store (`registry.manage`, re-auth) and its
   chain into the gateway configuration.
3. Store the root key offline (two copies); delete it from the machine used.
4. The root certificate fingerprint is shown in the Web App; enrollment tokens
   embed it ([`../07-node-agent/enrollment.md`](../07-node-agent/enrollment.md)).

## 5. First registry entries and the first target

The steps use REOSA's structure as the example. In Waves 4 to 9 the same steps
register test databases; REOSA's real targets follow in Wave 10 (current hosted
databases, as external clusters) and Wave 11 (on `reos-db-01`).

1. Web App → Settings: create product `reosa`, environments `staging` (nonprod)
   and `production` (prod, `evidence_from = staging`), project `platform`.
2. Infrastructure: create server `reos-db-01` (provider Hetzner Cloud), cluster
   (PostgreSQL 17, endpoint `10.8.1.2:5432`, TLS mode `verify-full`, CA bundle).
3. Credentials: on the database host, create ExponetDB's PostgreSQL roles
   (`exponetdb_observer`, `exponetdb_reader`, `exponetdb_verifier`,
   `exponetdb_operator`, `exponetdb_migrator`, `exponetdb_ledger_owner`) with the
   generated SQL script
   from the Web App (the script contains SCRAM verifiers, never passwords;
   [`../03-database-model/credentials-and-roles.md`](../03-database-model/credentials-and-roles.md)).
   This one-time step uses the local superuser on the host because the agent
   is not enrolled yet. After Wave 5 the same roles are maintained by
   `postgres.roles.apply`.
4. Register targets `reosa/platform/staging` and `reosa/platform/production`
   with their databases. Registration probes the endpoint with the observer
   role, checks the database does not carry an ExponetDB installation marker
   (not the Control Store, not another installation). The `target.register`
   operation then creates the `exponetdb` schema (owned by
   `exponetdb_ledger_owner`), stamps the identity marker and initializes the
   ledger; it is a planned operation that needs the owner's approval for the
   production target ([`../04-migrations/ledger.md` §4](../04-migrations/ledger.md#4-lifecycle-of-the-exponetdb-schema-in-a-target)).
5. Targets start in `registered`; they become `active` once the identity marker
   is stamped and the credentials are verified (registry rule); the first health
   sample and fingerprint follow immediately.

## 6. First node

1. Web App → Infrastructure → `reos-db-01` → "Enroll node": creates an
   enrollment token (shown once, 30 minutes, single use, includes gateway
   address and root fingerprint).
2. On the host: install the agent package, run
   `exponetdb-node enroll --token <token>`: the agent generates its key on the
   host, sends a CSR, verifies the gateway against the pinned root, stores its
   72-hour certificate.
3. Start the systemd units; the node appears `active` with its capabilities.
4. Attach the node to the cluster (registry operation) so cluster-level
   capabilities route to it.

## 7. First OAuth and MCP clients

- At bootstrap, the CIMD allowlist is pre-filled with the known client metadata
  URLs of supported MCP clients ([`../05-mcp/oauth.md`](../05-mcp/oauth.md)); the
  owner can edit it.
- The first-party clients (Web App session, `exponetdb` CLI) are created by the
  Control Store bootstrap migrations as fixed client records.
- A person connects an MCP client by adding `https://db.exponet.cloud/mcp` in
  the client; the OAuth flow (PKCE, consent with scopes and target/tier
  restrictions) creates the grant. Dynamic client registration requests from
  unknown clients wait for admin approval
  ([OD-5](../00-product/open-decisions.md#od-5-mcp-client-registration-policy)).
- Service accounts for CI (`private_key_jwt`) are created by an admin and bound
  to nonprod scopes by default.

## 8. Credential rotation

| Credential | How |
|---|---|
| ExponetDB's PostgreSQL roles on managed clusters | `credential.rotate`: new SCRAM verifier applied via `postgres.roles.apply` (node); single-password rotation (existing sessions stay valid, new sessions use the new password); new secret version activated after a verified test login ([`../03-database-model/credentials-and-roles.md` §5](../03-database-model/credentials-and-roles.md#5-exponetdbs-own-credentials-lifecycle)) |
| Control Store process-role passwords | rotate in Coolify and in the Control Store (`ALTER ROLE … PASSWORD` with a verifier, executed by `exdb_migrate` in a maintenance job), redeploy |
| Keyring | add new active key, re-wrap job, retire old key ([`../08-auth-and-security/secrets.md` §3](../08-auth-and-security/secrets.md#3-rotation)) |
| Issuing CA | new intermediate from the offline root (ceremony §4), overlap |
| Job-signing key | signed `config.update` announcing the new key, overlap 7 days |
| Agent client certificates | automatic renewal at 48 h of 72 h |
| Enrollment tokens | single-use, 30 minutes; nothing to rotate |
| OAuth refresh tokens | rotate on every use; reuse revokes the grant |

## 9. Bootstrap checklist (completed step by step from Wave 2 to Wave 7)

- [ ] (Wave 2) Control Store created; superuser not configured in any ExponetDB resource
- [ ] (Wave 2) Keyring generated; offline copy verified by a test decryption
- [ ] (Wave 3A) First owner with passkey and TOTP; bootstrap command refuses a second run
- [ ] (Wave 5) Root CA offline; issuing CA online; fingerprints recorded
- [ ] (Wave 4) Two test targets registered and `active`; identity markers stamped
- [ ] (Wave 5) Node enrolled; capabilities listed; certificate renewal observed once
- [ ] (Wave 7) First MCP client connected with nonprod-only grant; consent screen shows tiers
- [ ] (Wave 5) Rotation of one PostgreSQL credential executed end to end

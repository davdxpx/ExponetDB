# Bootstrap: from nothing to the first managed target

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05; G2 and G3A accepted; first rollout running 2026-10-06, owner invitation pending and off-host prerequisites open ([record](./deployments/2026-10-06-reos-01.md)) |
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
4. Run `exponetdb control-store migrate` once as its own one-shot resource
   with the `exdb_migrate` login: the bootstrap runner applies the Control
   Store's own bundles, verifies them, and writes the installation marker with a
   new `installation_id`. **[DECIDED]** (Wave 2) Not a step of the `worker`
   resource, so the worker never holds the DDL credential
   ([`deployment.md` §3](./deployment.md#3-startup-and-readiness)). Step by
   step: [`control-store-runbook.md`](./control-store-runbook.md).
5. Deploy `serve`, `worker`, `gateway`. Readiness confirms schema version and
   keys.

## 3. First owner

**[DECIDED]** (2026-10-05, with the authorization of Wave 2) Wave 2 creates no
owner record and no auth-owned table: a record without a credential, a setup
token or a login would be half an identity system. The first-owner bootstrap
belongs to Wave 3A.

**[OBSERVED]** (Wave 3A, implemented; G3A accepted 2026-10-06;
`packages/auth/src/operator.ts`, `apps/server/src/commands/`.)

**[OBSERVED]** (first rollout) Operator commands need a minimal command
environment. Do not pass the full `serve` environment to `bootstrap owner`:
its allowed settings are the `exdb_serve` Control Store URL, public origin,
optional WebAuthn RP ID and log settings. Runtime role, installation,
listener, trusted-proxy and keyring settings are deliberately rejected.
The prepared invitation is not an active identity; activation still waits
for the deployment prerequisites below.

1. Inside the `serve` container (or a one-off container of the same image)
   with `EXPONETDB_CONTROL_STORE_URL` of the `exdb_serve` login and
   `EXPONETDB_PUBLIC_URL` (optionally `EXPONETDB_WEBAUTHN_RP_ID`):
   `exponetdb bootstrap owner --email <address> [--display-name <name>]`.
   The command works **only while no owner exists**; afterwards it refuses
   (`refused (bootstrap_closed)`, exit 2).
2. It prints JSON with a single-use setup link
   (`https://db.exponet.cloud/setup#token=…`, the secret in the fragment),
   valid 30 minutes, to standard output only; it is never logged. While the
   first owner is pending, a second run refuses (`bootstrap_pending`) unless
   `--reissue` is given;
   a re-issue invalidates the previous link and may correct the address
   (there is never a second first-owner identity).
3. The owner opens the link in a browser on the public origin. The page
   removes the token from the address bar at once, then the owner registers
   a passkey (user verification required), sets a password (at least 14
   characters, not a common password) and confirms an authenticator app
   (TOTP). Nothing is active until all three are set; completing activates
   them together, makes the identity the owner through the Control Store
   function that re-checks every precondition under the owner lock, signs
   the owner in and shows ten recovery codes once.
4. Audit records `auth.bootstrap.owner_invited` (and
   `auth.bootstrap.reissue`) with the actor `system:maintenance`, then
   `auth.enrollment.redeem`, `auth.bootstrap.owner_activated` and
   `auth.enrollment.complete`.
5. The owner invites further people from the Web App or `POST
   /api/v1/identities`; there is no self-signup. An invited person gets no
   role until an owner or admin plans and applies a role binding.

Recovery of a lost last owner: `exponetdb auth recover-owner --email
<address> --reason-file <file>` with the same environment, a written reason
of 20 to 1000 characters; it ends every session of that owner, prints a
single-use recovery link (30 minutes) and is audited as
`auth.out_of_band_recovery_used`
([`../08-auth-and-security/identity.md` §6 and §9](../08-auth-and-security/identity.md#6-bootstrap-and-recovery-of-the-first-owner)).

**[DECIDED]** (Wave 3A) Before real production logins on
`db.exponet.cloud`, the G2 deployment evidence (`reos-01`, Coolify, Traefik)
must be closed and `EXPONETDB_TRUSTED_PROXIES` set to the proxy network, so
rate limits see the client address.

**[DECIDED]** (owner instruction, 2026-10-07) The owner chose temporary local
storage and requested initial access. This authorizes first-owner enrollment
in local bootstrap mode while off-host audit and backup evidence remains
open. The measured proxy setting remains required. This limited operational
exception does not accept G2 off-host evidence or authorize real managed
targets; revisit it before real managed targets are registered.

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

- **[DECIDED]** ([OD-5](../00-product/open-decisions.md#od-5-mcp-client-registration-policy),
  resolved 2026-10-06) No third-party client is trusted at bootstrap. A CIMD
  client becomes usable only after an admin approves its exact `client_id`
  URL ([`../05-mcp/oauth.md`](../05-mcp/oauth.md)).
- The first-party clients (Web App session, `exponetdb` CLI with the client id
  `exponetdb-cli`) are created by the Control Store bootstrap migrations as
  fixed client records.
- **[DECIDED]** (Wave 3B) The first CLI sign-in after the first owner exists:
  `exponetdb login --server https://db.exponet.cloud` (loopback authorization
  code with PKCE; `--device` for a machine without a browser). Consent starts
  at non-production; production is an explicit opt-in.
- A person connects an MCP client by adding `https://db.exponet.cloud/mcp` in
  the client; the OAuth flow (PKCE, consent with scopes and target/tier
  restrictions) creates the grant. Dynamic client registration requests from
  unknown clients wait for admin approval
  ([OD-5](../00-product/open-decisions.md#od-5-mcp-client-registration-policy), resolved);
  a CIMD client is added by an admin with its exact `client_id` URL under
  Administration → OAuth clients and approved by its metadata fingerprint.
  In Wave 3B no MCP server answers at `/mcp` yet (Wave 7); its protected
  resource metadata is published so clients can discover the authorization
  server.
- Service accounts for CI (`private_key_jwt`) are created by an admin under
  Administration → Service accounts: no role and no credential at first; an
  admin registers the public keys, grants scopes (non-production preselected)
  and assigns a role through the access plans.

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
| Service-account client keys (Wave 3B) | register the new public key next to the old one (at most four), switch the service to it, remove the old one; replacing the keys keeps the grant |
| API keys (Wave 3B) | create a new key, switch the consumer, revoke the old key; every key expires (default 90 days, at most 365) |

## 9. Bootstrap checklist (completed step by step from Wave 2 to Wave 7)

- [ ] (Wave 2) Control Store created; superuser not configured in any ExponetDB resource
- [ ] (Wave 2) Keyring generated; offline copy verified by a test decryption
- [ ] (Wave 3A) First owner with passkey and TOTP; bootstrap command refuses a second run
- [ ] (Wave 3B) First CLI sign-in with the first-party client (loopback or device flow); consent preselects non-production only; `exponetdb logout` revokes the grant
- [ ] (Wave 5) Root CA offline; issuing CA online; fingerprints recorded
- [ ] (Wave 4) Two test targets registered and `active`; identity markers stamped
- [ ] (Wave 5) Node enrolled; capabilities listed; certificate renewal observed once
- [ ] (Wave 7) First MCP client connected with nonprod-only grant; consent screen shows tiers
- [ ] (Wave 5) Rotation of one PostgreSQL credential executed end to end

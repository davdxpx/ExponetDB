# REST resources (`/api/v1`)

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05; shapes are refined in the wave that implements each group |
| Read before | [`architecture.md`](./architecture.md) |

Permissions refer to RBAC permissions; scopes to OAuth scopes
([`../08-auth-and-security/authorization.md`](../08-auth-and-security/authorization.md)).
"Plan" in the last column means the endpoint creates a plan rather than changing
state directly.

## Registry

| Method & path | Purpose | Permission / scope | Notes |
|---|---|---|---|
| `GET /products`, `GET /products/{id}` | products | `targets.read` | |
| `POST /products` | create a product (slug, display name) | `registry.manage` | plan (Wave 4) |
| `GET /products/{id}/environments` | environments with tier, evidence chain and revision | `targets.read` | |
| `POST /products/{id}/environments` | define an environment | `registry.manage` | plan |
| `POST /products/{id}/environments/{env}/change-plans` | change an environment (display name, tier, evidence source, rank) | `registry.manage` | plan; class `high` when tier or evidence source changes; re-authentication; a tier change is refused while a live target uses the environment (Wave 4: a POST that creates a plan replaces the earlier `PATCH`) |
| `GET /projects`, `GET /projects/{id}` | projects (managed scope, evidence override, revision) | `targets.read` | |
| `POST /projects`, `POST /projects/{id}/change-plans` | create/configure a project (managed scope, evidence override); execution role aliases arrive with Wave 6 | `registry.manage` | plan |
| `GET /targets` | list targets (filters: product, project, environment, tier, state) | `targets.read` | grant target restrictions applied: a restricted grant sees only its targets |
| `GET /targets/{id}` | target detail with placement summary (cluster id and name, generation, version; never an address) | `targets.read` | `{id}` = `tgt_…` or URL-encoded path |
| `POST /targets` | register target (project, environment, database) | `registry.manage` | plan (stamps identity, initializes the empty ledger); prod tier: approval and re-authentication (`target.register-prod-approval`) |
| `POST /targets/{id}/suspend`, `POST /targets/{id}/resume` | stop / allow writes | `registry.manage` | plan |
| `POST /targets/{id}/decommission` | retire target | `registry.manage` | plan (`critical`) |
| `GET /servers`, `POST /servers`, `GET /servers/{id}` | servers | read: `nodes.read`; write: `registry.manage` | write: plan |
| `GET /clusters`, `GET /clusters/{id}` | clusters (state, observed facts, tier) | `nodes.read` | |
| `POST /clusters/{id}/confirm` | confirm a cluster (pins `system_identifier`; refuses the Control Store's own cluster) | `registry.manage` | plan; re-authentication |
| `POST /clusters` | register external cluster (CA bundle, endpoints) | `registry.manage` | plan; re-authentication |
| `GET /clusters/{id}/bootstrap-sql` | role bootstrap SQL for a person to run (no password) | `registry.manage` | Wave 4 |
| `GET /clusters/{id}/endpoints`, `POST /clusters/{id}/endpoints` | endpoints | `registry.manage` | addresses visible only to `registry.manage`; POST: plan, re-authentication |
| `POST /clusters/{id}/endpoints/{endpointId}/retire` | retire an endpoint (a changed address is a new endpoint) | `registry.manage` | plan; re-authentication |
| `GET /clusters/{id}/databases`, `POST /clusters/{id}/databases` | databases (external clusters: register an existing database; agent clusters: create via node capability, Wave 5) | `registry.manage` | plan |
| `GET /clusters/{id}/credentials` | credential metadata (role, state, times) | `registry.manage` | never a secret or a secret reference |
| `POST /clusters/{id}/credentials/{role}` | write-only credential submission (external clusters) | `registry.manage` | Web App, re-authentication; `202` with the pending metadata; never readable |
| `POST /clusters/{id}/role-verifiers` | write-only SCRAM verifier submission for consumer login roles | `registry.manage` | Wave 5 (roles capability) |

## Schema and drift

| Method & path | Purpose | Scope |
|---|---|---|
| `GET /targets/{id}/schema` | overview: schemas, object counts, fingerprint | `schema.read` |
| `GET /targets/{id}/schema/objects/{kind}/{qualifiedName}` | object detail | `schema.read` |
| `GET /targets/{id}/schema/search?q=` | search objects | `schema.read` |
| `GET /targets/{id}/schema/fingerprint` | current fingerprint + document reference | `schema.read` |
| `POST /schema-diffs` | diff two targets or fingerprints | `schema.read` |
| `POST /targets/{id}/drift-checks` | run drift check | `schema.read` |
| `GET /targets/{id}/findings` | findings (drift, advisors, health) | `diagnostics.read` |
| `POST /findings/{id}/accept` | `drift.accept` | `schema.manage` (admin) — plan |

## Queries

| Method & path | Purpose | Scope |
|---|---|---|
| `POST /targets/{id}/queries` | run a read-only query | `data.read:<tier>` |
| `POST /targets/{id}/explain` | EXPLAIN / EXPLAIN ANALYZE (read-only) | `data.read:<tier>` |
| `POST /targets/{id}/queries/{queryId}/cancel` | cancel own running query (Wave 7: the caller names the query by the `qry_` id it chose; another caller's query reads as not found) | `data.read:<tier>`, same identity, client and grant as the query |

## Migrations

**[DECIDED]** (Wave 6.) Request bodies that carry bundle text inline are
limited to 32 MiB of JSON, counted while the body arrives and before it is
parsed; every other route keeps 64 KiB. Each file's limit is in UTF-8 bytes
(`migration.yaml` 64 KiB, `up.sql` and `down.sql` 4 MiB, `verify.sql`
512 KiB); at most 50 bundles and 200 migration ids per request. Source
references are stored as claims (`provenance: claimed`, OD-6 (a)); the server
never fetches a repository.

| Method & path | Purpose | Scope |
|---|---|---|
| `POST /projects/{id}/migrations/lint` | lint bundles | `migrations.read` |
| `POST /projects/{id}/bundles` | ingest bundles without planning (validated and hashed again on the server) | `migrations.plan` |
| `GET /projects/{id}/bundles/{migrationId}` | bundle metadata, revisions, earlier never-applied rewrites | `migrations.read` |
| `GET /projects/{id}/bundles/{migrationId}/revisions/{revision}/files/{file}` | exact stored text of one file of a revision | `migrations.read` |
| `GET /projects/{id}/migrations` | stream: DAG, heads, per-target state matrix ("promotion board") | `migrations.read` |
| `GET /targets/{id}/migrations` | ledger (mirror + live check), pending, verification states | `migrations.read` |
| `GET /targets/{id}/migrations/{migrationId}` | ledger row, events, verification runs | `migrations.read` |
| `POST /targets/{id}/migrations/plans` | plan apply of bundles / ids | `migrations.plan` |
| `POST /targets/{id}/migrations/{migrationId}/verifications` | re-run verification (an operation, `202`) | `migrations.apply:<tier>` |
| `POST /targets/{id}/migrations/{migrationId}/rollback-plans` | plan rollback | `migrations.plan` |
| `POST /targets/{id}/migrations/{migrationId}/resume-plans` | plan resuming a non-transactional bundle | `migrations.plan` |
| `POST /targets/{id}/break-glass-grants` | activate break-glass on one target: named overridable rules, a reason (≥ 20 characters), at most 2 h; a Web App session re-authenticated within 120 s; the owners are notified, and without a notification channel the activation is refused (`BREAK_GLASS_UNAVAILABLE`, OD-21) | `breakglass.activate` (human only) |
| `POST /targets/{id}/migrations/import-analyses` | plan a legacy import analysis: replay on an explicit, empty scratch target of the same project, compare, classify into an import report (`migration.import.replay`) | `migrations.import` |
| `GET /targets/{id}/import-reports/{importReportId}`, `POST /targets/{id}/import-reports/{importReportId}/items/{itemId}/decision` | review and resolve import items (a POST that records a decision replaces the earlier `PATCH`) | `migrations.import` |
| `POST /targets/{id}/migrations/baseline-plans` | plan baseline | `migrations.import` |
| `POST /targets/{id}/ledger/reconcile-plans` | plan ledger reconciliation | `migrations.import` |

## CLI step-up (Wave 6, ADR-0026)

| Method & path | Purpose | Who |
|---|---|---|
| `POST /step-ups` | request a step-up for one action of the person's first-party CLI | the person's CLI access token |
| `GET /step-ups/{stepUpId}` | read one's own step-up | the person (CLI or Web App) |
| `POST /step-ups/{stepUpId}/confirm` | confirm with the CLI's code and a fresh re-authentication | the person's Web App session |
| `POST /step-ups/{stepUpId}/cancel` | cancel one's own step-up | the person (CLI or Web App) |

**[DECIDED]** A step-up exists for `plan.apply` (an active plan the person
made through the CLI whose kind or policy needs a fresh proof; otherwise
`CONFLICT`) and for `node.enrollment_token.reveal` (a token this person may
reveal now); anything else is `NOT_FOUND` or `VALIDATION_FAILED`. The
answer to the request carries the `userCode` once; a read never repeats
it. A wrong code counts as an attempt (`VALIDATION_FAILED`); the fifth ends
the step-up (`CONFLICT`), as does a grant revoked meanwhile. The CLI then
repeats the bound request with `ExponetDB-Step-Up: <stu_…>`; a receipt that
is not confirmed, expired, already redeemed or bound to anything else
answers `REAUTH_REQUIRED`. A Web App session never names a receipt
(`VALIDATION_FAILED`). The confirmation page is `/step-up#id=<stu_…>`.

## Plans, approvals, operations

| Method & path | Purpose | Permission / scope |
|---|---|---|
| `GET /plans`, `GET /plans/{id}` | plans, newest first; filters `target`, `kind`, `state`, `actor=self`; cursor pages (the list: Wave 6) | read permission of the kind, or `plans.approve` (Web App session), at a scope covering the subject (OD-26 (c), see below) |
| `POST /plans/{id}/apply` | apply (idempotent); repeating it on an operation that waits after a `critical` self-approval releases it once the cooling period passed and the actor re-authenticated (OD-9, Wave 3A) | kind/tier scope |
| `POST /plans/{id}/withdraw` | withdraw | plan actor |
| `GET /approvals?state=pending` | approval queue: operations awaiting approval (Wave 3A) | `plans.approve` (human) |
| `POST /approvals/{id}/approve`, `POST /approvals/{id}/reject` | decide the plan of the operation `{id}` awaiting approval (requires recent re-auth; body includes `planHash`, the acknowledgement of a self-approval and, from Wave 6 when required, the compatibility attestation) | `plans.approve` (Web App session only) |
| `GET /operations`, `GET /operations/{id}` | operations, newest first; filters `target`, `kind`, `state`, `actor=self`; cursor pages. **[DECIDED]** Wave 6: an operation carries its `steps` (from the driver's events), `waitingFor` (a lock wait), `observedAt`, the monotonic `lastEventId` and the server's `nextAction`; a watcher polls this read (no SSE in V1) | same as `GET /plans/{id}` |
| `GET /operations/{id}/events` | step events **[PLANNED]** (not served in Wave 6: `lastEventId` and `steps` on the operation carry what a watcher needs) | same |
| `POST /operations/{id}/cancel` | cancel an operation that has not started (`awaiting_approval`, `queued`); `OPERATION_NOT_CANCELABLE` otherwise; a running operation is never interrupted (Wave 6) | the actor that applied the plan (same identity and client), with the plan kind's apply permission |
| `POST /operations/{id}/retry-verification` | verify again an operation that needs attention after an applied change whose verification errored or never finished (`needs_attention` to `verifying` by the worker; the change is never run again); `OPERATION_NOT_RETRYABLE` otherwise (Wave 6) | anyone with the plan kind's apply permission on the plan's subject |
| `POST /break-glass-grants` | activate break-glass (human, re-auth, reason, rules, targets, duration) | `breakglass.activate` (Web App/CLI session only) |
| `POST /break-glass-grants/{id}/review` | post-incident review | admin |

**[DECIDED]** Reading a plan or an operation (`read_of_kind`;
[OD-26 (c)](../00-product/open-decisions.md#od-26-who-may-read-a-plan-or-an-operation-read_of_kind),
resolved 2026-10-12). The kind's domain decides the read permission
(`readPermissionOfKind` in `packages/contracts`): `migrations.read` for
`migration.*` and `ledger.*`; `nodes.read` for `node.*`, `postgres.*`,
`credential.*`, `packages.*` and registry kinds about a server or a cluster;
`access.read` for `access.*`; `backups.read` for `backup.*` and `restore.*`;
`diagnostics.read` for `connections.*`; `schema.read` for `drift.*`;
`targets.read` for every other kind. The permission must cover the plan's
subject (an operation without a plan has the installation as subject), a
delegated caller also needs the permission's scope and stays inside its
grant restrictions, and a Web App session holding `plans.approve` at a
covering scope reads what it could approve (`plans.approve` is no delegated
scope). Each candidate is tried at the subject. An id alone grants nothing:
an unreadable plan or operation answers exactly like an unknown one
(`PLAN_NOT_FOUND`, `OPERATION_NOT_FOUND`). `GET /plans` and `GET /operations` filter by the
same rule before the page is cut, examines at most 2000 candidates per call
and continues with an opaque keyset cursor over the operation id (ULID,
newest first), so neither the items, the cursor nor the page length reveals
an operation of another subject.

## Sessions, locks, performance

| Method & path | Purpose | Scope |
|---|---|---|
| `GET /targets/{id}/sessions` | sessions (redacted statements) | `diagnostics.read` |
| `GET /targets/{id}/locks` | lock graph | `diagnostics.read` |
| `POST /targets/{id}/sessions/{pid}/cancel` | cancel (body: `backendStart`, `queryStart`) | `connections.operate:<tier>` |
| `POST /targets/{id}/sessions/{pid}/terminate` | create a terminate plan (body: `backendStart`, `reason`); `201` plan, applied via `POST /plans/{id}/apply` | `connections.operate:<tier>` |
| `GET /targets/{id}/health` | health with sub-states | `diagnostics.read` |
| `GET /targets/{id}/health/history?window=` | samples / rollups | `diagnostics.read` |
| `GET /targets/{id}/query-stats` | statement statistics | `diagnostics.read` |
| `GET /targets/{id}/table-stats` | tables, indexes, vacuum, bloat | `diagnostics.read` |
| `POST /targets/{id}/advisor-runs` | live advisors | `diagnostics.read` |
| `GET /statements/{digest}/raw` | raw statement (human, re-auth) | `diagnostics.read_sensitive` |

## Backups and restore

| Method & path | Purpose | Scope |
|---|---|---|
| `GET /clusters/{id}/backup-repositories`, `POST …` | repositories (engine, location, encryption key reference) | read `backups.read`; write `registry.manage` (plan) |
| `GET /clusters/{id}/backup-policies`, `PUT …` | schedules, retention | read `backups.read`; write `registry.manage` (plan) |
| `GET /clusters/{id}/backups` | backups, WAL window, RPO status | `backups.read` |
| `POST /clusters/{id}/backups` | run a backup | `backups.run` |
| `POST /backups/{id}/verifications` | verify a backup | `backups.run` |
| `POST /restores/plans` | plan a restore (source, explicit destination) | `restore.plan` |
| `GET /restores`, `GET /restores/{id}` | restore records | `backups.read` |
| `GET /restore-drills`, `POST /restore-drills/plans` | drills | read `backups.read`; plan `restore.plan` |

## Nodes

| Method & path | Purpose | Scope |
|---|---|---|
| `GET /nodes`, `GET /nodes/{id}` | nodes, capabilities, health (the lifecycle state, and what the agent last reported with its source and time; `offline` after four missed heartbeats) | `nodes.read` |
| `POST /servers/{id}/nodes/enroll` | plan `node.enroll` (high, re-authentication at apply): applied, it creates the server's enrollment token record without a secret | `registry.manage` (human) — plan |
| `POST /enrollment-tokens/{id}/reveal` | reveal the token once, for the identity that applied `node.enroll`, within 30 minutes (Web App, re-authentication); the secret exists only in this response | `registry.manage` (human) |
| `POST /nodes/{id}/revoke` | plan `node.revoke` (high, re-authentication at apply) | `registry.manage` (human) — plan |
| `POST /nodes/{id}/decommission` | plan `node.decommission` (high, re-authentication at apply) | `registry.manage` (human) — plan |
| `POST /nodes/{id}/config-updates` | plan `node.config.update` (high, re-authentication at apply): body `addJobKeys` (staged or active keys the node does not trust yet) and `retireJobKeys` (retiring or retired keys it still trusts); verified by a read the added key signs ([`../07-node-agent/control-plane.md` §9.8](../07-node-agent/control-plane.md#98-job-key-rotation-nodeconfigupdate)) | `registry.manage` (human) — plan |
| `POST /nodes/{id}/inspections` | run one read or plan capability through the node (`node.inspect`, low: planned and accepted in one call, run by the worker); `202` with the operation; the node-signed result becomes an observation | `nodes.plan` |
| `GET /nodes/{id}/observations` | the latest node-signed observations per capability, cluster and arguments, with source (`agent_reported`, `nr1` verified) and time; `capability` and `clusterId` filter | `nodes.read` |
| `POST /nodes/{id}/plans` | plan a PostgreSQL operation through the node (`node.plan`): body `clusterId` and `change` (`kind` and its fields), bound to an observation at most 10 minutes old ([`../07-node-agent/control-plane.md` §9.3](../07-node-agent/control-plane.md#93-plans-nodeplan)) | `nodes.plan`; apply: `nodes.operate:<tier>` — plan |
| `POST /clusters/{id}/credentials/{role}/rotate` | plan `credential.rotate` on an agent-managed cluster: the worker generates the password, sets its verifier through the node and logs in with it | `registry.manage` (human) — plan |
| `GET /nodes/{id}/jobs` | job history | `nodes.read` — **[PLANNED]** |

**[DECIDED]** (Wave 5 Phase 3) Enrollment tokens are created by the
`node.enroll` operation and revealed by a separate call, so the token secret
never sits in a plan, an operation or a log
([`../07-node-agent/control-plane.md` §4](../07-node-agent/control-plane.md#4-enrollment-tokens)).
The earlier `POST /servers/{id}/enrollment-tokens` is replaced by these two
steps.

## Access

**[DECIDED]** (Wave 3A, Wave 3B) Every route accepts exactly one credential:
a Web App session (mutating routes then need the session's CSRF token and
exact `Origin`), an OAuth access token for the audience
`https://db.exponet.cloud/api`, or an API key. Whether a credential may use a
route is decided by the action's client kinds, the delegated scope, the
grant's restrictions and the identity's live role bindings, centrally
([`../08-auth-and-security/authorization.md`](../08-auth-and-security/authorization.md));
there are no separate machine routes. Actions that need a re-authentication
can only be completed in a Web App session.

**[DECIDED]** (Wave 3B, `apps/server/src/interfaces/http/api.ts`.) The
credential mode is settled before the handler: a session cookie together
with an `Authorization` header is `AMBIGUOUS_CREDENTIALS`; two
`Authorization` headers, another scheme, or a token that is not live for
`api` is `401 UNAUTHENTICATED` with `WWW-Authenticate: Bearer
error="invalid_token", resource_metadata="…/.well-known/oauth-protected-resource/api"`;
no credential at all is `401` with the `resource_metadata` challenge. A
bearer credential is no ambient authority, so bearer requests need neither
`Origin` nor the CSRF token. When the identity holds the permission but the
token lacks the scope, the answer is `403 INSUFFICIENT_SCOPE` with
`details.requiredScope` and `WWW-Authenticate: Bearer
error="insufficient_scope", scope="…", resource_metadata="…"` (step-up). The
`/auth` ceremonies never take a bearer credential.

| Method & path | Purpose | Permission |
|---|---|---|
| `GET /me` | current identity, its bindings, the effective permissions per scope (a projection of the live bindings, never a token), the session | self |
| `GET /me/sessions` | own Web App sessions: public `ses_` ids, times, coarse device label, current marker; never addresses or user agents | self |
| `POST /me/sessions/{sessionId}/revoke`, `POST /me/sessions/revoke-others` | revoke one own session, or every own session except the current one | self |
| `GET /me/factors` | own factors (passkeys with label and last use, password, TOTP, remaining recovery codes); never keys, hashes or secrets | self |
| `GET /identities`, `GET /identities/{identityId}` | identities (humans; service accounts from Wave 3B) | `access.read` |
| `POST /identities` | invite a person: an `invited` identity without any role, and a one-time link shown once to the inviting human (inline plan, re-authentication) | `access.manage` |
| `POST /identities/{identityId}/invitation` | issue a new invitation link for an `invited` identity; the old link stops working | `access.manage` |
| `POST /identities/{identityId}/disable` | disable: sessions, ceremonies and links end in the same transaction (inline plan, re-authentication; never the last active owner; only an owner disables an owner) | `access.manage` |
| `POST /identities/{identityId}/enable-plans` | plan enabling a disabled identity | `access.manage` — plan |
| `POST /identities/{identityId}/erasure-plans` | plan the erasure of an identity (`critical`: approval, re-authentication; OD-9 self-approval with cooling period) | `access.manage` — plan |
| `GET /roles`, `GET /roles/{roleId}` | built-in roles with their explicit permissions | `access.read` |
| `GET /role-bindings` | role bindings, filter by identity and state | `access.read` |
| `POST /role-bindings`, `DELETE /role-bindings/{bindingId}` | bind or unbind a role at a scope; the response is the plan with before, after and risk analysis | `access.manage` — plan |
| `GET /policy-settings` | policy rules, defaults and configured revisions | `access.read` |
| `POST /policy-settings/plans` | plan a rule parameter change (analysis tighter, weaker or unknown per parameter) | `policy.manage` — plan |
| `GET /me/grants` | connected applications of the caller: client (registration, trust), resource, scopes, restrictions, consent time, expiry, last token (Wave 3B) | self |
| `POST /me/grants/{grantId}/revoke` | revoke an own grant: every access and refresh token of it stops at once (inline plan) | self |
| `GET /grants` | grants of every identity, filter by identity and state | `access.read` |
| `POST /grants/{grantId}/revoke` | revoke another identity's grant (inline plan, re-authentication) | `access.manage` |
| `GET /oauth-clients`, `GET /oauth-clients/{oauthClientId}` | OAuth clients with registration method, state, redirect URIs, metadata fingerprint and approval; display data is untrusted | `access.read` |
| `POST /oauth-clients/cimd` | fetch the Client ID Metadata Document of an exact `client_id` URL (SSRF-hardened) and record the client as pending review | `access.manage` |
| `POST /oauth-clients/{oauthClientId}/refresh-metadata` | fetch a CIMD client's metadata again; a changed security fingerprint returns the client to review | `access.manage` |
| `POST /oauth-clients/{oauthClientId}/approve` | approve exactly this client and the fingerprint that was reviewed (inline plan, re-authentication) | `access.manage` |
| `POST /oauth-clients/{oauthClientId}/reject`, `POST /oauth-clients/{oauthClientId}/disable` | reject a pending client; disable a client, ending its grants and tokens (inline plan, re-authentication) | `access.manage` |
| `GET /service-accounts`, `GET /service-accounts/{identityId}` | service accounts with their client, API keys and machine grants | `access.read` |
| `POST /service-accounts` | create a service account: a service identity with a responsible person, no role, no credential (inline plan, re-authentication); roles are bound through `POST /role-bindings` | `access.manage` |
| `POST /service-accounts/{identityId}/oauth-client` | register the service account's OAuth client with public keys (`private_key_jwt`; no secret, no private key) | `access.manage` |
| `POST /service-accounts/{identityId}/oauth-client/keys` | replace the client's public keys (rotation: add before remove) | `access.manage` |
| `POST /service-accounts/{identityId}/grants` | grant the client a bounded machine authority for the REST API: scopes, restrictions, expiry; production writes need an explicit confirmation | `access.manage` |
| `GET /api-keys` | API keys (metadata only), filter by service account | `access.read` |
| `POST /service-accounts/{identityId}/api-keys` | create an API key: shown once to the creating human, only its hash is stored; mandatory expiry (default 90, max 365 days) | `access.manage` |
| `POST /api-keys/{keyId}/revoke` | revoke an API key at once (inline plan, re-authentication) | `access.manage` |

## Audit

| Method & path | Purpose | Scope |
|---|---|---|
| `GET /audit-events` | search, newest first; filters `from`, `to`, `target`, `action`, `actor=self`, `result`; opaque cursor. **[DECIDED]** (served from Wave 6) actors stay pseudonymous; a change description, the request pseudonyms and the decision are not part of the read view; a stored event the view cannot vouch for answers `CONTROL_PLANE_DEGRADED`, never an invented row | `audit.read` at the installation, or covering the `target` for its events only |
| `GET /audit-events/chain` | chain head, last verified checkpoint | `audit.read` |

## Installation

| Method & path | Purpose | Scope |
|---|---|---|
| `GET /installation/health` | Control Plane health: Control Store, workers, samplers, gateway, keyring, self-check findings ([`../10-observability/self-observability.md`](../10-observability/self-observability.md)) | `nodes.read` |
| `GET /installation` | installation id, version, contract versions, enabled features | `targets.read` |

## Service endpoints (outside `/api/v1`)

| Path | Purpose | Auth |
|---|---|---|
| `/healthz/live` | process liveness | none |
| `/healthz/ready` | readiness (Control Store, migrations at expected version, keys loaded for the role) | none; returns no details publicly |
| `/.well-known/oauth-protected-resource[/mcp|/api]`, `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration` | discovery | none |
| `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`, `/oauth/register` | OAuth AS | per spec |
| `/mcp` | MCP | bearer |

## Example: plan a migration (OpenAPI fragment, documentation only)

```yaml
/targets/{targetId}/migrations/plans:
  post:
    operationId: createMigrationPlan
    security: [{ bearer: [migrations.plan] }, { session: [] }]
    parameters:
      - { name: targetId, in: path, required: true, schema: { type: string } }
      - { name: Idempotency-Key, in: header, required: false, schema: { type: string, maxLength: 255 } }
    requestBody:
      required: true
      content:
        application/json:
          schema:
            type: object
            additionalProperties: false
            properties:
              bundles:
                type: array
                maxItems: 50
                items: { $ref: '#/components/schemas/MigrationBundleSubmission' }
              migrationIds:
                type: array
                items: { type: string, pattern: '^[0-7][0-9A-HJKMNP-TV-Z]{25}$' }
              source: { $ref: '#/components/schemas/SourceReference' }
    responses:
      '201': { description: Plan created (decision may be deny), content: { application/json: { schema: { $ref: '#/components/schemas/MigrationPlan' } } } }
      '409': { $ref: '#/components/responses/Problem' }   # e.g. MIGRATION_CHECKSUM_MISMATCH
      '422': { $ref: '#/components/responses/Problem' }   # e.g. MIGRATION_MANIFEST_INVALID
```

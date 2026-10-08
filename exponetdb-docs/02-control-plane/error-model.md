# Error model

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
| Applies to | Wave 1 (contracts), every interface |
| Read before | [`../06-rest-api/architecture.md`](../06-rest-api/architecture.md), [`../05-mcp/architecture.md`](../05-mcp/architecture.md) |

## 1. Principles

**[DECIDED]**

- One error catalog for every interface. REST, MCP, SDK, CLI and Web App use the
  same stable `code` strings, defined in `packages/contracts/errors`.
- Codes are `UPPER_SNAKE_CASE`, never renamed, never reused for a different
  meaning. Deprecation keeps the old code working.
- Every error carries: `code`, `message` (English, human-readable, no secrets,
  no raw PostgreSQL `DETAIL`), `retryable` (boolean), optional `details`
  (code-specific, schema-defined), optional `remediation`, `requestId`, and for
  operations `operationId`/`planId`.
- PostgreSQL errors are wrapped, never passed through raw. The SQLSTATE, the
  position and the hint are kept; `DETAIL` is dropped by default because it can
  contain row values (for example the conflicting key of a unique violation). The
  `detail` is available only in the operation record to identities with
  `diagnostics.read_sensitive`, and only redacted (see
  [`../03-database-model/statement-redaction.md`](../03-database-model/statement-redaction.md)).
  This follows REOSA's measured lesson that logging only `error.message` hid the
  real cause, while logging `detail` would leak values
  (`REOSA/.claude/rules/portability.md`).
- A refusal explains itself (P-5): which precondition failed and what to do.

## 2. Envelope per interface

### REST

RFC 9457 `application/problem+json`, extended:

```json
{
  "type": "https://db.exponet.cloud/errors/plan-stale",
  "title": "Plan is stale",
  "status": 409,
  "code": "PLAN_STALE",
  "message": "The plan no longer matches the target. Create a new plan.",
  "retryable": false,
  "details": { "planId": "pln_…", "changedBindings": [ … ] },
  "remediation": "Call POST /api/v1/targets/{id}/migrations/plans again.",
  "requestId": "req_01JB…"
}
```

### MCP

A domain refusal is a **tool execution error**, not a protocol error: the tool
result has `isError: true`, a short text content for the model, and
`structuredContent` with the same object as the REST body (minus HTTP fields).
Protocol errors (JSON-RPC) are reserved for malformed requests, unknown tools and
authentication failures handled by the transport.

### OAuth protocol endpoints (Wave 3B)

**[DECIDED]** (Wave 3B) The authorization server speaks OAuth, not RFC 9457
([`../05-mcp/oauth.md`](../05-mcp/oauth.md) §4 and §5):

- `/oauth/token`, `/oauth/revoke`, `/oauth/device_authorization` and
  `/oauth/register` answer errors as `{"error", "error_description"}` JSON
  (RFC 6749 §5.2, RFC 7591 §3.2.2, RFC 8628 §3.5) with `Cache-Control:
  no-store`; the description is fixed text, never request or library text.
  A rate limit is `temporarily_unavailable` with status 429 and
  `Retry-After`. Revocation answers 200 for unknown tokens and tokens of
  other clients (RFC 7009 §2.2).
- `/oauth/authorize` redirects errors to the matched redirect URI with
  `error`, `state` and `iss`; until the client and its exact redirect URI
  are established it never redirects there and sends the browser to
  `/oauth/error?reason=<fixed reason>` (no open redirector).
- At `/api/v1` a bearer credential that is unknown, expired, revoked, of a
  disabled client or identity, or for the other resource is one answer:
  `UNAUTHENTICATED` (401) with `WWW-Authenticate: Bearer
  resource_metadata="…", error="invalid_token"`; which of these it was is
  not told (no oracle), so `TOKEN_EXPIRED` and `GRANT_REVOKED` are not
  emitted by Wave 3B. A request without a credential gets the challenge
  without `error`. `INSUFFICIENT_SCOPE` (403) carries `error=
  "insufficient_scope"` and the missing scope only when the identity's live
  role bindings would allow the action (a step-up that cannot succeed is
  `PERMISSION_DENIED`).

### SDK

`ExponetDBError` with typed `code` union, `retryable`, `details` typed per code.

## 3. Catalog

HTTP status in brackets. `R` = retryable as-is (the same request may succeed
later without changes).

### Plans and operations

| Code | Status | R | Meaning |
|---|---|---|---|
| `PLAN_STALE` | 409 | no | One or more bindings changed; `details.changedBindings`. Re-plan. |
| `PLAN_EXPIRED` | 409 | no | Plan passed `expiresAt`. Re-plan. |
| `ORDER_DIVERGES_FROM_EVIDENCE` | 409 | no | Production must apply unordered, overlapping migrations in staging's order, and production's state makes that order impossible. Add an explicit `dependsOn` edge or reconcile, then re-plan ([`../04-migrations/dependency-graph.md` §5](../04-migrations/dependency-graph.md#5-target-specific-state)). |
| `PLAN_ALREADY_USED` | 409 | no | Plan consumed by another request or caller. |
| `PLAN_NOT_FOUND` | 404 | no | Unknown plan id (or not visible to the caller). |
| `PLAN_BINDING_ACTOR` | 403 | no | Caller is not the plan's actor/client. |
| `PLAN_DENIED` | 403 | no | Policy decision at plan time was `deny`; plan exists for explanation only. |
| `APPROVAL_REQUIRED` | 202/409 | no | Apply accepted into `awaiting_approval` (202) or approval missing for a kind that cannot wait (409). |
| `REAUTH_REQUIRED` | 401 | no | Fresh passkey/TOTP proof needed. |
| `APPROVAL_COOLING_PERIOD` | 409 | yes | A `critical` self-approval is in its cooling period ([OD-9](../00-product/open-decisions.md#od-9-approval-model-for-a-one-person-organization)); apply again after `details.notBefore` with a fresh re-authentication (Wave 3A). |
| `SELF_APPROVAL_UNACKNOWLEDGED` | 422 | no | An approval of one's own plan must carry the explicit acknowledgement (Wave 3A). |
| `APPROVAL_NOT_PENDING` | 409 | no | Approving or rejecting an operation that does not await approval (Wave 3A). |
| `APPROVAL_DUPLICATE` | 409 | no | The same person decides twice on one operation (Wave 3A). |
| `BREAK_GLASS_REQUIRED` | 403 | no | Only a break-glass grant can override `details.rules`. |
| `OPERATION_NOT_FOUND` | 404 | no | |
| `OPERATION_CONFLICT` | 409 | yes | Exclusivity domain held by `details.blockingOperationId` and the request asked not to wait (`wait: false`, used by inline-plan actions); by default an accepted operation waits in `queued` with `waitingFor` instead. |
| `OPERATION_CANCELLED` | 409 | no | |
| `OUTCOME_UNKNOWN` | 409 | no | Operation in `needs_reconciliation`; do not retry, wait for reconciliation. |
| `PRECONDITION_FAILED` | 412 | no | Inline-plan precondition token no longer matches (object changed). |
| `IDEMPOTENCY_KEY_REUSED` | 422 | no | Same key, different request. |

### Migrations

| Code | Status | R | Meaning |
|---|---|---|---|
| `MIGRATION_CHECKSUM_MISMATCH` | 409 | no | Id known with a different checksum; `details.knownChecksum`, `details.where`. |
| `MIGRATION_DEPENDENCY_MISSING` | 409 | no | `details.missing[]` not applied and not in the plan. |
| `MIGRATION_DEPENDENCY_UNVERIFIED` | 409 | no | Dependency applied but not verified (prod tier). |
| `MIGRATION_DEPENDENCY_CYCLE` | 422 | no | `details.cycle[]`. |
| `MIGRATION_DEPENDENCY_UNKNOWN` | 422 | no | `dependsOn` names an id not in the stream. |
| `MIGRATION_MANIFEST_INVALID` | 422 | no | Schema validation errors in `details.errors[]`. |
| `MIGRATION_BUNDLE_INVALID` | 422 | no | Missing files, bad encoding, name/id mismatch; `details.reason`, `details.file` (reason codes in `packages/contracts`). |
| `MIGRATION_LINT_BLOCKED` | 422 | no | Blocking lint findings in `details.findings[]`. |
| `MIGRATION_ALREADY_APPLIED` | 409 | no | Same id and checksum already applied on this target. |
| `VERIFY_CONSTRUCT_UNSUPPORTED` | 422 | no | `verify.sql` uses a function, operator, cast, relation or output column the admission cannot classify; `details.construct`, `details.check`. Rewrite with allowlisted built-ins or declare a consumer check. |
| `MIGRATION_STATEMENT_FORBIDDEN` | 422 | no | Statement class not allowed in this context (e.g. `COMMIT` in `up.sql`, `CREATE INDEX CONCURRENTLY` with `transactional: true`). |
| `MIGRATION_LOCK_TIMEOUT` | 409 | no | Advisory lock or `lock_timeout` hit; nothing applied; the plan is consumed, so retrying means re-planning. |
| `MIGRATION_EXECUTION_FAILED` | 422 | no | SQL error; `details.sqlstate`, `details.statementIndex`, `details.position`; apply outcome in `details.applyOutcome`. |
| `MIGRATION_REQUIREMENT_UNMET` | 409 | no | PostgreSQL version or extension requirement not met. |
| `VERIFICATION_FAILED` | 200 in operation / 409 on sync calls | no | Verification ran and failed; `details.checks[]`. |
| `VERIFICATION_ERROR` | 409 | yes | Verification could not run (timeout, unreachable). |
| `SCHEMA_FINGERPRINT_MISMATCH` | 409 | no | Fingerprint differs from expectation outside plan context (drift checks, lineage). Inside plans it surfaces as `PLAN_STALE`. |
| `LEDGER_DIVERGENCE` | 409 | no | Target ledger and Control Store mirror disagree; schema changes blocked. |
| `LEDGER_NOT_INITIALIZED` | 409 | no | Target has no `exponetdb` schema / baseline yet. |
| `LEGACY_IMPORT_AMBIGUOUS` | 409 | no | Import cannot proceed without human resolution of `details.items[]`. |

### Evidence and policy

| Code | Status | R | Meaning |
|---|---|---|---|
| `STAGING_EVIDENCE_MISSING` | 409 | no | No application of this checksum on the evidence target. |
| `STAGING_VERIFICATION_FAILED` | 409 | no | Applied on staging but verification failed or is pending. |
| `STAGING_EVIDENCE_UNREACHABLE` | 409 | yes | Evidence target cannot be read to confirm evidence (fails closed). |
| `EVIDENCE_CHAIN_MISCONFIGURED` | 409 | no | Project/environment evidence configuration invalid (I-9). |
| `POLICY_DENIED` | 403 | no | Rule results in `details.rules[]`. |
| `MAINTENANCE_WINDOW_REQUIRED` | 409 | no | |
| `BACKUP_REQUIRED` | 409 | no | Policy requires a verified backup newer than `details.newerThan`. |
| `BACKUP_NOT_VERIFIED` | 409 | no | The referenced backup has no successful verification. |

### Authentication and authorization

| Code | Status | R | Meaning |
|---|---|---|---|
| `UNAUTHENTICATED` | 401 | no | Missing/invalid credentials; REST/MCP include `WWW-Authenticate`. |
| `TOKEN_EXPIRED` | 401 | no | Refresh and retry. |
| `INSUFFICIENT_SCOPE` | 403 | no | `details.requiredScope`; MCP clients may step up. |
| `PERMISSION_DENIED` | 403 | no | Identity lacks the RBAC permission at that scope. |
| `TARGET_NOT_IN_GRANT` | 403 | no | Token's grant does not include the target of a plan or operation the caller already holds. A target itself outside the grant is `TARGET_NOT_FOUND` (§4). |
| `TIER_NOT_PERMITTED` | 403 | no | Scope exists for the other tier only (for a plan or operation the caller already holds; a target of the other tier is `TARGET_NOT_FOUND`, §4). |
| `GRANT_REVOKED` | 401 | no | |
| `CLIENT_NOT_APPROVED` | 403 | no | OAuth client registered but not approved by an admin. |
| `AUTHORIZATION_REQUEST_INVALID` | 400 | no | The consent page names an authorization request that is unknown, expired, decided or bound to another browser (Wave 3B). |
| `USER_CODE_INVALID` | 400 | no | The device verification code is unknown, expired or used; failures are rate-limited (Wave 3B). |
| `SCOPE_NOT_DELEGABLE` | 403 | no | Consent or a machine grant names a scope the identity does not hold or the client may never receive; `details.scopes[]` (Wave 3B). |
| `PRODUCTION_CONFIRMATION_REQUIRED` | 400 | no | Production authority was requested without the explicit confirmation (Wave 3B). |
| `CLIENT_METADATA_INVALID` | 422 | yes | A Client ID Metadata Document could not be fetched safely or failed validation; `details.reason` (Wave 3B). |
| `AUTHENTICATION_FAILED` | 401 | no | Sign-in failed. One generic answer for an unknown e-mail address, a wrong password, a wrong or replayed TOTP code, a used recovery code, a disabled identity and an expired sign-in step, so that a caller cannot enumerate accounts or learn which factor was right (Wave 3A). |
| `SESSION_EXPIRED` | 401 | no | A session cookie was sent but no valid session belongs to it (expired, revoked, replaced, identity disabled) (Wave 3A). |
| `AMBIGUOUS_CREDENTIALS` | 400 | no | A session cookie and a bearer token in the same request; rejected rather than choosing one (Wave 3A). |
| `CSRF_FAILED` | 403 | no | A mutating browser request without the exact `Origin` or a valid `X-CSRF-Token` for its session (Wave 3A). |
| `AUTH_CHALLENGE_EXPIRED` | 401 | no | A ceremony of an authenticated person (passkey registration, re-authentication) expired (Wave 3A). |
| `AUTH_CHALLENGE_INVALID` | 401 | no | A ceremony of an authenticated person failed verification or was already used (Wave 3A). |
| `LINK_INVALID` | 401 | no | A one-time link (setup, invitation, recovery) is unknown, used or expired; the three cases are not distinguished (Wave 3A). |
| `RECOVERY_REQUIRED` | 403 | no | A session opened with a recovery code may only set up new factors (Wave 3A). |
| `PASSWORD_REJECTED` | 422 | no | The password violates the policy; `details.reason` (Wave 3A). |
| `ENROLLMENT_INCOMPLETE` | 409 | no | Enrollment completion before passkey, password and confirmed TOTP are set (Wave 3A). |
| `IDENTITY_EXISTS` | 409 | no | An invitation names an e-mail address another identity already uses (Wave 3A). |
| `IDENTITY_STATE_INVALID` | 409 | no | The identity's lifecycle state does not allow the change, e.g. re-issuing an invitation of an active identity (Wave 3A). |
| `BINDING_EXISTS` | 409 | no | A role binding plan names a role the identity already holds at that scope (Wave 3A). |
| `LAST_FACTOR` | 409 | no | The last passkey cannot be removed without a replacement (Wave 3A). |
| `OWNER_INVARIANT` | 409 | no | The change would leave no active owner (Wave 3A). |

### Targets, clusters, nodes

| Code | Status | R | Meaning |
|---|---|---|---|
| `TARGET_NOT_FOUND` | 404 | no | |
| `TARGET_SUSPENDED` | 409 | no | Writes blocked; reason in details. |
| `TARGET_UNAVAILABLE` | 503 | yes | Cannot connect (network, server down). Never reported as empty data. |
| `TARGET_CREDENTIAL_INVALID` | 503 | no | Authentication to PostgreSQL failed; credential needs rotation/repair. |
| `TARGET_TLS_FAILED` | 503 | no | TLS verification failed (expired, wrong name, unknown CA). |
| `TARGET_IDENTITY_MISMATCH` | 409 | no | Identity marker ≠ expected target/generation; target auto-suspended. |
| `CLUSTER_IDENTITY_MISMATCH` | 409 | no | `system_identifier` ≠ pinned value. |
| `TARGET_REGISTRATION_REFUSED` | 409 | no | Wave 4: `target.register` found a database it never adopts; nothing in it changed. `details.reason`: `control_store` (the Control Store's own schema signs), `cluster_hosts_control_store`, `foreign_installation`, `other_target`, `generation_mismatch`, `schema_exists_without_marker`, `marker_unreadable`, `database_mismatch`, `unsupported_version`, `credential_missing`, `lock_unavailable` (open enum). |
| `REGISTRY_CONFLICT` | 409 | no | Wave 4: the registry refuses the change in its current state (`details.reason`: `slug_taken`, `path_taken`, `address_taken`, `database_taken`, `cluster_not_confirmed`, `cluster_already_confirmed`, `cluster_retired`, `evidence_cycle`, `evidence_other_product`, `tier_in_use`, `target_state`, `endpoint_retired`, `database_not_found`, `no_active_endpoint`, `observer_credential_missing`, `system_identifier_taken`, `credential_missing`; Wave 5: `cluster_unmapped`, `cluster_not_agent_managed`, `cluster_ambiguous` (two local instances with the cluster's system identifier), `postgres_ca_missing`, `ca_bundle_lacks_postgres_ca`, `role_missing`, `role_privileges` (the role is not at its documented least privilege), `egress_addresses_unknown`, `tls_name_not_registered`; open enum). |
| `NODE_OFFLINE` | 503 | yes | No heartbeat within threshold. |
| `NODE_REVOKED` | 409 | no | |
| `CAPABILITY_UNAVAILABLE` | 409 | no | Node does not report the capability/version, or the cluster is external. |
| `JOB_EXPIRED` | 409 | no | Job not claimed before `expiresAt`. |
| `NODE_PROTOCOL_UNSUPPORTED` | 400 | no | Wave 5 agent API: no protocol major in common with the gateway, or a missing or malformed `X-Exponetdb-Protocol` / `X-Exponetdb-Agent-Version` header ([`protocol.md` §1, §6](../07-node-agent/protocol.md#1-transport)). |
| `NODE_ENROLLMENT_REFUSED` | 401 | no | Wave 5: the enrollment token is unknown, expired, already used, or its redeem key does not match; one code for all four, so the answer reveals nothing about a token ([`enrollment.md` §3](../07-node-agent/enrollment.md#3-enrollment-flow)). The token is not consumed. |
| `NODE_PROOF_INVALID` | 400 | no | Wave 5: a proof of possession, a renewal signature or another node-key proof does not verify ([`protocol.md` §7.4](../07-node-agent/protocol.md#74-enrollment-and-renewal-proofs)); an enrollment token is not consumed by it. |
| `NODE_ALREADY_ENROLLED` | 409 | no | Wave 5: the server record already has a node that is not revoked or decommissioned (I-6). |
| `NODE_CERTIFICATE_REFUSED` | 403 | no | Wave 5: the client certificate is not the node's current certificate, or the node's state does not allow the request (renewal only while `active` or `degraded`). |
| `NODE_CAPABILITY_FAILED` | 422 | no | Wave 5 Phase 5: the node ran the capability and reported a failure before its effect point, so the host did not change; the operation shows the agent's (host-redacted) message ([`../07-node-agent/control-plane.md` §9.4](../07-node-agent/control-plane.md#94-execution-and-outcomes)). |
| `NODE_OBSERVATION_STALE` | 409 | no | Wave 5 Phase 5: no node-signed observation of the cluster is recent enough (10 minutes) to plan against; `details.capability` names what to inspect first. |

### Backup and restore

| Code | Status | R | Meaning |
|---|---|---|---|
| `BACKUP_FAILED` | 422 | no | |
| `BACKUP_REPOSITORY_UNAVAILABLE` | 503 | yes | |
| `RESTORE_TARGET_MISMATCH` | 409 | no | Destination is not the target named in the plan, or its identity/tier differs. |
| `RESTORE_SOURCE_INVALID` | 409 | no | Backup missing, incomplete, or WAL range insufficient for the requested point in time. |
| `RESTORE_FAILED` | 422 | no | |

### Queries and diagnostics

| Code | Status | R | Meaning |
|---|---|---|---|
| `QUERY_NOT_READ_ONLY` | 422 | no | Statement classified as writing; use migrations. |
| `QUERY_CONSTRUCT_UNSUPPORTED` | 422 | no | The query calls a function, operator or cast, or reads a relation, that the admission cannot classify as free of side effects; `details.construct`. |
| `QUERY_TIMEOUT` | 408 | yes | `statement_timeout` reached. |
| `QUERY_RESULT_TOO_LARGE` | 413 | no | Row or byte cap reached; `details.cap`. |
| `QUERY_PARSE_ERROR` | 422 | no | Parser rejected the statement; position given. |
| `DATA_READ_NOT_PERMITTED` | 403 | no | Data reads disabled on this target or tier for this client. |
| `SAMPLE_STALE` | 200 with warning / 503 | yes | Requested diagnostics older than freshness threshold and live read failed. |

### Generic

| Code | Status | R | Meaning |
|---|---|---|---|
| `VALIDATION_FAILED` | 422 | no | Request schema violation; `details.errors[]`. |
| `NOT_FOUND` | 404 | no | |
| `CONFLICT` | 409 | no | Generic optimistic concurrency failure (`If-Match`). |
| `RATE_LIMITED` | 429 | yes | `Retry-After` header. |
| `CONTROL_PLANE_DEGRADED` | 503 | yes | Control Store unavailable or ExponetDB not ready. Distinct from `TARGET_UNAVAILABLE` (C-29). |
| `INTERNAL` | 500 | yes | Unexpected; `requestId` correlates with logs. Never contains stack traces. |

**[DECIDED]** (Wave 1, `packages/contracts/src/errors.ts`) `details` is
schema-checked per code and closed (unknown members refused). Codes whose row
above names no `details.*` carry no details in v1; details for them are an
additive change. `message`, `title` and `remediation` are fixed catalog text:
request data, exception text, SQL and PostgreSQL `DETAIL` never enter them.
Policy rule results in `POLICY_DENIED` omit the rule `facts`, which stay in the
plan.

## 4. Visibility rule

**[DECIDED]** To avoid leaking existence, a caller who may not see a resource
receives `NOT_FOUND`-class codes for it, except where the caller already holds the
id from an earlier response they were entitled to (their own plans). Target
paths are not secret within an authenticated session, but tokens restricted to a
set of targets see only those targets.

**[DECIDED]** (Wave 4, after the G4 adversarial review) A target read or
plan checks first that the caller holds the action's permission somewhere,
through a scope its client may use, and only then looks the target up: a
caller without any such access gets `PERMISSION_DENIED` for an existing and
an unknown path alike. A caller with access elsewhere learns that a path
exists (`PERMISSION_DENIED`); lists never show it.

**[DECIDED]** (owner decision R2, 2026-10-07, G4 correction) A delegated
token restricted to a list of targets or to one tier sees only those
targets: a target outside its list or tier answers `TARGET_NOT_FOUND`,
exactly like an unknown path (same status and body apart from the request
id), and before any check that could name a tier or a scope (a
nonprod-only token used to learn `INSUFFICIENT_SCOPE` with
`requiredScope: …:prod`). The server writes why to its log
(`authz.denial_concealed`: the route template, the request id and
`target_restriction` or `tier_restriction`, never the path); it is not part
of the answer and not an audit event (refusals are not audited).
`TARGET_NOT_IN_GRANT` and `TIER_NOT_PERMITTED` stay for plans and
operations the caller already holds. An unrestricted delegated token, like
a person, still learns that a path exists from `PERMISSION_DENIED`.

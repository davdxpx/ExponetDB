# Error model

| | |
|---|---|
| Status | Baseline (Wave 0), awaiting owner approval |
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
| `MIGRATION_BUNDLE_INVALID` | 422 | no | Missing files, bad encoding, name/id mismatch. |
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
| `TARGET_NOT_IN_GRANT` | 403 | no | Token's grant does not include this target. |
| `TIER_NOT_PERMITTED` | 403 | no | Scope exists for the other tier only. |
| `GRANT_REVOKED` | 401 | no | |
| `CLIENT_NOT_APPROVED` | 403 | no | OAuth client registered but not approved by an admin. |

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
| `NODE_OFFLINE` | 503 | yes | No heartbeat within threshold. |
| `NODE_REVOKED` | 409 | no | |
| `CAPABILITY_UNAVAILABLE` | 409 | no | Node does not report the capability/version, or the cluster is external. |
| `JOB_EXPIRED` | 409 | no | Job not claimed before `expiresAt`. |

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

## 4. Visibility rule

**[DECIDED]** To avoid leaking existence, a caller who may not see a resource
receives `NOT_FOUND`-class codes for it, except where the caller already holds the
id from an earlier response they were entitled to (their own plans). Target
paths are not secret within an authenticated session, but tokens restricted to a
set of targets see only those targets.

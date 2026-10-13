# REST API architecture

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05; §3 note, §7, §9 and §10 updated on 2026-10-13 for Wave 7 (G7 not yet accepted, [G7 record](../14-roadmap/gates/7.md)) |
| Applies to | Wave 1 (contracts), Wave 2 (framework), every later wave (resources) |
| Read before | [`../02-control-plane/error-model.md`](../02-control-plane/error-model.md), [`../01-architecture/versioning.md`](../01-architecture/versioning.md) |
| Decision | [ADR-0018](../01-architecture/adr/0018-contracts-first.md) |

REST is a first-class interface: the Web App, the SDK, the CLI and CI use it.
MCP and REST expose the same application services.

## 1. Basics

**[DECIDED]**

| Aspect | Rule |
|---|---|
| Base URL | `https://db.exponet.cloud/api/v1` |
| Format | JSON (`application/json`), UTF-8; errors `application/problem+json` (RFC 9457 + ExponetDB `code`) |
| Contract | OpenAPI 3.1, generated from Zod schemas in `packages/contracts`; published at `/api/v1/openapi.json` |
| Auth | `Authorization: Bearer <token>` (OAuth access token with audience `https://db.exponet.cloud/api`, or API key `exak_…`); Web App uses a session cookie + CSRF token (§6) |
| IDs | prefixed ULIDs (`tgt_…`); targets also addressable by URL-encoded path (`/targets/reosa%2Fplatform%2Fproduction`) |
| Time | RFC 3339 UTC with `Z` |
| Naming | `camelCase` JSON fields; plural nouns for collections; verbs only for actions that are not CRUD (`/plans/{id}/apply`) |
| Unknown fields | Requests with unknown fields are rejected (`VALIDATION_FAILED`), so that a typo cannot silently drop a safety-relevant option. Responses may gain fields; clients must ignore unknown response fields. |

## 2. Resource conventions

- **Collections**: `GET /targets?limit=50&cursor=…` with cursor pagination
  (opaque cursor, `nextCursor` in the response, stable ordering by id). No
  offset pagination.
- **Filtering**: explicit query parameters per collection (documented in
  OpenAPI); no generic query language. **[DECIDED]** (Wave 4) An array
  parameter is exploded (`?kinds=table&kinds=view`, OpenAPI `style: form`,
  `explode: true`); a scalar parameter given twice is refused
  (`VALIDATION_FAILED`), never resolved by picking one. A target path in a
  URL is one percent-encoded segment (`/targets/acme%2Fplatform%2Fstaging`).
- **Sparse responses**: `?fields=` not supported in V1; responses are designed to
  be small; expensive sub-resources are separate endpoints.
- **Freshness**: every response containing observed state includes
  `observedAt` and `source` (`live`, `sampled`, `cached`) at the level where it
  applies (C-28). A live read that fails returns an error, never an empty
  collection. **[DECIDED]** (Wave 1 clarification) The contract has one
  `source` enum for all observed state: `live` (read during this request),
  `sampled` (from a periodic sampler), `cached` (an earlier read, served
  again), `agent_reported` (reported by a node agent) and `inferred` (derived
  from other observations, see
  [`../10-observability/health.md`](../10-observability/health.md)). It is an
  open enum (`x-extensible-enum`).
- **Concurrency control** for registry and access resources: `ETag` on GET,
  `If-Match` required on PATCH/DELETE (`CONFLICT` on mismatch).

## 3. Mutations

| Class | HTTP pattern | Response |
|---|---|---|
| Registry/access changes (admin) | `POST`/`PATCH`/`DELETE` on the resource, with `Idempotency-Key` | **creates a plan** when the change is consequential (most are): `201 Created` with the plan; applied via `POST /plans/{id}/apply`. Purely cosmetic changes (display names, labels) apply directly. |
| Plans | `POST /targets/{id}/migrations/plans`, `POST /nodes/{id}/plans`, `POST /restores/plans`, … | `201` plan (including denied plans with `decision: deny`) |
| Apply | `POST /plans/{id}/apply` | `202 Accepted` + `Location: /api/v1/operations/{op}` + operation body; `200` with the same body for a repeated call (idempotent); see the **[OBSERVED]** note below |
| Inline-plan actions | `POST /targets/{id}/sessions/{pid}/cancel` with precondition fields in the body | `200` result or `412 PRECONDITION_FAILED` |
| Long-running status | `GET /operations/{id}` | state machine as in operations-engine.md |

**[DECIDED]** No endpoint executes a consequential mutation without either a
stored plan or an inline-plan precondition token (C-6). The contract test
"every mutating route is registered as an action kind" enforces it.

**[OBSERVED]** (2026-10-13; `packages/contracts/src/rest/routes.ts`
`applyPlan`, `apps/server/src/interfaces/http/api.ts`) The apply route
answers `202` with the operation body also for a repeated call, and the
server sends neither a `Location` header nor `Idempotent-Replayed` (§4) yet.
The rows above keep the Wave 0 decision; the answers are as observed here.

## 4. Idempotency

`Idempotency-Key` header (1-255 visible ASCII) on every `POST`/`PATCH`/`DELETE`
except `plans/{id}/apply` (where the plan id is the key) and inline actions
(where precondition tokens are the key). Semantics in
[`../02-control-plane/operations-engine.md` §5](../02-control-plane/operations-engine.md#5-idempotency).
Responses replayed from an idempotency record carry `Idempotent-Replayed: true`.

## 5. Errors

RFC 9457 problem documents with the ExponetDB error catalog
([`../02-control-plane/error-model.md`](../02-control-plane/error-model.md)).
`WWW-Authenticate` on 401/403 for bearer tokens, including
`error="insufficient_scope"` and the required scopes.

## 6. Web App sessions and CSRF

The Web App authenticates with a `__Host-` prefixed, `Secure`, `HttpOnly`,
`SameSite=Strict` session cookie. Mutating requests from the Web App must carry
an `X-CSRF-Token` header matching a per-session token (double submit with server
verification), and `Origin` must equal `https://db.exponet.cloud`. Bearer-token
requests are not subject to CSRF checks and are not accepted with cookies
present (a request with both is rejected, to avoid ambiguous authorization).

## 7. Rate limits

**[DECIDED]** (Wave 0, the defaults confirmed for `/mcp` by owner decision 9 of
the Wave 7 order) Per principal and per client: token bucket with defaults
(reads 20/s burst 100; plans 2/s; applies 1/s; `data.read` 5/s). `429` with
`Retry-After` and `RATE_LIMITED`. Separate, stricter limits for authentication
endpoints.

**[OBSERVED]** (2026-10-13, Wave 7; G7 not yet accepted) These buckets are
built for `/mcp` only: per grant and, at twice the rate, per identity, in the
memory of `serve` (`apps/server/src/interfaces/mcp/rate-limit.ts`,
`MCP_RATE_LIMITS` in `packages/contracts/src/mcp/protocol.ts`;
[`../05-mcp/architecture.md`](../05-mcp/architecture.md) §3). `/api/v1` has no
general per-principal bucket in the code. What it has: the failure limits of
the authentication and OAuth endpoints
([`../08-auth-and-security/identity.md`](../08-auth-and-security/identity.md) §9), and
the concurrency bounds of the data-read lane, which the query routes (§10)
share with `sql_query` (over a bound: `429 RATE_LIMITED` with `Retry-After`).
**[PLANNED]** General REST buckets; no wave is assigned.

## 8. OpenAPI and SDK generation

- The OpenAPI document is generated at build time from the contracts and
  committed; CI fails if it is out of date.
- `@exponetdb/sdk` is generated from it (types) with a small hand-written client
  (auth, retries for idempotent GETs, idempotency-key generation, operation
  polling helper). See [`../13-integrations/sdk.md`](../13-integrations/sdk.md).
- OpenAPI 3.1 for V1 (3.2.1 exists; generator support unverified).

## 9. Versioning

`/api/v1` is stable once declared GA (end of Wave 7). Before that, breaking
changes are allowed with notice in the changelog. After GA: additive changes
only; a breaking change creates `/api/v2` with at least 12 months of parallel
support ([`../01-architecture/versioning.md`](../01-architecture/versioning.md)).

**[OBSERVED]** (2026-10-13) **GA is not declared.** Wave 7 delivered a
readiness report, not a declaration: [`ga-readiness.md`](./ga-readiness.md)
lists what GA would cover (132 documented operations, 126 served), four criteria
that are not met (documented surface equals served surface, a changelog, a CI
run on the commit, off-host deployment evidence) and a recommendation to
postpone. The owner decides at G7. Until then the pre-GA rule above applies,
and Wave 7 changed four existing answers (a target outside the caller's role
scope is `404 TARGET_NOT_FOUND`; every `404` leaves no earlier than 50 ms after
the request began; applying a denied plan is `PLAN_DENIED`; cancelling an
operation another client of the same person applied is `PLAN_BINDING_ACTOR`),
as the report lists.

## 10. Query routes (Wave 7)

**[OBSERVED]** (2026-10-13; `packages/contracts/src/rest/routes.ts`,
`packages/application/src/queries.ts`, `apps/server/test/mcp-data.int.test.ts`;
G7 not yet accepted; [ADR-0028](../01-architecture/adr/0028-data-read-lane.md))

| Operation | Route | Notes |
|---|---|---|
| `runQuery` (`query.run`) | `POST /targets/{target}/queries` | one read-only statement in a read-only transaction, with caps |
| `explainQuery` (`query.explain`) | `POST /targets/{target}/explain` | `EXPLAIN` of one read-only statement; the plan is redacted; `ANALYZE` is refused for an agent |
| `cancelQuery` (`query.cancel`) | `POST /targets/{target}/queries/{queryId}/cancel` | cancels one of the caller's own running reads (the same identity, client and grant) |

They are the REST form of the MCP tools `sql_query`, `sql_explain` and
`sql_cancel` and call the same use cases. All three are class `read`: no
plan, no `Idempotency-Key`. They need the scope `data.read:<tier>` and pass the
policy rule `data.read`: on a production target an agent (every caller that is
not a person in the Web App or the first-party CLI,
[`../08-auth-and-security/identity.md`](../08-auth-and-security/identity.md) §11) reads no rows by default,
as `403 DATA_READ_NOT_PERMITTED`. Caps: 500 rows for an agent, 5 000 for a
person, 5 MiB, 60 s. A result over a cap is returned capped with
`truncated: true`. The refusal codes (`QUERY_NOT_READ_ONLY`,
`QUERY_CONSTRUCT_UNSUPPORTED`, `QUERY_PARSE_ERROR`, `QUERY_FAILED`,
`QUERY_TIMEOUT`, `QUERY_RESULT_TOO_LARGE`, `QUERY_CANCELED`,
`DATA_READ_NOT_PERMITTED`, `RATE_LIMITED`, `CAPABILITY_UNAVAILABLE`) are the
contract's `errors` of the routes; `CAPABILITY_UNAVAILABLE` means no
data-read worker runs, never an empty result. Concurrent reads are bounded at
2 per grant (or person), 3 per target and 8 per installation; agents (every
caller but a person in the Web App or the CLI, OD-13) hold at most 2 of a
target's and 6 of the installation's, so agents alone never hold every slot
(owner decision 2026-10-13). Every read is
audited as `data.read` with the normalized statement, never a value, and
before the rows are returned: if the audit cannot be written, no rows are
returned.


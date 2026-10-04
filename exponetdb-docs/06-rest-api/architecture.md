# REST API architecture

| | |
|---|---|
| Status | Baseline (Wave 0), awaiting owner approval |
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
  OpenAPI); no generic query language.
- **Sparse responses**: `?fields=` not supported in V1; responses are designed to
  be small; expensive sub-resources are separate endpoints.
- **Freshness**: every response containing observed state includes
  `observedAt` and `source` (`live`, `sampled`, `cached`) at the level where it
  applies (C-28). A live read that fails returns an error, never an empty
  collection.
- **Concurrency control** for registry and access resources: `ETag` on GET,
  `If-Match` required on PATCH/DELETE (`CONFLICT` on mismatch).

## 3. Mutations

| Class | HTTP pattern | Response |
|---|---|---|
| Registry/access changes (admin) | `POST`/`PATCH`/`DELETE` on the resource, with `Idempotency-Key` | **creates a plan** when the change is consequential (most are): `201 Created` with the plan; applied via `POST /plans/{id}/apply`. Purely cosmetic changes (display names, labels) apply directly. |
| Plans | `POST /targets/{id}/migrations/plans`, `POST /nodes/{id}/plans`, `POST /restores/plans`, … | `201` plan (including denied plans with `decision: deny`) |
| Apply | `POST /plans/{id}/apply` | `202 Accepted` + `Location: /api/v1/operations/{op}` + operation body; `200` with the same body for a repeated call (idempotent) |
| Inline-plan actions | `POST /targets/{id}/sessions/{pid}/cancel` with precondition fields in the body | `200` result or `412 PRECONDITION_FAILED` |
| Long-running status | `GET /operations/{id}` | state machine as in operations-engine.md |

**[DECIDED]** No endpoint executes a consequential mutation without either a
stored plan or an inline-plan precondition token (C-6). The contract test
"every mutating route is registered as an action kind" enforces it.

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

Per principal and per client: token bucket with defaults (reads 20/s burst 100;
plans 2/s; applies 1/s; `data.read` 5/s). `429` with `Retry-After` and
`RATE_LIMITED`. Separate, stricter limits for authentication endpoints.

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

# `@exponetdb/sdk`

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05; first slice implemented in Wave 4 (§6, awaiting G4); Wave 7 note on `/mcp` and GA (§7, 2026-10-13) |
| Applies to | Wave 1 (contracts), Wave 4 onward (generated with each REST addition), Wave 10 (first consumer: REOSA Admin) |
| Read before | [`../06-rest-api/architecture.md`](../06-rest-api/architecture.md), [`../06-rest-api/resources.md`](../06-rest-api/resources.md), [ADR-0018](../01-architecture/adr/0018-contracts-first.md) |

The SDK is a typed client for `/api/v1`. It contains **no business logic**: no
policy evaluation, no plan computation, no retries of non-idempotent calls
without an idempotency key. It is generated from the same contracts the server
uses, so it cannot drift from the API.

## 1. Generation

```
packages/contracts (Zod)
   ├──▶ OpenAPI 3.1 document (committed, CI checks it is current)
   │       └──▶ @exponetdb/sdk types (generated)
   └──▶ JSON Schema (MCP tool I/O), Go types (node protocol)

@exponetdb/sdk = generated types + small hand-written client
```

The hand-written part: authentication, request signing for `private_key_jwt`,
retries with backoff for idempotent `GET`s, automatic `Idempotency-Key`
generation for mutations, cursor pagination iterators, operation waiting, error
mapping. What exists in Wave 4 and what is still planned is in §6.

## 2. Surface

Namespaces follow REST resources (illustrative, final names from the contracts):

| Namespace | Examples |
|---|---|
| `targets` | `list`, `get`, `resolve("reosa/platform/production")` |
| `health` | `get(targetId)`, `history(targetId, window)` |
| `schema` | `get(targetId)`, `fingerprint(targetId)`, `diff(a, b)` |
| `migrations` | `status(targetId)`, `ledger(targetId)`, `plan(targetId, bundles)`, `lint(bundles)` |
| `plans` | `get`, `apply(planId)`, `withdraw` |
| `operations` | `get`, `wait(operationId, { timeoutMs })`, `cancel` |
| `connections` | `list(targetId)`, `summary(targetId)`, `planCancel`, `planTerminate` |
| `locks` | `tree(targetId)` |
| `performance` | `summary(targetId)`, `statements(targetId, window)` |
| `backups` | `status(clusterId)`, `list`, `run`, `planRestore`, `drills` |
| `findings` | `list(targetId, { kind, severity })` |
| `nodes`, `clusters` | `list`, `get`, `planConfig` |
| `audit` | `search` |

Approvals are not in the SDK at all: they happen only in the Web App
([`../08-auth-and-security/authorization.md` §6](../08-auth-and-security/authorization.md#6-human-only-and-client-kind-restrictions)).
Break-glass activation and `critical` applies are exposed only to first-party
human sessions (CLI); service accounts never get them (the server refuses them
anyway).

## 3. Example (documentation only)

```ts
import { ExponetDB } from "@exponetdb/sdk";

const exponetdb = new ExponetDB({
  baseUrl: "https://db.exponet.cloud",
  auth: { kind: "serviceAccount", clientId: process.env.EXPONETDB_CLIENT_ID, keyId: "k1", privateKey: loadKey(), scopes: ["targets.read", "diagnostics.read"] },
});

const target = await exponetdb.targets.resolve("reosa/platform/production");
if (!target.ok) throw new Error(target.error.code); // a denial stays a denial
const health = await exponetdb.health.get(target.value.id);

if (health.ok) {
  // health.value.state: "healthy" | "degraded" | "unhealthy" | "unreachable" | "unknown" | "suspended"
  // health.value.source and health.value.observedAt are always present
} else {
  // health.error.code is a stable error code, e.g. "CONTROL_PLANE_DEGRADED"
}
```

Results are `Readable<T>`-shaped (`{ ok: true, value } | { ok: false, error }`),
mirroring the server's truthfulness rules: a failed call never looks like an
empty list.

## 4. Authentication modes

| Mode | For | Notes |
|---|---|---|
| Service account with `private_key_jwt` | server-side integrations (REOSA Admin), CI | short-lived access tokens obtained automatically; keys rotated by the consumer |
| API key (`exak_…`) | simple scripts, read-only dashboards | scoped and target-restricted; prefer service accounts for anything long-lived |
| User token (OAuth authorization code + PKCE) | first-party CLI | device or loopback flow |

The SDK never accepts or stores database credentials.

## 5. Compatibility

- The SDK's major version follows the API version (`/api/v1` → SDK 1.x).
- Each SDK release states the minimum server version; the server reports its
  contract version in `GET /installation`; the SDK warns on mismatch.
- Runtimes: Node.js 22+ and Bun on servers. Browser use is unsupported by
  design (tokens must not reach browsers): the SDK's token transport stays
  Node-only.
- **[OBSERVED]** (Wave 8 Phase 1, `82669c5`, [order](../14-roadmap/orders/wave-8-order.md)
  D10, [ADR-0032](../01-architecture/adr/0032-web-app-browser-transport.md))
  A browser-safe subpath `@exponetdb/sdk/operations`
  (`packages/sdk/src/operations.ts`) exports only the generated `OPERATIONS`
  table and the generated wire types (§6): no transport, no `node:crypto`, no
  `jose`, no token handling; the generated module imports nothing
  (`packages/sdk/test/operations.test.ts`). It is what the Web App's own
  client (same-origin `fetch`, session cookie plus CSRF header, never an
  `Authorization` header) types itself with; the boundary rule
  `web-sdk-operations-only` keeps the Web App off the SDK's entry point.

## 6. The Wave 4 slice

**[DECIDED]** (Wave 4, order §124 to §126, §205 to §208, §264 to §267,
§322 to §325; awaiting G4)

`packages/sdk` is version `1.0.0-alpha.1` (private, not published; the major
follows `/api/v1`). Node.js 22+ and Bun; no browser build (the
`./operations` subpath of §5, **[OBSERVED]** since Wave 8 Phase 1, is a table
and types, not a client).

**Generation.** `tooling/generators/sdk.ts` turns the committed
`openapi.json` into `src/generated/api.ts`: one type per component schema, an
`Operations` interface (params, query, body, response per `operationId`) and
the `OPERATIONS` table (method, path, success status, wave, action).
`bun run generate` writes it; `bun run verify:generated` fails when it is not
current. The hand-written part is four small files: `result.ts`, `auth.ts`,
`transport.ts`, `client.ts`.

**Surface.** Namespaces `installation` (`get`, `compatible`), `products`,
`environments`, `projects`, `targets` (`list`, `pages`, `all`, `get`,
`resolve`), `clusters`, `health`, `findings`, `schema` (`overview`,
`fingerprint`, `search`, `object`, `diff`) and `drift` (`check`). There is
no approval, access, credential or registry-management namespace: those
are human-only or Web App operations, and a key or token for a service
account reaches none of them anyway (the server refuses).
`targets.resolve(path)` sends the path to the server as one percent-encoded
segment: the SDK never parses a path into a host or a database, never
falls back to another target and never matches "nearly" (order §166, §194).

**Results.** Every call returns `{ ok: true, value } | { ok: false, error }`.
`error` keeps the problem document's catalog fields only: `code`, `status`,
`requestId`, `retryable`, `title`, `message`, `details`, `remediation`,
`operationId`, `planId` and `retryAfterSeconds`; anything else in a body
(a stack, a stray field) is dropped. The SDK's own codes:
`TRANSPORT_FAILED` (no answer; `retryable` only for a `GET`, because a
mutation that did not answer may have run), `RESPONSE_INVALID` (an answer
that is not the contract's, never turned into an empty value) and
`CLIENT_AUTHENTICATION_FAILED` (the token endpoint refused the assertion;
only its OAuth `error` code is kept, never `error_description`).

**Retries.** A `GET` is retried on no answer and on 429, 502, 503 and 504,
at most three attempts, backing off 200 ms then 400 ms, or `Retry-After`
capped at 5 s. A mutation is sent exactly once: no SDK retry, whatever the
answer. An `Idempotency-Key` is sent when the caller passes one; automatic
key generation **[PLANNED]** arrives with the first plan and apply
namespaces (Wave 6), which the Wave 4 slice does not have.

**Pagination.** `pages()` is an async iterator over the server's cursor and
stops at the first error. `all()` collects at most `maxItems` (default
10,000) and stops asking once it has them; a failed page returns the error,
never a partial list. A repeated cursor, or more than 10,000 pages, ends the
listing with `RESPONSE_INVALID` instead of looping. Nothing walks a catalog
unless the caller calls `pages()` or `all()`.

**Shapes and paths** (hardened after the G4 adversarial review). The
generated operation table names each success body's shape (`paged`,
`object`, `array`, `none`); a body that is not that shape, or not JSON, is
`RESPONSE_INVALID`, never a value. A path parameter of `.` or `..` is
refused before sending (a URL parser would drop the segment and reach
another route). No request follows a redirect (`redirect: 'error'`), so a
credential or a client assertion never travels to another origin. The base
URL is `https`, or `http` only on `localhost`, `127.0.0.1` or `[::1]`. A
service-account key must fit its algorithm (RSA keys hash with SHA-256) and
allow signing, checked when the client is built.

**Authentication** (§4 above, order §125, §207, §208).

- API key: `Authorization: Bearer exak_…`, held in memory as given; never
  in a URL, never logged; anything that is not an `exak_` key (a connection
  string, for instance) is refused at construction.
- Service account: the caller passes a WebCrypto private key (it may be
  non-extractable) with its `kid`; nothing is stored on disk. The assertion
  is signed with `jose` (no custom JOSE): `iss` = `sub` = the client id,
  `aud` = the issuer origin as one string, `iat`, `exp` one minute later
  (the server accepts at most five), a fresh random `jti` per assertion,
  algorithm ES256, ES384, EdDSA, RS256 or PS256 derived from the key. The
  token request is `client_credentials` with `resource=<origin>/api`; the
  SDK never asks for `/mcp`, and there is no refresh token. The access token
  stays in memory until 30 s before `expires_in` runs out; concurrent calls
  share one token request. A 401 on an API call drops the cached token, and
  the same request is sent once more with a fresh token (the server
  authenticates before anything runs, so nothing was executed); a second
  401 is returned.
- The base URL is `https` (plain `http` only for `localhost`) and carries
  no credentials.

**Compatibility.** `installation.compatible()` compares the server's
`contracts.restApi` with `v1`. `GET /installation` is read at installation
scope (`targets.read` through a global binding); an account bound only to
a project or a target gets `PERMISSION_DENIED`, which the SDK reports
instead of assuming compatibility.

**Evidence.** `packages/sdk/test/sdk.test.ts` (scripted `fetch`: encoding,
retries, no mutation retry, error mapping, pagination bounds, assertion
claims verified with `jose` for all five algorithms, token cache, single
flight, renewal and refusal, and the leak check: no Wave 4 response type
reaches a field named `password`, `connectionString`, `dsn` or
`credentialSecret`, and no response reaches `CredentialSubmission`, the
write-only input of `POST /clusters/{id}/credentials/{role}`).
`apps/server/test/http-registry.int.test.ts` runs the SDK over real HTTP
against the public app on a TCP listener with real PostgreSQL 17: a
target-bound API key reads list, get, resolve, health, schema, fingerprint
and findings of its one target and is denied production, the schema without
`schema.read`, and the administration routes; an unknown key gets 401 after
one request; a project-bound service account authenticates with
`private_key_jwt`, uses one `/api` token for all calls, is denied
production by its tier restriction, and a key it never registered is
refused at the token endpoint before any API call.

## 7. Wave 7: `/mcp` and GA

**[OBSERVED]** (2026-10-13; `packages/sdk/package.json`,
`packages/sdk/src/auth.ts`, `packages/sdk/src/generated/api.ts`; G7 not yet
accepted)

- The SDK does not cover `/mcp`. It is a client of `/api/v1` only: its token
  request names `resource=<origin>/api`, and no namespace speaks the MCP
  protocol. AI clients use their own MCP client and ExponetDB's OAuth
  ([`../05-mcp/architecture.md`](../05-mcp/architecture.md)); the reference
  MCP client in `@exponetdb/testkit/mcp` is a test harness, not a product.
- The generated `OPERATIONS` table lists the Wave 7 routes of the data
  reads (`runQuery`, `explainQuery`, `cancelQuery`); the hand-written
  namespaces are those of §6 (`installation` to `drift`) and have none for
  them.
- GA of `/api/v1` is **not declared**. The SDK stays `1.0.0-alpha.1`
  (private, not published); the readiness report is
  [`../06-rest-api/ga-readiness.md`](../06-rest-api/ga-readiness.md) and the
  owner decides.

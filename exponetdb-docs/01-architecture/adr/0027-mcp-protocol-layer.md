# ADR-0027: The MCP protocol layer: the official TypeScript SDK inside ExponetDB-owned edges

| | |
|---|---|
| Status | **Accepted for development** under the owner's Wave 7 order (§9); part of the G7 evidence the owner accepts or rejects with G7 |
| Date | 2026-10-12 |
| Related | [ADR-0015](./0015-oauth-protected-mcp.md) (MCP behind ExponetDB's authorization server), [ADR-0018](./0018-contracts-first.md) (contracts first), [ADR-0022](./0022-opaque-tokens.md) (opaque tokens, live lookup); [`../../05-mcp/architecture.md`](../../05-mcp/architecture.md), [`../../05-mcp/protocol-baseline.md`](../../05-mcp/protocol-baseline.md); [G7 record](../../14-roadmap/gates/7.md) §5.2 (spike) |

## Context

`/mcp` must serve two protocol eras on one URL: **modern** (revision
2026-07-28: stateless, a per-request `_meta` envelope, `server/discover`,
multi round-trip requests with `input_required`) and **legacy** (2025-11-25
and 2025-06-18: an `initialize` handshake, optional sessions, server-sent
requests on a stream). [`architecture.md` §8](../../05-mcp/architecture.md#8-implementation-notes)
planned the official TypeScript SDK *if* it serves both eras, otherwise a
thin JSON-RPC layer of ExponetDB's own. A time-boxed spike on 2026-10-12
(outside the repository; results in the G7 record §5.2) checked the
condition.

Whatever carries the protocol, the security-relevant decisions stay
ExponetDB's: who the caller is, what the caller may see and do, what is
logged and audited, what leaves the server. The order's decision rule: a
dependency that does not let the host (1) process each request without
hidden per-process state, (2) authenticate per request and authorize per
tool call without the library holding or forwarding tokens, filter
`tools/list` per request, and (3) check header-body agreement, `Origin`,
`Accept`, body size and JSON depth itself, does not become part of the
security-relevant path.

## Decision

### 1. The SDK, exactly pinned

- `@modelcontextprotocol/server` **2.3.1** (published 2026-10-05,
  Apache-2.0, Node ≥ 20; runtime dependencies `zod ^4.2` and
  `@modelcontextprotocol/core` 2.3.1; `ajv` 8.18.0 and `fast-uri` 3.1.0 are
  compiled into its distribution, so lockfile and SBOM tools do not see
  them: recorded here and in [`package-architecture.md`](../package-architecture.md)).
  Dependency of `apps/server` only.
- `@modelcontextprotocol/client` **2.3.1**: the reference client and test
  harness, dependency of `packages/testkit` only.
- Not used: `@modelcontextprotocol/hono` (a thin adapter; mounting needs one
  line), `@modelcontextprotocol/node` (a second `@hono/node-server`),
  `@modelcontextprotocol/server-legacy` (the frozen HTTP+SSE pair) and the
  v1 package `@modelcontextprotocol/sdk` (maintenance line without
  2026-07-28; stays forbidden in `tooling/boundaries/graph.json`).
- License: Apache-2.0 permits use in a proprietary product; the notice
  file ships with the package in `node_modules` and in the server bundle's
  third-party notices.

### 2. What the SDK does

`createMcpHandler(factory, { legacy: 'stateless', responseMode: 'auto' })`
mounted at `POST /mcp` carries the JSON-RPC framing, the era
classification of a parsed request (an envelope in `_meta` is modern,
otherwise legacy), the modern header validation (`MCP-Protocol-Version`,
`Mcp-Method`, `Mcp-Name` against the body, Base64 sentinel decoding,
`-32020`), the `-32602` for a missing envelope key, `server/discover`,
`initialize` for the legacy leg, `subscriptions/listen` (acknowledged and
completed at once: no capability declares change notifications),
notifications answered `202`, `resultType`, `ttlMs`/`cacheScope` from cache
hints, the `input_required` result with its `-32021` capability gate, and
`404`/`-32601` for unknown methods. The factory builds a **fresh low-level
`Server` per HTTP request** (no instance, transport or cache is shared
between requests or principals).

### 3. What ExponetDB owns (the edges)

In this order, each with its own answer and test, before the SDK sees
anything (the order §10):

1. **Method and path.** `POST /mcp` only. `GET` and `DELETE` answer `405`
   with `Allow: POST` before authentication (the SDK's `405` has no
   `Allow`); other methods `405`. `/mcp/` and every other spelling answer
   the same `404` as any unknown path, never a redirect.
2. **`Origin`.** Absent: allowed (native clients send none). Present: must
   equal the origin of `EXPONETDB_PUBLIC_URL`, one of the configured extra
   origins, or, when the public URL is a loopback origin (the lab), a
   loopback origin on the same port; exact comparison, `null` refused.
   Otherwise `403` with a JSON-RPC error without `id` and no CORS header.
3. **`Host`.** Must name the public URL's host and port (on a loopback
   public URL: any loopback name with that port); otherwise `421`. Then
   availability: until the stored role matrix is verified, `503` with
   `Retry-After` (as `/api/v1`: nothing is authorized before).
4. **`Content-Type`** `application/json` (`415`), **`Accept`** naming
   `application/json`, `text/event-stream`, `application/*` or `*/*`
   (`406` only when none fits).
5. **Declared length** against the body tier (`413`).
6. **Bearer authentication** through the shared helper also used by
   `/api/v1` (audience `mcp`), live per request (§6).
7. **Bounded, streamed read** with a deadline (`408`), strict UTF-8 and
   JSON (`-32700`; a duplicate key, a depth or element overrun `-32600`),
   exactly one JSON-RPC object (an array is `-32600`). A modern request
   names its tool in `Mcp-Name`, so only a bundle tool reads up to the
   bundle tier; a legacy request names none, so a body over the general
   tier takes one of two large-body slots of its grant and is checked
   against the tool in the body after parsing.
8. **Classification** by ExponetDB's own table (the oracle the tests use
   against the SDK; [`protocol-baseline.md` §4](../../05-mcp/protocol-baseline.md#4-classification-of-a-request)):
   the version ladder ExponetDB answers itself (an unsupported or legacy
   version in a modern envelope is `-32022` naming every served version).
9. **Rate limiting** by grant, identity and tool class (`429` with
   `Retry-After`): token buckets in the memory of `serve` (owner decision
   9; `contracts` `MCP_RATE_LIMITS`), never in the Control Store; a restart
   resets them, and running a second `serve` instance needs an edge
   limiter first (deployment.md §1). A notification is then acknowledged with `202` by the
   edge itself: a stateless instance has nothing it could act on (a
   `notifications/cancelled` would reach a fresh instance; closing the
   connection is what cancels a request).
10. **Dispatch** to the SDK with the parsed body and a **reduced request**:
    a new `Request` carrying only `content-type`, a normalized `accept`
    and the three `Mcp-*`/`MCP-Protocol-Version` headers. The SDK never
    sees `Authorization`, cookies, `Origin`, `X-Forwarded-*` or
    `Mcp-Session-Id`; it gets the authentication *result* as `authInfo`
    (no token value). The whole request is bounded (`504` after 90 s; an
    accepted operation continues and is observed with `operation_get`).
    The factory checks that the SDK put the request in the era the edge
    classified; when not, the instance serves nothing and the mismatch is
    logged (the table is the oracle, the SDK never overrides it).

ExponetDB also owns `tools/list`, `tools/call`, `resources/list` and
`resources/read` on the low-level `Server`: one tool registry built from
the contracts validates arguments against the contract schemas (the
low-level server does not), dispatches to exactly one application use
case, validates the result against the strict output schema, caps and
sanitizes it, and maps every refusal to a tool error. No handler throws
through to the SDK (which would put the raw message on the wire as
`-32603`).

### 4. Versions

Modern `2026-07-28`; legacy `2025-11-25` and `2025-06-18` (owner decision
3). The low-level server's `supportedProtocolVersions` is exactly these.
`initialize` offering any other version is answered with `2025-11-25`
(the legacy rule: answer another supported version; the client decides).
A request whose `MCP-Protocol-Version` names `2025-03-26` or `2024-11-05`
is `400` with `-32022` and every served version. A request without the
header and without an envelope is served as legacy (the 2025-11-25
transport rule; VS Code sends the header only to metadata requests).
`server/discover` lists the modern revision only; `-32022` lists all
served versions. ExponetDB's promise for legacy (removal no earlier than
twelve months after an announcement and after checking the client matrix)
is the owner's, not the specification's: the specification sets no sunset
date for a revision.

### 5. Legacy without sessions

Owner decision 4: the legacy leg is stateless. No `Mcp-Session-Id` is
issued or returned; one sent by a client is dropped at the edge (§3 item
10) and never authenticates anything; `DELETE` is `405`. A legacy client's
capabilities are known only inside its `initialize` request, so ExponetDB
never sends a server-to-client request on the legacy leg: the approval
link is always in the result (text block and `structuredContent`).
Legacy URL elicitation is not offered.

### 6. Authentication result, never the token

The edge authenticates with `application.authenticateBearer(token,
'mcp')`: hash lookup of the opaque token with grant, client and identity
state, live on every request, no cache (the Wave 3B decision; ADR-0022's
"short in-process cache" sentence is corrected). An `/api` token at `/mcp`
and every other token failure are the same `401` with
`error="invalid_token"` and the same body. The SDK receives `authInfo`
with a placeholder token (`"redacted"`), the client id, the granted scopes
and `resource` = the `/mcp` resource URI; the tool registry takes the
caller from ExponetDB's own request context, never from `authInfo`.

### 7. `requestState`: AEAD, ExponetDB's codec

The SDK's `createRequestStateCodec` is HMAC (integrity without
confidentiality) and is not used. ExponetDB's codec seals the state with
AES-256-GCM under a dedicated installation key of the purpose
`mcp.request_state_key` (a secret of the `auth` consumer, like the other
installation keys; one purpose per key; the additive Wave 7 bundle admits
the purpose). Format `rs1.<secret version>.<base64url(nonce ‖ ciphertext ‖
tag)>`; the associated data binds the format and key version. The sealed
payload holds the identity, client and grant, the method and tool, the
JCS digest of the arguments, the operation id the elicitation is about,
the expiry (at most ten minutes) and a random id. Any failure
(decryption, principal, tool, digest, expiry) answers the same tool error
without saying why. The only state ExponetDB puts in it, the approval
round of `plan_apply`, has no effect when repeated (the retry reads the
operation), so no single-use store is needed. Rotation writes a new
secret version; verification accepts the newest two versions.

**Sealed list cursors** (Wave 7 Phase 5, order §22). A cursor handed to an
agent is the use case's own cursor sealed the same way under a second key,
`mcp.cursor_key` (`apps/server/src/interfaces/mcp/cursor.ts`): format
`c1_<base64url(nonce ‖ ciphertext ‖ tag)>` (the contracts' cursor
alphabet), the plaintext holds the inner cursor and an expiry of one hour,
and the associated data binds the grant, the tool (or `resources/list`)
and the JCS digest of the filters (every argument except the cursor and
the page size). A cursor of another grant, tool or filter set, an edited
or an expired one does not open and is answered `VALIDATION_FAILED` on
`/cursor` ("list again without a cursor"); it never authorizes anything
(the use case decides every page). Both keys are created on first use by
the additive bundle `mcp-keys` (control-database.md §5).

### 8. Responses

The handler runs with `responseMode: 'auto'`: a single JSON body unless a
related message precedes the result, and no ExponetDB handler sends one in
Wave 7, so every modern answer is one JSON object (`'json'` would do the
same but prints a console warning outside the structured logger). The edge shapes the answer to
what the client accepts: a single-message SSE answer of the legacy leg
becomes `application/json` when the client accepts JSON; a JSON answer
becomes a one-event SSE stream for a client that accepts only
`text/event-stream`. Every answer carries `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff`, `X-Request-Id`, no cookie, and streams
`X-Accel-Buffering: no`.

### 9. Errors

Transport rejections that ExponetDB makes use standard JSON-RPC codes
(`-32700`, `-32600`) or the specification's (`-32020`, `-32021`,
`-32022`), never the legacy range `-32000…-32019`. Tool refusals are tool
execution errors (`isError: true`) with the ExponetDB catalog code; a
missing scope is `403 insufficient_scope` with the challenge; nothing else
is ever a `403` (red line 8). The full table is in
[`protocol-baseline.md` §5](../../05-mcp/protocol-baseline.md#5-situation-http-status-json-rpc-code-body).

### 10. Cache hints

`tools/list` and `resources/list` are `private` with `ttlMs` 60 000 (a
revoked grant or a new scope is visible within a minute; every call is
authorized again anyway); static resources are `public` with one hour;
`server/discover` `private`, 60 000.

## Spike results (2026-10-12)

| Step | Result |
|---|---|
| Mount in Hono with host `authInfo` | works without SDK changes |
| Low-level `Server` with host-owned tools | works; `tools/list` served as given |
| Era matrix (curl, SDK client `legacy` and `auto`) | both eras answered as the specification says, apart from the gaps the edge closes (§3) |
| Memory | heap flat after 2 × 40 000 requests per era |
| Production bundle | `bun build --target=node` 0.91 MB, runs under Node 24 |
| Traefik, conformance suite, SSE load | after the implementation (G7 record) |

**Go**: steps 1 to 3 passed without patches to the SDK. Step 6 (the real
Traefik) cannot run in the lab, which has no Traefik; it is covered by a
disposable Traefik container in the hardening suite.

## SDK traps and their countermeasures

| # | Trap | Countermeasure | Test |
|---|---|---|---|
| 1 | Audit inside tool handlers misses refused calls | the edge logs every JSON-RPC call and its outcome; ExponetDB owns `tools/call` | request-log and audit suite |
| 2 | Output validation keeps extra keys | output parsed with the contract schema (unknown keys stripped) before it is sent; advertised `additionalProperties: false` | tool contract suite |
| 3 | Stateless legacy has no back channel | no server-to-client request on legacy; the link is in the result | protocol suite |
| 4 | `tools.listChanged` defaults to `true` and holds listen streams open | `{ tools: { listChanged: false } }` | protocol suite (`subscriptions/listen`) |
| 5 | `acceptedContent()` reads form answers only | the retry reads the operation from `requestState`; elicitation answers are never decisions | approval suite |
| 6 | Reading the body in middleware breaks `handler.fetch` | the edge passes `parsedBody` and a reduced request without a body | endpoint tests |
| 7 | Thrown errors reach the wire raw | every tool handler returns a sanitized tool error | tool contract suite |
| 8 | Low-level server does not enforce `inputSchema` | the registry validates against the contract | tool contract suite |
| 9 | AJV recompiles schemas without `$id` | no AJV on the request path: validation with the contract's Zod schemas | not applicable |
| 10 | `createRequestStateCodec` is HMAC | own AEAD codec (§7) | request-state tests |
| 11 | The whole body is buffered | the edge's bounded streamed read decides first (§3 item 7) | hardening suite |
| 12 | Open SDK issues (405 without `Allow`, `-32603` for broken params, RFC 9728 paths, inlined `fast-uri`, URI templates) | `405` at the edge; registry validation answers `-32602`; PRM served by ExponetDB; no resource templates | protocol and endpoint suites |
| 13 | Churn (14 versions in six months) | exact pins; the update process below | — |

## Rejected options

- **(b) v1 SDK or a wrapper on it** (FastMCP, `@hono/mcp`, mcp-handler):
  no 2026-07-28.
- **(c) An own thin layer**: two to three person-weeks for the header
  ladder, envelope rules, `server/discover`, MRTR, SSE framing and the
  legacy handshake, and every future revision again. It stays the fallback
  if an advisory or a release makes the SDK unusable; the classification
  table and the conformance suite are written so that they would test it
  unchanged.

## Update process

A pin moves only in its own commit: read the release notes and advisories
of `modelcontextprotocol/typescript-sdk`, run the protocol, tool contract,
adversarial and conformance suites, rebuild the bundle and run the image
smoke test. An advisory that reaches a code path ExponetDB uses blocks the
release until a fixed version is pinned or the edge closes the path; if
neither is possible within the advisory's window, option (c) replaces the
SDK behind the same edges.

## Consequences

- `tooling/boundaries/graph.json` allows `@modelcontextprotocol/server` in
  `apps/server` and `@modelcontextprotocol/client` in `packages/testkit`;
  `@modelcontextprotocol/sdk` and `ws` stay forbidden.
- The MCP interface is a thin adapter: business logic, authorization and
  policy stay in `packages/application` and the engine (C-9).
- The legacy era costs nothing at runtime but a fresh instance per request.

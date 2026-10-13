# MCP protocol baseline

| | |
|---|---|
| Status | Wave 7, in progress (2026-10-12); the baseline the G7 protocol suite tests |
| Applies to | `POST /mcp` ([`architecture.md`](./architecture.md)), [ADR-0027](../01-architecture/adr/0027-mcp-protocol-layer.md) |
| Sources | read on 2026-10-12 from the primary sources listed in §7; every row is **[OBSERVED]** unless marked |

This document fixes which normative requirements of the two protocol eras
ExponetDB implements, where, and which test proves each. Where the
specification and an ExponetDB document disagree, the specification wins
and the document is corrected in the same change. Revisions: **2026-07-28**
is the current revision (no newer revision or draft change existed on
2026-10-12); **2025-11-25** and **2025-06-18** are earlier revisions the
site keeps unchanged. The site labels only the current revision; "final"
for the earlier ones follows from its definition of past revisions.

Test locations: `protocol` = `apps/server/test/mcp-protocol.test.ts` (the
endpoint with a fixture registry, in process), `auth` =
`apps/server/test/mcp-auth.int.test.ts`, `tools` =
`apps/server/test/mcp-tools.int.test.ts`, `contract` =
`packages/contracts/test/mcp-tools.test.ts`, `state` =
`apps/server/test/mcp-request-state.test.ts`, `conformance` = the pinned
conformance suite (§6). A row is proven only when its test ran green on the
recorded commit ([G7 record](../14-roadmap/gates/7.md)).

## 1. Modern revision 2026-07-28: what ExponetDB implements

IDs follow the session's source extract (M-n).

| ID | Requirement (in our words) | Implementation | Test |
|---|---|---|---|
| M-1, M-2 | Every request carries `_meta` with `io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities` (MUST); missing → `400` + `-32602` | SDK envelope check after the edge's classification | protocol |
| M-3 | No state across requests; nothing inferred from earlier requests | fresh server per request; stateless edge | protocol |
| M-4 | A request needing an undeclared client capability → `400` + `-32021` with `data.requiredCapabilities` | SDK gate; ExponetDB never asks for an undeclared kind (the approval link is always in the result) | protocol |
| M-5 | `io.modelcontextprotocol/serverInfo` in every result's `_meta` (SHOULD); `clientInfo` never a security input | SDK; `clientInfo` logged as untrusted only | protocol |
| M-6 | Every result has `resultType` (`complete`, `input_required`) | SDK | protocol |
| M-7 | Request ids string or integer, never `null`; no response to a notification | SDK; the edge refuses a body with `id: null` (`-32600`) | protocol |
| M-8 | Codes `-32020…-32099` reserved, `-32000…-32019` legacy (SHOULD NOT use); never `-32002` or `-32042` on the modern era | edge uses `-32700`, `-32600` and the spec codes only | protocol |
| M-9 | Unsupported version → `400` + `-32022`, `data: {supported, requested}` | edge: with a modern envelope `supported` is what `server/discover` lists (the conformance suite checks that the two agree); without one, every served version (§4); `requested` echoes the requester's own value as SEP-2575 requires (the conformance suite checks it), back to that requester only, bounded to 64 printable ASCII characters (anything else is `"unrecognized"`), and never logged or audited (Phase 9 adversarial review) | protocol, conformance, adversarial (headers) |
| M-10 | `server/discover` with `supportedVersions`, `capabilities`, `ttlMs`, `cacheScope`, `instructions` | SDK; `supportedVersions` = the modern revision only | protocol |
| M-11 | Extensions only when both sides declare them | none declared in Wave 7 (owner decision 8: no Tasks) | protocol |
| M-12, M-13 | Dual era: a modern envelope is served statelessly; `initialize` selects legacy | edge classification (§4), SDK | protocol |
| M-14 | One endpoint path with POST | `POST /mcp` | protocol |
| M-15 | `Origin` validated; present and invalid → `403` | edge, before authentication | protocol, auth |
| M-16 | Client sends `Accept` with both media types | edge tolerates `application/json`, `application/*`, `*/*` and shapes the answer; `406` only when nothing fits | protocol |
| M-17 | One JSON-RPC request or notification per POST | edge (`-32600` for an array or a response object) | protocol |
| M-18 | Notification → `202`, no body | SDK | protocol |
| M-19 | Answer as `application/json` or `text/event-stream` | `responseMode: 'auto'` (no related message is ever sent, so one JSON body) plus the edge's shaping | protocol |
| M-20 | On SSE: only related notifications, never requests; `X-Accel-Buffering: no` | ExponetDB sends no notification on the modern era in Wave 7; header set on streams | protocol |
| M-21 | Closing the stream cancels the request; nothing more is sent | the request's `AbortSignal` reaches the use case; an accepted operation is never canceled by it | tools |
| M-22 | `MCP-Protocol-Version` equals the envelope's version; mismatch → `400` + `-32020` | SDK | protocol |
| M-23, M-29 | Unknown or removed method (`ping`, `logging/setLevel`, `roots/*`, `initialize` with an envelope) → `404` + `-32601` | SDK | protocol, conformance |
| M-24 | Missing version header with an envelope → `400` + `-32020` | SDK | protocol |
| M-25, M-26 | `Mcp-Method`, `Mcp-Name` required and equal to the body (Base64 sentinel decoded); names case-insensitive, values case-sensitive | SDK | protocol |
| M-27 | `x-mcp-header` | **not used** (§2) | contract (no schema carries it) |
| M-28 | GET/DELETE `405`; `Mcp-Session-Id` and `Last-Event-ID` ignored, never minted | edge (`405` with `Allow: POST` before authentication; both headers dropped) | protocol |
| M-30, M-31 | `ttlMs` (≥ 0) and `cacheScope` on complete results of discover and lists; retried MRTR answers not cached; `cacheScope` is no access control | cache hints (ADR-0027 §10); `Cache-Control: no-store` on every answer | protocol |
| M-33 | `subscriptions/listen`: acknowledgment first (`notifications: {}`), then completion | SDK with `listChanged: false` | protocol, conformance |
| M-34, M-36 | `input_required` only on `tools/call` (and `resources/read`, `prompts/get`); at least one of `inputRequests`, `requestState`; retry with a new id, `inputResponses`, the same `requestState` | `plan_apply` on a plan that needs a human approval when the client declared `elicitation.url` | tools, state |
| M-35 | `requestState` integrity-protected and bound (principal, expiry, request identity) | AEAD codec (ADR-0027 §7) | state |
| M-37, M-38 | URL elicitation `{mode: "url", url, message}`; no sensitive data or pre-authenticated URL; the person who opens it is verified by the server | `approvalUrl` = `<public origin>/approvals#operation=op_…`; the page signs the person in itself; the message is a fixed server text | tools, approval E2E |
| M-39 | `tools` capability; `tools/list` varies only with the request's authorization; deterministic order | registry filtered per grant, sorted by name | tools, contract |
| M-40 | Tool names 1 to 128 of `A-Z a-z 0-9 _ - .` (SHOULD) | stricter: `[a-z0-9_]`, at most 48 (client limits) | contract |
| M-41 | `inputSchema` object root, valid JSON Schema 2020-12; no network `$ref` | generated from the contracts, self-contained, flat object root | contract |
| M-42 | `structuredContent` conforms to `outputSchema`; a serialized text block SHOULD follow | registry validates and adds the text block | tools, contract |
| M-43 | Unknown tool → `-32602`; execution errors as `isError: true`; validate, authorize, rate-limit, sanitize | registry and result layer | tools |
| M-44 | Resources: not found → `-32602` (modern), never empty `contents` | resource host (`apps/server/src/interfaces/mcp/resources.ts`): unknown URI or a target the caller may not read is "not found", with `data.uri` when the URI is plain and short | protocol, conformance |
| M-45 | Logging deprecated: `notifications/message` only when the request asked | **not implemented** (§2) | protocol |
| M-46 | Progress only for a token of an active request | **not used** in Wave 7 (§2) | — |
| M-47, M-48 | Protected resource metadata (RFC 9728); `401` with `resource_metadata` and `scope`; never `offline_access` | `auth` package metadata; edge challenge | auth |
| M-49 | `403 insufficient_scope` with every scope the operation needs in one challenge | edge; the challenge also names the scopes already held (legacy clients replace rather than merge) | auth |
| M-50 | Audience validation; no token passthrough; tokens only in `Authorization` | shared bearer helper (audience `mcp`); no upstream calls | auth |
| M-51 | A handle is never authentication | every id is authorized again by the use case (OD-26) | tools, adversarial |

## 2. Modern revision: deliberately not implemented

| Part | Why |
|---|---|
| Prompts (`prompts/*`) | none offered in V1 ([`tool-catalog.md` §11](./tool-catalog.md)) |
| Sampling, roots, logging | deprecated in 2026-07-28; ExponetDB never asks a client's model |
| Tasks extension | owner decision 8: the operation is the durable handle |
| Change notifications | `listChanged: false`; the list changes only with a release or a grant change |
| Resource templates, completion | no templates (open SDK URI-template issues; no need) |
| `x-mcp-header` / `Mcp-Param-*` | headers are visible to intermediaries; no parameter is worth exposing |
| Progress notifications, SSE answers by default | no Wave 7 tool streams; answers are single JSON objects |

## 3. Legacy revisions 2025-11-25 and 2025-06-18

| ID | Requirement | Implementation | Test |
|---|---|---|---|
| L-1, L-2 | `initialize` answers `protocolVersion`, `capabilities`, `serverInfo`, `instructions`; a supported version is echoed, another one is answered with a supported version | SDK with `supportedProtocolVersions` = 2026-07-28, 2025-11-25, 2025-06-18; any other offer is answered with 2025-11-25 | protocol |
| L-4 | GET: SSE or `405` | `405` with `Allow: POST` | protocol |
| L-5 | `Origin` → `403` when present and invalid | edge (both eras) | protocol |
| L-6 | One message per POST; notification → `202`; batching removed in 2025-06-18 | edge (`-32600` for an array); SDK | protocol |
| L-7 | Answer JSON or SSE; a dropped stream is not a cancellation | edge shaping; `notifications/cancelled` cancels the request | protocol |
| L-8 | Sessions optional; `DELETE` MAY be `405` | stateless (owner decision 4): no `Mcp-Session-Id`, `DELETE` `405` | protocol |
| L-9 | Missing `MCP-Protocol-Version` → assume 2025-03-26 (SHOULD); invalid or unsupported → `400` | a request without the header is served as legacy; `2025-03-26` or `2024-11-05` named in the header → `400` + `-32022` | protocol |
| L-10 | `ping` answered `{}` | SDK (legacy only) | protocol |
| L-11 | `notifications/cancelled` cancels a request | stateless: the notification reaches a fresh instance with nothing to cancel and is acknowledged `202`; closing the connection aborts the request's signal | protocol |
| L-13 | `structuredContent` an object; `outputSchema` object root | every output schema has an object root | contract |
| L-14 to L-17 | Elicitation as a server request on the stream; `-32042`; `notifications/elicitation/complete` | **not used**: stateless legacy has no back channel; the link is in the result | protocol |
| L-18 | Resource not found `-32002` (SHOULD) | the SDK sends `-32602` on every revision; the edge turns a legacy `resources/read` miss into `-32002` | protocol |
| L-19 | Authorization on every request; `403` scopes list held and new scopes | same edge as modern | auth |
| L-20 | Request ids unique within a session | no sessions | — |

## 4. Classification of a request

ExponetDB decides the era of every POST before anything else runs, with a
pure function (`apps/server/src/interfaces/mcp/classify.ts`). This table is
the oracle of the protocol suite; the SDK's own classification is checked
against it. The specification leaves the rows marked **[DECIDED]** open
(source extract §4); ExponetDB's choice is recorded here.

| Input | Answer |
|---|---|
| `initialize` (any offered version) | legacy: supported version echoed, otherwise answered with 2025-11-25 |
| `server/discover` with envelope and header 2026-07-28 | `DiscoverResult` |
| envelope with `protocolVersion` 2026-07-28 and the matching header | modern |
| envelope, header missing or different | `400` + `-32020` |
| envelope without `protocolVersion` or `clientCapabilities` | `400` + `-32602` |
| `Mcp-Method` or `Mcp-Name` missing or different from the body | `400` + `-32020` |
| unknown method, or `ping`/`logging/setLevel`/`roots/*`/`initialize` with an envelope | `404` + `-32601` |
| header names an unknown version (e.g. `1900-01-01`) | `400` + `-32022`, `supported` = every served version |
| **[DECIDED]** envelope naming a legacy or unknown version (no `initialize`) | `400` + `-32022`, `supported` = the modern revision (what `server/discover` lists): a legacy client starts with `initialize` |
| **[DECIDED]** header 2026-07-28 without an envelope | `400` + `-32602` |
| **[DECIDED]** header 2025-11-25 or 2025-06-18, no envelope | legacy, stateless |
| **[DECIDED]** header 2025-03-26 or 2024-11-05 | `400` + `-32022` with every served version |
| no header, no envelope, not `initialize` | legacy (2025-11-25 transport rule), not refused |
| **[DECIDED]** envelope together with `Mcp-Session-Id` | modern; the session header is dropped and never returned |
| **[DECIDED]** legacy request with `Mcp-Session-Id` | legacy, stateless; the header is dropped and never returned |
| notification (either era) | `202`, no body |
| `GET`, `DELETE` | `405`, `Allow: POST`, before authentication |
| **[DECIDED]** body not JSON | `400` + `-32700` |
| **[DECIDED]** an array, a response object, `id: null`, no `method` | `400` + `-32600` |

## 5. Situation, HTTP status, JSON-RPC code, body

| Situation | HTTP | JSON-RPC | Body |
|---|---|---|---|
| Request head not complete within 20 s, or the whole request not received within 120 s (the listener of every role, `apps/server/src/roles/lifecycle.ts`, checked every 2 s; a response stream is not bounded by them) | 408 | — | Node's `408 Request Timeout`, connection closed; no handler ran (`apps/server/test/listen-deadlines.test.ts`) |
| `GET`, `DELETE`, other methods (a CORS preflight `OPTIONS` too: no `Access-Control-*` header on any answer) | 405 | `-32600` | JSON-RPC error without `id`, `Allow: POST` |
| `Origin` present and not allowed | 403 | `-32600` | JSON-RPC error without `id`; no CORS header |
| `Host` not the public host | 421 | `-32600` | JSON-RPC error without `id` |
| `Content-Type` not JSON | 415 | `-32600` | JSON-RPC error without `id` |
| `Accept` names nothing usable | 406 | `-32600` | JSON-RPC error without `id` |
| Body over its tier | 413 | `-32600` | JSON-RPC error without `id` |
| Body arrives slower than its deadline (30 s) | 408 | `-32600` | JSON-RPC error without `id` |
| Role matrix not verified yet | 503 | `-32603` | `Retry-After`; `data.code` `CONTROL_PLANE_DEGRADED` |
| Whole request over 90 s | 504 | `-32603` | with the request's `id`; an accepted operation continues |
| No or invalid token, wrong audience, revoked grant, disabled client | 401 | `-32600` | `WWW-Authenticate: Bearer error="invalid_token", resource_metadata=…`; without a token no `error` but `scope` = the baseline scopes; JSON-RPC error without `id`, `data.code` `UNAUTHENTICATED` |
| Scope missing for the called tool | 403 | `-32600` | `WWW-Authenticate: Bearer error="insufficient_scope", resource_metadata=…, scope="<held ∪ needed>"`; JSON-RPC error without `id`, `data` = the `INSUFFICIENT_SCOPE` tool error (required scope, remediation) |
| Rate limit | 429 | `-32600` | `Retry-After`; JSON-RPC error without `id`, code `RATE_LIMITED` in `data` |
| Parse, batch, malformed | 400 | `-32700` / `-32600` | |
| Version ladder | 400 | `-32020`, `-32022`, `-32602`, `-32021` | as §4 |
| Unknown method | 404 | `-32601` | |
| Unknown tool (the name is not echoed), invalid cursor, resource not found (modern) | 200 | `-32602` | |
| Invalid tool arguments | 200 | — | `isError: true`, `VALIDATION_FAILED` with the issue paths (2025-11-25 SEP-1303: the model can correct its call) |
| Resource not found (legacy) | 200 | `-32002` | |
| Refusal by RBAC, tier, grant, policy, plan state; validation in the use case | 200 | — | `isError: true`, text block = the problem body without HTTP fields (code, message, details, remediation, `retryable`, `requestId`); no `structuredContent` |
| An object that is not there, real or concealed (`TARGET_NOT_FOUND`, `PLAN_NOT_FOUND`, …) | 200 | — | as the row above, sent no earlier than 50 ms after the request began (one time class, `error-model.md` §4) |
| Internal failure | 200 | — | `isError: true`, code `INTERNAL`, no internal text |

## 6. Conformance and reference tools

| Tool | Version (pinned) | Use |
|---|---|---|
| `@modelcontextprotocol/conformance` | `0.2.0-alpha.12` (2026-10-01; `latest` 0.1.16 does not know 2026-07-28) | `bun run --cwd apps/server test:conformance` (CI and `bun run verify`): `--requirements 2026-07-28` and `--requirements 2025-11-25` against the test composition (`apps/server/test/support/mcp-world.ts`: the real edge, SDK and hosts over a stub application) on a local port; fetched with `bunx` at that exact version, never a workspace dependency (it depends on the v1 SDK, which the boundaries forbid). Expected failures are listed with their reason in `apps/server/test/conformance/expected-failures.<revision>.yaml` (fixture tools and resources of the reference server, no prompts, no completions, no Tasks, no `x-mcp-header`); an unexpected failure or a stale entry fails the run. [OBSERVED] 2026-10-12: both revisions pass with that baseline |
| `@modelcontextprotocol/inspector` | `2.10.1` (2026-10-08, Node ≥ 22.19) | `bun run mcp:inspect` (the conformance job of CI and `bun run verify`): the CLI with `npx` at that exact version against the test composition on a local port, `--protocol-era legacy` and `modern`: `tools/list --strict` (schema portability), a `tools/call`, a refused token (exit 3, `--stored-auth-only`: never an interactive login in a test). [OBSERVED] 2026-10-13: both eras list the grant's tools with 0 errors and 0 warnings, after the wire schemas were made single-typed (`anyOf` instead of a `type` array) and a recursive JSON value names its six types (5 warnings before); against the lab: Phase 10 |
| `@modelcontextprotocol/client` | `2.3.1` | the reference client of `@exponetdb/testkit/mcp` (`createProtocolClient`, both eras, in process or over sockets) and the transcript recorder of the replay tests (`apps/server/test/mcp-replay.int.test.ts`, synthetic transcripts in `packages/testkit/fixtures/mcp-replay/`) |

## 7. Sources (read 2026-10-12)

- https://modelcontextprotocol.io/docs/2026-07-28/learn/versioning (redirect target of `/specification/versioning`)
- https://modelcontextprotocol.io/specification/2026-07-28/ : `changelog`, `deprecated`, `basic/index`, `basic/versioning`, `basic/patterns/mrtr`, `basic/patterns/subscriptions`, `basic/patterns/cancellation`, `basic/patterns/progress`, `basic/transports/streamable-http`, `basic/authorization/index` and its three subpages, `client/elicitation`, `server/discover`, `server/resources`, `server/tools`, `server/utilities/caching`, `server/utilities/logging`, `server/utilities/pagination`
- https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2026-07-28/schema.ts and its examples (`UnsupportedProtocolVersionError`, `MissingRequiredClientCapabilityError`, `DiscoverResult`, `InputRequiredResult`, `HeaderMismatchError`)
- https://modelcontextprotocol.io/specification/2025-11-25/ : `changelog`, `basic/lifecycle`, `basic/transports`, `basic/authorization`, `basic/utilities/cancellation`, `basic/utilities/ping`, `client/elicitation`, `server/resources`, `server/tools`; `schema/2025-11-25/schema.ts`
- https://modelcontextprotocol.io/specification/2025-06-18/ : `basic/transports`, `basic/lifecycle`, `changelog`
- https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices
- https://modelcontextprotocol.io/community/feature-lifecycle
- npm registry pages of `@modelcontextprotocol/server`, `client`, `conformance`, `inspector`

Differences between the order's research and the sources, recorded here:
the range `-32000…-32019` is "legacy" (implementations SHOULD NOT use it),
not merely implementation-defined; `405` for GET and DELETE is a SHOULD of
a modern-only server (a dual-era server follows the legacy rule, which
also allows `405`); tool-name rules are SHOULD; caching hints also apply to
`server/discover` and only to complete results; the specification's two
examples disagree on whether `supportedVersions` lists legacy versions
(§4 records ExponetDB's choice); the cancellation page says a server MUST
send `notifications/cancelled` when it tears down a listen stream, the
subscriptions page that it SHOULD send a completion result: ExponetDB
sends the completion result (the cancellation notification is defined for
stdio only in the schema).

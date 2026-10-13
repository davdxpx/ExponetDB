# MCP architecture

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05; Wave 7 decisions of 2026-10-12 folded in ([ADR-0027](../01-architecture/adr/0027-mcp-protocol-layer.md), [ADR-0028](../01-architecture/adr/0028-data-read-lane.md), [ADR-0029](../01-architecture/adr/0029-approval-link-from-mcp.md)); implementation in progress ([G7 record](../14-roadmap/gates/7.md)) |
| Applies to | Wave 7 (a read-only slice may start after Wave 4, never before G3B) |
| Read before | [`oauth.md`](./oauth.md), [`tool-catalog.md`](./tool-catalog.md), [`../08-auth-and-security/ai-agent-safety.md`](../08-auth-and-security/ai-agent-safety.md) |
| Sources | MCP specification 2026-07-28 and 2025-11-25 (modelcontextprotocol.io), standards research of 2026-10-04, primary sources read again on 2026-10-12 ([`protocol-baseline.md`](./protocol-baseline.md)) |
| Decision | [ADR-0015](../01-architecture/adr/0015-oauth-protected-mcp.md) |

## 1. Position

**[DECIDED]**

- One remote MCP endpoint for all targets: `https://db.exponet.cloud/mcp`. New
  databases are registered as targets, never as new MCP servers.
- MCP is an **interface**: every tool calls an application service; the same
  service backs the REST endpoint for the same action (C-9).
- No anonymous access. Every request carries an OAuth bearer token issued by
  ExponetDB's authorization server for the audience `https://db.exponet.cloud/mcp`.
- The MCP server never accepts tokens issued for another audience (including
  ExponetDB's REST audience) and never passes tokens upstream.

## 2. Protocol versions: dual-era

**[OBSERVED]** (standards research 2026-10-04): the latest MCP revision is
**2026-07-28**. It is breaking relative to 2025-11-25: no protocol sessions
(`Mcp-Session-Id` removed), no `initialize` handshake (capabilities and version in
each request's `_meta`), no GET stream and no SSE resumability, server-initiated
requests replaced by Multi Round-Trip Requests (`input_required` results), Tasks
moved into an extension, Dynamic Client Registration deprecated in favor of Client
ID Metadata Documents, new required headers (`MCP-Protocol-Version`, `Mcp-Method`,
`Mcp-Name`). The spec explicitly allows a server to serve both eras on one
endpoint. Major clients' support for 2026-07-28 could not be confirmed from
primary sources; Claude's connector documentation still cites the 2025-11-25
authorization spec.

**[OBSERVED]** (2026-10-12, [`protocol-baseline.md`](./protocol-baseline.md)):
the specification site lists 2026-07-28 as the current revision; the
official TypeScript SDK 2.3.1 serves both eras on one endpoint.

**[DECIDED]** ExponetDB serves both on the same endpoint, choosing semantics per
request as the spec defines (an `initialize` request selects legacy semantics; a
request with modern `_meta` selects modern semantics). Supported versions
(owner decision 3, 2026-10-12): modern `2026-07-28`; legacy `2025-11-25` and
`2025-06-18`. The classification of every request, including the cases the
specification leaves open, is the table in
[`protocol-baseline.md` §4](./protocol-baseline.md#4-classification-of-a-request).

| Aspect | Legacy (2025-11-25) | Modern (2026-07-28) |
|---|---|---|
| Handshake | `initialize` / `initialized` | none; `server/discover` implemented |
| Sessions | none (owner decision 4): no `Mcp-Session-Id` is issued or returned; a sent one is dropped | none |
| Server→client requests | none: the stateless legacy leg has no back channel; the approval link is in the result | MRTR: `resultType: "input_required"` with an AEAD-sealed `requestState` (ADR-0027 §7) |
| Long-running work | operation handles + `operation_get` | operation handles + `operation_get` (Tasks extension not in Wave 7, owner decision 8) |
| GET stream | not offered (405) | not offered (405) |
| Headers | `MCP-Protocol-Version` | `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` validated against the body (mismatch → 400 `-32020`) |

Legacy support is removed no earlier than twelve months after ExponetDB
announces it **and** only after the clients in use support the modern
revision (checked against the client matrix; owner decision at that time).
This is ExponetDB's own promise (owner decision 3): the specification sets
no sunset date for a revision; its twelve-month deprecation window applies
to deprecated features (roots, sampling, logging, DCR), and sessions were
removed in 2026-07-28 without one.

## 3. Transport

**[DECIDED]** Streamable HTTP only (no stdio server, no deprecated HTTP+SSE):

- `POST /mcp` for every request; responses as `application/json` or a
  request-scoped `text/event-stream` (progress for longer reads).
- `GET` and `DELETE` → `405` with `Allow: POST`, for both eras, before
  authentication.
- `Origin` validation: requests with an `Origin` header not in the allowlist
  (the origin of `EXPONETDB_PUBLIC_URL`, configured extra origins, and in the
  lab the loopback origins of its port) → `403`; a request without `Origin`
  (native clients) is allowed and still needs a token. `Host` must name the
  public host (`421` otherwise).
- `X-Accel-Buffering: no` on streams; every answer `Cache-Control: no-store`.
- Request bodies: 256 KiB by default; 16 MiB only for the bundle-carrying
  tools, enough for one maximal bundle (about 8.6 MiB). This is deliberately
  below the REST limit for bundle bodies (32 MiB): plans with several or
  large bundles reference bundles ingested earlier into the bundle store
  (`POST /projects/{id}/bundles`, by the CLI or CI) instead of sending them
  inline.
- Rate limits per grant and per identity (token bucket; `RATE_LIMITED` with
  `Retry-After`).

## 4. Authentication and authorization flow

```
client ──POST /mcp (no token)──────────────▶ 401 WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp",
                                                                   scope="targets.read schema.read diagnostics.read"
client ──GET PRM──────────────────────────▶ { resource: https://db.exponet.cloud/mcp, authorization_servers: [https://db.exponet.cloud], scopes_supported: [...] }
client ──GET AS metadata──────────────────▶ RFC 8414 document (no OIDC discovery: oauth.md §2)
client ── authorize (PKCE S256, resource=…/mcp, scope=…) ──▶ ExponetDB login (passkey/TOTP) + consent screen
client ── token ──────────────────────────▶ opaque access token (aud=/mcp) + rotating refresh token
client ──POST /mcp (Bearer)───────────────▶ tool calls; insufficient scope → 403 insufficient_scope (step-up)
```

Details: [`oauth.md`](./oauth.md). Per request, the server:

1. validates the token (hash lookup), audience, expiry, grant state;
2. resolves identity, client, grant (scopes, target restrictions, tier
   restrictions);
3. filters the tool list (`tools/list`) to tools the grant can use at all
   (`cacheScope: "private"`); a hidden tool is not a security control, the
   authorization check in the service is;
4. on `tools/call`, the application service performs RBAC ∩ scopes ∩ grant ∩
   policy; refusals are tool execution errors with ExponetDB error codes
   (`isError: true`, the problem body as JSON in the text block), except
   missing scope, which uses the spec's 403 `insufficient_scope` challenge so
   that clients can step up. No other refusal is ever an HTTP 403 (a client
   such as VS Code registers again after a 403 that carried a token).

## 5. Tool design principles

**[DECIDED]**

- **Few, coarse, well-described tools** (26 in the Wave 7 part of the
  catalog; the catalog marks each tool served or planned), named
  `<domain>_<verb>` (`migration_plan`, `schema_inspect`, `sessions_list`); applying any plan is the generic `plan_apply`.
  Agents choose tools by description; many tiny tools degrade selection.
- **Targets by path**: every target-scoped tool takes `target` as a path
  (`reosa/platform/staging`) or `tgt_` id. No tool takes hosts or connection
  strings.
- **Structured output** for every tool: `outputSchema` (JSON Schema 2020-12)
  plus `structuredContent`, and a short text summary for clients that only show
  text. Large results are paginated with opaque cursors.
- **Plans are the confirmation mechanism.** Mutating tools are either
  `*_plan` + `*_apply(planId)` pairs or inline-plan tools with precondition
  tokens. There is no "confirm: true" flag anywhere.
- **Annotations are hints**: `readOnlyHint: true` only on tools that are truly
  read-only in the MCP sense, that is, whose action has effect `read` and
  changes nothing, not even an ExponetDB record (clients such as VS Code skip
  confirmation for them); a tool that records findings or creates a plan has
  `readOnlyHint: false` and `destructiveHint: false`. `destructiveHint` and
  `idempotentHint` are set honestly per tool. They are never relied on for
  security (C-10).
- **Descriptions state preconditions**, not rules: "Requires a plan created by
  migration_plan; production plans may require human approval." The rules live
  in the policy engine.
- **Untrusted content is labeled**: tool results that contain database-sourced
  text (object names, comments, function bodies, redacted statements) mark those
  fields as data (`"untrusted": true` in the schema, and the text summary quotes
  them), so that agents and their hosts can avoid prompt injection
  ([`../08-auth-and-security/ai-agent-safety.md`](../08-auth-and-security/ai-agent-safety.md)).
- **No secrets in or out**: no tool accepts or returns credentials. When an
  operation would need a human-held secret (for example a consumer login role's
  SCRAM verifier), the tool returns a URL elicitation to the Web App's
  write-only form, following the reference pattern "it never passes through your
  AI client".

## 6. Human approval from inside an MCP conversation

When a plan requires approval:

1. `plan_apply` returns the operation in `awaiting_approval` with an
   `approvalUrl` pointing to the approvals page
   (`https://db.exponet.cloud/approvals#operation=op_…`, ADR-0029), where the
   approval is given. Wave 8 moves the plan review to `/changes/plans/<id>`;
   the old link stays valid as a redirect.
2. The link is always in the result's text block and `structuredContent`.
   If a modern request declared URL-mode elicitation, the server also
   returns it (`input_required`); the legacy leg has no back channel and
   never sends an elicitation request.
3. The human opens it in the browser, authenticates **as themselves** (passkey/
   TOTP), sees the plan, evidence and analysis, approves. The approval page
   checks that the approver is entitled (the spec requires that the user who
   completes a URL elicitation is verified; ExponetDB verifies it by its own
   login, not by trusting the client).
4. The operation continues; the agent observes it via `operation_get`.

**[DECIDED]** (Wave 7 Phase 7, implemented in
`apps/server/src/interfaces/mcp/registry.ts` and `request-state.ts`; tests
`mcp-plans.int.test.ts`, `mcp-units.test.ts`, `mcp-approval.e2e.test.ts`.)
The approval round:

- Only a **modern** request whose envelope declared `elicitation.url`
  (an empty `elicitation` is form mode and does not count) gets
  `input_required`: `inputRequests.approval` is `elicitation/create` with
  `mode: "url"`, the approval link and a fixed message built from checked
  facts only ("ExponetDB: a person must approve `<kind>` on `<target path>`
  (`<tier>`), plan hash `<first 27 characters>`…"; never the agent's words,
  plan content or database text). The operation is accepted **before** the
  link is shown; the round never waits for the person.
- `requestState` is the AEAD state of ADR-0027 §7 (`rs1.1.…`), bound to the
  identity, client, grant, tool and the JCS digest of the arguments, ten
  minutes. The retry (new JSON-RPC id, the same arguments, the state)
  **reads** the operation and answers the normal result (`resultType:
  "complete"`, `awaiting_approval`, `approvalUrl`); its `inputResponses`
  are never read: an `accept` decides nothing. A state that does not open
  (altered, expired, another principal, tool or arguments) is the same
  tool error, `VALIDATION_FAILED` on `/requestState`.
- Without the plan's facts (the plan read fails) there is no elicitation;
  the link stays in the result. Legacy and clients without URL mode always
  get the link in the result, never a server request.
- The approvals page shows a review computed by the server (ADR-0029): the
  plan view (target and tier, kind and class, creator and client with the
  client's own name marked *not verified*, the policy decision with every
  rule that did not pass and the requirements, expiry, the full plan hash
  with a copy button), per migration the compatibility, the statements with
  line, lock and compatibility, drops, rewrite estimates, rollback, the
  staging evidence fact and the bound schema fingerprint, and the files the
  plan runs verbatim from the bundle store (`up.sql`, or `down.sql` for a
  rollback; at most 256 KiB characters, a cut is named). Raw text is text
  only (`textContent`, never markup or a link) with line numbers; control,
  direction, invisible and tag characters are shown by their code point,
  other non-ASCII characters are marked. A card made through an MCP client
  says so ("an AI agent proposed this plan … the agent cannot approve").
  The newest backup is "not known" until Wave 9; plans carry no agent note
  in Wave 7.

Form-mode elicitation is **never** used as an approval: a client controls what it
shows and how it answers, so an elicitation "accept" is not proof of a human
decision. It may be used for harmless clarifications (choose one of several
targets that match a name).

## 7. Long-running operations

- Accepting an apply returns an operation handle immediately.
- `operation_get(op_…)` returns state, per-migration outcomes, progress events.
- The Tasks extension is not offered in Wave 7 (owner decision 8): the
  operation is already a durable handle with polling. A later wave may add
  it for clients that declare it, with `taskId` = operation id and the
  operation's own cancel semantics.
- A dropped stream never cancels an accepted operation.

## 8. Implementation notes

**[DECIDED]** ([ADR-0027](../01-architecture/adr/0027-mcp-protocol-layer.md), 2026-10-12)

- Built on the official TypeScript SDK (`@modelcontextprotocol/server`
  2.3.1, exactly pinned) for framing, era classification, header
  validation, `server/discover`, MRTR and the legacy handshake, inside edges
  ExponetDB owns: method, `Origin`, `Host`, media types, body bounds, bearer
  authentication through the shared helper, classification, rate limits,
  and the tool registry (`tools/list`, `tools/call`, resources) built from
  `packages/contracts`. The SDK never sees the token.
- `requestState` for MRTR: AEAD-sealed (AES-256-GCM under the installation
  key `mcp.request_state_key`), bound to identity, client, grant, tool,
  argument digest and operation, expiry at most 10 minutes. The only state
  ExponetDB seals (the approval round of `plan_apply`) has no effect when
  repeated, so no single-use store is needed.
- Logging: tool name, target, outcome, duration, error code; never argument
  values that may contain SQL (only digests) or results.

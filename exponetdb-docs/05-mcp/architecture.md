# MCP architecture

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
| Applies to | Wave 7 (a read-only slice may start after Wave 4, never before G3B) |
| Read before | [`oauth.md`](./oauth.md), [`tool-catalog.md`](./tool-catalog.md), [`../08-auth-and-security/ai-agent-safety.md`](../08-auth-and-security/ai-agent-safety.md) |
| Sources | MCP specification 2026-07-28 and 2025-11-25 (modelcontextprotocol.io), standards research of 2026-10-04 |
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

**[DECIDED]** ExponetDB serves both on the same endpoint, choosing semantics per
request as the spec defines (an `initialize` request selects legacy semantics; a
request with modern `_meta` selects modern semantics):

| Aspect | Legacy (2025-11-25) | Modern (2026-07-28) |
|---|---|---|
| Handshake | `initialize` / `initialized` | none; `server/discover` implemented |
| Sessions | `Mcp-Session-Id` issued; bound server-side to (identity, client, grant); no state other than negotiated capabilities | none |
| Server→client requests | elicitation as server request (if client declared it) | MRTR: `resultType: "input_required"` with HMAC-protected `requestState` |
| Long-running work | operation handles + `operation_get` (Tasks experimental: not used) | operation handles + `operation_get`; Tasks extension when the client declares it |
| GET stream | not offered (405) | not offered (405) |
| Headers | `MCP-Protocol-Version` | `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` validated against the body (mismatch → 400 `-32020`) |

Legacy support is removed no earlier than the spec's 12-month deprecation window
after 2026-07-28 **and** only after the clients in use support the modern
revision (checked against the client matrix; owner decision at that time).

## 3. Transport

**[DECIDED]** Streamable HTTP only (no stdio server, no deprecated HTTP+SSE):

- `POST /mcp` for every request; responses as `application/json` or a
  request-scoped `text/event-stream` (progress for longer reads).
- `GET` and `DELETE` → `405` (modern); legacy session termination via `DELETE`
  is accepted for 2025-11-25 sessions.
- `Origin` validation: requests with an `Origin` header not in the allowlist
  (`https://db.exponet.cloud` and configured client origins) → `403`.
- `X-Accel-Buffering: no` and periodic keep-alive comments on SSE responses.
- Request body limit 16 MiB, enough for one maximal bundle (about 8.6 MiB). Plans
  with several or large bundles reference bundles ingested earlier into the
  bundle store (`POST /projects/{id}/bundles`, by the CLI or CI) instead of
  sending them inline.
- Rate limits per grant and per identity (token bucket; `RATE_LIMITED` with
  `Retry-After`).

## 4. Authentication and authorization flow

```
client ──POST /mcp (no token)──────────────▶ 401 WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp",
                                                                   scope="targets.read schema.read"
client ──GET PRM──────────────────────────▶ { resource: https://db.exponet.cloud/mcp, authorization_servers: [https://db.exponet.cloud], scopes_supported: [...] }
client ──GET AS metadata──────────────────▶ RFC 8414 + OIDC discovery documents
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
   (`isError: true`, structured content), except missing scope, which uses the
   spec's 403 `insufficient_scope` challenge so that clients can step up.

## 5. Tool design principles

**[DECIDED]**

- **Few, coarse, well-described tools** (about 30), named
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
   `approvalUrl` pointing to the plan review page
   (`https://db.exponet.cloud/changes/plans/pln_…`), where the approval is given.
2. If the client declared URL-mode elicitation, the server returns it
   (`input_required` in modern mode, an elicitation request in legacy mode) so
   the client can show the link; otherwise the URL is in the structured result.
3. The human opens it in the browser, authenticates **as themselves** (passkey/
   TOTP), sees the plan, evidence and analysis, approves. The approval page
   checks that the approver is entitled (the spec requires that the user who
   completes a URL elicitation is verified; ExponetDB verifies it by its own
   login, not by trusting the client).
4. The operation continues; the agent observes it via `operation_get`.

Form-mode elicitation is **never** used as an approval: a client controls what it
shows and how it answers, so an elicitation "accept" is not proof of a human
decision. It may be used for harmless clarifications (choose one of several
targets that match a name).

## 7. Long-running operations

- Accepting an apply returns an operation handle immediately.
- `operation_get(op_…)` returns state, per-migration outcomes, progress events.
- When a modern client declares the `io.modelcontextprotocol/tasks` extension,
  apply tools may return a task (`taskId` = operation id) and support
  `tasks/get` and `tasks/cancel` (cancel maps to the operation's cancel, which is
  honored only in `queued`/`awaiting_approval`, or at safe points).
- A dropped stream never cancels an accepted operation.

## 8. Implementation notes

**[PLANNED]**

- Built on the official TypeScript MCP SDK packages; the SDK's handling of both
  revisions must be verified in Wave 7 (the research could not confirm which npm
  package line implements 2026-07-28). If the SDK does not support dual-era
  serving, ExponetDB implements the thin JSON-RPC layer itself over Hono, keeping
  tool definitions in `packages/contracts`.
- `requestState` for MRTR: AEAD-encrypted, bound to identity, client, grant,
  tool, argument digest, TTL 10 minutes, single-use tracked server-side.
- Logging: tool name, target, outcome, duration, error code; never argument
  values that may contain SQL (only digests) or results.

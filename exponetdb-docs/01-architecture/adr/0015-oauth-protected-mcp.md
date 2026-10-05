# ADR-0015: MCP protected by ExponetDB's own OAuth authorization server

| | |
|---|---|
| Status | Accepted (baseline) |
| Date | 2026-10-04 |
| Related | C-24, C-25; [`../../05-mcp/oauth.md`](../../05-mcp/oauth.md), [`../../05-mcp/architecture.md`](../../05-mcp/architecture.md) |

## Context

AI clients (Claude Code, Claude, ChatGPT/Codex, Cursor, VS Code and others)
connect to `https://db.exponet.cloud/mcp` on behalf of people. Static API keys
pasted into client configurations are long-lived, unscoped per person and hard
to revoke. The MCP specification moved in 2026 (2025-11-25 with sessions and
the 2026-07-28 revision with stateless requests); both are in use.

## Decision

- ExponetDB runs its own **OAuth 2.1 authorization server** (issuer
  `https://db.exponet.cloud`) and acts as the MCP **resource server**:
  protected-resource metadata, PKCE S256 only, resource indicators (RFC 8707),
  `iss` in responses (RFC 9207), exact redirect matching with loopback on any
  port.
- Clients are known through a **CIMD allowlist**, **approval-gated dynamic
  registration**, or pre-registration (OD-5).
- Consent shows scopes **and** tiers; MCP grants default to nonprod; admin,
  approval, break-glass and sensitive scopes are never grantable to MCP clients.
- Streamable HTTP only, both protocol eras, Origin validation.

## Alternatives considered

- **API keys only.** Kept for scripts, not for interactive AI clients.
- **External identity provider as authorization server.** Deferred (OD-10).

## Consequences

- ExponetDB implements and maintains an authorization server, with conformance
  and SSRF tests.
- Each person sees and revokes their connected applications.

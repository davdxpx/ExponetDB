# ADR-0022: Opaque access tokens and rotating refresh tokens

| | |
|---|---|
| Status | Accepted (baseline) |
| Date | 2026-10-04 |
| Related | C-20; [`../../05-mcp/oauth.md`](../../05-mcp/oauth.md) |

## Context

ExponetDB is both the authorization server and the only resource server for its
tokens. Revocation must take effect immediately (a leaked agent token on
production is an incident).

## Decision

- Access tokens are **opaque** random values (`exat_…`, 256 bits), valid
  10 minutes, stored as SHA-256 hashes, checked against the Control Store on
  every request (with a short in-process cache that revocation invalidates).
- Refresh tokens (`exrt_…`) **rotate on every use**; presenting a rotated-out
  token revokes the token family and the grant and is audited.
- API keys (`exak_…`) are opaque, scoped and target-restricted, stored hashed.
- Service accounts authenticate with `private_key_jwt` and receive short-lived
  opaque tokens.

## Alternatives considered

- **Self-contained JWT access tokens.** Rejected: no immediate revocation without
  extra machinery, larger tokens, key distribution for no gain (single resource
  server).

## Consequences

- Each request costs a token lookup; acceptable at ExponetDB's scale.
- Token formats can change without client impact, since clients never parse them.

# @exponetdb/auth

Identity, authentication and authorization of ExponetDB
([identity.md](../../exponetdb-docs/08-auth-and-security/identity.md),
[authorization.md](../../exponetdb-docs/08-auth-and-security/authorization.md)).
Built in Wave 3A ([G3A record](../../exponetdb-docs/14-roadmap/gates/3a.md)).

## Owns

| Module | What |
|---|---|
| `config.ts` | trusted public origin and WebAuthn RP id, from operator configuration only |
| `tokens.ts` | opaque tokens (256-bit, typed prefixes), domain-separated hashes, constant-time comparison |
| `credentials/webauthn.ts` | passkey options and verification through `@simplewebauthn/server` |
| `credentials/password.ts` | Argon2id (64 MiB, t=3, p=1) through `@node-rs/argon2`, password policy, dummy verification |
| `credentials/breached.ts` | the offline common-password list (no online lookup) |
| `credentials/totp.ts` | RFC 6238 through `otpauth`, replay window, local QR matrix |
| `credentials/recovery-codes.ts` | ten 80-bit Crockford recovery codes, hash-only |
| `credentials/device.ts` | a coarse device label from the user agent |
| `identities.ts`, `factors.ts`, `passkeys.ts`, `second-factors.ts` | identity and factor rows; TOTP secrets through `@exponetdb/secrets` (consumer `auth`) |
| `sessions.ts` | Web sessions: issue, lookup (idle and absolute on the database clock), CSRF, rotation, revocation |
| `challenges.ts`, `links.ts` | ceremony state and one-time links (hash-only, single use) |
| `ratelimit.ts`, `failures.ts` | keyed rate-limit buckets, progressive delay, lock, aggregated failure audit |
| `ceremonies/` | sign-in, re-authentication, enrollment, self-service |
| `access/identities.ts` | invite, re-issue, disable, identity views |
| `operator.ts` | `bootstrap owner` and `auth recover-owner` services |
| `keys.ts`, `notifications.ts`, `audit.ts` | installation keys, truthful notifications, audit helpers |
| `authorization/delegation.ts` | the delegated principal (Wave 3B): credential, resource, scopes, restrictions; the scope ceiling after RBAC |
| `oauth/authorize.ts`, `consent.ts`, `token.ts`, `grants.ts` | authorization endpoint, consent re-evaluated at submission, codes, token endpoint with refresh rotation and reuse detection, RFC 7009 revocation, grants |
| `oauth/bearer.ts`, `metadata.ts`, `params.ts`, `catalog.ts` | live bearer authentication, RFC 8414 and RFC 9728 metadata, strict parameter parsing, the scope catalog check |
| `oauth/clients.ts`, `registry.ts`, `client-metadata.ts`, `fetch.ts` | the client registry, CIMD with the hardened fetcher, approval-gated DCR, exact redirect URIs |
| `oauth/device.ts` | the device authorization grant for the first-party CLI |
| `oauth/assertion.ts`, `service-accounts.ts` | `private_key_jwt` through `jose`, service accounts, machine grants, `client_credentials`, API keys |
| `oauth/limits.ts`, `maintenance.ts` | protocol rate limits (keyed pseudonyms), the worker prune |

## Does not own

OIDC federation and identity providers (later wave), the MCP server (Wave 7),
interfaces (`apps/server`).

## Allowed dependencies

`@exponetdb/contracts`, `@exponetdb/control-store`, `@exponetdb/secrets`,
`@exponetdb/audit`, `@exponetdb/policy`, `@exponetdb/operations`,
`@exponetdb/kernel`; `jose` for client assertions only
([package-architecture.md §1.4, §1.5](../../exponetdb-docs/01-architecture/package-architecture.md#15-state-during-wave-3b)).

## Security properties

- No secret is stored: tokens, recovery codes and passwords are stored as
  hashes; the TOTP secret is an `se1` envelope of the `auth` consumer. OAuth
  codes, tokens, device and user codes, assertion ids, API keys and browser
  bindings are domain-separated SHA-256 hashes; client keys are public keys.
- Library errors from credential verification never leave the module; a
  failure is `undefined` or a typed refusal.
- Origin and RP id come from configuration, never from request headers.

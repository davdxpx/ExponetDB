# Identity and authentication

| | |
|---|---|
| Status | Baseline (Wave 0), awaiting owner approval |
| Applies to | Wave 3A (humans, sessions, re-authentication), Wave 3B (service accounts, API keys) |
| Read before | [`authorization.md`](./authorization.md), [`../05-mcp/oauth.md`](../05-mcp/oauth.md) |
| Decision | [ADR-0016](../01-architecture/adr/0016-identity-federation.md) |

## 1. Model

**[DECIDED]** ExponetDB has its own identity system. It does not depend on REOSA's
authentication (C-2) and does not offer authentication to anyone else's
applications (C-3).

| Entity | Purpose |
|---|---|
| `identity` (`idn_`) | a person (`kind = human`) or a service account (`kind = service`); states `invited`, `active`, `disabled`, `erased` |
| `identity_provider` | `local` (ExponetDB credentials) or an external OIDC provider (future `auth.exponet.cloud`) |
| `external_subject` | `(provider, issuer, sub)` → identity; a human may have both local credentials and external subjects |
| `identity_credential` | local credentials: WebAuthn passkeys, password hash, TOTP secret (encrypted), recovery codes (hashed) |
| `web_session` (`ses_`) | browser session |
| `oauth_grant`, tokens | delegated access for clients ([`../05-mcp/oauth.md`](../05-mcp/oauth.md)) |
| `api_key` (`key_`) | long-lived secret for service accounts |
| `reauth_event` | recorded proof of presence for step-up |

There is **no self-signup**. Identities are created by an admin (or by bootstrap
for the first owner) and invited by a one-time link.

## 2. Human authentication (local, V1)

**[DECIDED]**

- **Passkeys (WebAuthn)** are the primary factor, with user verification
  required. At least two passkeys are recommended per person.
- **Password + TOTP** as a fallback method: passwords hashed with Argon2id
  (memory ≥ 64 MiB, iterations ≥ 3, parallelism 1, per-hash salt); minimum length
  14; checked against a breached-password list (k-anonymity range queries are not
  used, to keep ExponetDB free of third-party calls; a bundled top-N list is used
  instead). TOTP (RFC 6238, SHA-1/6 digits for authenticator compatibility) is
  **mandatory** with passwords.
- **Recovery codes**: 10 single-use codes, hashed; using one forces enrolling a
  new factor.
- No SMS, no e-mail one-time codes as factors (e-mail is used only for
  invitations and security notifications).
- Login rate limiting per identity and per IP hash; progressive delays; lockout
  after repeated failures with owner notification; all failures audited in
  aggregated form.

**[OBSERVED]** REOSA protects its admin console with TOTP and a 30-minute idle
lock, and treats MFA recovery as an out-of-band break-glass flow
(`REOSA/apps/admin/src/lib/operations/catalog/mfa-emergency.ts`). ExponetDB
adopts the idea of an out-of-band recovery for the last owner (§6).

## 3. Web sessions

**[DECIDED]**

- `__Host-exdb_session` cookie: `Secure`, `HttpOnly`, `SameSite=Strict`, path
  `/`; opaque 256-bit id, stored hashed; idle timeout 30 minutes, absolute
  lifetime 12 hours.
- CSRF protection as in [`../06-rest-api/architecture.md` §6](../06-rest-api/architecture.md#6-web-app-sessions-and-csrf).
- Sessions are bound to a coarse device fingerprint (user agent family) and
  rotated on privilege change (re-auth, role change).
- Active sessions are listed per identity and can be revoked; revoking a session
  does not revoke OAuth grants (they are listed separately).

## 4. Re-authentication (step-up)

**[DECIDED]** A **reauth event** is a fresh passkey assertion (user verification)
or TOTP code entered in the Web App or CLI. Required within:

| Action | Window |
|---|---|
| Approving a prod-tier plan | 5 min |
| Applying `critical` plans | 5 min |
| Activating break-glass | 2 min |
| Granting `:prod` write scopes to an OAuth client | 5 min |
| Creating API keys, enrollment tokens, role bindings | 5 min |
| Viewing raw statements (`diagnostics.read_sensitive`) | 15 min |

MCP clients cannot perform re-authentication; actions that require it must be
completed by the human in the Web App (approval URL pattern).

## 5. Service accounts

**[DECIDED]**

- `kind = service`; owned by a human identity (responsible person); no
  interactive login, no passkeys.
- Authenticate with:
  - **OAuth `client_credentials` with `private_key_jwt`** (RFC 7523): the
    service account's OAuth client registers a public key (JWKS); preferred for CI
    and backends;
  - or an **API key** (`exak_` + 256-bit random): stored as a hash, shown once at
    creation, scoped (scopes + target restrictions + tier), with mandatory expiry
    (default 90 days, maximum 365) and last-used tracking. Leaked-key detection is
    supported by the prefix.
- Service accounts never receive `:prod` *write* scopes by default; granting them
  requires an admin with re-authentication and is listed as a standing finding
  ("service account with production write access").
- Service accounts cannot approve plans, activate break-glass or execute
  `critical` operations (restore).

## 6. Bootstrap and recovery of the first owner

- The first owner is created by a one-time bootstrap command executed inside the
  server container (`exponetdb bootstrap owner --email …`), which prints a setup
  link valid for 30 minutes ([`../12-operations/bootstrap.md`](../12-operations/bootstrap.md)).
- **Last-owner recovery** (lost all factors): an out-of-band flow modeled on
  REOSA's MFA emergency: an operator with shell access to the ExponetDB container
  sets a time-limited environment variable or runs a recovery command that issues
  a single-use recovery link; requires a written reason; ends all sessions and
  grants of that identity; notifies all owners; audited as
  `out_of_band_recovery_used`.

## 7. Identity lifecycle and erasure

- Disabling an identity revokes sessions, grants, tokens and API keys immediately.
- Erasure (data protection request): the identity row is pseudonymized (name,
  e-mail removed), credentials deleted, external subjects removed; audit events
  remain with the pseudonymous label ([`../02-control-plane/audit.md` §6](../02-control-plane/audit.md#6-personal-data)).
- Plans and operations keep the identity id; they never stored names.

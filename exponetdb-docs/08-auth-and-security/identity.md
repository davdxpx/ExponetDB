# Identity and authentication

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
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
  their secrets rotate on re-authentication and at the end of a recovery.
  **[DECIDED]** (Wave 3A) A role change does not rotate the cookie:
  privileges are never stored in a session, every request evaluates the
  live role bindings, so a removed binding has effect on the next request
  ("stale privileges are invalidated immediately"), and a session token is
  never attacker-chosen (no fixation). Rotating on someone else's role
  change would break that person's requests in flight for no gain.
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

## 8. Browser ceremonies (Wave 3A)

**[DECIDED]** (Wave 3A, `packages/contracts/src/auth/ceremonies.ts`.) The
first-party Web App authenticates through ceremony routes under `/auth`,
outside `/api/v1`: client kind `web` only, `POST` only, exact `Origin`,
`Cache-Control: no-store`, `Referrer-Policy: no-referrer`. Pre-session
ceremonies carry their state in a short-lived `__Host-exdb_ceremony` cookie
(`HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`); everything else uses the
session cookie and the CSRF token.

| Route | Purpose |
|---|---|
| `POST /auth/login/passkey/options` | start a passkey sign-in; discoverable credentials, so no account is named and nothing can be enumerated |
| `POST /auth/login/passkey` | finish it with user verification; a new session |
| `POST /auth/login/password` | first step of the fallback; the same answer for every e-mail address and password |
| `POST /auth/login/totp` | second step with a TOTP code; a new session |
| `POST /auth/login/recovery-code` | second step with a recovery code; a restricted session that may only set up new factors |
| `POST /auth/logout` | revoke the current session and clear its cookies |
| `POST /auth/reauth/passkey/options` | start a re-authentication with a passkey |
| `POST /auth/reauth/passkey` | finish it; the session secret and CSRF token rotate |
| `POST /auth/reauth/totp` | re-authenticate with a TOTP code; rotation as above |
| `POST /auth/enrollment/redeem` | redeem a one-time link (first owner, invitation, out-of-band recovery); the token comes from the URL fragment, in the body |
| `POST /auth/enrollment/passkey/options` | passkey registration options for the identity being enrolled |
| `POST /auth/enrollment/passkey` | register the passkey |
| `POST /auth/enrollment/password` | set the fallback password |
| `POST /auth/enrollment/totp/options` | a new TOTP secret, shown once |
| `POST /auth/enrollment/totp` | confirm it with a valid code |
| `POST /auth/enrollment/complete` | activate the identity once passkey, password and TOTP are set; the recovery codes are shown once; a new session |
| `POST /auth/passkeys/options` | registration options for an additional passkey |
| `POST /auth/passkeys` | register it |
| `POST /auth/passkeys/{factorId}/remove` | remove a passkey (never the last one) |
| `POST /auth/password` | set a new fallback password |
| `POST /auth/totp/options` | a new TOTP secret replacing the current one once confirmed |
| `POST /auth/totp` | confirm the replacement |
| `POST /auth/recovery-codes` | replace all recovery codes with ten new ones, shown once |

## 9. Wave 3A behavior

**[DECIDED]** (Wave 3A, `packages/auth`.) Everything below is enforced on
the server and, where the Control Store can, by its guards as well
([`control-database.md` §5b](../02-control-plane/control-database.md)).

**Sign-in.**

- Passkey sign-in uses discoverable credentials: the options name no
  account, so they reveal nothing. The assertion must carry user
  verification, the exact origin and RP id from configuration, a challenge
  of this ceremony (5 minutes, consumed by the first attempt, failed or
  not), and the user handle of the identity that owns the credential.
  `id` and `rawId` must equal the credential id inside the signed data. A
  counter that does not increase is refused; synchronized passkeys that
  always report 0 are accepted.
- The password step answers identically for an unknown address, a wrong
  password, an identity that is not active or has no TOTP, and a right
  password: the same body and a ceremony cookie. Only for a right password
  does the cookie name a stored ceremony; otherwise it is a decoy that is
  never stored. Argon2id work is the same (a dummy hash for unknown
  addresses) and runs outside any database transaction.
- Every failure of the second step (wrong or replayed code, decoy, expired
  ceremony, locked identity) is the same `AUTHENTICATION_FAILED`, so the
  second step is no oracle for the first. A TOTP code is accepted once
  (the step is stored and only grows, also in the database guard).
- Rate limits count failures per bucket in a 15-minute window, stored as
  HMAC values under the installation's rate-limit key (no address is
  stored):

  | Bucket | Delay from | Lock at | Lock |
  |---|---|---|---|
  | account address as typed (`acct`, exists or not) | 3rd failure (1, 2, 4 … s, max 30 s) | 10 | 15 min |
  | client address (`ip`) | 20th failure | 100 | 15 min |
  | identity (`idn`: second step, re-authentication, enrollment TOTP) | 3rd failure | 10 | 15 min |

  A blocked bucket answers `RATE_LIMITED` with `Retry-After` before any
  credential is checked, except the identity bucket at the second step,
  which fails like a wrong code. A lock of an identity's bucket notifies
  the person. Failures are audited in aggregate (`auth.login.failures`,
  `auth.reauth.failures`, `auth.enrollment.failures`): at 5, at every
  doubling and at the lock, with the bucket kind and count, never the
  address. A successful sign-in clears the account and identity buckets.
- The client address is the TCP peer, or the address reported by a
  configured trusted proxy (`EXPONETDB_TRUSTED_PROXIES`); `X-Forwarded-For`
  from any other peer is ignored.

**Recovery codes.** Ten codes of 80 bits, shown once, stored as hashes bound
to their set. Using one opens a `recovery` session (the code is its proof),
marks the identity `recovery_required`, ends every other session and
notifies the person. A recovery session may only read its own data, sign
out, re-authenticate and set up factors; it ends when the person has
registered a new passkey and confirmed a new authenticator in it: the
session becomes a full one with new secrets and every other session ends.
A recovery-code proof never counts as re-authentication for anything else.

**Enrollment** through a one-time link (first owner, invitation,
out-of-band recovery): redeeming consumes the link at once and opens a
30-minute ceremony. Passkey (user verification), password and a confirmed
TOTP stay `pending` until completion activates them together and shows ten
recovery codes once. A first owner becomes owner only through the Control
Store function that re-checks every precondition under the owner lock; an
invited person gets no role. Redeeming a recovery link ends every session
of the identity and deletes all its old factors.

**First-owner bootstrap.** `exponetdb bootstrap owner --email …` issues the
setup link (30 minutes). While a first owner is pending, a new link needs
`--reissue`; the old link stops working, and a corrected address replaces
the pending identity's address (there is never a second first-owner
identity). Once an owner exists the command refuses.

**Out-of-band recovery.** `exponetdb auth recover-owner --email …
--reason-file …` works only for the last active owner (another owner uses
the administrative flow), requires a written reason of 20 to 1000
characters, ends every session at once, issues a 30-minute recovery link,
notifies the owners and writes `auth.out_of_band_recovery_used` with the
reason and the actor `system:maintenance`.

**Notifications.** The Control Store records the kind, the recipient and a
truthful status (`unavailable` without a channel, `sent` or `failed` after
a delivery attempt), never content, links or addresses. Wave 3A ships no
e-mail channel: invitations report `not_configured` and the inviting
person passes the link on.

**Keys.** The audit pseudonym key and the rate-limit key are separate
256-bit secrets of the `auth` consumer, created on first use under a lock.

**Residual risks** (also in the [threat model](./threat-model.md)): the
ciphertext of a deleted TOTP secret stays in the append-only secrets store
(its subject is the factor id, which is no longer linked to anyone); serve
holds the auth consumer's keys, so a fully compromised serve process can
act as any signed-in person (C-31 audit still records what it does).


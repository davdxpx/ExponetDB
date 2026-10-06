# OAuth for MCP (and for every other client)

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
| Applies to | Wave 3B (authorization server), Wave 7 (MCP resource server) |
| Read before | [`architecture.md`](./architecture.md), [`../08-auth-and-security/identity.md`](../08-auth-and-security/identity.md), [`../08-auth-and-security/authorization.md`](../08-auth-and-security/authorization.md) |
| Sources | MCP authorization spec 2026-07-28 (and 2025-11-25); OAuth 2.1 draft-ietf-oauth-v2-1-16; RFC 8414, 8707, 9207, 9728, 7591, 7009, 8252, 7523, 9700; CIMD draft-ietf-oauth-client-id-metadata-document-02 |
| Decision | [ADR-0015](../01-architecture/adr/0015-oauth-protected-mcp.md), [ADR-0022](../01-architecture/adr/0022-opaque-tokens.md) |

## 1. Roles

**[DECIDED]**

| OAuth role | Who | Notes |
|---|---|---|
| Authorization Server (AS) | ExponetDB itself, issuer `https://db.exponet.cloud` | Endpoints under `/oauth/*`; metadata at the well-known URIs |
| Resource Servers | `https://db.exponet.cloud/mcp` (MCP) and `https://db.exponet.cloud/api` (REST) | Separate audiences; a token is valid for exactly one |
| Clients | MCP clients (Claude, Claude Code, ChatGPT, Codex, Cursor, VS Code, Antigravity), the CLI, CI service accounts, the Web App | Registered by CIMD, DCR (gated) or pre-registration |
| User authentication | ExponetDB local identities in V1; federated via OIDC later | Upstream IdP authenticates; ExponetDB authorizes ([`../08-auth-and-security/federation.md`](../08-auth-and-security/federation.md)) |

ExponetDB is its own AS because authorization (scopes, consent, target
restrictions, tiers, revocation) belongs to ExponetDB. When `auth.exponet.cloud`
exists, ExponetDB's AS federates *login* to it and stays the token issuer for
ExponetDB resources ([OD-10](../00-product/open-decisions.md#od-10-future-identity-architecture)).

## 2. Discovery

**[DECIDED]**

| Document | URL |
|---|---|
| Protected Resource Metadata (RFC 9728) for MCP | `https://db.exponet.cloud/.well-known/oauth-protected-resource/mcp` (path-inserted) |
| PRM for REST | `https://db.exponet.cloud/.well-known/oauth-protected-resource/api` |
| AS metadata (RFC 8414) | `https://db.exponet.cloud/.well-known/oauth-authorization-server` |

**[DECIDED]** (Wave 3B, deviation D2 of the [G3B record](../14-roadmap/gates/3b.md).)
Two documents of the baseline are **not served**, so that discovery stays
truthful: `/.well-known/openid-configuration` (ExponetDB issues no ID
token and implements no OpenID Connect; MCP clients fall back to RFC 8414,
which MCP 2026-07-28 lists first) and the root
`/.well-known/oauth-protected-resource` (RFC 9728 §3.3: the document's
`resource` must equal the resource it was fetched for, and each resource
has its own path-inserted document). Both answer 404. The issuer and
every resource URI come from `EXPONETDB_PUBLIC_URL`, never from `Host` or
a forwarded header. The metadata advertises only what is implemented: no
`offline_access`, no `jwks_uri`, no client secret method.

PRM for MCP:

```json
{
  "resource": "https://db.exponet.cloud/mcp",
  "authorization_servers": ["https://db.exponet.cloud"],
  "scopes_supported": ["targets.read", "schema.read", "diagnostics.read"],
  "bearer_methods_supported": ["header"],
  "resource_name": "ExponetDB"
}
```

`scopes_supported` in the PRM is the **minimal baseline**; additional scopes are
requested by step-up challenges (MCP guidance: do not advertise everything up
front; never `offline_access` in PRM or challenges).

AS metadata (excerpt):

```json
{
  "issuer": "https://db.exponet.cloud",
  "authorization_endpoint": "https://db.exponet.cloud/oauth/authorize",
  "token_endpoint": "https://db.exponet.cloud/oauth/token",
  "revocation_endpoint": "https://db.exponet.cloud/oauth/revoke",
  "registration_endpoint": "https://db.exponet.cloud/oauth/register",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token", "client_credentials"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none", "private_key_jwt"],
  "client_id_metadata_document_supported": true,
  "authorization_response_iss_parameter_supported": true,
  "scopes_supported": [ "...full catalog..." ]
}
```

## 3. Client registration

**[DECIDED]** ([OD-5](../00-product/open-decisions.md#od-5-mcp-client-registration-policy),
resolved 2026-10-06, option a.) Three methods, in the priority order MCP
clients use; registration never implies trust:

| Method | For | Trust handling |
|---|---|---|
| **Pre-registered** clients | the ExponetDB Web App and the ExponetDB CLI (first party, fixed records); clients of service accounts, created by an admin for one service identity | first-party records ship with the Control Store; a service-account client authenticates with `private_key_jwt` only and is never created through DCR |
| **Client ID Metadata Documents (CIMD)** | modern external clients (preferred) | `client_id` is an HTTPS URL; ExponetDB fetches the document (SSRF-hardened, §7), checks that `client_id` equals the URL, validates `redirect_uris`, caches within its own bounds. **Approval**: a CIMD client is usable only after an admin approves its **exact `client_id` URL** (no domain wildcard, no product name). The approval binds a fingerprint of the security-relevant metadata; a change of it returns the client to review. No third-party client is trusted at bootstrap. |
| **Dynamic Client Registration (RFC 7591)** | older clients without CIMD | deprecated by MCP 2026-07-28, kept as compatibility; a registration creates a **pending** public client (`token_endpoint_auth_method = none`, no `client_secret`); the consent screen refuses pending clients with `CLIENT_NOT_APPROVED`; admins see the registration with its redirect URIs and a pseudonymous requester hash and approve the exact registration with re-authentication |

No shared client secrets in V1: public clients use `none`, confidential
(service-account) clients use `private_key_jwt`; `client_secret_basic` and
`client_secret_post` are not supported.

**Redirect URIs**: exact match, except loopback redirects
(`http://127.0.0.1/...`, `http://[::1]/...`, `http://localhost/...`), which
match on any port as RFC 8252 §7.3 describes; the host, path and query still
match exactly. Only `https` or loopback `http` are accepted.

**Issuer binding**: DCR and pre-registered credentials are bound to this issuer;
CIMD ids are portable by design.

## 4. Authorization request and consent

**[DECIDED]**

- Authorization code flow with **PKCE S256 only** (`plain` refused); `state`
  required; `resource` (RFC 8707) required and must be one of ExponetDB's
  resources; `iss` returned in the authorization response (RFC 9207).
- **[DECIDED]** (Wave 3B, `packages/auth/src/oauth/authorize.ts`.) The
  request is validated completely before anything is stored. Until the
  client (`client_id` once, known, active, a public `cli` or `mcp` client
  with the authorization code grant) and its redirect URI (exact match,
  loopback on any port) are established, every error is a **local error
  page** (`/oauth/error?reason=…`): ExponetDB never redirects to a URI it
  has not matched. After that, errors go to the redirect URI with
  `error`, `state` (when valid) and `iss`: a repeated parameter
  (`invalid_request`), `response_type` other than `code`, `response_mode`
  other than `query`, request objects (`request`, `request_uri`: not
  supported), PKCE other than S256, a missing or foreign `resource` or one
  the client kind may not obtain (`invalid_target`: the CLI and service
  accounts only `api`), a scope that is unknown, repeated, wildcard-shaped
  or never holdable by the client kind (`invalid_scope`; `offline_access`
  and `openid` are unknown). An unknown CIMD URL is never fetched at the
  authorization endpoint: discovery is not approval.
- The validated request is stored on the server for 10 minutes under the
  hash of an opaque handle (`exar_…`) and bound to the hash of an HttpOnly
  `__Host-exdb_oauth` browser-binding cookie (`SameSite=Strict`, 10
  minutes, reused for concurrent requests of the same browser). The
  browser goes to the Web App consent page with the handle in the URL
  fragment (never sent to a server or in a `Referer`). The consent page
  shows and decides the request only for the browser that started it; a
  request is decided once.
- The user authenticates with their ExponetDB identity (passkey or password +
  TOTP); an existing Web App session within the last 12 hours counts, but
  granting any `:prod` write scope requires re-authentication within 5 minutes.
- **Consent screen** (adopting the reference audit's lessons): client name and
  logo from metadata marked as *unverified* unless allowlisted; the redirect host
  shown prominently; a lookalike warning when the name matches a known client but
  the redirect host does not; requested scopes grouped by domain with read/write
  and tier clearly separated; a **target restriction** selector (all targets the
  user may access, or a chosen subset, default: non-production only); the grant
  lifetime (default 30 days, maximum 90); explicit opt-in checkboxes for any
  production write scope.
- The resulting **grant** stores: identity, client, scopes granted (subset of
  requested ∩ what the identity may delegate), target restrictions, tier
  restrictions, expiry, consent time, re-auth time.
- An identity can never grant a client more than it holds itself
  (`access.no-self-escalation`); admin-only scopes are never grantable to MCP
  clients (`access.mcp-ineligible-scopes`).

## 5. Tokens

**[DECIDED]** ([ADR-0022](../01-architecture/adr/0022-opaque-tokens.md))

| Token | Format | Lifetime | Storage | Notes |
|---|---|---|---|---|
| Authorization code | 256-bit random | 60 s, single use | SHA-256 hash | bound to client, redirect URI, PKCE challenge, resource, scopes |
| Access token | opaque, 256-bit random, prefix `exat_` | 10 minutes | SHA-256 hash | audience = one resource; scopes; grant id; identity; client |
| Refresh token | opaque, prefix `exrt_` | rotates on every use; family expires with the grant | SHA-256 hash | **reuse detection**: presenting a rotated-out refresh token revokes the whole family and the grant, and audits `oauth.token_refresh_reuse_detected` |
| Client credentials token | opaque | 10 minutes | hash | service accounts only (`private_key_jwt`, RFC 7523), never human identities |

Why opaque instead of JWT: the AS and both resource servers are the same
deployment with the same database; a hash lookup per request is cheap, gives
**immediate revocation** (stolen token threat) and avoids key-management and
token-format complexity. JWT access tokens (RFC 9068) become relevant only if a
separate resource server appears. Prefixes make leaked tokens detectable by
secret scanners.

Validation per request: hash lookup, `expires_at > now()`, audience equals the
resource, grant active, identity active, client active. **[DECIDED]** (Wave
3B) There is no validation cache: every request reads the token, grant,
client and identity rows live, so a revocation, a disabled client or a
disabled identity ends the token for the very next request. (The baseline
allowed a 30-second cache with broadcast invalidation; it is not needed at
this scale and would weaken immediate revocation.)

**[DECIDED]** (Wave 3B, `packages/auth/src/oauth/token.ts`.) The token
endpoint takes `application/x-www-form-urlencoded` bodies of at most 16 KiB
with no repeated parameter and answers normative OAuth errors as JSON
(never RFC 9457 problems), always with `Cache-Control: no-store`. Client
authentication is exactly one method: `none` (`client_id` only) for public
clients, `private_key_jwt` for service-account clients; a `client_secret`
parameter or an `Authorization` header is `invalid_client`. A code is
locked while it is redeemed: of two concurrent exchanges one wins; a code
presented again after it was used is a replay and revokes the grant and
every token of it (OAuth 2.1 §4.1.3). A refresh token is rotated on every
use; the grant is locked before the token (the order every revocation
takes); a spent token presented again revokes the grant (`refresh_reuse`)
and audits `oauth.token_refresh_reuse_detected`. There is **no grace
window**: of two concurrent refreshes with one token, one wins and the
other ends the family. A `scope` on a refresh may only narrow the access
token; a `resource`, when sent, must name the grant's resource
(`invalid_target`).

**Step-up**: when a tool needs a scope the token lacks, the resource server
returns `403` with `WWW-Authenticate: Bearer error="insufficient_scope",
scope="<all scopes the operation needs>", resource_metadata="…"`; the client
re-authorizes with the union of scopes. Production write scopes always pass
through a fresh consent screen with re-authentication.

**Revocation** (RFC 7009) at `/oauth/revoke`; the Web App's "Connected
applications" page revokes grants (all tokens of the grant die immediately).
**[DECIDED]** (Wave 3B) Revoking a refresh token ends its grant; revoking an
access token ends that token; a token of another client or an unknown
value is answered with success and changes nothing; an API key is
`unsupported_token_type` (it is revoked by an administrator).

**DPoP** (RFC 9449): not required in V1 because no major MCP client supports it
(MCP SEP-1932 is still a draft). **[PLANNED]** Supported for the CLI and service
accounts later as an optional sender constraint.

## 6. Machine-to-machine

**[OBSERVED]** No mainstream MCP client supports `client_credentials` (Claude
states it is not supported; the MCP client-credentials extension is a draft).

**[DECIDED]**

- MCP access is always on behalf of a human identity (authorization code flow).
- CI and backend consumers use the **REST API** with service accounts:
  `client_credentials` with `private_key_jwt`, or API keys
  ([`../08-auth-and-security/identity.md`](../08-auth-and-security/identity.md)).
- Node agents never use OAuth; they use mTLS with enrollment-issued certificates.

## 7. SSRF and fetch hardening

The AS fetches CIMD documents (and later, federated IdP metadata). **[DECIDED]**
Fetches go through a hardened HTTP client: HTTPS only; DNS resolved once and
pinned for the connection; private, loopback, link-local and metadata ranges
(RFC 1918, `127.0.0.0/8`, `::1`, `169.254.0.0/16`, `fd00::/8`,
`100.64.0.0/10`) refused; redirects refused (a client metadata URL must answer directly);
response size cap 64 KiB; timeout 5 s; content type `application/json`.

## 8. Web App sessions

The Web App is a first-party client using the same AS with a session-cookie
variant ([`../08-auth-and-security/identity.md`](../08-auth-and-security/identity.md#3-web-sessions)).
It never holds refresh tokens in JavaScript-accessible storage.

## 9. Compliance checklist (MCP 2026-07-28 and 2025-11-25)

| Requirement | Status in design |
|---|---|
| Resource server; PRM with `authorization_servers` | yes |
| `WWW-Authenticate` with `resource_metadata` on 401 | yes |
| AS metadata via RFC 8414 | yes (OIDC discovery not served: no ID tokens) |
| PKCE S256 advertised (`code_challenge_methods_supported`) | yes |
| CIMD supported | yes (allowlisted) |
| DCR (deprecated, optional) | yes (approval-gated) |
| `resource` parameter; audience validation | yes |
| `iss` in authorization response (RFC 9207) | yes |
| Refresh token rotation for public clients | yes |
| Scope challenges, 403 `insufficient_scope` | yes |
| No token passthrough | yes (no upstream calls with client tokens) |
| Tokens only in `Authorization` header | yes |
| `Origin` validation | yes |
| Loopback redirect any port | yes |

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
| Protected Resource Metadata (RFC 9728) for MCP | `https://db.exponet.cloud/.well-known/oauth-protected-resource/mcp` (path-inserted) and the root form `/.well-known/oauth-protected-resource` |
| PRM for REST | `https://db.exponet.cloud/.well-known/oauth-protected-resource/api` |
| AS metadata (RFC 8414) | `https://db.exponet.cloud/.well-known/oauth-authorization-server` |
| OIDC discovery (for clients that try it) | `https://db.exponet.cloud/.well-known/openid-configuration` |

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

**[OPEN: OD-5]** Recommended setting: three methods, in the priority order MCP clients use:

| Method | For | Trust handling |
|---|---|---|
| **Pre-registered** clients | ExponetDB CLI, CI service accounts, the Web App, and any MCP client the owner registers by hand | admin-created; may use `private_key_jwt` |
| **Client ID Metadata Documents (CIMD)** | Claude, Claude Code, ChatGPT, Codex, VS Code (all support it per the research) | `client_id` is an HTTPS URL; ExponetDB fetches the document (SSRF-hardened, §7), checks `client_id` equals the URL, validates `redirect_uris`, caches per HTTP caching headers. **Allowlist**: a CIMD client is usable only after an admin approves its `client_id` URL (one click per client product); the five known ones are pre-approved at bootstrap as a default allowlist the owner can edit. |
| **Dynamic Client Registration (RFC 7591)** | Cursor and Antigravity (no CIMD support per the research), older clients | deprecated by MCP 2026-07-28 but still needed; a registration creates a client in state `pending_approval`; the consent screen refuses pending clients with `CLIENT_NOT_APPROVED` and tells the user that an admin must approve; admins see the registration with its redirect URIs, software statement (if any), and requester IP hash |

[OD-5](../00-product/open-decisions.md#od-5-mcp-client-registration-policy) asks the
owner to confirm this default (approval-gated DCR + CIMD allowlist) versus a more
open setting.

**Redirect URIs**: exact match, except loopback redirects
(`http://127.0.0.1/...`, `http://localhost/...`), which match on any port as
RFC 8252 §7.3 describes (Claude Code's metadata lists port-less loopback URIs).
Only `https` or loopback `http` are accepted.

**Issuer binding**: DCR and pre-registered credentials are bound to this issuer;
CIMD ids are portable by design.

## 4. Authorization request and consent

**[DECIDED]**

- Authorization code flow with **PKCE S256 only** (`plain` refused); `state`
  required; `resource` (RFC 8707) required and must be one of ExponetDB's
  resources; `iss` returned in the authorization response (RFC 9207).
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
resource, grant active, identity active, client active. Validation results are
cached for at most 30 s per token with revocation broadcast invalidating the
cache.

**Step-up**: when a tool needs a scope the token lacks, the resource server
returns `403` with `WWW-Authenticate: Bearer error="insufficient_scope",
scope="<all scopes the operation needs>", resource_metadata="…"`; the client
re-authorizes with the union of scopes. Production write scopes always pass
through a fresh consent screen with re-authentication.

**Revocation** (RFC 7009) at `/oauth/revoke`; the Web App's "Connected
applications" page revokes grants (all tokens of the grant die immediately).

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
| AS metadata via RFC 8414 (and OIDC discovery) | yes |
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

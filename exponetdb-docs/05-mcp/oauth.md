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
| Resource Servers | `https://db.exponet.cloud/mcp` (MCP) and `https://db.exponet.cloud/api` (REST) | Separate audiences; a token is valid for exactly one. An MCP client obtains tokens for `/mcp` only; the CLI and service accounts for `/api` only (G3B final hardening) |
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
  "scopes_supported": ["targets.read", "schema.read", "diagnostics.read", "data.read:nonprod", "data.read:prod", "migrations.read", "migrations.plan", "migrations.apply:nonprod", "migrations.apply:prod", "…every MCP-grantable scope"],
  "bearer_methods_supported": ["header"],
  "resource_name": "ExponetDB"
}
```

**[DECIDED]** (owner decision 2026-10-13) For `/mcp`, `scopes_supported` in
the PRM and the scope of the first `WWW-Authenticate` challenge list **every
scope an MCP client may hold** (`MCP_ADVERTISED_SCOPES` in
`packages/contracts/src/scopes.ts`). Before, they listed the read baseline
(`targets.read`, `schema.read`, `diagnostics.read`) and left the rest to
step-up challenges; but a client lists only the tools its grant covers, so a
model never called a tool that could step it up, and Claude ended with read
tools only. Now the client asks for all of them and the person chooses on
the consent page: ordinary scopes are preselected, production scopes are not
and need the separate production opt-in, and the trifecta warning applies.
Never `offline_access` in PRM or challenges. The API resource keeps the
read baseline.

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

**[DECIDED]** (owner decision 2026-10-13, [OD-5](../00-product/open-decisions.md#od-5-mcp-client-registration-policy)
revised) **Open registration is the default.** The serve setting
`EXPONETDB_OAUTH_CLIENT_REGISTRATION` is `open` (default) or `review`.
Under `open`, a CIMD client is discovered at the authorization endpoint and
a DCR registration is recorded, both **approved automatically** (no
approver; the approval binds the fingerprint of the recorded metadata), so
connecting Claude, Claude Code, Cursor, Codex or VS Code needs no
administrator step. What protects the installation is unchanged: each
person signs in with a passkey and consents on ExponetDB's page to the
client (its name marked "not verified", the lookalike warning), the scopes
and the tiers; production applies by agents wait for a human approval;
production rows stay `humans_only` for agents (OD-13 (a)). An
administrator can disable any client on **Access → OAuth clients**
(`/access/oauth-clients`; the old `/admin/clients` link redirects there; every grant
and token ends at once) or reject a pending one; a rejected or disabled
client is never approved automatically (`client_not_approved`). The
database guard (bundle `oauth-open-registration`) admits an approval
without an approver only for a CIMD or DCR client that is new or pending,
and a re-approval of an active CIMD client with a changed fingerprint.
Under `review` the rule of 2026-10-06 below applies unchanged.
**[OBSERVED]** (Wave 8 completion, 2026-10-20) `GET /installation` reports
the running mode as `oauthClientRegistration`, and the OAuth clients page
names it.

**[DECIDED]** ([OD-5](../00-product/open-decisions.md#od-5-mcp-client-registration-policy),
resolved 2026-10-06, option a; the `review` policy since 2026-10-13.) Three
methods, in the priority order MCP clients use; registration never implies
trust:

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

**[DECIDED]** (Wave 3B, `packages/auth/src/oauth/registry.ts`,
`client-metadata.ts`.) How the registry works:

- **CIMD.** An administrator (`oauth.client.register_cimd`, human-only)
  adds a client by its exact `client_id` URL; ExponetDB fetches the
  document through the hardened fetcher (§7) and records the client as
  `pending`. The document must name exactly that URL as `client_id`,
  declare a public client (`token_endpoint_auth_method` absent or `none`;
  no `client_secret`, no `jwks`, no `jwks_uri`), at most 8 exact redirect
  URIs, grant types within `authorization_code` and `refresh_token`
  (with `authorization_code`), `response_types` only `code`. Only the
  name, `client_uri`, `software_id` and `software_version` are kept, as
  bounded text; contacts, logos and policy URLs are not stored. Under
  `review` an unknown CIMD URL presented at the authorization endpoint is
  never fetched (`client_unknown`). Under `open` it is fetched and
  validated the same way and recorded as approved automatically
  (`oauth.client_registered` with `approvedAutomatically`); an invalid
  document or an exceeded registration rate answers `client_unknown` and
  records nothing.
- **Approval** (`oauth.client.approve`, inline, re-authentication within 5
  minutes) names the client and the fingerprint the administrator
  reviewed; a different current fingerprint is `PLAN_STALE`. The
  fingerprint covers `client_id`, redirect URIs, authentication method,
  application type, grant types and keys; display data is not part of it.
  `reject` closes a pending client; `disable` ends every grant and token of
  an active client at once (Control Store trigger). The database refuses a
  change of redirect URIs, grant types, application type or keys under the
  same fingerprint, so such a change always meets the review (or, for a
  service client, the key replacement that approves the new fingerprint);
  a first-party client changes only through a Control Store bundle, and
  disabling it stays possible as a kill switch.
- **Freshness.** The cached document of a CIMD client is fetched again
  when it is stale (cache lifetime from `Cache-Control: max-age`, bounded
  to 5 minutes … 24 hours, default 1 hour), by the authorization endpoint
  or by an administrator. A display change is applied in place; under
  `review` a changed fingerprint returns an approved client to `pending`
  and ends its grants in the same transaction
  (`oauth.client_metadata_changed`); under `open` the client is approved
  again automatically with the new fingerprint and keeps its grants. A failed
  fetch refuses the authorization and leaves the client's state unchanged.
- **DCR** (`POST /oauth/register`) accepts at most 16 KiB of JSON, the
  same strict public-client metadata (a `client_id` from the client is
  refused: the server assigns `exdb-dcr-…`), 10 registrations per client
  address and hour, 100 per hour in total, at most 3 pending per requester
  and at most 50 pending
  registrations at a time; a pending registration expires after 7 days and
  is pruned. Under `open` the registration is active at once (the pending
  bounds do not apply; the rate limits do, shared with CIMD discovery),
  and one that no grant and no authorization request names is pruned
  about a week after its registration. The response carries no secret and no registration access
  token (no management API). The requester is stored only as a keyed
  pseudonym (`requester_hash`), never as an address.

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
  accounts only `api`, an MCP client only `mcp`), a scope that is unknown, repeated, wildcard-shaped
  or never holdable by the client kind (`invalid_scope`; `offline_access`
  and `openid` are unknown). Under `review` an unknown CIMD URL is never
  fetched at the authorization endpoint; under `open` it is discovered
  (§3) before the client is checked, and a pending client is approved
  automatically.
- The validated request is stored on the server for 10 minutes under the
  hash of an opaque handle (`exar_…`) and bound to the hash of an HttpOnly
  `__Host-exdb_oauth` browser-binding cookie (`SameSite=Strict`, 10
  minutes, reused for concurrent requests of the same browser). The
  browser goes to the Web App consent page with the handle in the URL
  fragment (never sent to a server or in a `Referer`). The consent page
  shows and decides the request only for the browser that started it; a
  request is decided once.
- **[DECIDED]** (Wave 8 Phase 8; `apps/web/src/app/router.ts`,
  `src/lib/navigation/search.ts`) The Web App reads the handle from the
  fragment exactly as the address bar has it and matches it against the
  exact grammar `#request=exar_<43>`. Its router writes its canonical
  location back on load with the fragment percent-decoded; the app keeps
  the raw fragment when the router writes the same fragment in decoded
  form, so an encoded handle (`exar_%41…`) never becomes a valid one by
  that rewrite and is refused like any other malformed fragment. Query
  values are read as plain strings (never as JSON), so
  `?returnTo=%22%2Fapprovals%22` is the text `"/approvals"` and falls back
  to the account page. One-time link tokens (`/setup`, `/invite`,
  `/recover`) leave the address bar and the history before the router
  exists. Pinned by `apps/web/test/app/router.test.tsx`.
- The user authenticates with their ExponetDB identity (passkey or password +
  TOTP); an existing Web App session within the last 12 hours counts, but
  granting any `:prod` write scope requires re-authentication within 5 minutes.
- **Consent screen** (adopting the reference audit's lessons): client name from
  metadata marked as *name not verified* unless first party (allowlisted); **no
  logo is ever loaded from client metadata** (**[DECIDED]** Wave 8 order,
  Appendix A, consistent with
  [`threat-model.md`](../08-auth-and-security/threat-model.md) and the code,
  which loads none): the screen shows the client's initial in a neutral tile
  next to the name; the redirect host shown prominently; a lookalike warning
  when the name matches a known client but the redirect host does not;
  requested scopes grouped by domain with read/write and tier clearly
  separated; a **target restriction** selector (all targets the
  user may access, or a chosen subset, default: non-production only); the grant
  lifetime (default 30 days, maximum 90); explicit opt-in checkboxes for any
  production write scope.
- **[DECIDED]** (Wave 7 order §16, minimal; since Wave 8 `apps/web/src/features/consent/`,
  `Application.consentView`/`consent`.) The consent view lists the targets
  the person can see (`targets`: id, path, tier; at most 200, from the
  registry as this person); the page offers "every target of the chosen
  kinds" (the default, `targets: { kind: 'all' }`) or "only the targets
  checked below" (`targets: { kind: 'list', targetIds }`, at most 64). The
  application checks each chosen target again (`target.get` by the engine
  on the registry's subject, as this person) and that its tier is among the
  chosen tiers; anything else is `VALIDATION_FAILED` on
  `/targets/targetIds/<i>` and no grant is written. Each scope shows what
  its strongest action does (`effect`: reads; records plans or checks,
  changes nothing; changes), derived from the action contracts:
  `schema.read` (drift checks record a result) is never shown as "changes".
  The re-authentication rule still uses `write` (any effect other than a
  read). `[OBSERVED]` in `mcp.int.test.ts` and `web-review.e2e.test.ts`.
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
locked while it is redeemed: of two concurrent exchanges one wins; the
`code_verifier` and the stored challenge are validated, the challenge must
decode to exactly the 32 bytes of a SHA-256 digest (canonical base64url),
and the digest of the verifier is compared with `timingSafeEqual` (G3B
final hardening; in-process hardening, no claim about network timing); a
code presented again after it was used is a replay and revokes the grant and
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

**Last use of a grant.** **[DECIDED]** (Wave 7 order §16, decision 10;
bundle `grant-last-use`, `packages/auth/src/oauth/usage.ts`) Every
authenticated request with an access token notes its grant's last use:
`oauth.grant_last_use` holds one row per grant with the minute
(`last_used_at`, truncated to the minute) and the class of the use (an MCP
tool's rate class `read`, `plan`, `apply`, `data`, or `rest` for
`/api/v1`). The upsert changes a row only when the stored minute is older,
so a grant is written at most once a minute across processes; each serve
process also skips the round trip within the minute. It runs in the
background and never fails a request; an API key has no grant and records
nothing. It is a data basis only: Wave 8 shows "last used" on the
Connected applications page and Wave 9 derives an "unused for 30 days"
finding; it is never a log of requests (the audit and the request logs are)
and never an input to a decision. A table of its own, so a use never locks
the grant row that a refresh or a revocation takes. **[OBSERVED]**
(2026-10-13, Wave 8 server batch S1) `GET /me/grants` and `GET /grants`
return it as the optional `lastUsedAt` and `lastUseClass` of the grant view
(`packages/auth/src/oauth/grants.ts`, a left join: `null` means no use is
recorded, not that the grant was never used, because the record began with
its deployment and the background write can be lost). **[OBSERVED]**
(2026-10-20, Wave 8 completion, REST only) `GET /oauth-clients` and
`GET /oauth-clients/{id}` aggregate the same record per client: `lastUsedAt`
is the latest minute any grant of the client authenticated a request (over
all of its grants, revoked and expired ones too; `null` with the same meaning
as above) and `activeGrantCount` the grants that are neither revoked nor
expired now. The list computes both in the statement that reads the page
(`packages/auth/src/oauth/clients.ts`, one lateral aggregate per client); the
answers of the client decisions leave them out. Still a data basis only.

**Device flow and the CLI.** **[DECIDED]** (Wave 3B,
`packages/auth/src/oauth/device.ts`, `apps/cli`.) The first-party CLI signs
in with the loopback authorization code flow (a one-shot listener on
`127.0.0.1` and a random port, PKCE S256, a fresh `state`; the callback must
carry that `state` and the expected `iss` before the code is exchanged; the
page shown in the browser reflects nothing) or, without a browser, the
device flow (RFC 8628) at `/oauth/device_authorization`: device and user
codes are stored as hashes and live 10 minutes; the user code is 8 letters
from `BCDFGHJKLMNPQRSTVWXZ` (20^8 codes), every verification attempt counts
against the person (10 per 10 minutes, counted outside the transaction a
wrong code rolls back); there is no `verification_uri_complete`, so a link
from someone else cannot carry their code; a poll within the interval is
`slow_down` and the interval grows by 5 seconds (at most 60). The person
approves in a Web App session with the same re-evaluated consent as the
authorization code flow. **[DECIDED]** (G3B final hardening, owner decision
on D13, 2026-10-06.) The device flow is a convenience flow, not an
elevation ceremony: it carries only scopes whose contract says
`explicitConsent: false` (`isDeviceFlowScope`), so no production scope and
no human-only administrative scope ever passes through it, and neither does
a later scope classified as explicit consent. The decision is the
contract's flag, never the scope's name. A request naming one such scope is
refused whole with `invalid_scope` (nothing is stored); a decision never
adds one; the Control Store repeats the rule (`oauth.scopes.explicit_consent`,
the device-code guard refuses such a scope at insertion and an approving
grant that holds one or exceeds the device's scopes). The loopback
authorization code flow of the CLI keeps offering the CLI's elevated scopes
under the normal consent and re-authentication rules. The CLI keeps its tokens in
`$XDG_CONFIG_HOME/exponetdb/credentials.json` (or `EXPONETDB_CONFIG_DIR`):
0600 in a 0700 directory, written atomically (exclusive temporary file,
fsync, rename), refused when others could read it or another user owns it;
a refresh runs under an exclusive lock file and re-reads the store, so two
CLI processes never rotate the same refresh token twice (which would end
the grant through reuse detection). `exponetdb logout` revokes the refresh
token before it deletes the local copy and reports when the server did not
confirm the revocation. No token is printed or logged.

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
- **[DECIDED]** (Wave 3B) Service accounts, their `private_key_jwt`
  clients, machine grants and API keys are described in
  [`../08-auth-and-security/identity.md` §5](../08-auth-and-security/identity.md#5-service-accounts).
  A token endpoint refusal after the client authenticated is returned, not
  thrown, so what the request recorded (an assertion's `jti`, a
  revocation) commits with it.

## 7. SSRF and fetch hardening

The AS fetches CIMD documents (and later, federated IdP metadata). **[DECIDED]**
Fetches go through a hardened HTTP client: HTTPS only; DNS resolved once and
pinned for the connection; private, loopback, link-local and metadata ranges
(RFC 1918, `127.0.0.0/8`, `::1`, `169.254.0.0/16`, `fd00::/8`,
`100.64.0.0/10`) refused; redirects refused (a client metadata URL must answer directly);
at most 5 KiB read (G3B final hardening; 64 KiB until then); timeout 5 s;
a JSON media type.

**[DECIDED]** (Wave 3B, `packages/auth/src/oauth/fetch.ts`.) The fetcher is
not a general HTTP client and never calls `fetch(url)`:

- **URL**: `https`, a DNS host name with a letter in its last label (no IP
  literal, no `localhost`, `.local` or `.internal`), the default port, a
  path other than `/` without dot segments, no user information, query or
  fragment, at most 512 characters, already canonical.
- **Addresses**: the name is resolved once; *every* answer must be public,
  otherwise nothing is fetched (a round-robin answer cannot smuggle an
  internal address). Refused IPv4: `0/8`, `10/8`, `100.64/10`, `127/8`,
  `169.254/16`, `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.88.99/24`,
  `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4`,
  `240/4`. IPv6 must be global unicast (`2000::/3`) and outside `64:ff9b::/96`,
  `64:ff9b:1::/48`, `100::/64`, `2001::/23`, `2001:db8::/32`, `2002::/16`,
  `3fff::/20`, `5f00::/16`; `::`, `::1`, `fc00::/7` (including
  `fd00:ec2::254`), `fe80::/10`, `fec0::/10` and `ff00::/8` are outside
  `2000::/3` anyway. An IPv4-mapped address is judged as its IPv4 address.
- **Connection**: to the pinned address only (no second resolution, so a
  rebinding between check and use cannot happen), no agent and no proxy,
  TLS 1.2 or later with the certificate verified for the host name (SNI and
  verification use the name, not the address).
- **Exchange**: one `GET` with `Accept: application/json,
  application/*+json` and `Accept-Encoding: identity`; any 3xx refused,
  only 200 accepted; no `Content-Encoding`; 5 seconds for resolution and
  exchange together; strict JSON (duplicate members refused).
- **Media type** **[DECIDED]** (G3B final hardening): `Content-Type` is
  parsed as an RFC 9110 media type (type, subtype and parameters in one
  pass, case-insensitive names, quoted strings, no trailing garbage) and
  must be `application/json` or a structured `application/<name>+json`
  (CIMD -02 §3 allows the more specific type). `text/json`, `text/plain`,
  `application/javascript`, `application/json.evil`,
  `application/x+json.evil`, a bare `application/+json`, a `charset` other
  than UTF-8 and every malformed value are refused; never a substring test.
- **Size** **[DECIDED]** (G3B final hardening): at most 5 KiB (5120 bytes,
  the 5 KB CIMD -02 §8.7 recommends), applied to the declared
  `Content-Length` (refused before reading), to the body as it arrives,
  chunked or not, and to the bytes actually received on the connection:
  every byte the server sends is counted before the HTTP parser sees it
  (head at most 8 KiB, the whole response at most 5 KiB plus that), and a
  body longer than its declared length is `too_large`. A giant chunk or a
  slow oversized stream ends the connection as soon as the budget is
  passed.
- Refusals carry a reason (`address_refused`, `tls_failed`,
  `redirect_refused`, `too_large`, `timeout`, …) in `CLIENT_METADATA_INVALID`;
  the document's content never reaches a log.

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

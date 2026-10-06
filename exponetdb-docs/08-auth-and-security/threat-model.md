# Threat model

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05; reviewed at every wave's security gate (last: Wave 3B for G3B, §5; G3B accepted 2026-10-06 after the final hardening) |
| Read before | [`../00-product/constitution.md`](../00-product/constitution.md) Part IV, [`ai-agent-safety.md`](./ai-agent-safety.md) |

## 1. Assets

| Asset | Why it matters |
|---|---|
| Production data in managed databases (REOSA customer data, personal data) | confidentiality, integrity, availability; legal obligations |
| Schema and ledger integrity of managed databases | a wrong migration or a forged history corrupts production |
| Database credentials held by ExponetDB | direct access to production |
| Node agent channel (job signing, agent identities) | root-equivalent capabilities on database hosts |
| ExponetDB authorization state (roles, grants, policies, break-glass) | whoever changes it controls everything above |
| Audit trail | accountability, incident reconstruction |
| Backups and their keys | a full copy of production; also the only way back after disaster |
| Availability of the control plane | needed for changes and diagnosis during incidents |

## 2. Trust boundaries

```
                         INTERNET (untrusted)
  ┌──────────────┐  ┌───────────────┐  ┌──────────────────┐  ┌───────────────────────┐
  │ Browser      │  │ MCP clients   │  │ REST/SDK/CLI/CI  │  │ Future IdP            │
  │ (Web App)    │  │ (AI agents)   │  │ clients          │  │ auth.exponet.cloud    │
  └──────┬───────┘  └──────┬────────┘  └────────┬─────────┘  └──────────┬────────────┘
         │ B1 cookie+CSRF   │ B2 OAuth bearer     │ B3 bearer/API key     │ B4 OIDC
  ═══════╪══════════════════╪═════════════════════╪══════════════════════╪════════ TLS at Traefik (reos-01)
         ▼                  ▼                     ▼                      ▼
  ┌───────────────────────────────────────────────────────────────────────────────────┐
  │ serve (public-facing; no target credentials)                                      │
  └───────────────┬───────────────────────────────────────────────────────────────────┘
                  │ B5 Control Store roles (per process)
  ┌───────────────▼────────────┐   B6   ┌──────────────────────────────┐
  │ Control Store (PostgreSQL) │◀──────▶│ worker (credentials, job key) │
  └───────────────▲────────────┘        └──────────────┬───────────────┘
                  │                                    │ B7 SQL over TLS, least-privilege roles
  ┌───────────────┴────────────┐                       │      (private network)
  │ gateway (agent CA, no      │                       ▼
  │ credentials, no job key)   │        ┌───────────────────────────────────────────┐
  └───────────────▲────────────┘        │ Managed PostgreSQL (data plane)            │
                  │ B8 mTLS             │   ▲ B9 local socket, peer (superuser)       │
                  │ (private network)   │   │                                        │
                  └─────────────────────┼── exponetdb-node ── B10 Unix socket ── helper (root)
                                        └───────────────────────────────────────────┘
                                                   │ B11 HTTPS to backup storage (off-host/off-provider)
                                                   ▼
                                        ┌──────────────────────────┐
                                        │ Backup storage provider  │
                                        └──────────────────────────┘
```

| Boundary | Crosses | Primary controls |
|---|---|---|
| B1 Browser ↔ serve | user sessions | passkeys/TOTP, `__Host-` cookies, SameSite=Strict, CSRF tokens, CSP, re-auth for risky actions |
| B2 MCP client ↔ serve | delegated agent access | OAuth 2.1 + PKCE, audience-bound opaque tokens, scopes with tiers, grant target restrictions, policy engine, approvals |
| B3 programs ↔ serve | CI and backends | client credentials with `private_key_jwt`, scoped expiring API keys |
| B4 IdP ↔ ExponetDB | authentication assertions | OIDC with PKCE, issuer pinning, `(iss, sub)` mapping, no claim-based authorization |
| B5/B6 processes ↔ Control Store | control state | per-process DB roles, network isolation, TLS on the Docker network where supported |
| B7 worker/serve ↔ managed PostgreSQL | inspection, reads, migrations, operator actions | role-per-path, `verify-full` TLS, identity guards, `pg_hba` source restrictions |
| B8 agent ↔ gateway | jobs and telemetry | mTLS, pinned root, signed jobs, replay protection |
| B9 agent ↔ local PostgreSQL | superuser actions | local peer auth only; compiled capability SQL |
| B10 agent ↔ helper | root actions | typed requests, `SO_PEERCRED`, allowlists |
| B11 agent ↔ backup storage | backup data | client-side encryption, scoped storage credentials, object lock |

## 3. Threats and mitigations

Format: threat → scenario → mitigations (where specified) → residual risk.

| # | Threat | Scenario | Mitigations | Residual |
|---|---|---|---|---|
| T1 | Malicious or compromised MCP client | A client app sends harmful tool calls or exfiltrates results | scopes and tiers per grant; target restrictions; policy approvals for prod; no write SQL path; data reads gated (`humans_only` on prod by default); rate limits; audit; grant revocation | a client with `data.read:nonprod` can read nonprod data it was granted |
| T2 | Stolen OAuth token | Token leaked from a client's storage | opaque 10-min access tokens bound to audience; rotating refresh tokens with reuse detection revoking the family; grant revocation; prefixes for secret scanning | 10-minute window for an access token |
| T3 | Over-privileged AI agent | User grants broad scopes for convenience | consent defaults to nonprod; prod write scopes need explicit opt-in with re-auth; agent prod applies require approval by default; admin scopes not MCP-grantable; standing findings for broad grants | owner can choose to relax defaults |
| T4 | Prompt injection causing DB mutation | Text in a schema comment, a row, a log line or a web page instructs the agent to drop a table | agent intent ≠ authorization: mutations need plans and policy; prod needs human approval; tool outputs label untrusted fields; no tool executes text from results; see [`ai-agent-safety.md`](./ai-agent-safety.md) | nonprod damage within granted scopes (recoverable by rebuild/restore) |
| T5 | Stale plan replay | Old plan applied after state changed | expiry, single use, bindings to fingerprint, ledger hash, generation; re-check under lock | none known |
| T6 | Plan substitution | Attacker swaps the content between approval and execution | approvals bind `planHash`; content stored with the plan and re-hashed (`content` binding); apply takes only a plan id | Control Store compromise (see T11) |
| T7 | Migration checksum substitution | Same id, different SQL slipped into production | checksum computed server-side; immutable per id across all ledgers; staging evidence requires the identical checksum and verify digest, and the verify digest binds the whole `verify.sql` including its directives (`-- covers:`, `-- calls:`, `-- reads-view:`) | none known |
| T8 | Dependency confusion | A bundle claims a dependency from another project or a forged id | dependencies resolved only within the project stream; unknown ids rejected; dependency checksums compared | — |
| T9 | Node impersonation | Attacker pretends to be `reos-db-01`'s agent | mTLS with host-generated keys; enrollment tokens single-use, bound, short-lived; duplicate-identity detection; node state checked per request | host compromise = node compromise |
| T10 | mTLS compromise | CA key stolen | issuing CA key encrypted, used only by gateway; offline root; short-lived certs; re-enrollment runbook | root compromise requires full re-enrollment |
| T11 | Control database compromise | Attacker gets SQL access to the Control Store | no plaintext secrets in it (keyring outside); jobs need the worker's signing key (outside DB in plaintext); audit chain anchored off-host; ledger in targets (divergence detectable) | attacker can deny service, alter grants/policies (detectable via audit chain gaps if they also tamper) |
| T12 | Target credential leak | ExponetDB's PG credentials leak | least-privilege roles (no superuser over network); `pg_hba` restricted to control-plane source; rotation; private network only | on `reos-01`, other containers share the source IP (documented) |
| T13 | SQL injection into management queries | Hostile identifiers in catalogs break engine SQL | bind parameters; always-quote identifier escaper; no nested quoting contexts; no `DO` blocks with spliced names; hostile-fixture tests (the reference implementation had a verified injection via role names) | — |
| T14 | Dangerous arbitrary SQL | Agent or user runs destructive SQL | no write path outside migrations; parser-based admission for reads with a function, operator, cast and relation allowlist; read-only role + read-only tx | — |
| T15 | Malicious `verify.sql` | Verification used to write, lock or exfiltrate | `verify.sql` is reviewed bundle content bound by digest to the plan and approval; admission allows only `SELECT` with an explicit allowlist of `pg_catalog` built-ins; consumer functions and views only as declared checks that require approval; dedicated verifier role without write privileges; read-only rolled-back transaction on a closed-after-use connection; timeouts; `ok`/`detail`-only result contract | PostgreSQL is not a sandbox: a reviewed, approved consumer check can still have side effects; a migration author (who already has DDL power) can leak data through the pass/fail and `detail` channel |
| T16 | Malicious migration | Migration with a backdoor (e.g. `SECURITY DEFINER` function granting access) | lint (`security_definer_without_search_path`, grants), analysis shows grants and security-relevant changes, staging-first, human approval for prod, drift classes for security changes | a reviewed-and-approved malicious migration (human review is the last line) |
| T17 | Supply-chain risk | Compromised npm/Go dependency in ExponetDB | lockfiles, dependency review, minimal dependencies in agent and helper, SBOM, pinned base images, signed releases, no install scripts in CI where avoidable | inherent residual risk of dependencies |
| T18 | Backup exfiltration | Backup storage bucket read by an attacker | client-side encryption (keys not at the storage provider), scoped storage credentials, separate provider for off-site copy | key compromise on the DB host = data compromise anyway |
| T19 | Restore into the wrong target | A restore overwrites production or lands in the wrong environment | restores only into scratch or explicitly named targets; destination identity and tier shown and typed-confirmed; recovery and unmasked production clones are `critical` (drills into scratch `standard`, clones `high`), human-only, re-auth; identity marker stamping; no in-place restore over running clusters in V1 | — |
| T20 | Production/staging confusion | Staging credentials point at production (or vice versa) | target identity marker checked before every write; `system_identifier` pinning; tier separation in scopes | read paths before identity check (observer reads are harmless) |
| T21 | Audit tampering | Attacker deletes or edits audit rows | INSERT-only grants, triggers, hash chain, off-host checkpoints with object lock, hourly incremental and daily full verification | superuser can rewrite since last export (≤ 1 h window, detectable) |
| T22 | Break-glass abuse | Insider uses break-glass to bypass staging | human-only, rule-specific, time-boxed, reason required, re-auth, out-of-band notification, banner, mandatory post-incident review finding; never overrides checksum/identity/staleness | an owner can still do harm deliberately (accountability, not prevention) |
| T23 | CSRF / session compromise in Web App | Malicious site triggers actions or steals session | `SameSite=Strict`, CSRF tokens, `Origin` checks, `HttpOnly` cookies, strict CSP (no inline scripts), no third-party scripts, re-auth for risky actions | XSS in the Web App (mitigated by CSP and escaping of hostile metadata) |
| T24 | OAuth client impersonation | A malicious app registers as "Claude" | CIMD allowlist; DCR approval gating; consent shows redirect host and lookalike warnings; exact redirect matching | user ignoring warnings for an approved but malicious client |
| T25 | Service account leakage | CI secret leaks | scoped, expiring keys; nonprod by default; prod write requires admin + standing finding; `private_key_jwt` preferred (no shared secret) | — |
| T26 | SSRF from database tooling | Fetching CIMD documents, IdP metadata, or a feature that fetches URLs | hardened fetcher (private ranges blocked, DNS pinning, redirects refused, size/time caps); no user-controlled fetches elsewhere; agent has no URL-fetch capability | — |
| T27 | Hostile schema metadata | Object names/comments contain markup, control characters, prompt-injection text | escaped rendering, length caps, untrusted-field labeling in MCP, never interpolated into SQL or prompts as instructions | agents may still be influenced (see T4) |
| T28 | Log/statement secret leakage | Passwords or PII appear in statements, errors, logs | parse-based redaction, sensitive-command summaries, `DETAIL` dropped, logger denylist, verifiers instead of passwords | lexical fallback is weaker (marked) |
| T29 | Denial of service on managed DB by ExponetDB | Diagnostics or verification overload production | connection budget per cluster, timeouts, cost preflight for reads, sampling intervals, `lock_timeout` for DDL, plan-guarded introspection | — |
| T30 | Gateway exposure | Gateway reachable from the internet | private-network listener only (V1); mTLS required for every request | — |
| T31 | Agent job flooding | Compromised control plane spams restarts | capability ceiling; prod node operations need approval; per-node job rate limits enforced by the agent (e.g. at most one restart per 10 min) | availability impact |
| T32 | Clock manipulation | Expired plans or jobs accepted | server clock only for plan expiry; agent skew checks; NTP monitoring | — |
| T33 | Data exfiltration via `data.read` | Agent reads personal data at scale | prod `humans_only` default; row/byte caps; sensitive column masking; audit of every query; rate limits | granted nonprod data reads (nonprod should not contain production personal data: a recommendation to consumers) |
| T34 | Second ExponetDB installation managing the same DB | Copied config or rogue install | `installation_id` in identity marker; ledger divergence detection | — |

## 4. Review cadence

The threat model is reviewed at each wave's security gate
([`../14-roadmap/acceptance-gates.md`](../14-roadmap/acceptance-gates.md)), after
any incident, and when a new interface, capability or data class is added.

## 5. Review log

### Wave 2 (2026-10-05, reviewed for G2; G2 accepted the same day)

**[OBSERVED]** What the Control Plane skeleton implements of the mitigations
above, and what it adds; evidence in the
[G2 gate record](../14-roadmap/gates/2.md).

| Threat | State after Wave 2 |
|---|---|
| T11 Control database compromise | The keyring is never in the Control Store (a scan of every row finds no key and no plaintext); ciphertext is split by consumer, each readable only by its own login; audit is append-only for every login including the owner, and the chain is checked by the database and by `audit verify`. The off-host anchor works against an S3-compatible test server; **no production anchor exists until the deployment**, so until then a superuser rewrite would not be detectable from outside. |
| T12 (for the Control Store) | Each process and command refuses a login that is not exactly its role or holds any privilege (superuser, `CREATEROLE`, `CREATEDB`, `REPLICATION`, `BYPASSRLS`, a membership); the superuser is used once, for the bootstrap SQL, and is never configured in a resource. |
| T17 Supply chain | GitHub Actions pinned to commit SHAs, base images pinned by digest, frozen lockfile with exact versions, `--ignore-scripts` in the image build, `bun audit` clean. SBOM and signed releases (listed above) do not exist yet and no wave owns them; the image is not bit-for-bit reproducible. Both are open items for the owner (G2 record §6). |
| T21 Audit tampering | As specified, plus the database chain guard (`EXA01` to `EXA06`) and tamper tests with a superuser that bypasses every control. Residual unchanged: a superuser can rewrite events since the last exported checkpoint (hourly). |
| T28 Secret leakage in logs | Logger with a field allowlist and a secret-pattern denylist (26-case corpus), errors without messages or `DETAIL`, configuration errors name variables and never values, commands write secrets only to new 0600 files, the image's logs are scanned in CI. |
| Information disclosure (new) | The public probes expose the status and the request id only; the build version and per-check detail are on the loopback listener. Found and fixed during the G2 review. |

### Wave 3A (2026-10-05, reviewed for G3A; G3A accepted 2026-10-06)

**[OBSERVED]** What the identity and authorization foundation implements of
the mitigations above, what it adds and what stays open; evidence in the
[G3A gate record](../14-roadmap/gates/3a.md). Boundary B1 now exists:
`serve` answers the `/auth` ceremonies, the Wave 3A `/api/v1` routes and the
Web App on the public origin.

| Threat | State after Wave 3A |
|---|---|
| T23 CSRF and session compromise | `__Host-` cookies (`Secure`, `HttpOnly` for the session, `SameSite=Strict`, `Path=/`, no `Domain`), exact `Origin` on every mutating request plus `Sec-Fetch-Site`, a CSRF token bound to the session, a bearer token next to a cookie refused as ambiguous, session secrets rotated on re-authentication and at the end of a recovery, a planted cookie never adopted, idle and absolute expiry on the database clock, revocation per session and for all others. The Web App runs under `default-src 'none'; script-src 'self'` with no inline script or style and no third-party script, and sets untrusted text with `textContent` only; the browser suite records no CSP violation. Residual: an XSS in the Web App would act with the person's session (no inline script makes it harder, not impossible). |
| Credential stuffing and brute force (new) | Passkeys are phishing-resistant (origin- and RP-bound, user verification required). The password path needs TOTP; failures are counted per typed address, per client address and per identity with progressive delays and a 15-minute lock; a lock notifies the person and every other active owner; failures are audited in aggregate. Residual: the per-address bucket can be used to lock an account address out for 15 minutes (a deliberate trade against guessing); behind a reverse proxy the client address is only right when `EXPONETDB_TRUSTED_PROXIES` names the proxy (an owner setting on `reos-01`; without it every client shares the proxy's address bucket). |
| Account enumeration (new) | The passkey options name no account; the password step answers identically (body, cookie, Argon2id work) for unknown addresses, wrong passwords, inactive identities and right passwords; every second-step failure is the same `AUTHENTICATION_FAILED`, including a locked identity; invitations refuse a duplicate address only to people who may invite. |
| One-time link interception (new) | Setup, invitation and recovery tokens travel in the URL fragment (never sent to a server in a URL, no `Referer`), are removed from the address bar and history on load, are stored as hashes, are single-use and short-lived (30 minutes, invitations 24 hours), and a re-issue invalidates the previous link. Residual: whoever reads the link before the person redeems it can enroll; with no e-mail channel in Wave 3A the link travels the way the operator or inviting person passes it on. |
| Recovery abuse (new) | A recovery code opens a session that may only replace factors and ends every other session; out-of-band recovery needs shell access, works only for the last owner, needs a written reason, ends all sessions, replaces every factor and is audited prominently as `auth.out_of_band_recovery_used`. Residual: recovery codes are bearer secrets of the person. |
| Privilege escalation (new) | One central two-phase authorization engine for every use case (a structural test fails when a use case skips it); explicit role matrix without wildcards, checked at startup against the Control Store; no owner bypass; an admin cannot grant owner or bind themselves; a narrower binding cannot be widened by its holder; role bindings, policy settings and identity enablement change only through plans executed by the worker (`serve` cannot write them); privileges are read per request, so a removed binding has effect on the next request; the last-owner invariant holds in the application and under concurrent removal in the database. |
| Self-dealing approvals (OD-9, new) | An agent client never approves (engine and database). A human approving their own plan must acknowledge it explicitly with a fresh proof; a critical self-approval cools for 10 minutes on the database clock and the apply needs a fresh proof again; approvals bind the reviewed plan hash; an approver who lost `plans.approve` no longer counts. Residual (accepted by the owner with OD-9): in a one-person organization the same person proposes and approves. |
| T11 Control database compromise | Wave 3A stores only hashes of session, CSRF, link, ceremony and recovery-code secrets, Argon2id hashes of passwords, and TOTP secrets as ciphertext under the keyring (consumer `auth`). Residual: the ciphertext of a deleted TOTP secret stays in the append-only secrets store, unlinked. |
| Compromised `serve` (new) | `serve` holds the `auth` consumer's keys and can therefore act as any signed-in person and read TOTP secrets; it cannot write role bindings, policy settings or identity enablement (worker only), and the audit records what it does. |
| T28 Secret leakage in logs | The denylist and the repository secret scan know every Wave 3A token prefix, `otpauth://` URIs, bare TOTP secrets and recovery codes; the image smoke test checks that no session token, CSRF token or setup token reaches a log. |
| Undelivered notifications (new) | Wave 3A has no e-mail channel: lockout, recovery-code and out-of-band-recovery notifications are recorded truthfully as `unavailable` and reach no one yet. A provider is an open owner decision before production logins rely on notifications. |

An adversarial review of the Wave 3A branch found and fixed: a re-issued
link that did not end an enrollment started with an older one (first-owner
takeover by the holder of a mistyped address), a body limit that trusted
`Content-Length`, a check-then-count race in the password rate limit and a
second-step timing difference, an apply proof that could predate the end
of a short cooling period, unmatched IPv6 trusted proxies, and unbounded
TOTP secret growth ([G3A record §4a](../14-roadmap/gates/3a.md#4a-adversarial-self-review-102-of-the-order)).
Residual: each passkey-options request stores a short-lived challenge row
(the worker prunes ended ones); raw request volume is limited at the proxy,
not by ExponetDB.

### Wave 3B (2026-10-06, reviewed for G3B; G3B accepted 2026-10-06)

**[OBSERVED]** What the authorization server and the delegated clients
implement of the mitigations above, what they add and what stays open;
evidence in the [G3B gate record](../14-roadmap/gates/3b.md). Boundaries B2
(OAuth bearer, without an MCP server yet: Wave 7) and B3 (CLI, service
accounts, API keys at `/api/v1`) now exist.

| Threat | State after Wave 3B |
|---|---|
| T1, T3 Malicious client, over-privileged agent | A scope is a ceiling, never a permission: every bearer request is decided by the central engine with the identity's live role bindings, then the delegated scope, resource and restrictions (`INSUFFICIENT_SCOPE` only when RBAC would allow). Consent offers only scopes the person holds now and the client kind may hold, preselects non-production for every client, makes production an explicit acknowledgement and production write or human-only authority need a proof at most 5 minutes old; it is re-evaluated at submission. MCP-ineligible and human-only scopes never reach an `mcp` client or a service account (catalog, engine and database guard). Grants live at most 90 days (machine grants 365). Residual: what a person consents to in non-production is usable by the client until revoked or expired. |
| T2 Stolen token | Opaque, hash-only tokens with prefixes for secret scanning; access tokens live 10 minutes and are bound to one resource (`/api` or `/mcp`); every request looks the token, grant, client and identity up live (no cache), so revocation, a disabled client or identity and a removed role binding act on the next request. Refresh tokens rotate on every use; a rotated-out token presented again ends the grant and every token of it (no grace window; of two concurrent refreshes exactly one wins). Residual: a bearer token is not sender-constrained (no DPoP in V1): a stolen access token works for up to 10 minutes. |
| Code interception and injection (new) | PKCE S256 only (`plain` and missing PKCE refused), exact redirect URI (loopback varies the port only), codes 60 seconds, single-use under a row lock, bound to client, redirect URI and verifier; a replayed code revokes its grant. |
| Mix-up and open redirect (new) | `iss` on every authorization response (RFC 9207), advertised; the CLI checks it. Errors are redirected only after client and exact redirect URI are established; before that a local page with a fixed reason. `returnTo` after sign-in accepts fixed pages only. |
| Consent CSRF and phishing (new) | The authorization request is stored server-side and bound to the browser that started it (`__Host-exdb_oauth`, HttpOnly, SameSite=Strict, 10 minutes); the consent page shows the exact `client_id`, the host the code goes to, the resource and the scopes; the client's name is untrusted text marked "name not verified" unless first party, with a lookalike warning for names imitating ExponetDB; no remote logo is loaded. Residual: a person can still approve an approved but malicious client. |
| T24 Client impersonation | No third-party client is trusted at bootstrap (OD-5). A CIMD client is usable only after an admin approves its exact `client_id` URL bound to the reviewed metadata fingerprint; a change of security metadata returns it to review and ends its grants; display changes keep the approval. DCR creates a pending public client without a secret, usable only after approval. Approvals are inline security changes with a fresh proof and are audited. |
| T26 SSRF | The CIMD fetcher never uses `fetch(url)`: an exact `https` URL of a DNS name, resolved once, every answer public (private, loopback, link-local, CGNAT, documentation, multicast, reserved, NAT64, 6to4, Teredo, IPv4-mapped judged as IPv4), the connection pinned to that address with TLS verified for the host name, no redirects, no compression, a JSON media type parsed per RFC 9110 (`application/json` or `application/<name>+json`), at most 5 KiB counted on the declared length, the body and the raw bytes received (a lying `Content-Length` is `too_large`), 5 seconds, no credential sent. Tested against a real TLS server with a throwaway CA, including rebinding and round-robin answers. |
| Registration flooding (new) | DCR: 10 per hour per address, 100 per hour overall, at most 3 pending per requester and 50 in total (serialized), 16 KiB bodies; pending registrations expire after 7 days and are pruned. Requesters are stored only as keyed pseudonyms. Residual: an attacker with many addresses can still fill the 50 pending slots for up to 7 days; approved clients and CIMD are unaffected, and an administrator rejects junk in the review list. |
| Device-code phishing and guessing (new) | Only the first-party CLI may start a device authorization; there is no `verification_uri_complete`, so the person types the code; codes are 8 letters from a 20-letter alphabet without vowels, 10 minutes; only a signed-in person can try a code, and every try counts against that person (10 per 10 minutes) outside the transaction; starting a device authorization is limited per address; consent is the same re-evaluated ceremony. The device page warns that a code someone else sent is an attempt to get access. Since the G3B final hardening (owner decision on D13) the device flow carries no scope that needs explicit consent: no production scope, no human-only scope; the contract flag decides and the Control Store repeats it. Residual (substantially reduced): a person who types a code an attacker gave them authorizes the attacker's CLI session with ordinary operational authority only (reads, plans, non-production writes, non-destructive backups); production reach for those scopes still needs the explicit production acknowledgement on the device page. No elevated authority can be phished through a device ceremony. |
| T25 Service account leakage | Service accounts have no password, factor, session or role by default; `private_key_jwt` with public keys only (at most four, RSA at least 2048 bits), an algorithm allowlist fitting the key (never `none` or HMAC), `iss = sub = client_id`, the audience exactly the issuer as a single string (no audience injection), at most 5 minutes, `jti` replay store, attempts rate-limited per client and address before any transaction; `client_credentials` gives 10-minute access tokens without a refresh token, REST only. API keys belong to service accounts only, are shown once, stored as hashes, expire (default 90, at most 365 days), are revocable and REST only. |
| Token passthrough and confused deputy (new) | Tokens are bound to their resource and never accepted at the other; ExponetDB never forwards a token anywhere; the CIMD fetch carries no credential. |
| MCP client steps around the MCP surface through REST (G3B final hardening) | A client of kind `mcp` obtains tokens for `/mcp` only, never `/api` (`invalid_target` at authorization, device and token endpoints, including a refresh asking for another resource); a stored MCP token for `/api` authenticates nothing; the Control Store refuses an MCP grant for `api` and a CLI or service grant for `mcp`. Residual: none beyond T2; there is no MCP server before Wave 7, so an MCP client's token is usable nowhere yet. |
| PKCE comparison timing (G3B final hardening) | Verifier and challenge are validated first; the challenge must decode to exactly 32 bytes (canonical base64url) and the SHA-256 of the verifier is compared with `timingSafeEqual`. In-process hardening only: no claim is made about timing observable over a network. |
| Privilege escalation through delegation (new) | Delegation never exceeds what the creator holds (application and database guard); live RBAC on every request; human-only and own-session actions stay human-only; a service account is never owner; disabling a person ends their grants, disabling a service account its keys, client and grants, owner recovery ends grants, in the same transaction. |
| T11 Control database compromise | Codes, tokens, device and user codes, assertion ids, API keys and browser bindings are stored as domain-separated SHA-256 hashes only; client keys are public keys; the worker reads none of them. Residual: `serve` is the authorization server and can issue tokens (see "Compromised `serve`" above). |
| T28 Secret leakage | The denylist and the repository scan know every new prefix (`exat_`, `exrt_`, `exak_`, `exac_`, `exdc_`, `exar_`, `exob_`), user and device codes and client assertions; audit events carry no token, code, verifier, assertion, key, e-mail address or client address; the CLI never prints a token and keeps it in a 0600 file. |
| Stale or tampered scope catalog (new) | The database guards decide with the stored catalog; `serve` refuses to authorize until it equals the release's (readiness check `scope_catalog`). |
| Undelivered notifications | Unchanged from Wave 3A: no e-mail channel, so a person is not notified of a new grant; connected applications are visible and revocable in the Web App. |

An adversarial review of the Wave 3B branch found and fixed: client
assertions counted on a second pool connection inside a transaction (a
pool stall from ten unauthenticated requests), an assertion bucket an
attacker could exhaust for a service account from anywhere, assertions left
unspent when an endpoint refused after verifying them, a device poll racing
an approval into an orphaned grant, a token-endpoint or array audience
accepted for client assertions, security metadata and first-party clients
changeable by `serve` without a new fingerprint, and a single requester
able to fill the DCR review queue
([G3B record §4a](../14-roadmap/gates/3b.md#4a-adversarial-self-review)).

### Wave 4 (2026-10-06, reviewed for G4; awaiting the owner's acceptance)

**[OBSERVED]** What the target registry, the PostgreSQL adapter and the
diagnostics implement of the mitigations above (boundary B7 now exists for
external clusters), what they add and what stays open; evidence in the
[G4 gate record](../14-roadmap/gates/4.md). Each row: threat, impact,
control, residual.

| Threat | Impact | Control | Residual |
|---|---|---|---|
| Wrong target through DNS or IP reuse | ExponetDB reads, and later writes, another database | No caller supplies an address: the registry resolves the target; TLS `verify-full` against the cluster's own CA bundle (no system CAs) and the registered server name (a DNS host is its own server name, an IP host needs an explicit name its certificate carries); every session checks the pinned `system_identifier` and the database name before anything else | A physical clone (standby, base backup) of the same cluster carries the same `system_identifier` and marker; a promoted clone at a re-pointed name with a certificate from the same CA is indistinguishable (writes from Wave 6 also need the marker's generation) |
| Wrong cluster `system_identifier` | Writes or reads against another cluster | Pinned at confirmation (`planClusterConfirm` with the observed value); a session against another identifier fails with `CLUSTER_IDENTITY_MISMATCH`; never re-pinned automatically (tested: a moved endpoint is refused) | Re-pinning is a person's registry change |
| Wrong database on the correct cluster | Another application's database observed as this target | Session guard compares `current_database()` with the placement; marker carries installation, target and generation; health suspends on a mismatch | none known |
| Identity-marker overwrite | A target adopted by a rogue installation or swapped between targets | Only `target.register` stamps, under the schema lock, refusing a marker of another installation or target; the marker table refuses `UPDATE` and `DELETE` (triggers), `PUBLIC` has nothing, only the migrator may insert; the health sampler re-reads it and requests a system suspension through the Operations Engine on a mismatch | A superuser or the table owner can disable the triggers; detected at the next sample, not prevented |
| Control Store registered as a target | ExponetDB manages and could write its own state | Registration refuses a database with the Control Store's signs and any cluster whose `system_identifier` equals the Control Store's (read from its own login) | none known |
| Another installation's target adopted | Two control planes act on one database (T34) | Marker with `installation_id`; registration refuses a foreign marker (`foreign_installation`, `foreign_target`), changing nothing | none known |
| TLS downgrade | Credentials or data in clear text | No `sslmode` fallback, plaintext servers refused, the session guard checks `pg_stat_ssl` | none known |
| Wrong CA | A man in the middle with a certificate from another CA | Only the registered CA bundle is trusted for the cluster; tested with a second CA | Whoever holds the registered CA key can impersonate the cluster (the owner's PKI) |
| Wrong host name | A valid certificate for another name accepted | `checkServerIdentity` with the registered server name; tested with an IP lacking the SAN and with a wrong name | none known |
| Target credential leakage | Database roles usable by an attacker | Passwords only through the write-only endpoint (Web App, re-authentication), stored as `se1` envelopes per consumer, never in a view, plan, audit event, log or error (scanned after the full end-to-end flow); `serve` decrypts observer secrets only; least-privilege roles, no superuser | A compromised worker holds every role's secret (T12) |
| Privilege fallback | A task runs with more power than it needs | One credential per access role, chosen by the use case; no fallback to another role and never a superuser; a missing credential is `credential_missing` | none known |
| Observer reading application data | Personal data read by monitoring | The observer has `pg_monitor` and catalog access only; tested on PostgreSQL 16, 17 and 18: `SELECT`, `TABLE`, `count(*)` on an application table and `pg_read_file` fail with `42501`, and every write fails even with the read-only default lifted | `pg_stat_activity` shows statements, redacted before they leave the adapter |
| Reader writing | Data changed through a read path | `READ ONLY` transactions, a role without write grants (reads through `pg_read_all_data`), parser admission for `data.read`; tested on 16, 17 and 18: `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, DDL, comments and `nextval` fail with `42501` even with the read-only default lifted, temporary tables and large objects with `25006` | none known |
| Malicious catalog identifier | SQL injection or broken rendering | Introspection queries are static `TrustedSql` with bind parameters; identifiers quoted by `quoteIdent`; keys are lists of names (a dot never joins two); hostile fixtures and `fp1` golden vectors pin quotes, `$$`, newlines, homoglyphs, emoji, markup, 63-byte truncation | none known |
| Malicious function body | Code or markup reaches logs, HTML or prompts | Bodies enter `fp1` as a digest only; shown live through bounded, escaped views, never logged; MCP labeling is Wave 7 | A person viewing a body in a future UI must see it escaped (Wave 8) |
| SQL injection in introspection | Arbitrary SQL with the observer's rights | No string-built SQL from catalog data; OID pages are array parameters | none known |
| SQL parser bypass | A write or side effect passes `data.read` admission | libpg_query of the target's own major; text with U+0000 refused before parsing; one statement only; node allowlist; data-modifying CTEs, `FOR UPDATE`, `SELECT INTO`, functions, operators, casts and relation kinds checked against allowlists | A grammar difference inside one major's builds; the 18 build comes from the binding maintainers' tag (G4 §4) |
| Read query side effects | A `SELECT` that writes, locks or reaches out | Function allowlist (no volatile user functions, no `dblink`, no `pg_sleep`), foreign tables and other relation kinds refused, `READ ONLY` transaction, statement and lock deadlines | none known for admitted reads |
| Catalog snapshot race | A fingerprint mixes two catalog states | One `REPEATABLE READ READ ONLY` transaction per snapshot; keyset pages by OID inside it | none known |
| Fingerprint collision or semantic instability | Drift hidden or invented; plans bound to a meaningless value | SHA-256 over RFC 8785 forms; names as lists; absent values omitted; golden vectors on 16, 17 and 18; `fp1` frozen from the G4 acceptance, a fix is `fp2` by ADR | Deparsed texts may change in a PostgreSQL minor release (the golden test would fail) |
| Incomplete snapshot treated as authoritative | A partial view taken as the expected schema | The visibility report makes a snapshot incomplete; an incomplete snapshot is never a baseline, and its drift check is `incomplete`, never clean | none known |
| Drift baseline silently updated | Real drift absorbed | The baseline is the registration snapshot only; a drift check never writes it; `drift.accept` does not exist in Wave 4 | A project scope change takes effect only with the next baseline (documented) |
| Failed read shown as empty | An outage looks like "no sessions" or "no objects" | Every read throws or records a failed condition; tested with an unreadable `pg_stat_activity` (no empty session list, `activity_unreadable`, never healthy) and with failed drift reads | none known |
| Stale health shown as live | An outage looks healthy | Status older than 30 s is `cached`, older than 2 minutes or never sampled `unknown`, never healthy | none known |
| Schema diff cross-target leak | A grant for target A reads B's schema | A diff needs `schema.read` on both sides; a fingerprint side is accepted only if it was observed on a target the caller may diff | none known |
| Connection pool exhaustion caused by ExponetDB | The managed cluster refuses applications | One budget per process and cluster, `serve` 3 plus worker 5 = 8 (fixed during this review: connectors had separate budgets), deadlines, circuit breakers, bounded probes | Probes deliberately bypass the breaker (they measure) but not the budget |
| Malicious extension metadata | Objects hidden from the fingerprint | Extension entries are data (name, version, schema); objects owned by an extension are represented by that entry only | An extension owner can hide an object by `ALTER EXTENSION … ADD` (the member set is not hashed); see the G4 record §7 |
| Control Store snapshot tampering | A forged baseline or document | Documents verified on every read (bounded inflation, digest, entry hashes, fingerprint equal to the row key); never inflated past the recorded length | An attacker with write access to the Control Store can replace a document and its digest together (T11) |

# Threat model

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05; reviewed at every wave's security gate (last: Wave 3A for G3A, §5; G3A not accepted) |
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

### Wave 3A (2026-10-05, reviewed for G3A; awaiting owner acceptance)

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

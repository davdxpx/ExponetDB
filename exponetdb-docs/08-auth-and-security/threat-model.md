# Threat model

| | |
|---|---|
| Status | Baseline (Wave 0), awaiting owner approval; reviewed at every wave's security gate |
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
| T7 | Migration checksum substitution | Same id, different SQL slipped into production | checksum computed server-side; immutable per id across all ledgers; staging evidence requires the identical checksum and verify digest | none known |
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

# Test strategy

| | |
|---|---|
| Status | Baseline (Wave 0), awaiting owner approval; no tests exist yet |
| Read before | [`acceptance-gates.md`](./acceptance-gates.md), [`../12-operations/local-development.md`](../12-operations/local-development.md) |

ExponetDB's claims are about safety. A claim without a test that would fail if
the claim were false is not made (C-30). Tests run against **real PostgreSQL**,
never against an emulation, whenever PostgreSQL behavior is part of the claim.

## 1. Layers

| Layer | Scope | Runs | Tooling (planned, OD-3) |
|---|---|---|---|
| Unit | pure functions: canonical JSON, checksums, DAG, policy rules, state machine, redaction, lint rules | every commit, seconds | Vitest; Go `testing` for the agent |
| Contract | schemas in `packages/contracts` vs REST handlers, MCP tools, node protocol (TS ↔ Go), generated OpenAPI | every commit | schema snapshot tests, generated-artifact drift check |
| PostgreSQL integration | adapter, introspection, fingerprints, executors, migration engine, verification sandbox | every commit (PG 17), nightly full matrix | `packages/testkit` containers |
| Agent integration | daemon + helper on a VM or privileged container with PostgreSQL under systemd | every PR touching the agent, nightly | VM image |
| End to end | Web App, REST, MCP against the local stack | every PR (smoke), nightly (full) | Playwright, MCP client harness |
| Adversarial | prompt injection, SQL admission bypass, SSRF, plan substitution, privilege escalation | nightly and before each gate | dedicated suites |
| Failure injection | partitions, crashes, timeouts, disk full, storage unreachable | nightly | fake agent, toxiproxy-style network faults |
| Drills | backup, restore, C-35 drill | scheduled in the real deployment | ExponetDB itself |

## 2. Required test families

| Family | What it proves | Key cases | Wave |
|---|---|---|---|
| **Unit tests** | building blocks behave as specified | canonical JSON (JCS) vectors; ULID parsing and validation (26 chars; the 20-char example from the brief is rejected); policy decisions | 1+ |
| **Contract tests** | interfaces cannot drift from contracts | every REST route and MCP tool validates input and output against contracts; OpenAPI regenerated equals committed | 1+ |
| **PostgreSQL integration tests** | adapter correctness | catalog coverage per object class; hostile identifiers; Supabase-reference defects D1 to D13 as regression tests | 4 |
| **Migration fixture tests** | bundle semantics | corpus of bundles per class (additive, destructive, rewrite, non-transactional, data, security); REOSA-shaped legacy fixture (gaps, duplicates, renames, post-apply comment edits, missing effects) | 6 |
| **Migration concurrency tests** | one schema change per target | two workers race for the same target; lock holder crash; advisory lock key collisions across targets; `lock_timeout` behavior under contention | 6 |
| **Stale plan tests** | plans bind to reality | fingerprint changed, ledger head changed, policy version changed, bundle content changed, plan expired, plan used twice, plan used on another target | 6 |
| **Checksum tests** | content binding | golden vectors; comment-only edits keep the apply checksum; any executable change alters it; dollar-quoted bodies, `E''` strings, nested comments, Unicode; TS and Go produce identical digests | 1, 6 |
| **Schema fingerprint determinism tests** | same schema, same fingerprint | repeated runs; different sessions and `search_path`; object creation order permuted; PostgreSQL minor versions; extension-owned objects excluded; visibility report when the role cannot see objects | 4 |
| **Verification tests** | applied ≠ verified | each layer L0 to L3 detects a planted failure; `verify.sql` returning zero rows fails; sandbox refuses writes and side-effect functions; verification failure leaves the ledger in `verification_failed` | 6 |
| **Permissions tests** | authorization formula | full matrix (permission × scope × tier × grant restriction × client kind × policy); no implicit permission on new actions; escalation attempts | 3+ |
| **MCP contract tests** | MCP correctness | both protocol eras; session handling; tool schemas; error shapes; elicitation; Origin checks; large outputs truncated with flags | 7 |
| **OAuth tests** | authorization server | PKCE required; redirect URI exact match; loopback any port; resource indicator binding; token rotation and reuse detection; CIMD fetch validation; DCR approval gate; consent tier defaults | 3 |
| **Node protocol tests** | agent ↔ gateway | envelope schemas; signature verification; expiry; journal replay protection; long-poll claim semantics; result upload idempotency | 5 |
| **mTLS tests** | transport security | wrong CA, expired certificate, revoked node, hostname mismatch, downgrade attempts refused | 5 |
| **Failure injection** | failure model F1 to F30 | each failure produces the documented state and never a false success | 2+ |
| **Backup tests** | backups are real | run outcome checks (size floor, catalog entry, WAL coverage); object lock deletion refused; encryption keys required to read | 9 |
| **Restore tests** | backups restore | latest, older and PITR restores verified (amcheck, fingerprint, ledger head, row counts); C-35 drill without Control Plane | 9 |
| **Real PostgreSQL matrix** | version behavior | PostgreSQL 16, 17, 18 with pgvector for every integration suite; 19 beta as an allowed-to-fail lane | 4+ |
| **PostgreSQL version compatibility** | migrations across majors | analysis rules per version (lock levels, rewrite rules); fingerprints per major; catalog columns that differ (for example `pg_stat_checkpointer` from 17) | 4, 6 |
| **UI tests** | truthful, accessible UI | render tests for failed/stale/partial/empty states; typed confirmation requires the exact path; production cues present; accessibility; visual regression | 8 |
| **E2E** | the whole path | register target → plan migration via MCP → approve in Web App → apply → verify → audit visible; restore drill end to end | 8+ |
| **Security and adversarial tests** | attacker cannot succeed | prompt-injection goals; SQL admission bypass corpus (multi-statement, `COPY`, `DO`, data-modifying CTEs, function denylist evasion); SSRF; CSRF; secret leakage scans; plan substitution | 3+ |

## 3. Test data rules

- No real customer data, no REOSA production data, ever. Fixtures that model
  REOSA reproduce **shapes** (numbering, duplicates, roles, RLS patterns), not
  content.
- Fixtures are deterministic (fixed seeds, fixed clocks where time matters).
- Date-dependent behavior (for example partitions created relative to "today")
  is tested with an injected clock.

## 4. Speed and isolation

- Each PostgreSQL integration test gets its own database cloned from a template
  (pattern observed in both reference repositories); templates are keyed by a
  hash of the fixture content.
- The PostgreSQL 17 lane runs on every commit; the full matrix nightly and before
  gates.
- Flaky tests are fixed or deleted with a replacement, never retried into green
  and never quarantined silently.

## 5. Coverage expectations

Coverage percentages are not a gate. The gate is the families above: each gate
item in [`acceptance-gates.md`](./acceptance-gates.md) names the tests that
prove it, and a reviewer checks that those tests would fail if the property
were broken (mutation testing for the policy engine, checksums and plan
binding is planned for Wave 6).

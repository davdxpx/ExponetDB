# Test strategy

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05; tests exist since Wave 1 (§6); the MCP test layers of Wave 7 are listed in §7 (2026-10-13, G7 not yet accepted) |
| Read before | [`acceptance-gates.md`](./acceptance-gates.md), [`../12-operations/local-development.md`](../12-operations/local-development.md) |

ExponetDB's claims are about safety. A claim without a test that would fail if
the claim were false is not made (C-30). Tests run against **real PostgreSQL**,
never against an emulation, whenever PostgreSQL behavior is part of the claim.

## 1. Layers

| Layer | Scope | Runs | Tooling ([OD-3](../00-product/open-decisions.md#od-3-toolchain-and-runtime), resolved) |
|---|---|---|---|
| Unit | pure functions: canonical JSON, checksums, DAG, policy rules, state machine, redaction, lint rules | every commit, seconds | Vitest; Go `testing` for the agent |
| Contract | schemas in `packages/contracts` vs REST handlers, MCP tools, node protocol (TS ↔ Go), generated OpenAPI | every commit | schema snapshot tests, generated-artifact drift check |
| PostgreSQL integration | adapter, introspection, fingerprints, executors, migration engine, verification admission and execution layers | every commit (PG 17), nightly full matrix | `packages/testkit` containers |
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
| **Checksum tests** | content binding | golden vectors; comment-only edits keep the apply checksum; any executable change alters it; any edit of `verify.sql` except line endings, comment directives included, changes the verify digest and never the apply checksum; dollar-quoted bodies, `E''` strings, nested comments, Unicode; the TypeScript production code (`packages/migrations/format`) and the Go conformance implementation produce identical digests; vectors are append-only after G1 | 1, 6 |
| **Schema fingerprint determinism tests** | same schema, same fingerprint | repeated runs; different sessions and `search_path`; object creation order permuted; PostgreSQL minor versions; extension-owned objects excluded; visibility report when the role cannot see objects | 4 |
| **Verification tests** | applied ≠ verified | each layer L0 to L3 detects a planted failure and L4 evidence is required for production; `verify.sql` returning zero rows fails; admission refuses every forbidden form and every non-allowlisted function, operator, cast, view or foreign table; declared consumer checks require approval; the verifier role cannot write (privilege test); the read-only transaction cannot be switched; verification failure leaves the operation in `verification_failed` and the latest verification row `failed`, while the ledger keeps the migration as applied. No test claims that arbitrary malicious SQL is contained. | 6 |
| **Permissions tests** | authorization formula | full matrix (permission × scope × tier × grant restriction × client kind × policy); no implicit permission on new actions; escalation attempts | 3A+ (scopes and grants from 3B) |
| **MCP contract tests** | MCP correctness | both protocol eras; session handling; tool schemas; error shapes; elicitation; Origin checks; large outputs truncated with flags | 7 |
| **OAuth tests** | authorization server | PKCE required; redirect URI exact match; loopback any port; resource indicator binding; token rotation and reuse detection; CIMD fetch validation; DCR approval gate; consent tier defaults | 3B |
| **Node protocol tests** | agent ↔ gateway | envelope schemas; signature verification; expiry; journal replay protection; long-poll claim semantics; result upload idempotency | 5 |
| **mTLS tests** | transport security | wrong CA, expired certificate, revoked node, hostname mismatch, downgrade attempts refused | 5 |
| **Failure injection** | failure model F1 to F35 | each failure produces the documented state and never a false success | 2+ |
| **Backup tests** | backups are real | run outcome checks (size floor, catalog entry, WAL coverage); object lock deletion refused; encryption keys required to read | 9 |
| **Restore tests** | backups restore | latest, older and PITR restores verified (amcheck, fingerprint, ledger head, row counts); C-35 drill without Control Plane | 9 |
| **Real PostgreSQL matrix** | version behavior | PostgreSQL 16, 17, 18 with pgvector for every integration suite; 19 beta as an allowed-to-fail lane | 4+ |
| **PostgreSQL version compatibility** | migrations across majors | analysis rules per version (lock levels, rewrite rules); fingerprints per major; catalog columns that differ (for example `pg_stat_checkpointer` from 17) | 4, 6 |
| **UI tests** | truthful, accessible UI | render tests for failed/stale/partial/empty states; typed confirmation requires the exact path; production cues present; accessibility; visual regression | 8 |
| **E2E** | the whole path | register target → plan migration via MCP → approve in Web App → apply → verify → audit visible; restore drill end to end | 8+ |
| **Security and adversarial tests** | attacker cannot succeed | prompt-injection goals; SQL admission bypass corpus (multi-statement, `COPY`, `DO`, data-modifying CTEs, allowlist evasion through operators, casts, views or overloads); SSRF; CSRF; secret leakage scans; plan substitution | 3A+ |

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

## 6. State after Wave 2

**[OBSERVED]** (Wave 2, accepted with G2 on 2026-10-05) Layers in use; the others start with the
waves that build their subjects.

| Layer | What exists | Command |
|---|---|---|
| Unit, property | every package; property tests with `fast-check` (DAG, `c1`, state machine, envelope, policy) | `bun run test` |
| Contract | contracts vs documents, generated-artifact drift, golden vectors (TypeScript, Go, and SQL for `ac1`), golden history against the base commit | `bun run test`, `bun run verify:generated`, `bun run golden:check`, `bun run golden:history <base>`, `bun run go:test` |
| PostgreSQL integration | Control Store roles and privileges, runner, transactions and failure injection, audit chain and export, secrets, operations, the three roles and the commands, against PostgreSQL 17.11 and an S3-compatible test server; `*.int.test.ts` | `bun run test:integration` (services: `bun run dev:control-store`) |
| Image smoke | the release image: bootstrap, migrate, three roles healthy, graceful shutdown, no secrets in logs | `bun run smoke:image` |

Instead of a `packages/testkit` package, the Control Store test harness is
the `@exponetdb/control-store/testing` subpath (one database per suite, the
production bootstrap SQL); `packages/testkit` comes when the Wave 4 adapter
needs managed test targets. Integration suites are never skipped: without
their services they fail with a pointer to
[`local-development.md` §5](../12-operations/local-development.md#5-what-exists-since-wave-2).

## 7. MCP test layers (Wave 7)

**[OBSERVED]** (2026-10-13; [G7 record](./gates/7.md) §5 and §6; G7 not yet
accepted; CI has never run for this repository, so every "runs in CI" below is
a configuration, not evidence) The MCP interface is tested in these layers.
Fixtures never stand in for production evidence and a reference client never
stands in for a real client.

| Layer | What exists | Command |
|---|---|---|
| Protocol and unit | the endpoint with a fixture registry through the real SDK client, one test per row of [`protocol-baseline.md`](../05-mcp/protocol-baseline.md) §4 and §5 (`apps/server/test/mcp-protocol.test.ts`); the pure parts: classification table, strict JSON, origin and host policy, buckets, sanitizing, `requestState` and cursor codecs (`mcp-units.test.ts`); tool contracts (`packages/contracts/test/mcp-tools.test.ts`); the tool list per grant shape with golden digests (`mcp-catalog.test.ts`); read deadlines (`listen-deadlines.test.ts`) | `bun run test` |
| Conformance | the pinned `@modelcontextprotocol/conformance` suite on both revisions against the test composition, with a reasoned baseline of expected failures (`apps/server/test/conformance/`); the pinned MCP Inspector CLI with `--strict` in both eras | `bun run mcp:conformance`, `bun run mcp:inspect` (together: `bun run --cwd apps/server test:conformance`, part of `bun run verify`) |
| Integration over the real program | read tools against their REST routes for the same identity and grant (`mcp.int.test.ts`); plan tools, apply, approval states, attribution, idempotency (`mcp-plans.int.test.ts`); the agent data-read path and the audit outage (`mcp-data.int.test.ts`); the data-read executor on PostgreSQL 16, 17 and 18 (`packages/diagnostics/test/data-read.int.test.ts`, `data-read-lane.int.test.ts`) | `bun run test:integration` |
| Adversarial matrix | a scripted adversary, no model: 19 goals against 14 grant forms and the roles each token form runs as; oracles OR-1 to OR-8 (database checksums, approvals and policy unchanged, per-grant tool lists, canary secrets in no log, a sinkhole listener, output hygiene, the denial audit, the approval page's computed facts); the report is written to `apps/server/test-results/adversarial/` (git-ignored) (`mcp-adversarial.int.test.ts`) | `bun run test:integration` |
| Replay | three **synthetic** sessions recorded by the SDK client (`exponetdb.mcp-transcript/v1`) and replayed request by request against a fresh world; a changed answer or catalog digest fails the test (`mcp-replay.int.test.ts`) | `bun run test:integration` |
| Evals | layer A runs each time: fourteen tasks, each with a reference script that must pass and unsafe scripts the named check must reject (`mcp-evals.int.test.ts`, `packages/testkit/test/mcp-evals.test.ts`). Layers B and C run the same tasks with a model and the owner's key (`bun run mcp:evals`): **NOT RUN** without the key. Layer D (a model as red team) is not built | `bun run test:integration`; `bun run mcp:evals` |
| Browser end to end | the approval round in Chromium with a virtual passkey: plan over MCP, link, sign-in, review, approval, apply, verify (`mcp-approval.e2e.test.ts`); the hostile-content review of the approvals page and the consent page (`web-review.e2e.test.ts`) | `bun run test:e2e` |
| Lab suite | the installed packed CLI, the image of this tree, a real Chromium: the lab serves `/mcp`, the lab client is approved once, the SDK client and the Inspector in both eras, the main flow and the counter-checks (`quickstart.lab.test.ts`); `/mcp` behind a disposable Traefik 3.3.7 (`traefik.lab.test.ts`); 200 concurrent listen requests and heap stability (`mcp-stability.lab.test.ts`) | `bun run --cwd apps/server test:lab` (Docker) |
| Real clients | Claude Code 2.1.296 connected in both eras without a model. A sign-in and a model run in Claude Code, Claude, Cursor, Codex and VS Code are **NOT RUN**; the owner runs them ([`../05-mcp/owner-test-package.md`](../05-mcp/owner-test-package.md)) | owner |

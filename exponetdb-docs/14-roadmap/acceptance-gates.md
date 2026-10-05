# Acceptance gates

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
| Read before | [`implementation-waves.md`](./implementation-waves.md), [`test-strategy.md`](./test-strategy.md) |

A gate is passed when **every item has evidence** (a test run, a recorded
operation, a document, a measurement) linked from the gate record, and the owner
has signed it off. "It works on my machine" and "the code exists" are not
evidence (C-30).

## How gates are recorded

- One gate record per wave in `exponetdb-docs/14-roadmap/gates/<wave>.md`
  (created when the wave starts; first record: [`gates/0.md`](./gates/0.md)), listing each item with status (`open`,
  `evidence`, `accepted`, `waived`) and a link to the evidence.
- A waived item needs a reason, an expiry and the owner's name; security items
  (marked **S**) cannot be waived.
- Once ExponetDB runs, gate evidence that consists of operations (plans,
  applies, drills) links to the operation records in ExponetDB itself.

## Wave gates

### G0: Documentation baseline

Accepted on 2026-10-05; evidence in the [gate record](./gates/0.md).

- [x] Constitution, domain model, architecture and audits reviewed by the owner
- [x] Open decisions blocking Wave 1 decided (OD-2, OD-3, OD-19); decisions that block later waves are entry conditions of those waves (OD-8 before Wave 2)
- [x] All docs links and anchors resolve; every `OD-n` and ADR reference exists
- [x] **S** No secrets, tokens or private keys in the repository

### G1: Contracts

Accepted on 2026-10-05 after the pre-G1 contract hardening pass; evidence
in the [gate record](./gates/1.md). `c1`, `ls1`, JCS and the plan hash are
frozen since then (freeze baseline `b52a6ca`), enforced against the base
commit by `bun run golden:history`.

- [x] Error catalog, permissions, scopes, action registry, manifest schema, read resources, read MCP tools and node envelopes defined in `packages/contracts`
- [x] OpenAPI 3.1, JSON Schema and Go types generated deterministically and committed; CI fails on drift
- [x] `packages/migrations/format` implements the manifest projection, `c1` canonicalization, apply checksum, verify, rollback, bundle and source digests and the `ls1` ledger state hash as specified, as the production code the server and CLI will use; it does no I/O and opens no database connection
- [x] Golden vectors for canonical JSON, checksums (`c1`), ledger state hash and plan hash pass against the production TypeScript code (`packages/kernel`, `packages/migrations/format`) and against the Go conformance implementation in `agent/node`; no vector is verified only by throwaway code in `tooling/`
- [x] `c1` and `ls1` frozen: golden vectors are append-only, and any change of output needs `c2`/`ls2` through an ADR
- [x] Boundary checker active in CI
- [x] **S** MCP-ineligible scopes encoded and tested; no wildcard permission exists

### G2: Control Plane skeleton

- [ ] Three process roles start from one image; readiness checks schema version, keys and Control Store
- [ ] Control Store bundles apply and verify from empty via the bootstrap runner; a second run is a no-op
- [ ] Operation state machine and idempotency property tests pass
- [ ] Deployed on `reos-01` behind `db.exponet.cloud` (readiness only)
- [ ] **S** Audit rejects `UPDATE`/`DELETE` for every role; hash chain verifies; checkpoint export works
- [ ] **S** Envelope encryption with AAD; substitution test fails to decrypt; keyring not in the Control Store
- [ ] **S** Redaction tests over logs and errors pass

### G3A: Identity and authorization foundation

Required before Wave 4 starts.

- [ ] Passkey login with password + TOTP fallback, re-authentication windows, invitations, first-owner bootstrap, last-owner recovery runbook
- [ ] Core RBAC: roles, permissions, bindings at global, product, project, environment and target scope; tier model; client-kind concept
- [ ] Server-side authorization evaluation, integrated with the policy engine, for first-party Web App sessions: matrix tests (permission × binding scope × tier × client kind × policy) pass
- [ ] **S** Session security: fixation, CSRF and cookie-flag tests pass
- [ ] **S** No wildcard permission; a new action grants nothing implicitly
- [ ] **S** Human-only actions enforced by client kind; tier separation holds for sessions

### G3B: OAuth and delegated clients

Required before Wave 7 starts, and before any external REST/SDK machine access, the CLI's server-side commands or CI access.

- [ ] OAuth flows for one CIMD client, one approved DCR client, the CLI (loopback and device) and one service account; API keys issued, scoped and revoked
- [ ] Authorization matrix extended with scope × grant restriction passes
- [ ] **S** PKCE S256 required; `resource` bound; `iss` returned; refresh reuse revokes the grant
- [ ] **S** Metadata fetcher SSRF suite passes (private ranges, redirects, DNS rebinding, size limits)
- [ ] **S** MCP-ineligible scopes never issued to `mcp` clients; nonprod grants cannot act on prod subjects

### G4: Registry and PostgreSQL adapter

- [ ] Targets registered with identity markers; registration refuses the Control Store and other installations
- [ ] Introspection and fingerprints for PostgreSQL 16, 17, 18 deterministic; plan-guard budget passes on a large catalog
- [ ] Health model with dual probes, path awareness and named conditions; failed reads never render empty
- [ ] Drift detection produces findings on fixtures with known drift
- [ ] **S** TLS `verify-full` to every target; connection attempts without TLS fail
- [ ] **S** Observer and reader roles cannot write (tested on real PostgreSQL); `data.read` admission refuses all non-read classes
- [ ] **S** No connection material in any API or MCP response; redaction corpus passes

### G5: Node agent

- [ ] Enrollment end to end; certificate renewal observed; revocation stops the agent within one heartbeat
- [ ] Capabilities for status, config, roles, hba, TLS, extensions, stats, logs, WAL status work on a real host
- [ ] Configuration ownership implemented as decided in OD-20, checked against the real host packaging; values found in `postgresql.auto.conf` are detected and shown, never silently overwritten
- [ ] Failure injection: agent crash mid-job, partition, clock skew handled as documented
- [ ] **S** No code path executes arbitrary commands (allowlist test, helper operation types)
- [ ] **S** Job signatures, expiry, node binding and replay protection verified by negative tests
- [ ] **S** `pg_hba` apply refuses changes that lock out ExponetDB's own access

### G6: Migration engine

- [ ] Bundles linted, checksummed and planned from the CLI and REST; DAG ordering deterministic
- [ ] Apply with advisory lock, session settings, ledger write in the same transaction; verification layers L0 to L4
- [ ] Staging evidence enforced for production; break-glass recorded and reviewed
- [ ] Non-transactional bundles run alone with their own recovery path
- [ ] Legacy import on the REOSA-shaped fixture yields the documented states and review items
- [ ] Failure catalog E1 to E30 covered by tests
- [ ] **S** Plan substitution, replay and stale-plan tests pass
- [ ] **S** `verify.sql` admission and execution tests pass: forbidden forms and non-allowlisted functions, operators, casts, views and foreign tables are refused at plan time; declared consumer checks require approval; the verifier role has no write privilege (tested on real PostgreSQL); read-only transaction, timeouts, row limits and connection close hold. (The gate tests the defined admission, role and read-only model; it does not claim a sandbox for arbitrary SQL.)
- [ ] **S** `down.sql` never runs automatically

### G7: MCP

- [ ] Both protocol eras pass contract tests; tested with at least three real clients
- [ ] Tool outputs match their schemas; untrusted fields labeled; caps enforced
- [ ] Approval links via URL elicitation land on the plan review page
- [ ] **S** Adversarial suite: every injection goal fails or requires human approval for every grant shape
- [ ] **S** Origin validation; no tool reachable without its scope; no SQL write path

### G8: Web App

- [ ] Global and target levels as in the information architecture; plan review, approvals and typed confirmations
- [ ] Render tests for truthful states on every list and card
- [ ] Accessibility checks (WCAG 2.2 AA) and visual regression in CI
- [ ] Implementation is native; every direct copy of third-party source (expected: none) has a recorded file-specific license review and the attribution its license requires; no Supabase vendor directory, submodule or provenance layer
- [ ] **S** CSP, cookie flags, CSRF tests; untrusted content never rendered as HTML

### G9: Backup, restore, performance

- [ ] Backups run on schedule with measured outcomes; verification scheduled
- [ ] RPO and RTO measured and displayed against objectives
- [ ] Drill passed: latest backup, older backup, PITR to a random point
- [ ] **C-35 drill**: restore from the generated runbook with offline keys and the Control Plane stopped
- [ ] Diagnostics actions (cancel, terminate) and advisors live with findings
- [ ] **S** Object lock prevents deletion by the host's credentials (tested)
- [ ] **S** Restore destination checks and human-only execution enforced

### G10: REOSA integration

- [ ] REOSA targets registered; health and drift observed for staging and production
- [ ] Legacy import baseline accepted with every review item decided
- [ ] At least five REOSA migrations applied staging-first through ExponetDB, production with evidence
- [ ] Runtime schema contract active in REOSA's health checks
- [ ] REOSA Admin `/database` reads ExponetDB through the SDK
- [ ] **S** REOSA's service account is read-only; out-of-band changes produce drift findings

### G11: REOSA move

- [ ] All product gates below accepted
- [ ] Rehearsal: restore, fingerprint and ACL equality, RLS invariants, isolation probe, timings
- [ ] Cutover executed with evidence; acceptance checks green; backups active; first drill within 7 days
- [ ] **S** Rollback plan rehearsed before the window

## Product gates before REOSA production moves

Before REOSA production ever runs on ExponetDB-managed PostgreSQL, each of these
must be **proven**, not just implemented (owner brief §65):

| # | Gate | Proven by | Wave |
|---|---|---|---|
| PG-1 | Target registration | REOSA targets registered with identity markers; wrong-database registration refused | 4, 10 |
| PG-2 | TLS | every ExponetDB and REOSA connection to `reos-db-01` uses `verify-full`; plaintext attempts fail; certificate rotation executed once | 4, 5, 11 |
| PG-3 | Scoped database roles | ExponetDB's roles least-privilege and tested; REOSA's roles reproduced by desired state with verifiers; no superuser over the network | 4, 5, 11 |
| PG-4 | Migration engine | G6 accepted | 6 |
| PG-5 | Migration import and baseline | REOSA baseline accepted; ledger states reproducible; review items decided | 10 |
| PG-6 | Staging-first policy | production apply refused without staging evidence (negative test on real targets) | 6, 10 |
| PG-7 | Migration plan and apply | real REOSA migrations planned and applied through ExponetDB with plan binding | 10 |
| PG-8 | Migration verification | verification failures detected in a planted case; applied and verified reported separately | 6, 10 |
| PG-9 | MCP OAuth | agents connect with nonprod-only grants by default; production requires explicit consent and human approval | 3B, 7 |
| PG-10 | Production scopes | tier matrix tests green; a nonprod grant cannot touch production with a stolen plan id | 3A, 3B, 6 |
| PG-11 | Audit | every operation in the rehearsal is in the audit; chain verifies; off-host checkpoint exists | 2, 11 |
| PG-12 | Node agent | G5 accepted on `reos-db-01` | 5, 11 |
| PG-13 | Backups | backups with WAL archive on the new cluster; RPO measured within objective | 9, 11 |
| PG-14 | Restore test | drill passed on the new cluster, including the C-35 drill | 9, 11 |
| PG-15 | Health | dual probes, path awareness and named conditions on REOSA targets; failed-read tests | 4, 10 |
| PG-16 | Connection diagnostics | sessions, locks, cancel/terminate plans tested on staging | 9, 10 |
| PG-17 | Schema drift detection | planted out-of-band change detected and triaged | 4, 10 |
| PG-18 | SDK | REOSA Admin `/database` reads ExponetDB in production | 10 |
| PG-19 | REOSA integration | G10 accepted | 10 |
| PG-20 | Rollback plan | written, rehearsed, with a decision point and owner in the cutover plan | 11 |

## Cross-cutting security gates

These hold at every gate from the wave in which they are introduced:

| Gate | From wave |
|---|---|
| No secrets in logs, errors, traces, MCP output, audit (redaction tests) | 2 |
| No superuser credentials stored by the Control Plane for agent-managed clusters | 4 |
| No arbitrary command execution on hosts | 5 |
| No arbitrary SQL write path outside migrations | 4 |
| Human-only actions enforced by client kind | 3A |
| Threat model updated when a trust boundary changes | 0 |

The constitution's enforcement table maps articles to the mechanisms above
([`../00-product/constitution.md`](../00-product/constitution.md#how-the-constitution-is-enforced)).

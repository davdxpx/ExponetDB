# Acceptance gates

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05; the G7 entry updated on 2026-10-13 (in progress, awaits evidence and the owner) |
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

Accepted on 2026-10-05; evidence in the [gate record](./gates/2.md). The
deployment line was not proven at acceptance (nothing is deployed yet) and
stays unticked until the rollout is recorded; the owner accepted G2 with it
open, as the Wave 2 order allowed ([gate record §9](./gates/2.md#9-acceptance-2026-10-05)).
Checkpoint export is proven through its integration contract; the real
off-host export is recorded with the rollout.

- [x] Three process roles start from one image; readiness checks schema version, keys and Control Store
- [x] Control Store bundles apply and verify from empty via the bootstrap runner; a second run is a no-op
- [x] Operation state machine and idempotency property tests pass
- [ ] Deployed on `reos-01` behind `db.exponet.cloud` (readiness only): not proven, open
- [x] **S** Audit rejects `UPDATE`/`DELETE` for every role; hash chain verifies; checkpoint export works
- [x] **S** Envelope encryption with AAD; substitution test fails to decrypt; keyring not in the Control Store
- [x] **S** Redaction tests over logs and errors pass

### G3A: Identity and authorization foundation

Required before Wave 4 starts. Wave 3A was authorized on 2026-10-05.
Accepted by the owner on 2026-10-06 on the baseline of
`davdxpx/ExponetDB#6` (merge `06613bc`); evidence in the
[gate record](./gates/3a.md) (§1, acceptance in §8). The three Wave 3A
Control Store bundles are frozen since then, like the Wave 2 bundles.

- [x] Passkey login with password + TOTP fallback, re-authentication windows, invitations, first-owner bootstrap, last-owner recovery runbook
- [x] Core RBAC: roles, permissions, bindings at global, product, project, environment and target scope; tier model; client-kind concept
- [x] Server-side authorization evaluation, integrated with the policy engine, for first-party Web App sessions: matrix tests (permission × binding scope × tier × client kind × policy) pass
- [x] **S** Session security: fixation, CSRF and cookie-flag tests pass
- [x] **S** No wildcard permission; a new action grants nothing implicitly
- [x] **S** Human-only actions enforced by client kind; tier separation holds for sessions

### G3B: OAuth and delegated clients

Required before Wave 7 starts, and before any external REST/SDK machine access, the CLI's server-side commands or CI access.
Wave 3B was authorized by the owner on 2026-10-06 together with the
resolution of OD-5 (option a). **Accepted by the owner on 2026-10-06** on
the baseline `548c9a7` (`548c9a765e43cc1eceacdefd39ac50d47bb80347`), the commit that completes the
final hardening the owner required after reviewing `davdxpx/ExponetDB#7`
(an MCP client holds `/mcp` only, the device flow carries no
explicit-consent scope, CIMD reads at most 5 KiB of a JSON media type, PKCE
compared in constant time); evidence in the [gate record](./gates/3b.md)
(§1, hardening in §8, acceptance in §9). The Wave 3B Control Store bundle
is frozen since then, like the Wave 2 and Wave 3A bundles.

- [x] OAuth flows for one CIMD client, one approved DCR client, the CLI (loopback and device) and one service account; API keys issued, scoped and revoked
- [x] Authorization matrix extended with scope × grant restriction passes
- [x] **S** PKCE S256 required; `resource` bound; `iss` returned; refresh reuse revokes the grant
- [x] **S** Metadata fetcher SSRF suite passes (private ranges, redirects, DNS rebinding, size limits)
- [x] **S** MCP-ineligible scopes never issued to `mcp` clients; nonprod grants cannot act on prod subjects

### G4: Registry and PostgreSQL adapter

**[OBSERVED]** (2026-10-07) Accepted on 2026-10-07 under the owner's
conditional delegation (the Wave 5 order) on the verified baseline
`04b2e7705df8047aa89f4c28670cfb75a4e11bea`; evidence, corrections and the acceptance in the
[G4 gate record](./gates/4.md) (§9, §10). Nothing waived.

- [x] Targets registered with identity markers; registration refuses the Control Store and other installations
- [x] Introspection and fingerprints for PostgreSQL 16, 17, 18 deterministic; plan-guard budget passes on a large catalog
- [x] Health model with dual probes, path awareness and named conditions; failed reads never render empty
- [x] Drift detection produces findings on fixtures with known drift
- [x] **S** TLS `verify-full` to every target; connection attempts without TLS fail
- [x] **S** Observer and reader roles cannot write (tested on real PostgreSQL); `data.read` admission refuses all non-read classes
- [x] **S** No connection material in any API or MCP response; redaction corpus passes

### G5: Node agent

**[OBSERVED]** (2026-10-12) Accepted by the owner on 2026-10-12 on the baseline
`c7e8bc763e7c886b8826930dead16548dc482ac4`; evidence and the acceptance in the
[G5 gate record](./gates/5.md) (§4, §11). **Items 2 and 4 are waived by the owner** (no
systemd host, CI blocked) with the expiry "before a node agent is installed on, or
enrolled for, any real host"; no security item is waived.

- [x] Enrollment end to end; certificate renewal observed; revocation stops the agent within one heartbeat
- [ ] Capabilities for status, config, roles, hba, TLS, extensions, stats, logs, WAL status work on a real host *(waived by the owner on 2026-10-12; expiry: before a node agent runs on a real host)*
- [x] Configuration ownership implemented as decided in OD-20, checked against the real host packaging; values found in `postgresql.auto.conf` are detected and shown, never silently overwritten
- [ ] Failure injection: agent crash mid-job, partition, clock skew handled as documented *(waived by the owner on 2026-10-12; expiry: before a node agent runs on a real host)*
- [x] **S** No code path executes arbitrary commands (allowlist test, helper operation types)
- [x] **S** Job signatures, expiry, node binding and replay protection verified by negative tests
- [x] **S** `pg_hba` apply refuses changes that lock out ExponetDB's own access

### G6: Migration engine

**[OBSERVED]** (2026-10-12) Accepted by the owner on 2026-10-12 on the baseline
`c7e8bc763e7c886b8826930dead16548dc482ac4` after the owner ran the owner test package on a
local lab; evidence and the acceptance in the [G6 gate record](./gates/6.md) (§7, §10).
The failure-catalog item is **waived in part by the owner** (E16, E18, E25 and the partially
covered cases) with expiries; no security item is waived.

- [x] Bundles linted, checksummed and planned from the CLI and REST; DAG ordering deterministic
- [x] Apply with advisory lock, session settings, ledger write in the same transaction; verification layers L0 to L4
- [x] Staging evidence enforced for production; break-glass recorded and reviewed
- [x] Non-transactional bundles run alone with their own recovery path
- [x] Legacy import on the REOSA-shaped fixture yields the documented states and review items
- [ ] Failure catalog E1 to E30 covered by tests *(waived in part by the owner on 2026-10-12: E16 and E18 expire before the first real REOSA import, E25 and the partial cases before Wave 9 closes)*
- [x] **S** Plan substitution, replay and stale-plan tests pass
- [x] **S** `verify.sql` admission and execution tests pass: forbidden forms and non-allowlisted functions, operators, casts, views and foreign tables are refused at plan time; declared consumer checks require approval; the verifier role has no write privilege (tested on real PostgreSQL); read-only transaction, timeouts, row limits and connection close hold. (The gate tests the defined admission, role and read-only model; it does not claim a sandbox for arbitrary SQL.)
- [x] **S** `down.sql` never runs automatically

### G7: MCP

**[OBSERVED]** (2026-10-13) **In progress; awaits evidence and the owner.**
Wave 7 was authorized on 2026-10-12 (the owner's Wave 7 order; OD-13 (a) and
OD-29 (c) decided with it). Development and disposable tests only, nothing is
deployed, and no box below is ticked: only the owner accepts G7. The gate
record, [`gates/7.md`](./gates/7.md), holds the criteria of the order with
their contract, implementation and evidence columns (§6), the evidence per
phase (§5) and the limits (§8). It records, for example, the item "at least
three real clients" as **NOT PROVEN** (one real client connected, no model
run, no OAuth sign-in in a real client; the owner test package
[`../05-mcp/owner-test-package.md`](../05-mcp/owner-test-package.md) is the
guide) and "land on the plan review page" as partial by design (owner
decision 5: the link opens the existing approvals page until Wave 8). The
boxes below are the wave's gate wording and stay open.

- [ ] Both protocol eras pass contract tests; tested with at least three real clients
- [ ] Tool outputs match their schemas; untrusted fields labeled; caps enforced
- [ ] Approval links via URL elicitation land on the plan review page
- [ ] **S** Adversarial suite: every injection goal fails or requires human approval for every grant shape
- [ ] **S** Origin validation; no tool reachable without its scope; no SQL write path

### G8: Web App

Rewritten on 2026-10-13 by the owner's Wave 8 order and
[ADR-0030](../01-architecture/adr/0030-supabase-ui-source-adoption.md)
(adoption of Supabase UI source by copy); evidence in the
[gate record](./gates/8.md).

- [ ] Global and target levels as in the information architecture; plan review, approvals and typed confirmations
- [ ] Parity: every page and external URL of the earlier Web App (`/login`, `/setup`, `/invite`, `/recover`, `/account`, `/approvals#operation=`, `/step-up#id=`, `/credentials#cluster=`, `/oauth/consent#request=`, `/oauth/device`, `/oauth/error`, the admin pages or their redirects) keeps its security behavior; the existing browser suites, `tooling/smoke/roles.sh` and the hostile cases of the `returnTo` allowlist and the plan review pass
- [ ] The additive server endpoints the screens need are contracted, implemented and tested; Wave 9 surfaces and those blocked by OD-21 render a named "not available yet" state, never mock data
- [ ] Render tests for truthful states on every list, card and chart (failed is never empty; stale shows age; partial names what is missing)
- [ ] Accessibility checks (WCAG 2.2 AA) and visual regression in light and dark (run in CI once a runner starts; until then recorded locally with the commit)
- [ ] Third-party source: every copied file is on ADR-0030's allowlist, carries the provenance header, has a row in the [third-party register](../11-ui/third-party-register.md) with a recorded file-specific license review, and the required license texts and notices ship; no vendor directory, submodule, workspace link or upstream sync; no excluded category (fonts, logos, brand colors, telemetry, `@supabase/*` imports, clean-room areas) present; the dependency license scan passes
- [ ] **S** CSP without inline script or style and without `unsafe-*` or nonces, zero CSP violations in every browser suite; cookie flags, CSRF and `Origin` tests; untrusted content never rendered as HTML; no connection material or tokens rendered

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

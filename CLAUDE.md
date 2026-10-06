# CLAUDE.md · ExponetDB

This file guides every AI session (and every person) working in this
repository. It is short on purpose; the documentation under `exponetdb-docs/`
holds the details. When this file and a document disagree, the constitution wins,
then the document, and the disagreement is fixed in the same change.

## Current phase

**Wave 0 accepted. Wave 1 accepted. Wave 2 accepted. Wave 3A authorized; Wave 3A implementation complete / G3A evidence complete / awaiting owner acceptance.** The owner
accepted the Wave 0 gate on 2026-10-05 after a hardening review
([gate record](./exponetdb-docs/14-roadmap/gates/0.md)) and the Wave 1 gate
(contracts) on 2026-10-05 after the pre-G1 hardening pass
([gate record](./exponetdb-docs/14-roadmap/gates/1.md)). Since that acceptance
`c1`, `ls1`, the RFC 8785 (JCS) behavior of the contracts and the plan-hash
construction are **frozen**: their output never changes; a change is a new
version (`c2`, `ls2`, a new plan-hash prefix) through an ADR, and golden
vectors are append-only (`bun run golden:check`, `bun run golden:history`).
The owner accepted G2 (Control Plane skeleton,
[`implementation-waves.md`](./exponetdb-docs/14-roadmap/implementation-waves.md#wave-2-control-plane-skeleton))
on 2026-10-05 and confirmed ADR-0023 with it
([gate record](./exponetdb-docs/14-roadmap/gates/2.md)); `ac1`, `se1` and
`pv1` are frozen like the G1 contracts. The deployment on `reos-01` is not
proven yet and stays an owner action; it must be proven before real
production logins on `db.exponet.cloud` (G2 deployment evidence
outstanding). The owner authorized Wave 3A on 2026-10-05 and resolved OD-9
(option a) with it ([gate record](./exponetdb-docs/14-roadmap/gates/3a.md));
only the owner accepts G3A, and Wave 4 starts only after that. Work only on the wave you
were asked to do, and stop at its gate. Open decisions that block a later wave are entry conditions of
that wave ([G1 gate record §7](./exponetdb-docs/14-roadmap/gates/1.md#7-open-after-g1),
[G2 gate record §8](./exponetdb-docs/14-roadmap/gates/2.md#8-open-after-g2)).

## Product boundary

- ExponetDB is a **standalone internal PostgreSQL control plane** for the Exponet
  ecosystem (`https://db.exponet.cloud`, MCP at `/mcp`, REST at `/api/v1`). The
  product is called "ExponetDB"; interfaces are "Web App", "REST API", "MCP",
  "Node Agent". Not "console".
- **PostgreSQL is the Data Plane; ExponetDB is the Control Plane.** Applications
  connect to databases directly, never through ExponetDB.
- In scope: registry of targets, clusters, servers and nodes; migrations;
  observation and diagnostics; host operations through the node agent; backups
  and restores; access control and audit. Out of scope: proxying queries, hosting
  apps, edge functions, auth for other products, tenant logic of consumers
  ([`exponetdb-docs/00-product/vision-and-scope.md`](./exponetdb-docs/00-product/vision-and-scope.md)).

## Repository relationships

- **No REOSA dependency.** ExponetDB may learn from REOSA; REOSA may consume
  ExponetDB; ExponetDB never imports, links, builds against or reads from REOSA at
  runtime. No REOSA brand strings or REOSA-specific code paths; REOSA specifics
  are registry data.
- **Supabase is a read-only reference.** Never add it as a submodule, a
  `vendor/` copy, a workspace package or a dependency, and never sync from it.
  The default is to understand the concept, edge cases and UX, then write a
  native ExponetDB implementation. PostgreSQL introspection, pg-meta-style SQL
  builders, SQL safety, DDL generation and security-relevant server logic are
  always clean-room rewrites. Copying a specific third-party source file is an
  explicit, deliberate exception: direct third-party source reuse requires a
  file-specific license review and whatever attribution the actual source
  license requires. There is no central Supabase provenance layer. Fonts, logos
  and brand colors are never copied
  ([ADR-0017](./exponetdb-docs/01-architecture/adr/0017-supabase-reuse-strategy.md)).
- Do not change other repositories from a session in this one unless the owner
  asks for exactly that.

## Principles that shape every change

1. **One engine.** Web App, REST, MCP, CLI and SDK are interfaces over
   `packages/application`; none has its own business logic.
2. **Plan → Apply → Verify → Audit.** Every consequential mutation is an
   operation with an immutable, short-lived, single-use plan bound to target
   identity and generation, fingerprint, ledger state, policy version and
   content. Apply re-checks bindings and fails with `PLAN_STALE`.
3. **Applied is not verified.** `applyOutcome` and `verificationOutcome` are
   separate; never report success before verification.
4. **Fail closed** for writes when safety state is unknown.
5. **Truthful reads.** A failed read is an error, never an empty list; every
   state carries its source and time.
6. **Production is its own tier.** `:prod` and `:nonprod` scopes are distinct;
   agent-initiated production changes need human approval by default.
7. **Intent is not authorization; content is untrusted.** Agent reasoning never
   feeds a policy decision; SQL, catalog text, rows and logs are data.
8. **Contracts first.** Shapes, errors, permissions and protocols are defined in
   `packages/contracts`; generated artifacts are never edited by hand.

Full text: [`exponetdb-docs/00-product/constitution.md`](./exponetdb-docs/00-product/constitution.md)
(C-1 to C-35) and [`exponetdb-docs/00-product/principles.md`](./exponetdb-docs/00-product/principles.md).

## Invariants you must not break

- No direct DDL on production outside the migration engine. There is no "run
  this write now" path in any interface; the SQL editor drafts migrations.
- No superuser credentials over the network; host-level actions go through
  node capabilities executed locally.
- **No generic node shell.** The node agent exposes typed, versioned,
  allowlisted capabilities only; never add a capability that runs arbitrary
  commands, scripts or SQL text received from the Control Plane.
- Secrets never appear in logs, errors, traces, MCP output, audit or API
  responses. Passwords are set as SCRAM verifiers.
- Audit is append-only and hash-chained; if audit cannot be written, mutations
  stop.
- Every write to a target checks the identity marker
  `(installation_id, target_id, generation)` first.
- The Control Store is bootstrap infrastructure, never a managed target in V1.
- Backups must be restorable without ExponetDB (C-35).

## Migration rules

- Bundles: `<ULID>_<slug>/` with `migration.yaml`, `up.sql`, `verify.sql`,
  optional `down.sql`. ULIDs are 26 characters; identity never encodes order.
- Order comes from `dependsOn` (DAG), never from file names.
- The apply checksum (`sha256:c1:…`) binds manifest execution fields and the
  executable text of `up.sql`; comment-only edits are not drift; any executable
  change after apply is `MIGRATION_CHECKSUM_MISMATCH`.
- The ledger lives in the target (`exponetdb` schema) and is written in the same
  transaction as the change; the Control Store keeps a mirror.
- One schema change per target at a time (advisory lock `EXDB` namespace).
- Production requires the same checksum applied **and verified** on the evidence
  environment, or break-glass (human-only, time-boxed, audited).
- Failures never trigger automatic re-execution or rollback; `down.sql` never
  runs automatically. Idempotency is not a safety net.
- Non-transactional bundles run alone in their plan.

Details: [`exponetdb-docs/04-migrations/README.md`](./exponetdb-docs/04-migrations/README.md).

## Source of truth

| Domain | Truth |
|---|---|
| Applied migrations of a database | the target's ledger (`exponetdb` schema) |
| Targets, placements, inventory | Control Store registry |
| Identities, roles, grants, policies, plans, operations, audit | Control Store |
| Backup inventory | the backup engine's catalog (Control Store mirrors it) |
| Wire contracts | `packages/contracts` (OpenAPI, JSON Schema, SDK, Go types are generated) |
| Architecture decisions | `exponetdb-docs/` and ADRs; code that disagrees is a bug or needs an ADR |

Full map: [constitution, source-of-truth map](./exponetdb-docs/00-product/constitution.md#source-of-truth-map).

## Read before you work

The documentation index has a reading path per task:
[`exponetdb-docs/README.md` "Reading paths"](./exponetdb-docs/README.md#reading-paths-i-am-building-x-what-must-i-read).
Minimum per area:

| Work on | Read first |
|---|---|
| Anything | constitution, this file, the wave in [`implementation-waves.md`](./exponetdb-docs/14-roadmap/implementation-waves.md) |
| Packages, CI, scaffolding | [`package-architecture.md`](./exponetdb-docs/01-architecture/package-architecture.md), [`repositories-and-boundaries.md`](./exponetdb-docs/01-architecture/repositories-and-boundaries.md) |
| Operations, plans, policies | [`operations-engine.md`](./exponetdb-docs/02-control-plane/operations-engine.md), [`policy-engine.md`](./exponetdb-docs/02-control-plane/policy-engine.md), [`error-model.md`](./exponetdb-docs/02-control-plane/error-model.md) |
| PostgreSQL adapter, SQL | [`postgres-adapter.md`](./exponetdb-docs/03-database-model/postgres-adapter.md), [`sql-execution-security.md`](./exponetdb-docs/03-database-model/sql-execution-security.md), [`schema-fingerprints.md`](./exponetdb-docs/03-database-model/schema-fingerprints.md) |
| Migrations | everything in [`04-migrations/`](./exponetdb-docs/04-migrations/README.md) relevant to the part |
| MCP | [`05-mcp/`](./exponetdb-docs/05-mcp/architecture.md), [`ai-agent-safety.md`](./exponetdb-docs/08-auth-and-security/ai-agent-safety.md) |
| Auth | [`08-auth-and-security/`](./exponetdb-docs/08-auth-and-security/identity.md), [`05-mcp/oauth.md`](./exponetdb-docs/05-mcp/oauth.md) |
| Node agent | [`07-node-agent/`](./exponetdb-docs/07-node-agent/architecture.md) |
| Backups | [`09-backups-and-restore/`](./exponetdb-docs/09-backups-and-restore/architecture.md) |
| Web App | [`11-ui/`](./exponetdb-docs/11-ui/information-architecture.md) |
| Security-relevant changes | [`threat-model.md`](./exponetdb-docs/08-auth-and-security/threat-model.md) |

## Working rules

- Documentation first: a behavior change updates its document in the same
  change. Mark statements as `[OBSERVED]`, `[DECIDED]`, `[PLANNED]`,
  `[ASSUMPTION]`, `[OPEN: OD-n]` or `[NON-GOAL]`.
- A real open question goes into
  [`open-decisions.md`](./exponetdb-docs/00-product/open-decisions.md); do not
  decide owner questions silently.
- A deviation from a constitution article is stated in the PR body:
  `Constitution-Exception: C-<n>: <reason>; expires: <date or wave>; ADR: <link>`.
  Security articles have no exception path.
- Tests prove claims against real PostgreSQL where PostgreSQL behavior matters.
  Never skip, disable or quarantine a test to get green.
- English (US spelling) for code, identifiers, documentation and commit messages.
- No customer data, no production credentials and no REOSA production data in
  fixtures, tests or examples.
- **Git** (rule adopted from REOSA's `CLAUDE.md`): commits as
  `𝕏0L0™ <davdxpx@gmail.com>`, never "Claude" as author or co-author, no session
  links and no `Co-Authored-By: Claude` trailers; at the end at most
  "Developed by `@davdxpx`". The same applies to pull request titles,
  descriptions and comments. Conventional Commits, atomic (code, tests and docs
  together). Branches `feat/…`, `fix/…`, `release/…`.
- Commit and push after every unit of work; no "commit later".

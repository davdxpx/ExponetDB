# ExponetDB Product Constitution

| | |
|---|---|
| Status | Baseline (Wave 0), awaiting owner approval |
| Applies to | Every wave, every interface, every package, every reviewer |
| Read before | Any design or implementation work on ExponetDB |
| Amended by | ADR only (see [Amendments](#amendments)) |

ExponetDB is an AI-native PostgreSQL control plane. This document is the set of
rules that every design, pull request and review is measured against. Each
article is written so that a violation can be pointed at: it names what must
hold, why, and how it is checked. Articles are numbered `C-<n>` so that code
reviews, ADRs and test names can cite them ("violates C-13").

Normative words (MUST, MUST NOT, SHOULD, MAY) follow RFC 2119.

## The three sentences

> **ExponetDB was built so that humans and AI agents can safely change databases together.**

> **PostgreSQL remains the Data Plane. ExponetDB is the Control Plane.**

> **Every consequential change is inspectable, plannable, authorized, verifiable and auditable.**

These sentences are not slogans. The articles below are what they mean in
practice. If an article and a sentence ever seem to disagree, the article wins
and the disagreement is a bug in this document.

---

## Part I: Identity and boundaries

### C-1. PostgreSQL is the Data Plane; ExponetDB is the Control Plane

ExponetDB manages PostgreSQL clusters, databases and the hosts they run on. It
is never in the data path of an application: applications connect to PostgreSQL
directly, never through ExponetDB. ExponetDB is not a proxy, not a pooler, not a
query gateway for applications.

ExponetDB stores metadata about managed databases (structure, ledger mirror,
health samples, redacted statistics, audit) in its own Control Store. It does
not copy application rows into the Control Store, except bounded,
explicitly-requested query results returned to a caller and never persisted
(see [`../02-control-plane/data-retention.md`](../02-control-plane/data-retention.md)).

*Check:* no application connection string in any consumer points at an ExponetDB
endpoint; the Control Store schema contains no table holding target row data.

### C-2. ExponetDB is a standalone product

ExponetDB MUST NOT depend on REOSA or on the Supabase repository at runtime, at
build time, or architecturally. There is no git submodule, no `vendor/`
directory, no workspace link, no package import, no upstream-sync obligation.

> ExponetDB may learn from REOSA. REOSA may consume ExponetDB. ExponetDB must never depend on REOSA.

Code adapted from the Supabase reference lives as native ExponetDB code in the
ExponetDB package that owns that concern, with license notices preserved where
the source license requires it (see
[`../01-architecture/repositories-and-boundaries.md`](../01-architecture/repositories-and-boundaries.md)).

*Check:* CI dependency gate (Wave 2): the lockfile and every `package.json` /
`go.mod` contain no REOSA or Supabase-repository package; a repository grep for
REOSA-internal identifiers in non-documentation paths is empty.

### C-3. The scope boundary is fixed

ExponetDB does not build object storage, realtime, websocket platforms, edge
functions, serverless compute, application auth-as-a-service, PostgREST-style
data APIs, a Firebase replacement, a BaaS, general container orchestration, or a
replacement for Coolify. ExponetDB MAY operate a PostgreSQL host through its node
agent; it does not orchestrate anything on that host that is not part of running
PostgreSQL. The full list is in
[`vision-and-scope.md`](./vision-and-scope.md#non-goals).

*Check:* a new capability, endpoint or tool that does not map to a domain listed
in `vision-and-scope.md` requires an ADR before implementation.

### C-4. Logical targets are stable identities

Clients address **targets** (`reosa/platform/production`), never hosts, IP
addresses, ports or connection strings. ExponetDB resolves a target to its
current placement (server, cluster, endpoint, database, TLS settings, roles,
credentials) on the server side. A target keeps its identifier when its database
moves to another server.

*Check:* no public API, SDK method or MCP tool accepts a hostname, IP address or
connection string as the address of a managed database. Registry write APIs that
define placements are the only exception and are admin-only.

### C-5. The Control Plane does not depend on what it manages

The availability of the ExponetDB Control Plane MUST NOT depend on any managed
target whose failure it is supposed to detect or repair. The Control Store is
bootstrap infrastructure, not a managed target (see
[`../02-control-plane/control-database.md`](../02-control-plane/control-database.md#6-self-management-boundary)).

*Check:* the Control Store connection is configured outside the registry; the
registry rejects registering the Control Store as a target in V1.

---

## Part II: The change model

### C-6. Consequential mutations follow Inspect, Plan, Validate, Authorize, Apply, Verify, Audit

A **consequential mutation** is any action that changes a managed database's
structure, data, configuration, roles, privileges, extensions, availability
(restart, terminate), backups, restores, TLS material, packages, or ExponetDB's
own access-control state. Every consequential mutation runs through the
Operations Engine in this order:

1. **Inspect**: read current state.
2. **Plan**: produce an immutable plan describing exactly what will happen.
3. **Validate**: static and live checks; analysis results are part of the plan.
4. **Authorize**: permission, scope and policy decision, recorded in the plan.
5. **Apply**: execute exactly the plan.
6. **Verify**: check the outcome independently of "no error was raised".
7. **Audit**: record who, what, where, when, why, how and with which result.

Low-risk consequential actions (for example cancelling one query) MAY use an
*inline plan*: the request carries precondition tokens (for example
`pid` plus `backend_start`) that bind it to the observed state, and the action
is authorized, executed, verified and audited in one call. Read-only operations
need no plan. The classification of every action is defined in
[`../02-control-plane/operations-engine.md`](../02-control-plane/operations-engine.md#1-action-classification)
and is part of the contracts, not of individual handlers.

*Check:* every mutating endpoint and tool is registered as an operation kind
with a risk class; a contract test fails when a mutating handler is not.

### C-7. Plans are immutable, short-lived, single-use and bound

A plan binds at least: plan id, expiry, actor identity, OAuth client, target and
target generation, the content checksum of what will be executed, the expected
state (schema fingerprint and ledger state for schema changes), required
evidence, and the policy decision with the policy version. If any binding no
longer holds at apply time, the apply fails with `PLAN_STALE` and a list of the
bindings that changed. ExponetDB MUST NOT reinterpret, refresh or partially
apply a stale plan. The caller re-plans.

### C-8. Only the reviewed content is executed

The SQL, configuration diff or capability arguments that are executed are the
exact bytes stored in the plan. Nothing is re-read from a repository, a client
or a file system between plan and apply.

### C-9. Humans and agents share one engine

The Web UI, the REST API, the SDK, the CLI and MCP are interfaces. They call the
same application services, the same Operations Engine and the same Policy
Engine. No interface has its own mutation implementation, and no interface can
skip a policy. Differences between interfaces are limited to presentation and
to how a human or client proves who it is.

*Check:* package boundary rule (Wave 2): interface code (`apps/server/src/interfaces/**`)
may import only the application layer, contracts, auth middleware and
observability. MCP and REST contract tests call the same service with the same
fixture and expect the same decision.

### C-10. Policies live on the server

Policy decisions are made by the server-side Policy Engine. Tool descriptions,
system prompts, client-side confirmation dialogs and documentation are never a
security barrier. A rule that exists only in a tool description does not exist.

### C-11. Unknown safety state fails closed for writes

If ExponetDB cannot establish a fact that a write depends on (compatibility
class, lock severity, staging evidence, target identity, outcome of a previous
attempt, freshness of a plan), it refuses the write or routes it to an explicit
approval or break-glass path. It never assumes the favourable case.

### C-12. Retries never execute twice

Every mutation is idempotent with respect to its plan id, its idempotency key or
its job id. A network retry of an apply returns the existing operation instead
of starting a second one. When the outcome of an attempt is unknown (for
example, the connection dropped after `COMMIT` was sent), the operation enters
`needs_reconciliation` and is resolved by reading the target ledger, never by
running the action again.

---

## Part III: Migrations

### C-13. Applied is not verified

A successful SQL execution is not sufficient evidence that a migration
succeeded. Apply status and verification status are separate fields with
separate histories. A migration is *done* only when it is applied **and**
verified.

### C-14. Applied history is immutable and content-bound

A migration id is bound to its checksum. Presenting the same id with a different
checksum is `MIGRATION_CHECKSUM_MISMATCH`. There is no "latest wins", no silent
replacement, no edit-in-place of applied history. Corrections are new
migrations.

### C-15. Production requires verified staging evidence

A migration is applied to a production-tier target only if the same migration id
with the identical checksum was applied **and verified** on the evidence
environment configured for that project, unless an explicit, time-boxed,
audited break-glass grant permits otherwise.

### C-16. Failures never trigger automatic re-execution or rollback

A failed verification never re-runs `up.sql`. `down.sql` never runs
automatically. Recovery is a new, planned operation.

### C-17. Order comes from the dependency graph

Migration order is derived from a validated directed acyclic graph of declared
dependencies, with the migration id as the deterministic tie-breaker. File names
alone never define order.

### C-18. One schema change per target at a time

At most one schema-changing operation runs against a target at any time. This
is enforced inside the target database by an advisory lock and in the Control
Store by an exclusive operation lease. Either check failing is a refusal.

### C-19. The ledger lives with the data

The canonical record of which migrations are applied to a database lives inside
that database (schema `exponetdb`) and is mirrored in the Control Store. A
restored database carries its own history. A divergence between the target
ledger and the mirror is reported as drift and blocks schema changes on that
target until resolved.

---

## Part IV: Security

### C-20. Secrets never leave the secret boundary

No credential, key, token or password is ever returned to an MCP client, a
browser, an SDK caller, a log line, a trace, an error message or an audit event.
AI clients never receive database credentials of any kind.

### C-21. No superuser credentials in the Control Plane for agent-managed clusters

For clusters with an enrolled node agent, the Control Plane stores and uses only
non-superuser roles. Actions that require superuser (role management, extension
installation, `ALTER SYSTEM`, restore) are node capabilities executed locally by
the agent. Clusters without an agent (external clusters) cannot run those
actions through ExponetDB.

### C-22. Capabilities, not shells

The node agent exposes a finite, versioned catalog of typed capabilities. It
never executes arbitrary shell commands and never executes arbitrary SQL sent by
the Control Plane. There is no `exec`, no `run_script`, no `sql` capability.

### C-23. Least privilege per path

Metadata and diagnostics run as an observer role. Reading data runs as a reader
role inside read-only transactions. Schema changes run only through the
migration engine, under the project's designated execution role. Operator
actions use roles that can do exactly that action. No path uses a superuser by
default.

### C-24. Production is its own authorization tier

Environments belong to a tier (`prod` or `nonprod`). A permission, scope or grant
for one tier never implies the other. A cluster, server or node takes the
**highest** tier of any database it hosts: restarting a server that hosts
staging and production is a production action.

### C-25. Intent is not authorization

An agent may want to do something it is not allowed to do. Natural-language
reasoning, a confident explanation or a claimed urgency never substitutes for a
permission, a scope or a policy decision.

### C-26. Content is untrusted input

Migration SQL, `verify.sql`, query text, catalog metadata (object names,
comments, function bodies), client-supplied source references and agent-supplied
reasons are untrusted input. They are parsed, bounded, escaped and displayed as
data, never interpreted as instructions to ExponetDB or to an AI client.

### C-27. Identity before writes

Every connection used for a write verifies the target identity marker stored in
the database (`exponetdb.target_identity`) against the target it was resolved
for. A mismatch is `TARGET_IDENTITY_MISMATCH` and stops the operation. This
protects against staging credentials pointing at production, restores into the
wrong database, and DNS or placement mistakes.

---

## Part V: Truthfulness

### C-28. A failed read is not an empty result

A read that fails is reported as failed, with the error, never as an empty list
or a healthy state. Every reported state carries its source (`live`, `cached`,
`sampled`) and its timestamp.

### C-29. Control Plane down is not Database down

"ExponetDB cannot reach the target", "the target is down", "the node agent is
offline" and "ExponetDB itself is degraded" are four different states. They are
modeled, stored, displayed and alerted on separately. Consumers (for example
the REOSA status page) keep their own direct database probe; ExponetDB data
enriches it and never replaces it.

### C-30. No claimed safety without proof

Analyses (compatibility, lock risk, rollback safety, drift) report `unknown` when
they cannot prove a result. `unknown` is never rendered as safe, green or
additive.

### C-31. Audit is append-only and verifiable

Audit events are append-only. No application role can update or delete them.
Each event is chained to its predecessor by hash so that tampering is
detectable, and the chain head is exported off-host regularly.

### C-32. One source of truth per domain

Each domain has exactly one authoritative store, listed in
[Source-of-truth map](#source-of-truth-map). Everything else is a cache, a mirror
or a projection and is labeled as such.

---

## Part VI: Evolution

### C-33. Every contract is versioned

The REST API, the MCP tool schemas, the node protocol, the migration manifest
schema, the SDK and the Control Store schema are versioned from day one. A
breaking change requires a new version and a documented deprecation window. See
[`../01-architecture/versioning.md`](../01-architecture/versioning.md).

### C-34. PostgreSQL knowledge stays behind the adapter

PostgreSQL-specific SQL, catalog knowledge, parser use and lock rules live in the
PostgreSQL adapter (`packages/postgres`). Domain packages talk to it through
interfaces derived from real domain needs. ExponetDB does not implement other
database engines and does not create empty interfaces for hypothetical ones.

### C-35. Backups are restorable without ExponetDB

Every backup ExponetDB takes can be restored with documented standard tooling
and offline-held keys, without a running Control Plane. ExponetDB orchestrates
backups; it is not a single point of failure for recovering from them.

---

## Source-of-truth map

| Domain | Single source of truth | Mirrors / projections |
|---|---|---|
| Which migrations are applied to a database | Target ledger `exponetdb.schema_migrations` inside that database | Control Store `migration_ledger_mirror` |
| Migration content (SQL, manifest) | The bundle as stored in the plan at plan time; before that, the source repository | Control Store `migration_bundles` (content-addressed copy) |
| Target definition and placement | Control Store registry (`targets`, `placements`) | Target identity marker inside the database (verification only) |
| Physical inventory (servers, clusters) | Control Store registry | Node agent reports (observations, compared, never authoritative) |
| Node capabilities | Node enrollment record plus the agent's live capability report | none |
| Identities, roles, permissions | Control Store access tables | none (federated IdPs authenticate, they never authorize) |
| OAuth clients, grants, tokens | Control Store OAuth tables | none |
| Policies | Control Store policy configuration plus the versioned rule code | Policy decision snapshot inside each plan |
| Operations and plans | Control Store operations tables | none |
| Audit | Control Store `audit_events` (hash chained) | Off-host chain-head exports |
| Backup inventory | Backup repository (engine catalog) | Control Store backup catalog mirror |
| Wire contracts (REST, MCP, node protocol) | `packages/contracts` | Generated OpenAPI, JSON Schema, SDK, Go types |
| UI state | none: the Web UI consumes the REST API and owns no domain truth | |

## How the constitution is enforced

| Mechanism | Articles | Introduced in |
|---|---|---|
| Package boundary lint | C-2, C-9, C-34 | Wave 2 |
| Operation registry contract test | C-6, C-12 | Wave 2 |
| Plan binding tests (stale plan, substitution) | C-7, C-8 | Wave 6 |
| Migration engine adversarial tests | C-13 to C-19 | Wave 6 |
| Secret redaction tests over logs, errors, MCP output | C-20 | Wave 3 onward |
| Role privilege tests against real PostgreSQL | C-21, C-23 | Wave 4 |
| Node capability allowlist test (no shell) | C-22 | Wave 5 |
| Tier tests (nonprod grant cannot touch prod) | C-24 | Wave 3, Wave 6 |
| Health state model tests (failed read is not empty) | C-28, C-29 | Wave 4, Wave 9 |
| Audit immutability tests (UPDATE/DELETE rejected, chain verifies) | C-31 | Wave 2 |
| Restore-without-control-plane drill | C-35 | Wave 9 |

The full gate catalog is in
[`../14-roadmap/acceptance-gates.md`](../14-roadmap/acceptance-gates.md).

## Exceptions

A pull request that knowingly deviates from an article states it in the PR body:

```
Constitution-Exception: C-<n>: <reason>; expires: <date or wave>; ADR: <link or "pending">
```

An exception without an expiry is not accepted. Security articles (C-20 to C-27)
and C-13 to C-16 have no exception path in production code; they can only be
changed by amendment.

## Amendments

The constitution changes only through an ADR in
[`../01-architecture/adr/`](../01-architecture/adr/) that names the article,
the reason, the replacement text and the migration of existing behavior. An
amendment never weakens C-20 to C-22 without an accompanying threat-model update
([`../08-auth-and-security/threat-model.md`](../08-auth-and-security/threat-model.md)).

# Vision and scope

| | |
|---|---|
| Status | Baseline (Wave 0), awaiting owner approval |
| Read before | Proposing any new capability, endpoint, MCP tool or package |
| Related | [`constitution.md`](./constitution.md), [`principles.md`](./principles.md), [`open-decisions.md`](./open-decisions.md) |

## What ExponetDB is

**[DECIDED]** ExponetDB is an internal, standalone product of the Exponet
ecosystem: an AI-native control plane for PostgreSQL infrastructure. It manages
PostgreSQL clusters, databases, the hosts they run on, the migrations applied to
them, their backups, their health and the people and AI agents who change them.

- Product name: **ExponetDB**. Not "ExponetDB Console". Where interfaces need
  names, they are *Web App* (or *Web UI*), *REST API*, *MCP*, *SDK*, *CLI* and
  *Node Agent*.
- Primary domain: `https://db.exponet.cloud`
- Remote MCP endpoint: `https://db.exponet.cloud/mcp`
- REST API: `https://db.exponet.cloud/api/v1/...`
- Status: internal, under development. No public marketing site.

### Place in the ecosystem

**[OBSERVED]** The REOSA documentation establishes this separation
(`REOSA/reosa-docs/27-infrastructure/README.md`, section 0;
`REOSA/reosa-docs/09-operations/self-hosting-01-server-setup.md`, section 9.1):

| Name | What it is |
|---|---|
| REOS | The company |
| REOSA | A product (multi-tenant SaaS for real-estate agents) |
| Exponet | The infrastructure and internal-systems layer, zone `exponet.cloud`, "next to the product, not underneath it" |
| ExponetDB | A standalone internal product inside Exponet |

REOSA is the **first consumer** of ExponetDB, not its owner. Other REOS/Exponet
products are expected to register their databases as targets later.

## The problem ExponetDB solves

**[OBSERVED]** in REOSA (details in
[`../13-integrations/reosa-current-state.md`](../13-integrations/reosa-current-state.md)):

- Migrations reach databases through three different paths that write three
  different ledgers. About a quarter of the names in the database ledger do not
  match the file names in the repository. Drift has stayed invisible for months
  because fail-soft application code swallowed the missing objects.
- "Staging first" and "production only if compatible with the running build"
  are owner rules enforced by discipline and documentation, not by a system.
- Parallel AI sessions create migrations with colliding sequence numbers.
- Today an AI agent applies migrations to the live database through a hosted
  provider's MCP with a single broad credential. That developer experience is
  valuable and must not be lost when REOSA moves to self-managed PostgreSQL, but
  its safety rests entirely on the agent following written rules.
- Moving to self-managed PostgreSQL 17 (`reos-db-01`) removes the hosted
  provider's backups, dashboards, advisors and MCP. Something has to provide
  them, under REOS's control.

ExponetDB's answer is a control plane in which humans and AI agents use the
same server-side engine, every consequential change is planned, authorized,
verified and audited, and the safety rules are code, not prose.

## Goals

**[DECIDED]** in priority order for V1:

1. **Safe schema change for humans and agents.** A migration engine with
   content-bound migration ids, a dependency graph, immutable short-lived plans,
   advisory-lock serialization, schema fingerprints, first-class verification
   and technically enforced staging-before-production.
2. **One authoritative inventory.** Logical targets (`product/project/environment`)
   resolved to servers, clusters, databases, endpoints and credentials, so that
   clients never handle hosts or secrets.
3. **Authenticated, authorized, audited access** for people (Web App), programs
   (REST, SDK, CLI, CI) and AI agents (MCP over OAuth), with its own identity
   and RBAC, ready for federation with a future Exponet identity provider.
4. **Host operations without a shell.** A node agent on database hosts that
   offers typed capabilities (PostgreSQL status, configuration, TLS, roles,
   backups, packages, system health) with plan/apply for anything risky.
5. **Truthful observability of managed databases:** health, connections, locks,
   long-running queries, query statistics, sizes, vacuum, WAL, backups, with
   redaction and without confusing "ExponetDB cannot see" with "the database is
   down".
6. **Backups and restores that are proven by drills**, not assumed.

## Managed scope

**[DECIDED]** Long-term scope (V1 delivers the subset marked in the waves, see
[`../14-roadmap/implementation-waves.md`](../14-roadmap/implementation-waves.md)):

| Area | Includes |
|---|---|
| Inventory | servers, nodes, PostgreSQL clusters, databases, endpoints, logical targets, environments, projects, products |
| Structure | schemas, tables, columns, types (enum, domain, composite, range), constraints, indexes, views, materialized views, sequences, functions, procedures, triggers, event triggers, roles, grants, default privileges, RLS, policies, extensions |
| SQL | read-only queries, `EXPLAIN` / `EXPLAIN ANALYZE` (with safeguards), query plans, query statistics |
| Sessions | connections, sessions, locks, blocking chains, long-running queries, idle-in-transaction, cancel, terminate |
| Migrations | bundles, manifest, dependency graph, checksums, plans, apply, verification, schema fingerprints, drift detection, staging evidence, ledger, legacy import, linter |
| Backups | logical and physical backups, WAL archiving, PITR preparation, retention, encryption, verification, restore, restore drills, RPO/RTO tracking |
| Host | PostgreSQL configuration, restart/reload, TLS certificates, package maintenance, CPU, memory, disk, service status, logs |
| Access | identities, sessions, RBAC, scopes, service accounts, API keys, OAuth clients and grants, MCP, audit |
| Interfaces | Web App, REST API v1, SDK, CLI, MCP, node agent protocol |

## Non-goals

**[DECIDED]** These are out of scope. Building any of them requires an ADR that
amends [C-3](./constitution.md#c-3-the-scope-boundary-is-fixed).

| Not built | Why / what to use instead |
|---|---|
| Object storage, Supabase Storage replacement | Different product category. REOSA uses Cloudflare R2. |
| Realtime, websocket platform, change-data streaming to apps | Not a control-plane concern. |
| Edge functions, serverless or generic compute | Not a control-plane concern. REOSA's three Supabase Edge Functions are an auth boundary and are replaced on REOSA's side (see [`../13-integrations/reosa-current-state.md`](../13-integrations/reosa-current-state.md#supabase-edge-functions)). |
| Application auth-as-a-service (end-user auth for customer apps) | ExponetDB has identity only for its own operators and agents. |
| PostgREST-style or GraphQL data API for applications | Applications connect to PostgreSQL directly (C-1). |
| Firebase replacement, full BaaS | Same. |
| Connection pooler or proxy in the application data path | C-1. ExponetDB may *configure and observe* a pooler later; it does not become one. |
| General container orchestration, Coolify replacement | Coolify remains the deployment platform for applications and for ExponetDB itself. |
| General server management outside database nodes | The node agent manages what PostgreSQL needs (packages of the PostgreSQL stack, service, TLS, disk observations). OS provisioning is a runbook, not a capability. |
| Generic remote shell or arbitrary SQL on nodes | C-22. |
| MySQL, MariaDB, MongoDB or other engines | V1 is PostgreSQL-only (C-34). The adapter boundary keeps the door open; nothing is implemented for other engines. |
| Data-plane high availability and failover automation (Patroni-class) | Not V1. Replication state is observed; automated failover is a later, separate ADR (see [OD-12](./open-decisions.md)). |
| ORM-specific migration engines | The engine is SQL- and catalog-native. Framework adapters (for example Drizzle) may generate bundles, but the core never depends on an ORM. |
| A public product, multi-tenant SaaS for third parties | ExponetDB is internal. Nothing prevents later productization, but V1 makes no concessions for it. |
| Billing, plans, usage metering | Irrelevant for an internal product. |
| AI features inside ExponetDB (assistant, query generation) | ExponetDB is *for* agents, it does not *contain* one. Agents connect over MCP. A UI assistant may come later; it would be an MCP client like any other. |

## Who uses it

| Actor | Interface | Typical work |
|---|---|---|
| Owner / platform engineer | Web App, CLI | registry, approvals, break-glass, restores, access management |
| Developer | CLI, Web App | author and lint migration bundles, inspect schema and drift |
| AI coding agent (Claude Code, Codex, ...) | MCP | inspect schema, plan and apply migrations within its grant, diagnose |
| AI chat client (Claude, ChatGPT, ...) | MCP | read-only diagnostics, schema questions |
| CI pipeline | REST/SDK with a service account | validate bundles, plan against staging, apply to non-production |
| Consumer application backend (REOSA Admin) | SDK with a service account | read health, migration status, backups, connections for its own views |
| Node agent | Node protocol (mTLS) | heartbeats, capability reports, job execution |

## Success criteria for V1

**[PLANNED]** V1 is successful when the REOSA production database runs on
ExponetDB-managed PostgreSQL and all of the following are routinely true. The
measurable form is the gate catalog in
[`../14-roadmap/acceptance-gates.md`](../14-roadmap/acceptance-gates.md).

- An AI agent applies a migration to REOSA staging through MCP, the migration is
  verified, and the same agent cannot apply it to production unless the staging
  evidence exists and its grant includes the production tier.
- A stale plan, a changed checksum, a missing dependency or a concurrent
  migration is refused with a stable error code, in tests and in practice.
- A full restore of production into a scratch target is drilled on a schedule
  and its result (duration, fingerprint match) is visible.
- The REOSA Admin app shows ExponetDB data through the SDK, and its incident view
  still works when ExponetDB is down.
- No database credential exists outside ExponetDB's secret store and the
  consuming applications' own runtime configuration.

# Architecture overview

| | |
|---|---|
| Status | Baseline (Wave 0), awaiting owner approval |
| Read before | [`../00-product/constitution.md`](../00-product/constitution.md), [`../00-product/vision-and-scope.md`](../00-product/vision-and-scope.md) |
| Then read | [`control-plane-and-data-plane.md`](./control-plane-and-data-plane.md), [`domain-model.md`](./domain-model.md), [`package-architecture.md`](./package-architecture.md) |

## 1. System context

```
   People (Web App)        AI clients (MCP)          Programs (REST / SDK / CLI / CI)       Consumer backends (SDK)
   owner, engineers        Claude, Claude Code,      CI pipelines, scripts                  e.g. REOSA Admin
                           ChatGPT, Codex, …
          │                        │                              │                                  │
          └──────────────── HTTPS (TLS by Traefik) ─── https://db.exponet.cloud ─────────────────────┘
                                                   │
                         ┌─────────────────────────▼───────────────────────────────────────────┐
                         │                      ExponetDB Control Plane                          │
                         │  serve:   Web App assets · /api/v1 (REST) · /mcp · /oauth · /.well-known
                         │  worker:  Operations Engine · samplers · reconciliation · retention   │
                         │  gateway: node agent endpoint (mTLS, private network)                 │
                         │                         │                                              │
                         │                  Control Store (PostgreSQL, exponetdb_control)        │
                         └──────────┬──────────────────────────────────┬──────────────────────────┘
                                    │ SQL over TLS (private network)   │ mTLS, agent-initiated
                                    ▼                                  ▲
                ┌───────────────────────────────────────────────────────────────────┐
                │ reos-db-01 (database host)                                         │
                │   PostgreSQL 17 cluster "postgres-main"  ◀── local socket ──  exponetdb-node
                │     reosa_production   reosa_staging   (+ schema exponetdb in each)
                └───────────────────────────────────────────────────────────────────┘
                                    ▲
                                    │ SQL over TLS (private network), direct, not through ExponetDB
                            REOSA applications on reos-01
```

Key properties:

- ExponetDB is **beside** the application data path, never in it (C-1). REOSA's
  applications connect to PostgreSQL directly.
- Two channels reach a database host: **SQL** (control plane → PostgreSQL, with
  ExponetDB's least-privilege roles) and **capabilities** (node agent ← control
  plane jobs, for host-level work). Neither is a shell.
- One public hostname. Agents and people use the same API surface; the node agent
  uses a separate, private, mutually authenticated channel.

## 2. Containers (process roles)

**[DECIDED]** One server codebase (`apps/server`), one container image, three
process roles started with different commands
([ADR-0019](./adr/0019-process-roles-and-web-app.md)):

| Role | Listens | Does | Holds |
|---|---|---|---|
| `serve` | `:8080` behind Traefik (`db.exponet.cloud`) | Web App static assets; REST `/api/v1`; MCP `/mcp`; OAuth AS `/oauth/*`; discovery `/.well-known/*`; plan creation and apply acceptance (synchronous parts) | Control Store role `exdb_serve`; session/OAuth state; the **observer** credential only (read-only, `pg_monitor`; used for planning and the fast staleness check); **no** reader, operator or migrator credentials |
| `worker` | nothing public | executes operations (migrations, verifications, node job dispatch and signing), samplers (health, statement stats, drift), reconciliation, retention | `exdb_worker`; decrypts all target credentials; job-signing key; executes `data.read` queries for `serve` over an internal request lane |
| `gateway` | `:7443` on the private network only, mTLS | node agent API: enrollment, heartbeats, job claim/ack/progress/result, certificate renewal | `exdb_gateway`; agent CA (issuing intermediate); **no** target credentials, **no** job-signing key |

Why split processes: blast radius (P-7) and isolation of long-running database
work from request handling. The **gateway** is the only component reachable from
database hosts; if it is compromised, it can neither read target credentials nor
forge jobs (jobs are signed by the worker and verified by the agent). The
**serve** process faces the internet; it can decrypt only the observer credential
(statistics and catalogs, no table data), so a request-handling bug cannot leak
credentials that read data or change anything.

Why not more services: REST and MCP share one process because they are two
interfaces over the same application services (C-9); separating them would add
deployment surface without separating trust.

Plus:

| Component | Where | Notes |
|---|---|---|
| Control Store | Coolify PostgreSQL resource on `reos-01` (V1) | [`../02-control-plane/control-database.md`](../02-control-plane/control-database.md) |
| `exponetdb-node` | each database host, systemd | [`../07-node-agent/architecture.md`](../07-node-agent/architecture.md) |
| CLI `exponetdb` | developer machines, CI | uses the REST API; shares bundle/checksum code with the server |
| Web App | static SPA served by `serve` | talks only to `/api/v1` and `/oauth` like any client |

## 3. Layering inside the server

```
 interfaces (apps/server/src/interfaces/*)   REST handlers · MCP tools · OAuth endpoints · gateway API · Web App assets
        │  may import only ▼
 application services (packages/application) one function per use case: authorize → call domain → audit
        │
 domain packages        registry · migrations · operations · policy · nodes · backups · diagnostics · auth · secrets · audit
        │
 adapters / kernel      postgres (PostgreSQL adapter) · control-store (persistence) · observability · contracts · kernel
```

**[DECIDED]** Interfaces contain no business logic and no SQL. They translate
protocol to application calls and back. Contract tests run the same scenario
through REST and MCP and require identical outcomes (C-9).

## 4. Main flows

### 4.1 Agent applies a migration to staging, then production

```mermaid
sequenceDiagram
  participant A as AI agent (MCP)
  participant S as serve
  participant W as worker
  participant T as target DB (staging/production)
  participant H as Human (Web App)
  A->>S: migration_plan(staging, bundle)
  S->>T: inspect (observer): identity, ledger, fingerprint
  S-->>A: plan pln_1 (allow)
  A->>S: plan_apply(pln_1)
  S-->>A: op_1 queued
  W->>T: lock, re-check, execute, gate, ledger, commit, verify
  A->>S: operation_get(op_1)
  S-->>A: succeeded (applied, passed)
  A->>S: migration_plan(production, id)
  S->>T: inspect production + evidence on staging
  S-->>A: plan pln_2 (require approval)
  A->>S: plan_apply(pln_2)
  S-->>A: awaiting_approval + approval URL
  H->>S: open approval, re-auth, approve (planHash)
  W->>T: lock, re-check, execute, verify
  S-->>A: succeeded
```

### 4.2 Host-level change through the node agent

`postgres.config.plan` → plan with current/proposed values, reload vs restart,
validity per PostgreSQL version → approval (prod tier) → worker creates a
**signed job** → gateway delivers it when the agent claims → agent verifies
signature, node id, expiry, journal (replay protection) → executes the capability
via local socket / helper → reports result → worker verifies (re-reads
`pg_settings`, `pending_restart`) → audit.

### 4.3 Health sampling

The worker samples each target every 15 s with the observer role (dual
simple/extended probe, activity summary, key stats) and each node via heartbeats
(every 15 s). Results are stored with timestamp and source; a failed sample is
stored as a failure, never as zeros (C-28). The health state machine distinguishes
"target unhealthy" from "ExponetDB cannot see the target" from "node offline"
from "ExponetDB degraded" (C-29).

## 5. Technology choices (summary)

| Area | Choice | Status |
|---|---|---|
| Language (control plane, Web App, CLI, SDK) | TypeScript | **[DECIDED]** |
| Runtime (server processes) | Node.js 24 LTS | **[PLANNED]**, confirmed in Wave 2 ([OD-3](../00-product/open-decisions.md#od-3-toolchain-and-runtime)) |
| Workspace tooling | Bun workspaces + Turborepo + Vitest + Biome | **[PLANNED]** (OD-3) |
| HTTP framework | Hono with Zod-based OpenAPI generation | **[PLANNED]** (Wave 2) |
| Contracts | Zod schemas in `packages/contracts` → OpenAPI 3.1, JSON Schema 2020-12, SDK, Go types | **[DECIDED]** ([ADR-0018](./adr/0018-contracts-first.md)) |
| MCP | official TypeScript SDK, dual-era (2025-11-25 and 2026-07-28) | **[DECIDED]** ([`../05-mcp/architecture.md`](../05-mcp/architecture.md)) |
| SQL parser | libpg_query | **[DECIDED]** ([ADR-0021](./adr/0021-libpg-query-parser.md)) |
| PostgreSQL driver | node-postgres | **[PLANNED]** (Wave 4 spike) |
| Web App | React 19, Vite, TanStack Router + Query, Tailwind v4, Radix-based primitives | **[PLANNED]** ([`../11-ui/design-system.md`](../11-ui/design-system.md)) |
| Node agent | Go, single static binary + root helper | **[OPEN: OD-2]** (recommended) |
| Control Store | PostgreSQL 17 | **[DECIDED]** |
| Queues, leases, locks | PostgreSQL (`SKIP LOCKED`, leases, advisory locks) | **[DECIDED]** (P-8) |
| Observability | OpenTelemetry (traces, metrics), structured JSON logs, optional Sentry for errors | **[PLANNED]** |

## 6. Where to go next

- Separation of planes and network paths: [`control-plane-and-data-plane.md`](./control-plane-and-data-plane.md)
- Entities and invariants: [`domain-model.md`](./domain-model.md)
- Repository layout and dependency rules: [`package-architecture.md`](./package-architecture.md)
- Failure behavior: [`failure-model.md`](./failure-model.md)
- Security: [`../08-auth-and-security/threat-model.md`](../08-auth-and-security/threat-model.md)

# ExponetDB

**An AI-native control plane for PostgreSQL: humans and AI agents change
databases together, safely.**

[![License: ESAL-1.0](https://img.shields.io/badge/license-source--available-orange)](./LICENSE)
[![Not open source](https://img.shields.io/badge/open%20source-no-lightgrey)](./LICENSE)
[![PostgreSQL 16 · 17 · 18](https://img.shields.io/badge/PostgreSQL-16%20%C2%B7%2017%20%C2%B7%2018-336791)](./exponetdb-docs/03-database-model/postgres-adapter.md)
[![MCP](https://img.shields.io/badge/MCP-server-blueviolet)](./exponetdb-docs/05-mcp/architecture.md)
[![Status: alpha](https://img.shields.io/badge/status-alpha-red)](#status)

PostgreSQL stays the **Data Plane**. ExponetDB is the **Control Plane**.
Every consequential change is **inspectable, plannable, authorized, verifiable
and auditable**, whether a person clicks it in the Web App or an AI agent asks
for it over MCP.

> **Source-available, not open source.** You can read the code, study it and
> fork it in public. Running it in production, using it commercially or keeping
> a private copy needs the author's written permission or a commercial license.
> See [License](#license).

## Why this exists

ExponetDB was built because three things collided while moving a real product
(a multi-tenant SaaS) from a hosted database to self-managed PostgreSQL:

- **Migrations had no single source of truth.** They reached the database
  through three paths that wrote three ledgers. About a quarter of the ledger
  names did not match the files in the repository, and nobody saw it, because
  fail-soft application code swallowed the missing objects.
- **Safety rules lived in prose.** "Staging first" and "production only if the
  running build is compatible" were enforced by discipline and documentation.
  Parallel AI sessions created migrations with colliding sequence numbers.
- **AI agents already changed live databases**, through a hosted provider's MCP
  with one broad credential. That workflow is too useful to give up and too
  risky to leave as it is: its safety rested entirely on the agent obeying
  written rules.

The answer is a control plane where people and agents use the **same
server-side engine**, and where the safety rules are code, not text. It has to
be at least as convenient as "just run this SQL", otherwise people route around
it.

## What it does

- **Target registry.** Stable logical names such as `shop/platform/production`
  that resolve to servers, clusters, databases and credentials. Clients never
  handle hosts or secrets.
- **Migration engine.** Migrations are bundles (`migration.yaml`, `up.sql`,
  `verify.sql`, optional `down.sql`) with ULID identities, a dependency graph
  and content-bound checksums. Changes flow **plan → apply → verify**, with an
  in-database ledger, staging evidence before production, and import of
  existing migration history.
- **Safe AI access over MCP.** Agents authenticate with OAuth, get non-production
  scopes by default, and need a human approval for production changes. There is
  no "run this write now" tool. SQL, catalog text and row data are treated as
  untrusted content.
- **Observation.** Health with truthful states ("could not determine" is not
  "healthy"), sessions, locks, statement statistics, schema fingerprints and
  drift detection.
- **Host operations without a shell.** A node agent on the database host
  exposes typed, signed, allowlisted capabilities (PostgreSQL configuration,
  roles, `pg_hba`, TLS, backups). It never runs arbitrary commands.
- **One engine for every interface.** Web App, REST API, MCP server, CLI and
  TypeScript SDK all call the same application layer, the same policies and the
  same audit log.

### Design rules you can rely on

| Rule | What it means |
|---|---|
| Plan, apply, verify | Plans are immutable, short-lived and single-use. Apply re-checks every binding and fails with `PLAN_STALE`. **Applied is not verified.** |
| Fail closed | If safety state is unknown, writes stop. |
| Truthful reads | A failed read is an error, never an empty list. |
| Production is its own tier | `:prod` and `:nonprod` scopes are separate. Agents need human approval for production. |
| Intent is not authorization | An agent's reasoning never feeds a policy decision. |
| Append-only audit | The audit log is hash-chained. If it cannot be written, mutations stop. |
| Applications stay independent | Apps connect to PostgreSQL directly. If ExponetDB is down, your databases and apps keep working. |

## What it is not

Not a PostgreSQL proxy or pooler, not a hosting platform, not a generic SQL
editor with write access, not a Supabase or Firebase replacement, not an
identity provider for your applications, and not a place for tenant logic. The
full list is in
[`vision-and-scope.md`](./exponetdb-docs/00-product/vision-and-scope.md).

## Architecture

```
people, AI agents, programs
        │  HTTPS: Web App · REST /api/v1 · MCP /mcp · OAuth
        ▼
ExponetDB Control Plane (serve | worker | gateway) ──▶ Control Store (own PostgreSQL)
        │  PostgreSQL over TLS, least-privilege roles          ▲
        ▼                                                      │ mTLS, signed jobs
PostgreSQL clusters (Data Plane)  ◀── local ── node agent ─────┘
        ▲
        │  direct connections, unaffected by ExponetDB outages
your applications
```

- ExponetDB keeps its own state in a dedicated **Control Store**. Each managed
  database carries its own migration ledger in a schema named `exponetdb`.
- No superuser credentials travel over the network. Host-level work happens
  locally, through the node agent.
- Wire contracts are defined once in `packages/contracts` and generated into
  OpenAPI 3.1, JSON Schema, the SDK and the Go types of the node agent.

Details: [`exponetdb-docs/01-architecture/overview.md`](./exponetdb-docs/01-architecture/overview.md).

## Status

**Alpha, in active development, no stable release yet.** The public interfaces
and the storage layout can still change. Do not point it at data you cannot
lose.

| Area | State |
|---|---|
| Authentication, OAuth, RBAC, audit | built |
| Target registry, PostgreSQL adapter | built |
| Node agent and gateway | built (Go) |
| Migration engine and CLI | built |
| MCP server (`/mcp`) | built, awaiting the owner's acceptance gate |
| Web App | built, being reworked on a design system |
| Backups and restore | in progress |

The authoritative per-wave record, with the acceptance gates, is in
[`exponetdb-docs/14-roadmap/`](./exponetdb-docs/14-roadmap/implementation-waves.md).

## Repository layout

| Path | Contents |
|---|---|
| `apps/server` | the Control Plane process (`serve`, `worker`, `gateway`) |
| `apps/web` | the Web App |
| `apps/cli` | the `exponetdb` command line |
| `apps/design-system` | the Web App's design-system reference |
| `agent/node` | the node agent (Go) |
| `packages/*` | contracts, application layer, migration engine, auth, audit, policy, SDK, UI packages and more |
| `deploy/` | example environment files for each role |
| `tooling/` | checks, generators, golden vectors, smoke tests |
| `exponetdb-docs/` | the specification: constitution, architecture, ADRs, roadmap |

## Documentation

Start with [`exponetdb-docs/README.md`](./exponetdb-docs/README.md). It has a
reading path for "I want to build X, what do I read first?".

- [Constitution](./exponetdb-docs/00-product/constitution.md): the rules every change is measured against
- [Vision and scope](./exponetdb-docs/00-product/vision-and-scope.md)
- [Domain model](./exponetdb-docs/01-architecture/domain-model.md)
- [Migration engine](./exponetdb-docs/04-migrations/README.md)
- [MCP server and tool catalog](./exponetdb-docs/05-mcp/architecture.md)
- [AI agent safety model](./exponetdb-docs/08-auth-and-security/ai-agent-safety.md)
- [Threat model](./exponetdb-docs/08-auth-and-security/threat-model.md)
- [Architecture decision records](./exponetdb-docs/01-architecture/adr/README.md)

## Development

Requires Bun 1.4.4, Node.js 24.22.1, Go 1.26.10 (the `go` line of
`agent/node/go.mod`) and Docker. The integration suites run against a
PostgreSQL 17 Control Store, an S3-compatible test server and PostgreSQL 16, 17
and 18 as managed targets, all in containers.

```sh
bun install --frozen-lockfile
eval "$(bun run --silent dev:control-store)"   # Control Store (PostgreSQL 17) and S3 test services
eval "$(bun run --silent dev:targets)"         # managed targets, PostgreSQL 16, 17, 18
bun run verify        # Biome, types, unit and integration tests, build,
                      # generated drift, golden lock, boundaries, secret scan, Go conformance
bun run smoke:image   # the release image: three roles from one image
```

Running the program: [`apps/server/README.md`](./apps/server/README.md) and
[`local-development.md`](./exponetdb-docs/12-operations/local-development.md).
Running it for development is allowed by the license; running it in production
is not, without permission (see below).

## License

ExponetDB is licensed under the **ExponetDB Source-Available License 1.0**
([`LICENSE`](./LICENSE)). In short:

| You may | You may not (without written permission or a commercial license) |
|---|---|
| read, study and audit the code | run it in production, for anyone |
| fork it **publicly** and change your fork | use it commercially, directly or indirectly |
| run it locally to develop and test a public fork or a contribution | offer it as a hosted or managed service |
| report vulnerabilities and do good-faith security research | keep a private fork or a closed-source derivative |
| send pull requests | use the names "Exponet" or "ExponetDB" for your own project |

This is **not** an open source license. The table is a summary, the numbered
sections of the `LICENSE` file decide.

**Commercial use, a production permission or a quick question:** write to
[davdxpx@gmail.com](mailto:davdxpx@gmail.com) with the subject "ExponetDB
license" (what to include: Schedule A of the license).

Third-party code keeps its own license. Parts of the Web App interface are
derived from [Supabase](https://github.com/supabase/supabase) (Apache-2.0) and
shadcn/ui (MIT); see [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) and
[`LICENSES/`](./LICENSES/).

## Contributing and security

- Contributions are welcome: [`CONTRIBUTING.md`](./CONTRIBUTING.md). Read the
  constitution before changing behavior.
- Found a vulnerability? Do not open a public issue. See
  [`SECURITY.md`](./SECURITY.md).

## Related projects

**REOSA** is the first product built on ExponetDB's lessons. ExponetDB never
depends on it. **Supabase** is a read-only reference, never a dependency;
outside the Web App UI, adapted ideas are native ExponetDB code
([`supabase-reference-audit.md`](./exponetdb-docs/11-ui/supabase-reference-audit.md)).

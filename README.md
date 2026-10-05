# ExponetDB

ExponetDB is an internal PostgreSQL control plane for the Exponet ecosystem. It
manages PostgreSQL clusters, databases and schema changes across several servers
and environments, for people and AI agents alike.

> ExponetDB was built so that humans and AI agents can safely change databases
> together.
>
> PostgreSQL remains the Data Plane. ExponetDB is the Control Plane.
>
> Every consequential change is inspectable, plannable, authorized, verifiable
> and auditable.

**Status: in internal development. The architecture and documentation
baseline (Wave 0) was accepted on 2026-10-05
([gate record](./exponetdb-docs/14-roadmap/gates/0.md)). Wave 1 (contracts) is
implemented and awaits the owner's G1 review
([gate record](./exponetdb-docs/14-roadmap/gates/1.md)): the contracts, the
frozen migration-format primitives and their golden vectors exist; no server,
agent runtime, UI, database access or migration execution exists yet.**

| Interface | Address |
|---|---|
| Web App | `https://db.exponet.cloud` |
| REST API | `https://db.exponet.cloud/api/v1/…` |
| MCP (remote, OAuth) | `https://db.exponet.cloud/mcp` |
| Node agent | outbound mTLS from database hosts to the gateway (private network) |

## What ExponetDB does

- **Registry of logical targets** such as `reosa/platform/production`: stable
  identities that live on clusters and servers, with environments and a
  production tier.
- **Migration engine**: migrations as bundles (`migration.yaml`, `up.sql`,
  `verify.sql`, optional `down.sql`) with ULID identities, a dependency graph,
  content-bound checksums, an in-database ledger, plan → apply → verify,
  staging evidence before production, and import of existing migration history.
- **Observation**: health with truthful states, sessions, locks, statement
  statistics, schema fingerprints and drift detection, advisors.
- **Host operations through a node agent**: PostgreSQL configuration, roles,
  `pg_hba`, TLS, backups and restore drills, as signed, allowlisted
  capabilities. No shell.
- **One engine for every interface**: the Web App, REST, MCP, CLI and SDK call the
  same application layer, policies and audit.

## What ExponetDB is not

Not a PostgreSQL proxy, not a hosting platform, not a generic SQL editor with
write access, not a Supabase Studio clone, not an identity provider for other
products, not a replacement for application-level logic such as tenant
isolation. The full list is in
[`exponetdb-docs/00-product/vision-and-scope.md`](./exponetdb-docs/00-product/vision-and-scope.md).

## Architecture in brief

```
people, AI agents, programs
        │ HTTPS (Web App, /api/v1, /mcp, OAuth)
        ▼
ExponetDB Control Plane (serve | worker | gateway)  ──▶ Control Store (own PostgreSQL)
        │ PostgreSQL over TLS, least-privilege roles          ▲
        ▼                                                     │ mTLS, signed jobs
PostgreSQL clusters (Data Plane)  ◀── local ── node agent ────┘
        ▲
        │ direct connections, unaffected by ExponetDB outages
applications (REOSA and later products)
```

- Applications connect to their databases directly. If ExponetDB is down,
  databases and applications keep working.
- ExponetDB keeps its state in its own Control Store; each managed database
  carries its own migration ledger in a schema `exponetdb`.
- No superuser credentials over the network; host-level work happens locally
  through the node agent.
- AI agents authenticate through OAuth, receive nonprod scopes by default, and
  need human approval for production changes.

Details: [`exponetdb-docs/01-architecture/overview.md`](./exponetdb-docs/01-architecture/overview.md).

## Documentation

Start with the documentation index, which also answers "I am building X, what
must I read?":

- [`exponetdb-docs/README.md`](./exponetdb-docs/README.md): index and reading paths
- [`exponetdb-docs/00-product/constitution.md`](./exponetdb-docs/00-product/constitution.md): the rules every change is measured against
- [`exponetdb-docs/01-architecture/domain-model.md`](./exponetdb-docs/01-architecture/domain-model.md): entities and invariants
- [`exponetdb-docs/04-migrations/README.md`](./exponetdb-docs/04-migrations/README.md): the migration engine
- [`exponetdb-docs/14-roadmap/implementation-waves.md`](./exponetdb-docs/14-roadmap/implementation-waves.md): waves 0 to 11
- [`exponetdb-docs/00-product/open-decisions.md`](./exponetdb-docs/00-product/open-decisions.md): decisions waiting for the owner
- [`exponetdb-docs/01-architecture/adr/README.md`](./exponetdb-docs/01-architecture/adr/README.md): architecture decision records

## Development

Requires Bun 1.3.14, Node.js 24 and Go 1.24.

```sh
bun install --frozen-lockfile
bun run verify    # Biome, types, tests, build, generated drift, golden lock,
                  # golden history against origin/main, boundaries,
                  # secret scan, Go conformance (what CI runs)
```

Layout and dependency rules:
[`package-architecture.md`](./exponetdb-docs/01-architecture/package-architecture.md);
golden vectors: [`tooling/golden/README.md`](./tooling/golden/README.md).

## Related repositories

- **REOSA** is the first consumer. ExponetDB learns from it and REOSA will
  consume ExponetDB through the REST API and `@exponetdb/sdk`; ExponetDB never
  depends on REOSA. Measured state:
  [`exponetdb-docs/13-integrations/reosa-current-state.md`](./exponetdb-docs/13-integrations/reosa-current-state.md).
- **Supabase** (fork) is a read-only implementation reference. Nothing is
  imported from it; adapted ideas are documented in
  [`exponetdb-docs/11-ui/supabase-reference-audit.md`](./exponetdb-docs/11-ui/supabase-reference-audit.md).

## Contributing

Internal project. Read [`CLAUDE.md`](./CLAUDE.md) (it applies to people as much as
to AI sessions) and the constitution before changing anything. Changes to
behavior start with the documentation and, for contracts, with
`packages/contracts`.

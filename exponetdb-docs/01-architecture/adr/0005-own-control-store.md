# ADR-0005: ExponetDB has its own Control Store

| | |
|---|---|
| Status | Accepted (baseline) |
| Date | 2026-10-04 |
| Related | C-5, C-32; [`../../02-control-plane/control-database.md`](../../02-control-plane/control-database.md) |

## Context

ExponetDB needs durable state: registry, identities, grants, plans, operations,
audit, samples, secrets. It could reuse a managed database, an external service
or its own database.

## Decision

The Control Store is a dedicated PostgreSQL database (`exponetdb_control`) on a
separate instance (V1: a Coolify PostgreSQL resource on `reos-01`; later
`exponet-db-01`). It is **bootstrap infrastructure**: not a managed target in
V1, migrated by an embedded bootstrap runner using ExponetDB's own bundle format,
backed up by Coolify and an off-host dump, accessed with one login role per
process role.

## Alternatives considered

- **Store state in a managed database** (for example REOSA production). Rejected:
  circular dependency (C-5).
- **SQLite or files.** Rejected: concurrent workers, leases and audit integrity
  need a real database.
- **Let ExponetDB manage its own Control Store.** Deferred: a second installation
  or watcher can do that later without circularity.

## Consequences

- One more PostgreSQL instance to operate, with its own backup runbook (RB-10).
- The bundle format is dogfooded from the first migration.
- Restoring the Control Store to an older state is a known failure (F30) with a
  reconciliation path because ledgers live in targets.

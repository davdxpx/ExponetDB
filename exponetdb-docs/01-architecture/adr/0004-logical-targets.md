# ADR-0004: Logical targets as stable identities

| | |
|---|---|
| Status | Accepted (baseline) |
| Date | 2026-10-04 |
| Related | C-4, C-27; [`../domain-model.md`](../domain-model.md), [`../../02-control-plane/registry.md`](../../02-control-plane/registry.md) |

## Context

Server names change (`reos-db-01` today, other hosts later), staging and
production may share a host today and not tomorrow, and restores create new
copies. Anything bound to hostnames breaks on every move.

## Decision

The unit of management is a **logical target** with an immutable path
`<product>/<project>/<environment>` and id `tgt_…`. A target has a current
**placement** on a cluster (database on a PostgreSQL instance on a server); the
placement can change through a planned operation, and every change increments
the target's **generation**. Each target database carries an identity marker
`(installation_id, target_id, generation)`, checked before every write.
Environments carry a tier (`prod`/`nonprod`) and an evidence chain.

## Alternatives considered

- **Hosts or connection strings as identity.** Rejected: moves and restores
  would change identity and lose history.
- **Environment as a free-text label.** Rejected: the tier is an authorization
  boundary (C-24) and must be data.

## Consequences

- Ledgers, evidence, findings and audit attach to targets, not hosts.
- A restored copy is a different placement (and, until stamped, an identity
  mismatch), never silently "the same database".
- Registry operations (placement move, re-stamp) are first-class, planned and
  audited.

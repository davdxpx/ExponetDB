# ADR-0002: Control Plane and Data Plane are separate

| | |
|---|---|
| Status | Accepted (baseline) |
| Date | 2026-10-04 |
| Related | C-1, C-5, C-29; [`../control-plane-and-data-plane.md`](../control-plane-and-data-plane.md) |

## Context

The databases ExponetDB manages carry customer data and must keep working when
ExponetDB is down. ExponetDB needs its own state (plans, operations, audit,
samples) and must keep working when a managed database is down, because that is
when it is needed most.

## Decision

PostgreSQL clusters are the **Data Plane**; ExponetDB is the **Control Plane**.
Applications connect to their databases directly, never through ExponetDB. The
Control Plane reaches databases over the private network with dedicated
least-privilege roles and reaches hosts only through the node agent. Control
Plane state lives in its own Control Store, never in a managed database (the
only exception is the per-target ledger, ADR-0013, which belongs to the data it
describes).

## Alternatives considered

- **Proxy architecture** (applications connect through ExponetDB). Rejected:
  ExponetDB would become a single point of failure and a latency hop for every
  query.
- **State inside managed databases.** Rejected: the Control Plane would depend on
  what it repairs (C-5).

## Consequences

- Health must distinguish "database down" from "ExponetDB cannot see it" from
  "node offline" from "ExponetDB degraded".
- Restores and placement moves change where a target lives without changing how
  applications are configured beyond their connection endpoint.
- ExponetDB cannot enforce anything on traffic it does not see; it governs
  changes, not queries.

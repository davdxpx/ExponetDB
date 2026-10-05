# ADR-0008: Order comes from a dependency graph

| | |
|---|---|
| Status | Accepted (baseline) |
| Date | 2026-10-04 |
| Related | C-17; [`../../04-migrations/dependency-graph.md`](../../04-migrations/dependency-graph.md) |

## Context

Parallel branches create migrations that are independent of each other; file
order cannot express "B needs A" and breaks under merges. **[OBSERVED]** REOSA's
journal order fails at its first entry; 22 functions are redefined with
different bodies, so order matters even when files look independent.

## Decision

Each bundle declares `dependsOn` (ULIDs). If omitted, the CLI fills it with the
current heads of the stream at creation time, so linear work needs no manual
edits. The engine validates the graph (no cycles, no missing nodes, no
dependency on a bundle not yet applied on the target) and orders by Kahn's
algorithm with the ULID as deterministic tie-breaker. Baselines from legacy
import act as roots.

## Alternatives considered

- **Linear order by id or file name.** Rejected: see context.
- **Implicit dependencies inferred from SQL only.** Rejected as the sole source:
  inference is incomplete (dynamic SQL, functions); used as an additional lint.

## Consequences

- Merges of parallel branches produce multiple heads; the next bundle joins them.
- A bundle can be applied on staging before an unrelated older bundle without
  conflict.

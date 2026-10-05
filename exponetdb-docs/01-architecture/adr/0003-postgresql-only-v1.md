# ADR-0003: PostgreSQL only in V1

| | |
|---|---|
| Status | Accepted (baseline) |
| Date | 2026-10-04 |
| Related | C-3, C-34; [`../../00-product/vision-and-scope.md`](../../00-product/vision-and-scope.md) |

## Context

Every Exponet product uses PostgreSQL (REOSA: PostgreSQL 17 with pgvector).
Generic multi-engine abstractions tend to reduce every feature to the lowest
common denominator and add interfaces nobody implements.

## Decision

V1 supports PostgreSQL only, versions 16, 17 and 18 (19 tracked as a test lane).
PostgreSQL-specific knowledge lives behind the adapter (`packages/postgres`), but
the adapter's interface is shaped by real PostgreSQL needs; no empty interfaces
for hypothetical engines.

## Alternatives considered

- **Engine-neutral core with PostgreSQL as first driver.** Rejected for V1: it
  costs design effort now for an uncertain benefit.

## Consequences

- Features use PostgreSQL fully: catalog introspection, advisory locks, RLS,
  `pg_stat_*`, libpg_query parsing.
- Adding another engine later is a new adapter plus new analysis rules, decided
  by a new ADR.

# ADR-0007: Migrations are bundles with manifest, up, verify and down

| | |
|---|---|
| Status | Accepted (baseline) |
| Date | 2026-10-04 |
| Related | C-13, C-16; [`../../04-migrations/migration-bundles.md`](../../04-migrations/migration-bundles.md) |

## Context

A single SQL file cannot carry what the engine needs: dependencies, execution
settings (transactional or not, timeouts, role), declared compatibility,
verification and an optional reviewed rollback. REOSA expresses these in German
prose comments, which no tool can check.

## Decision

A migration is a directory `<ULID>_<slug>/` with:

- `migration.yaml` (schema `exponetdb.migration/v1`): id, title, `dependsOn`,
  execution settings, requirements, declared compatibility, verification and
  rollback metadata, source reference;
- `up.sql`: the change;
- `verify.sql`: read-only checks with an `ok` boolean contract, run in a sandbox;
- `down.sql` (optional): a reviewed rollback that **never** runs automatically.

The bundle is ORM-neutral: any tool that produces SQL can produce a bundle.

## Alternatives considered

- **Plain SQL files with header comments.** Rejected: unparseable conventions,
  as REOSA's history shows.
- **ORM-native migrations (Drizzle, Prisma).** Rejected: couples the engine to
  one ORM; REOSA's Drizzle journal covers 233 of 454 files.

## Consequences

- Authors write slightly more per migration; the CLI scaffolds bundles.
- Verification and rollback can be improved after apply without changing the
  migration's identity (separate digests, ADR-0009).

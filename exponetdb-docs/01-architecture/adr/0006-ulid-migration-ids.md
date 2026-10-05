# ADR-0006: Migration ids are ULIDs

| | |
|---|---|
| Status | Accepted (baseline) |
| Date | 2026-10-04 |
| Related | C-14, C-17; [`../../04-migrations/migration-bundles.md`](../../04-migrations/migration-bundles.md#migration-ids) |

## Context

**[OBSERVED]** REOSA's sequential numbers collided 60 times across 137 files in
parallel branch work; renumbering after apply left ledger names and file names
diverging in at least 14 documented cases. Sequential numbers encode order and
identity in one value, and parallel authors (including AI agents) cannot
coordinate them.

## Decision

Every migration has a **ULID** (26 characters, Crockford base32, 48-bit
millisecond time + 80 bits of randomness) generated at creation and never
changed. The directory name is `<ULID>_<slug>`; the slug is metadata and may
change. Order comes from the dependency graph (ADR-0008), not from the id; the
time component is only a deterministic tie-breaker. Legacy names are kept as
aliases.

Note: the example id in the owner brief (`01K6XQ4E9N8T3G5Y7Z2M`) has 20
characters and is not a valid ULID; validation rejects it.

## Alternatives considered

- **Sequential numbers with a collision checker.** Rejected: still couples
  identity to order and still breaks under renumbering.
- **Timestamps (`YYYYMMDDHHMMSS`).** Rejected: collide at second granularity
  across agents; same coupling.
- **UUIDv7.** Viable; ULID chosen for shorter, case-insensitive, sortable text
  that reads well in file names.

## Consequences

- No coordination between authors is needed to create ids.
- Tools must not infer order from ids; lint checks `dependsOn` instead.

# ADR-0009: Checksums bind executable content, versioned

| | |
|---|---|
| Status | Accepted (baseline) |
| Date | 2026-10-04 |
| Related | C-8, C-14; [`../../04-migrations/migration-bundles.md` §3](../../04-migrations/migration-bundles.md#3-checksum-semantics) |

## Context

An applied migration's identity must be immutable: if the content behind an id
changes, history lies. But comments are documentation: **[OBSERVED]** REOSA
edited comment headers of already-applied migrations (renumbering notes,
commit `58de20b4`). A raw byte hash would turn each such edit into a false alarm,
and false alarms train people to bypass checks.

## Decision

- The **apply checksum** `sha256:c1:<hex>` covers the canonical execution
  fields of the manifest (JCS) and the **executable text** of `up.sql`:
  comments outside literals removed, whitespace outside literals collapsed,
  everything else byte-exact, lexed with PostgreSQL rules under
  `standard_conforming_strings = on`; length-prefixed framing.
- Separate **verify** and **rollback digests** allow fixing verification or
  rollback scripts without changing the migration's identity; staging evidence
  binds the verify digest too.
- A **source digest** over the raw bytes records comment-only edits as an
  informational lint.
- The canonicalizer version (`c1`) is part of the stored value; a future `c2`
  never re-hashes history.

## Alternatives considered

- **Raw bytes.** Rejected: false alarms (see context).
- **Parse-and-reprint normalization.** Rejected: ties identity to a parser
  version.
- **Drizzle-style unverified hash.** Rejected: a hash nobody checks protects
  nothing.

## Consequences

- Golden vectors shared between TypeScript and Go implementations are required.
- An executable change after apply is always `MIGRATION_CHECKSUM_MISMATCH`.

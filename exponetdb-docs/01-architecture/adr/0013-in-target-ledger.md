# ADR-0013: The ledger lives in the target database

| | |
|---|---|
| Status | Accepted (baseline) |
| Date | 2026-10-04 |
| Related | C-14, C-19; [`../../04-migrations/ledger.md`](../../04-migrations/ledger.md) |

## Context

The record of what was applied must survive restores, copies and a Control Store
loss, and must be written atomically with the change it records.

## Decision

Each target database has a schema `exponetdb` owned by `exponetdb_ledger_owner`
(NOLOGIN) containing the identity marker and the migration ledger. The ledger
row is written in the **same transaction** as a transactional migration. For a
non-transactional bundle, a start event is committed first, each statement
records a progress event, and the ledger row is written in a final transaction
after the structural gate. Rows are append-only
for application roles. The Control Store keeps a **mirror** for queries and
history; the target ledger is the truth for "what is applied here", and a ledger
state hash `sha256:ls1:` binds plans to it.

## Alternatives considered

- **Ledger only in the Control Store.** Rejected: a restored database would
  carry no history, and a crash between apply and record would lose truth.
- **Reuse `supabase_migrations.schema_migrations` or Drizzle's table.**
  Rejected: no checksums, no verification state, provider-specific.

## Consequences

- A restored database brings its ledger; reconciliation compares mirror and
  target after Control Store restores (F30).
- ExponetDB creates one schema in each managed database; consumers must not
  write to it.

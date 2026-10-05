# ADR-0021: Server-side SQL classification with libpg_query

| | |
|---|---|
| Status | Accepted (baseline) |
| Date | 2026-10-04 |
| Related | C-8, C-26; [`../../04-migrations/analysis.md`](../../04-migrations/analysis.md), [`../../03-database-model/sql-execution-security.md`](../../03-database-model/sql-execution-security.md), [`../../03-database-model/statement-redaction.md`](../../03-database-model/statement-redaction.md) |

## Context

**[OBSERVED]** Supabase Studio classifies SQL with client-side regular
expressions (destructive statements, auto-`LIMIT`); REOSA's validators are regex
checks over SQL text. With REST and MCP clients, classification must run on the
server and be hard to fool (comments, dollar quoting, CTEs, functions).

## Decision

ExponetDB parses SQL with **libpg_query** (PostgreSQL's own parser, packaged per
major version) on the server for: migration analysis (statement classes, lock
levels, rewrites, non-transactional statements), admission of read-only
queries and `verify.sql`, and statement redaction (normalization with
constants replaced). A lexer fallback exists only for redaction of truncated
text and is marked as weaker.

## Alternatives considered

- **Regular expressions.** Rejected: bypassable, false confidence.
- **A third-party SQL grammar.** Rejected: dialect gaps; PostgreSQL's own parser
  is authoritative.

## Consequences

- A native dependency in the server (and parser versions per supported major).
- Classification rules are data over parse trees, testable with corpora.

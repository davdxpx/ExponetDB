# ADR-0010: Schema fingerprints over a canonical document

| | |
|---|---|
| Status | Accepted (baseline) |
| Date | 2026-10-04 |
| Related | C-7, C-13; [`../../03-database-model/schema-fingerprints.md`](../../03-database-model/schema-fingerprints.md) |

## Context

Plans must bind to the schema they were computed for; verification and drift
detection must compare schemas across time and environments. **[OBSERVED]**
REOSA's environments drifted in grants, default ACLs and policy predicates,
not only in tables; Supabase's introspection is UI-grade and loses typmods,
ACLs and memberships.

## Decision

A fingerprint is `fp1:<pg_major>:<sha256>` over the RFC 8785 serialization of a
**canonical document** of the managed scope: objects keyed by name (never OID),
including columns with typmods and collations, constraints, indexes, policies,
RLS/FORCE flags, table and column privileges, default ACLs, functions with
security attributes, triggers, views, sequences, types, extensions, ownership
and role memberships relevant to the scope; no statistics, no OIDs; read with a
pinned `search_path = ''`. Documents referenced by plans, ledgers or restores
are stored for object-level diffs. Fingerprints of different majors or
canonicalizer versions are "not comparable".

## Alternatives considered

- **`pg_dump --schema-only` hash.** Rejected: output varies with dump version and
  ordering, includes irrelevant detail, cannot be diffed structurally.
- **Supabase pg-meta queries.** Rejected: incomplete for this purpose (see
  [`../../11-ui/supabase-reference-audit.md`](../../11-ui/supabase-reference-audit.md#postgresql-introspection-pg-meta)).

## Consequences

- Introspection must be complete and deterministic; plan-guard tests protect
  performance on large catalogs.
- Visibility limits of the reading role are reported, never silently omitted.

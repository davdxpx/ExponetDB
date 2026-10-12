# ADR-0012: Staging evidence before production

| | |
|---|---|
| Status | Accepted (baseline) |
| Date | 2026-10-04 |
| Related | C-15, C-24; [`../../04-migrations/staging-production-policy.md`](../../04-migrations/staging-production-policy.md) |

## Context

**[OBSERVED]** REOSA's rule "staging first" exists only as text; no code, hook
or CI step enforces it, and applies happen through whoever holds MCP access.

## Decision

A production apply requires **evidence** from the environment named in
`evidence_from`: the identical apply checksum applied **and verified** there,
with the same verify digest, plus a live check that the evidence target still
has it. Lineage (production's fingerprint equals staging's pre-migration
fingerprint) is reported and enforced per OD-14. The only bypass is
**break-glass**: human-only, rule-specific, time-boxed, re-authenticated,
audited and reviewed. Projects without an evidence environment declare
`evidence_override: none` explicitly; since Wave 6 that declaration is a
recorded fact only and never lets a production plan proceed without
evidence (C-15; [staging-production-policy.md §1](../../04-migrations/staging-production-policy.md)).

## Alternatives considered

- **Advisory warnings only.** Rejected: rules that can be clicked away get
  clicked away under pressure.
- **Full shadow apply on a production copy.** Deferred (OD-16).

## Consequences

- Every production change has a recorded predecessor on staging.
- Fixes to `verify.sql` between staging and production force re-verification on
  staging.
- Emergency changes remain possible and visible.

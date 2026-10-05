# ADR-0017: Supabase is a reference, not a dependency

| | |
|---|---|
| Status | Accepted (baseline) |
| Date | 2026-10-04 |
| Related | C-2; [`../../11-ui/supabase-reference-audit.md`](../../11-ui/supabase-reference-audit.md), [`../repositories-and-boundaries.md`](../repositories-and-boundaries.md) |

## Context

The Supabase fork contains years of UI and PostgreSQL tooling work. Much of it
is generic; much is tied to Supabase's hosted platform, project model and brand;
some of it is verifiably broken (escaping in DDL generators, index introspection).
Licensing is mixed (Apache-2.0 repository, MIT package declarations,
third-party-derived files without notices, a commercially licensed font).

## Decision

- The fork is a **read-only reference**. No submodule, vendoring, workspace link
  or runtime dependency.
- Per component the audit decides **adopt / adapt / rewrite / not use**; only
  problems that exist because of PostgreSQL (not because of Supabase Cloud, its
  multi-tenancy or browser-only architecture) are taken over.
- Adapted code is copied natively into ExponetDB packages, treated as
  Apache-2.0, keeps its notices, marks changes and is listed in
  `THIRD_PARTY_NOTICES.md`. Files derived from third parties without notices,
  the font, logos and brand colors are never copied.
- Introspection and SQL safety are **clean-room rewrites** using the audit as a
  requirements and edge-case list.

## Alternatives considered

- **Depend on Supabase packages from npm.** Rejected: ties ExponetDB to their
  release cadence and platform assumptions.
- **Ignore Supabase.** Rejected: discards months of solved UX and edge cases.

## Consequences

- Faster UI work with a consistent license trail.
- The ExponetDB design system diverges deliberately (own tokens, own IA).

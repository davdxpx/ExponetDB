# ADR-0017: Supabase is a reference, not a dependency

| | |
|---|---|
| Status | Accepted (baseline); amended by [ADR-0030](./0030-supabase-ui-source-adoption.md) for the Web App UI packages (2026-10-13) |
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
- The default is **native reimplementation**: understand the concept, the edge
  cases, the behavior and the UX, then write ExponetDB code.
- PostgreSQL introspection, pg-meta-style SQL builders, SQL safety, DDL
  generation and security-relevant server logic are **clean-room rewrites**
  using the audit as a requirements and edge-case list.
- Copying a specific third-party source file is not a default but a deliberate
  exception: direct third-party source reuse requires a file-specific license
  review and whatever attribution the actual source license requires. Files
  derived from third parties without notices, the font, logos and brand colors
  are never copied.
- There is **no central Supabase provenance layer** (no `vendor/supabase`, no
  submodule, no upstream sync, no repository-wide notices file maintained only
  because Supabase was a reference).

**Amendment (2026-10-13).** For the Web App's UI packages (`packages/tokens`,
`ui`, `ui-patterns`, `ui-data` and the presentational code of `apps/web`)
[ADR-0030](./0030-supabase-ui-source-adoption.md) replaces "native
reimplementation as the default" with adoption by copy of allowlisted files,
each registered and reviewed. Everything else in this record, including the
clean-room areas and the never-copied fonts, logos and brand colors, stays in
force.

## Alternatives considered

- **Depend on Supabase packages from npm.** Rejected: ties ExponetDB to their
  release cadence and platform assumptions.
- **Ignore Supabase.** Rejected: discards months of solved UX and edge cases.
- **Copy-and-attribute as the default, with a central notices file for every
  adapted file.** Rejected (owner decision 2026-10-05): it turns a reference into
  a provenance dependency of the product; native reimplementation is preferred,
  and the rare direct copy carries exactly what its own license requires.

## Consequences

- Faster UI work without a dependency on, or a provenance layer for, the
  reference repository; license obligations are handled per copied file when a
  copy is ever made.
- The ExponetDB design system diverges deliberately (own tokens, own IA).

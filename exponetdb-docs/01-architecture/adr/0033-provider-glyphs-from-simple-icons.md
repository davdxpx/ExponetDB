# ADR-0033: Provider brand glyphs copied from Simple Icons

| | |
|---|---|
| Status | Proposed (in force since 2026-10-21; it carries out the owner's decision S11, and the choice of the source is the session's, confirmed or changed by the owner at G8) |
| Date | 2026-10-21 |
| Related | [C-2](../../00-product/constitution.md#c-2-exponetdb-is-a-standalone-product) (second paragraph, as amended by [ADR-0030](./0030-supabase-ui-source-adoption.md)); [`../../11-ui/third-party-register.md`](../../11-ui/third-party-register.md#other-sources), [`../../11-ui/design-system.md`](../../11-ui/design-system.md) §1, [`../domain-model.md` §3.2](../domain-model.md#32-physical-layer); [owner decision S11](../../00-product/open-decisions.md#owner-decisions-after-the-wave-8-session) |

## Context

On 2026-10-21 the owner asked for real icons: a server's provider is chosen
from a long list of well-known providers, each with its logo to the left of
its name, and "they are no dependency once copied into the project". Until
then `packages/icons` held Lucide glyphs and no brand mark
([`design-system.md` §1](../../11-ui/design-system.md#1-packages)).

ADR-0030 forbids copying logos from Supabase, third-party brand logos
included (§2). Outside its allowlist, C-2 says copying a specific
third-party file is an explicit exception with a file-specific license
review and the attribution that file's license requires. Drawing a
provider's logo by hand would be a rendition of someone else's mark, not a
real logo.

**[OBSERVED]** Simple Icons (`simple-icons` on npm, version `16.35.0` of
2026-10-11) ships about 3,400 single-path SVG brand glyphs on a 24 x 24
view box, each with a title, a brand color and a source address in
`data/simple-icons.json`. The package declares CC0-1.0; its `LICENSE.md` is
CC0 1.0 Universal, whose §4.1 leaves trademark rights untouched; its
`DISCLAIMER.md` says an icon may carry its own license where the data names
one, asks users to read a brand's guidelines where named, and removes a
brand at its owner's request. In this version AWS, Microsoft Azure, Oracle,
IBM and STACKIT have no glyph.

## Decision

1. **Source.** The provider glyphs are copied once from the npm package
   `simple-icons` at exactly `16.35.0` (tarball shasum
   `78db83dd7f5ae0212b68d05c2ae7797e5d864921`), fetched with `npm pack`
   into a scratch directory outside the repository. Simple Icons is never a
   dependency, a workspace package or a submodule, and there is no sync: a
   later version is a new copy with its own review.
2. **What is copied.** For each brand in use only its title, its hex color
   and its path data, unchanged; the upstream file (`icons/<slug>.svg`) and
   the brand's source address stand in a comment next to it. Nothing else
   of the package (no build code, no other icon, no alias data).
3. **Where.** The data in `packages/icons/src/provider-glyphs.ts`, which
   starts with the provenance header
   `// Copied from simple-icons@16.35.0 (npm). CC0-1.0. … Modified for ExponetDB.`
   and has a row under "Other sources" in the
   [third-party register](../../11-ui/third-party-register.md#other-sources);
   the component `BrandGlyph` (`packages/icons/src/brand-glyph.tsx`) is
   ExponetDB's own. `tooling/checks/third-party.ts` keeps file, header and
   row in step (allowed package, pinned version, license, scope, upstream
   files named).
4. **Use.** A glyph only names the provider a server runs on, next to the
   provider's name (decorative, `aria-hidden`) or with an accessible name
   when it stands alone. Its shape is never changed. It is drawn in its
   brand color on a neutral tile, or in the text color where the brand
   color reaches less than 3:1 (WCAG 2.x, non-text) against the light or
   the dark page background (`mono`, recomputed by a unit test from the
   token inputs). The glyph is part of the bundle; no request leaves the
   page (C-20), and the CSP is unchanged.
5. **No glyph.** A provider whose brand has no glyph in the pinned version
   gets a neutral Lucide glyph (a cloud, a server, a building); a logo is
   never taken from another source to fill the gap.
6. **Trademarks.** The marks belong to their owners; no endorsement or
   affiliation is implied (`THIRD_PARTY_NOTICES.md`). If a provider objects,
   or Simple Icons removes its glyph, the glyph is removed here too.
7. **Notices.** `LICENSES/CC0-1.0-simple-icons.txt` (the package's
   `LICENSE.md`) and a Simple Icons section in `THIRD_PARTY_NOTICES.md`;
   the Web App's license notice file carries both. CC0 asks for neither; they
   are a record.

## Alternatives considered

- **Draw the logos natively.** Rejected: a redrawn mark is still the mark,
  only less accurate; the owner asked for real logos.
- **Depend on `simple-icons` from npm.** Rejected: C-2's first paragraph
  (no dependency for a handful of glyphs), a 16 MB package for thirteen
  paths, and a brand removal would arrive through an update unnoticed.
- **Copy the glyphs from Supabase.** Forbidden by ADR-0030 §2.
- **Load logos at run time from a CDN or the providers' sites.** Rejected:
  C-20 and the CSP (`img-src`), and a page that changes when a third party
  does.
- **Names only.** Rejected by the owner's request.

## Consequences

- `packages/icons` holds brand marks for the first time, limited to
  providers and to this use ([`design-system.md` §1](../../11-ui/design-system.md#1-packages)).
- A new provider gets its glyph only through a new copy of a pinned
  version with a review row; a provider without a glyph stays on the
  neutral fallback.
- The register's check gains a second, generic section for copies from
  other packages; any other source needs its own entry in `OTHER_SOURCES`,
  a decision and a review.

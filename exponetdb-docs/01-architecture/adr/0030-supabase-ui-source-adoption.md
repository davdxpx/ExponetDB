# ADR-0030: Adoption of Supabase UI source for the Web App

| | |
|---|---|
| Status | Accepted (the owner's Wave 8 order, 2026-10-13) |
| Date | 2026-10-13 |
| Amends | [C-2](../../00-product/constitution.md#c-2-exponetdb-is-a-standalone-product) (second paragraph); [ADR-0017](./0017-supabase-reuse-strategy.md) for the Web App UI packages |
| Related | [ADR-0019](./0019-process-roles-and-web-app.md); [`../../11-ui/supabase-reference-audit.md`](../../11-ui/supabase-reference-audit.md), [`../../11-ui/design-system.md`](../../11-ui/design-system.md), [`../../11-ui/third-party-register.md`](../../11-ui/third-party-register.md), [`../repositories-and-boundaries.md`](../repositories-and-boundaries.md), [`../../08-auth-and-security/threat-model.md`](../../08-auth-and-security/threat-model.md); the [Wave 8 order](../../14-roadmap/orders/wave-8-order.md) §3 (D2, D3) and §6; [G8 record](../../14-roadmap/gates/8.md) |

## Context

ADR-0017 made the Supabase fork a read-only reference: ExponetDB learns
from it and writes native code; copying a specific file is a rare exception
with a file-specific license review, and G8 expected no copy at all. The
Web App that Waves 3A to 7 built (`apps/web`) is a small framework-free
TypeScript application without a design system.

For Wave 8 the owner ordered the opposite for the user interface: the Web
App is rebuilt on a real design system, and Supabase's UI source (the
primitives of `packages/ui`, the composites of `packages/ui-patterns`, the
OKLCH token CSS and the presentational layouts of Studio the owner likes,
first of all the OAuth/MCP **Authorize** screen at about 95% of its design
and structure) is **adopted by copy** into ExponetDB's own packages and
then owned natively ([Wave 8 order](../../14-roadmap/orders/wave-8-order.md)
§3 D2). The order calls this a permanent amendment of C-2 and ADR-0017 for
the Web App UI, not an interim exception.

**[OBSERVED]** License facts at the pinned source commit `8b9af568` of
`davdxpx/supabase`:

- the repository license is Apache-2.0 (`LICENSE`); its only copyright line
  is the appendix boilerplate "Copyright 2024 Supabase"; there is no
  `NOTICE` file;
- `packages/ui`, `packages/ui-patterns`, `packages/config` and
  `packages/common` declare `"license": "MIT"` in `package.json` but carry
  no license file;
- shadcn/ui-derived files (MIT, "Copyright shadcn") carry no notice; one
  file carries a Facebook MIT header
  (`packages/ui-patterns/src/SimpleCodeBlock/SimpleCodeBlock.tsx`);
- the bundled UI font (Circular, the `CustomFont-*` faces) is commercially
  licensed and forbids redistribution; `packages/icons` and
  `packages/build-icons` derive from Lucide without carrying its notice.

So the license that governs a single file is ambiguous between the
repository's Apache-2.0 and the package's MIT declaration. Both permit
copying and modification; the obligations differ in form.

## Decision

1. **Scope.** Files from `davdxpx/supabase` at commit `8b9af568` may be
   copied into `packages/tokens`, `packages/ui`, `packages/ui-patterns`,
   `packages/ui-data`, `apps/web` and `apps/design-system` (demos and
   example layouts only; its guidance text is written in ExponetDB's own
   words) when they are on the **allowlist** of
   the Wave 8 order §6.2: curated primitives of `packages/ui`, curated
   composites of `packages/ui-patterns`, the token CSS
   (`packages/ui/build/css/**`, `packages/config/css/**` and the
   Tailwind plugin CSS named there), and presentational parts of
   `apps/studio` (the Authorize screen and its layouts, the interstitial,
   sign-in and creation-form layouts, account and token sheets; class
   strings and structure only). The data grid, the SQL editor and the
   other viewers of `packages/ui-data` are native (the order's Phase 5);
   only small presentational pieces of it may be copied. A later commit of
   the source is a new copy with its own review; there is no sync.
2. **Never copied** (the order's D3): fonts (Circular and every
   `CustomFont-*` face), logos and wordmarks (`SupabaseWordmark`,
   `LogoLoader`, `supabase-logo-*`), the brand green scale (`--brand-*`,
   `--hue: 157.5` as identity), third-party brand and MCP-client logos,
   `packages/icons` and `packages/build-icons`, `packages/common`
   (telemetry, feature flags, GoTrue, PostHog, ConfigCat), anything that
   imports `@supabase/*`, `next`, `next-themes`, `openai`, `mermaid` or
   `sql-to-rest`, and Studio's data layer, platform types, telemetry,
   feature flags and `IS_PLATFORM` branches. The **clean-room areas stay
   clean-room**: PostgreSQL introspection, pg-meta-style SQL builders, SQL
   safety, DDL generation and security-relevant server logic are never
   copied ([ADR-0017](./0017-supabase-reuse-strategy.md)).
3. **Mechanism.**
   - A copied file lands in the ExponetDB package that owns its concern;
     never in `vendor/`, never through a submodule, a workspace link or an
     npm dependency on a Supabase package. After the copy it is ExponetDB
     code and is changed freely.
   - Every copied file starts with the provenance header
     `Derived from supabase/supabase <source path> @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.`
     (as a `//` comment in TypeScript, `/* */` in CSS, `{/* */}` in MDX).
   - Every copied file has a row in
     [`../../11-ui/third-party-register.md`](../../11-ui/third-party-register.md):
     ExponetDB path, source path, source commit, license basis, notices
     applied, changes, review status.
   - `tooling/checks/third-party.ts` (part of `bun run verify`) fails when a
     file with the header is missing from the register, a registered file is
     missing or lacks the header, or a header names another commit than its
     row.
   - The repository ships `LICENSES/Apache-2.0.txt`, `LICENSES/MIT-supabase.txt`
     (the MIT text with the Supabase copyright the package declarations
     imply), `LICENSES/MIT-shadcn.txt` and `THIRD_PARTY_NOTICES.md` naming
     Supabase (Apache-2.0 and the MIT declaration), shadcn/ui (MIT), Radix
     Colors if copied, and every other third-party derivative. The OFL
     license files of the self-hosted fonts ship with the fonts.
   - **File-specific review before the first commit of a copy**: the file
     header, the package's declaration, the repository license, notices
     inside the file, trademark or brand content, referenced fonts and
     images, and the dependencies the file pulls in. The result is the
     register row's review status. An unclear case becomes an open
     decision for the owner; it is not guessed. (The review is a
     compliance record, not legal advice.)
4. **Compliance with both possible bases.** Because the governing license
   of a file is ambiguous, ExponetDB complies with the superset: the
   Apache-2.0 text, the retained copyright line, the prominent change
   notice (the header's "Modified for ExponetDB") and the MIT notice text.
   Whether the owner accepts this reading is
   [OD-38](../../00-product/open-decisions.md#od-38-license-basis-of-copied-supabase-ui-files).
5. **Dependency policy.** Every non-workspace dependency the copied code
   needs is added with an exact version, through the boundary rules of
   [`../package-architecture.md`](../package-architecture.md); a dependency
   license scan (added in Wave 8) accepts MIT, ISC, Apache-2.0,
   BSD-2-Clause, BSD-3-Clause, 0BSD, CC0-1.0, BlueOak-1.0.0 and, for font
   files only, OFL-1.1; any other license stops the change for the owner.
   No Supabase package (`@supabase/*`) is ever a dependency.
6. **Browser-security review of copied code.** Copied renderers that can
   turn data into markup (Markdown, Mermaid, code blocks with HTML
   highlighting, `dangerouslySetInnerHTML`, `Admonition` children from
   data) are neutralized or not copied: untrusted content is rendered as
   text only (C-26). Copied components that talk to the network on their
   own (telemetry, remote images, remote fonts, CDN loaders) have that
   code removed, not wrapped (C-20). Code that injects `<style>` elements
   at runtime is changed to static CSS or replaced so the Web App's CSP
   stays `script-src 'self'; style-src 'self'` without `unsafe-*` or nonces.
7. **Abort criterion** (unchanged from the Wave 8 row): a review that finds
   copied code without a clear license, or with obligations the owner does
   not accept, replaces it with a native rewrite before release.

### Constitution amendment

C-2's second paragraph is replaced (amendment rule of the constitution) by:

> What ExponetDB learns from the Supabase reference becomes native ExponetDB
> code in the package that owns that concern. For the Web App's user
> interface (design tokens, primitives, composite patterns and presentational
> page layouts) ADR-0030 (a link in the constitution's text)
> permits copying allowlisted files of the Supabase repository at a pinned
> commit into ExponetDB's own packages, where they become ExponetDB code:
> each with a provenance header, a row in the third-party register and a
> file-specific license review before its first commit; never fonts, logos,
> brand colors, telemetry or anything that imports a Supabase package; and
> never in the clean-room areas (PostgreSQL introspection, SQL builders, SQL
> safety, DDL generation, security-relevant server logic). Elsewhere,
> copying a specific third-party source file stays an explicit exception: it
> requires a file-specific license review and whatever attribution that
> file's actual license requires.

The first paragraph (no runtime, build-time or architectural dependency; no
submodule, `vendor/`, workspace link, package import or upstream sync)
stays unchanged: a copied file is ExponetDB's own code, not a dependency.
The check gains the `third-party` register check. C-20 to C-22 are not
weakened; the threat model records the larger browser surface (its Wave 8
section).

### Migration of existing behavior

There is no copied file before this ADR (G1 to G7 recorded none). ADR-0017
stays in force for everything outside the Web App UI packages and for the
clean-room areas; its status becomes "Accepted; amended by ADR-0030 for the
Web App UI packages".

## Alternatives considered

- **Keep ADR-0017 as it is: native rewrite with a rare exception.**
  Rejected by the owner for the UI: it discards the look and structure the
  owner wants and costs months for primitives that are generic.
- **Depend on Supabase's packages from npm or through a workspace link.**
  Rejected: C-2's first paragraph; their packages import Next.js, telemetry
  and the platform, and their cadence would become ExponetDB's.
- **Copy from upstream shadcn/ui only and rewrite Supabase's additions.**
  Possible for the primitives, but the owner wants Supabase's composites,
  tokens and Studio layouts, which upstream shadcn/ui does not have.
- **A `vendor/supabase` directory synced from upstream.** Rejected: an
  upstream-sync obligation and a provenance dependency, both excluded by
  C-2's first paragraph.

## Consequences

- The Web App's UI packages contain derived code under Apache-2.0 and MIT;
  `THIRD_PARTY_NOTICES.md`, `LICENSES/` and the register ship with the
  repository and the image.
- On 2026-10-05 the owner rejected "copy-and-attribute as the default, with
  a central notices file" (ADR-0017, Alternatives). This ADR revisits that
  decision for the UI only and scopes it: the register is a
  **license-compliance register** that Apache-2.0 §4 requires once code is
  copied (license text, retained notices, prominent change notices); it is
  not a runtime provenance layer, there is no upstream sync, and nothing
  outside the copied UI files is registered.
- The design system starts from Supabase's structure and diverges
  deliberately: own tokens and hue, no Supabase branding or vocabulary
  ([`../../11-ui/design-system.md`](../../11-ui/design-system.md)).
- G8's criterion on third-party source changes from "expected: none" to
  "every copied file on the allowlist, registered and reviewed"
  ([`../../14-roadmap/acceptance-gates.md`](../../14-roadmap/acceptance-gates.md#g8-web-app)).

# Repositories and boundaries

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05; the Supabase rows amended by [ADR-0030](./adr/0030-supabase-ui-source-adoption.md) for the Web App UI on 2026-10-13 |
| Applies to | every wave; mandatory before adapting any code from the reference repositories |
| Decision | [ADR-0001](./adr/0001-own-repository.md), [ADR-0017](./adr/0017-supabase-reuse-strategy.md), amended by [ADR-0030](./adr/0030-supabase-ui-source-adoption.md) |

## 1. The three repositories

| Repository | Role | May ExponetDB code depend on it? | May ExponetDB docs cite it? |
|---|---|---|---|
| `davdxpx/ExponetDB` | **The product.** All ExponetDB code and documentation. | n/a | n/a |
| `davdxpx/supabase` (fork of the Supabase monorepo) | **Read-only implementation reference, and for the Web App UI only a source of allowlisted files adopted by copy** ([ADR-0030](./adr/0030-supabase-ui-source-adoption.md)). Generic PostgreSQL, UI and UX solutions to learn from. | **No.** No submodule, no `vendor/`, no workspace link, no package import, no build import, no runtime import, no upstream-sync obligation. A copied file is ExponetDB code, not a dependency. | Yes, by path (`supabase/…`) as audited at commit `cc31e2bd`; the copy source of the Web App UI is commit `8b9af568`. |
| `davdxpx/REOSA` | **Read-only reference and first consumer.** Shows real problems ExponetDB must solve; later consumes ExponetDB through the SDK and REST. | **No.** | Yes, by path (`REOSA/…`) as audited at commit `f09a302e`. |

> ExponetDB may learn from REOSA. REOSA may consume ExponetDB. ExponetDB must never depend on REOSA.

**[DECIDED]** Enforcement (Wave 2 CI gate):

- `package.json`/lockfile/`go.mod` checks: no package from the REOSA or Supabase
  repositories (`@reosa/*`, `@supabase/*` workspace packages, git dependencies on
  these repositories).
- No file outside `exponetdb-docs/` contains REOSA-internal identifiers used as
  code (role names like `reosa_app` may appear in documentation and test fixtures
  that model a consumer, never in product code defaults).
- No directory named `supabase/`, `vendor/supabase`, `reosa/` in the code tree.
- REOSA brand strings never appear in ExponetDB code or UI.
- **[DECIDED]** (Wave 8, ADR-0030) `tooling/checks/third-party.ts`, part of
  `bun run verify`: every file that carries the provenance header has a row in
  [`../11-ui/third-party-register.md`](../11-ui/third-party-register.md), every
  registered file exists and carries the header, and a header names the commit
  of its row. The checks above stay as they are: a copied file is not a package
  or an import of the Supabase repository.

## 2. How Supabase reference code may be used

**[DECIDED]**

| Approach | Allowed | Conditions |
|---|---|---|
| Read, understand the concept, edge cases, behavior, UX and the PostgreSQL problem, then write a native ExponetDB implementation | **yes, the default** (everywhere outside the Web App UI packages) | Our audit documents serve as the requirements; the implementation is written fresh. |
| Copy allowlisted Supabase UI files into the Web App UI (`packages/tokens`, `ui`, `ui-patterns`, `ui-data`, `apps/web`, and the demos of `apps/design-system`) | **yes, under [ADR-0030](./adr/0030-supabase-ui-source-adoption.md)** (amends C-2) | Only files on the allowlist of the Wave 8 order §6.2, at commit `8b9af568`; a provenance header on each file; a row in [`../11-ui/third-party-register.md`](../11-ui/third-party-register.md); a file-specific license review before its first commit (§3); the license texts and `THIRD_PARTY_NOTICES.md`; the file lives natively in the owning package, never under a `supabase` path or in `vendor/`; no sync. |
| Copy any other third-party source file or function | **only as a deliberate exception** | An explicit decision recorded in the change that does it; a file-specific license review of the actual source (§3); whatever attribution and change marking that license actually requires; the code lives natively in the owning ExponetDB package, never under a `supabase` path. Not allowed for the clean-room areas below. |
| PostgreSQL introspection, pg-meta-style SQL builders, SQL safety, DDL generation, security-relevant server logic | **clean-room rewrite only**, also under ADR-0030 | The audit verified defects in `packages/pg-meta`, including an SQL-injection path through role names and context-unaware escaping; we rewrite from catalog semantics ([`../11-ui/supabase-reference-audit.md`](../11-ui/supabase-reference-audit.md)). |
| Copy fonts, logos, brand colors, third-party brand icons, telemetry, `packages/icons`, `packages/common`, Studio's data layer, anything importing `@supabase/*`, `next` or `next-themes` | **no**, also under ADR-0030 | Fonts are commercially licensed (Circular, Lineto); logos and colors are trademarks; the rest is coupling ADR-0030 §2 excludes. |
| Depend on published Supabase npm packages | **no** for runtime | Same independence rule. Upstream open-source libraries that Supabase also uses (Radix, cmdk, TanStack, Monaco, Recharts, libpg_query bindings) are ordinary dependencies chosen on their own merit. |

## 3. License handling

**[OBSERVED]** (Supabase reference, audit 2026-10-04; the facts for the copy
source at `8b9af568` are in [ADR-0030](./adr/0030-supabase-ui-source-adoption.md)):

- The repository root `LICENSE` is **Apache License 2.0** ("Copyright 2024
  Supabase"); there is no `NOTICE` file.
- `packages/ui`, `packages/ui-patterns`, `packages/config`, `packages/pg-meta`
  declare `"license": "MIT"` in `package.json` without their own license file;
  `packages/build-icons` declares ISC; apps declare nothing.
- Some files carry third-party headers (for example a Docusaurus-derived code
  block under MIT); some are derived from third parties without notice
  (node-pg-format, `pg_get_tabledef`, the "splinter" lints, Lucide build tooling).

**[DECIDED]**

- **No central Supabase provenance layer.** No `vendor/supabase`, no
  submodule, no upstream sync, and no repository-wide notices mechanism that
  exists only because Supabase served as a reference. Learning from the
  reference and writing native code creates no attribution record. Copied
  files are the one case with a record, and it is a **license-compliance
  register** (Apache-2.0 §4), not a provenance layer: nothing reads it at run
  time and nothing syncs ([ADR-0030](./adr/0030-supabase-ui-source-adoption.md)).
- **Direct third-party source reuse requires a file-specific license review and
  whatever attribution the actual source license requires.** The review looks
  at the concrete file: its own header, the package declaration and the
  repository license can differ (see the observations above). The change that
  copies the file records the review, the source path and commit, and adds
  exactly the notices and change markings that license requires, in the form
  it requires.
- Files without a clear license, and files derived from third parties without
  notice, are not copied; we go to the original upstream (for example
  Lucide) under its own license, or write our own. The one class that is
  copied although the fork gives it no notice is the shadcn/ui-derived UI
  primitives: their upstream license (MIT) is explicit and is applied through
  `LICENSES/MIT-shadcn.txt` and the register.
- **[DECIDED]** (Wave 8, [ADR-0030](./adr/0030-supabase-ui-source-adoption.md),
  2026-10-13) **Web App UI.** Allowlisted Supabase UI files are adopted by
  copy: provenance header, register row and file-specific review per file,
  `LICENSES/` and `THIRD_PARTY_NOTICES.md` in the repository. Because the
  governing license of a file is ambiguous (the repository's Apache-2.0 or the
  MIT that the package declares), ExponetDB complies with the superset
  ([OD-38](../00-product/open-decisions.md#od-38-license-basis-of-copied-supabase-ui-files),
  open; it blocks release of the Wave 8 Web App, not its development). A
  review that finds copied code without a clear license, or with obligations
  the owner does not accept, replaces it with a native rewrite before release.
  Everything else in this section is unchanged: still no submodule, `vendor/`,
  workspace link, package dependency or upstream sync.
- These documents are not legal advice. Being internal does not remove license
  obligations. If a license question is unclear, the owner decides before the
  code is merged.
- **[DECIDED]** ExponetDB's own license: the ExponetDB Source-Available License
  1.0 (`LICENSE`): readable and publicly forkable, no production or commercial
  use without the owner's written permission or a commercial license; not open
  source ([OD-19](../00-product/open-decisions.md#od-19-exponetdb-license),
  amended 2026-10-23; first resolved 2026-10-05 as proprietary). Being internal does not remove obligations that come with
  third-party code or dependencies.

## 4. How REOSA knowledge may be used

- REOSA facts appear in documentation as **[OBSERVED]** evidence with paths.
- REOSA's patterns (operations kernel, approval modes, audit chain discipline,
  dual probes, redaction lessons) may inspire ExponetDB designs; the
  implementations are independent.
- REOSA consumes ExponetDB later through `@exponetdb/sdk` (published from this
  repository) and REST. REOSA-specific adapters (for example code that maps
  REOSA's role names) live in the REOSA repository, not here.
- Fixtures that model REOSA's database (for legacy-import tests) are synthetic:
  generated SQL that reproduces the *patterns* (duplicate numbers, renamed files,
  conditional DDL), not copies of REOSA's migrations.

## 5. Repository conventions (ExponetDB)

- Branches: work branches as assigned by the session or owner; default branch
  `main`.
- Commits: Conventional Commits (`docs:`, `feat(migrations):`, …), atomic (code,
  tests, docs together).
- Pull requests: link the wave and the acceptance gates they advance; state any
  `Constitution-Exception` explicitly.
- Documentation: in `exponetdb-docs/`, English, status markers, updated in the same
  pull request as the change (P-15).

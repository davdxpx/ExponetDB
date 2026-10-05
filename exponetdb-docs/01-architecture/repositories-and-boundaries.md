# Repositories and boundaries

| | |
|---|---|
| Status | Baseline (Wave 0), awaiting owner approval |
| Applies to | every wave; mandatory before adapting any code from the reference repositories |
| Decision | [ADR-0001](./adr/0001-own-repository.md), [ADR-0017](./adr/0017-supabase-reuse-strategy.md) |

## 1. The three repositories

| Repository | Role | May ExponetDB code depend on it? | May ExponetDB docs cite it? |
|---|---|---|---|
| `davdxpx/ExponetDB` | **The product.** All ExponetDB code and documentation. | n/a | n/a |
| `davdxpx/supabase` (fork of the Supabase monorepo) | **Read-only implementation reference.** Generic PostgreSQL, UI and UX solutions to learn from. | **No.** No submodule, no `vendor/`, no workspace link, no package import, no build import, no runtime import, no upstream-sync obligation. | Yes, by path (`supabase/…`) as audited at commit `cc31e2bd`. |
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

## 2. How Supabase reference code may be used

**[DECIDED]**

| Approach | Allowed | Conditions |
|---|---|---|
| Read, understand, re-implement in our own words ("clean-room style") | **yes, preferred** | Our audit documents serve as the requirements; the implementation is written fresh. |
| Adapt a specific file or function (copy, then modify) | yes, sparingly | License check of that file (§3); notice preserved; change notice added; recorded in `THIRD_PARTY_NOTICES.md`; lives natively in the owning ExponetDB package (for example `packages/ui/src/…`), never under a `supabase` path. |
| Copy SQL introspection or DDL generators from `packages/pg-meta` | **no** | The audit verified defects including an SQL-injection path through role names and context-unaware escaping; we rewrite from catalog semantics ([`../11-ui/supabase-reference-audit.md`](../11-ui/supabase-reference-audit.md)). |
| Copy fonts, logos, brand colors, third-party brand icons | **no** | Fonts are commercially licensed (Circular, Lineto); logos and colors are trademarks. |
| Depend on published Supabase npm packages | **no** for runtime | Same independence rule. Upstream open-source libraries that Supabase also uses (Radix, cmdk, TanStack, Monaco, Recharts, libpg_query bindings) are ordinary dependencies chosen on their own merit. |

## 3. License handling

**[OBSERVED]** (Supabase reference, audit 2026-10-04):

- The repository root `LICENSE` is **Apache License 2.0** ("Copyright 2024
  Supabase"); there is no `NOTICE` file.
- `packages/ui`, `packages/ui-patterns`, `packages/config`, `packages/pg-meta`
  declare `"license": "MIT"` in `package.json` without their own license file;
  `packages/build-icons` declares ISC; apps declare nothing.
- Some files carry third-party headers (for example a Docusaurus-derived code
  block under MIT); some are derived from third parties without notice
  (node-pg-format, `pg_get_tabledef`, the "splinter" lints, Lucide build tooling).

**[DECIDED]**

- Any adapted Supabase file is treated as **Apache-2.0** (the conservative
  reading; it also satisfies MIT): keep the copyright line, add "Modified by
  ExponetDB" with a date, include the Apache-2.0 text in
  `THIRD_PARTY_NOTICES.md`, list the source path and commit.
- Files with their own third-party headers keep those headers.
- Files derived from third parties without notice are not adapted; we go to the
  original upstream (for example shadcn/ui, Lucide) under its license, or write
  our own.
- ExponetDB's own license: internal, proprietary (all rights reserved) for now
  ([OD-19](../00-product/open-decisions.md#od-19-exponetdb-license)). Being internal
  does not remove obligations to keep notices.

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

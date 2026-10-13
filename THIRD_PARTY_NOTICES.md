# Third-party notices

ExponetDB is proprietary (see [`LICENSE`](./LICENSE)). Some files of its Web App
user interface are derived from third-party source under the rules of
[ADR-0030](./exponetdb-docs/01-architecture/adr/0030-supabase-ui-source-adoption.md).
Each such file starts with a provenance header that names its source and states
that it was modified for ExponetDB, and each is listed with its source path,
license basis and review in
[`exponetdb-docs/11-ui/third-party-register.md`](./exponetdb-docs/11-ui/third-party-register.md).

Third-party npm dependencies remain under their own licenses; the dependency
license scan checks them.

## Supabase

- Source: <https://github.com/supabase/supabase>, commit `8b9af568`.
- Repository license: Apache License 2.0, "Copyright 2024 Supabase"
  ([`LICENSES/Apache-2.0.txt`](./LICENSES/Apache-2.0.txt)). The source
  repository has no `NOTICE` file.
- The source packages `packages/ui`, `packages/ui-patterns` and
  `packages/config` declare the MIT license in their `package.json`
  ([`LICENSES/MIT-supabase.txt`](./LICENSES/MIT-supabase.txt)). ExponetDB
  complies with both licenses ([OD-38](./exponetdb-docs/00-product/open-decisions.md#od-38-license-basis-of-copied-supabase-ui-files)).
- Changes: every derived file was modified for ExponetDB (renamed exports,
  removed telemetry, framework and brand code, ExponetDB tokens and copy); the
  register's "Changes" column summarizes each file.
- Not used: Supabase's name, logos, wordmarks, brand colors and fonts.

## shadcn/ui

- Source: <https://github.com/shadcn-ui/ui>, MIT License, "Copyright (c) 2023
  shadcn" ([`LICENSES/MIT-shadcn.txt`](./LICENSES/MIT-shadcn.txt)).
- Supabase's primitives derive from shadcn/ui; ExponetDB's copies of them carry
  that derivation forward.

## Fonts

The Web App self-hosts Inter and Source Code Pro (from the pinned
`@fontsource/inter` and `@fontsource/source-code-pro` packages, `.woff2` only),
both under the SIL Open Font License 1.1
([`LICENSES/OFL-1.1-inter.txt`](./LICENSES/OFL-1.1-inter.txt),
[`LICENSES/OFL-1.1-source-code-pro.txt`](./LICENSES/OFL-1.1-source-code-pro.txt),
copied from the packages). The server bundle and the image carry this file
and `LICENSES/` (`/app/LICENSES/`).

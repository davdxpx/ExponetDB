# Third-party register (Web App UI)

| | |
|---|---|
| Status | **[DECIDED]** 2026-10-13 by [ADR-0030](../01-architecture/adr/0030-supabase-ui-source-adoption.md) (the owner's Wave 8 order); rows are added with each copy |
| Applies to | every file copied from third-party source into `packages/tokens`, `packages/ui`, `packages/ui-patterns`, `packages/ui-data`, `apps/web` and `apps/design-system` |
| Checked by | `tooling/checks/third-party.ts` (part of `bun run verify`) |
| License texts | [`../../LICENSES/`](../../LICENSES/), [`../../THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) |

This is a **license-compliance register**: Apache-2.0 §4 requires the license
text, the retained notices and a prominent notice of changes once code is
copied, and G8 requires a recorded file-specific review. It is not a runtime
provenance layer: nothing reads it at runtime, there is no upstream sync, and
a registered file is ExponetDB code that is changed freely.

## Rules

1. Only files on ADR-0030's allowlist (the Wave 8 order §6.2) are copied,
   from `davdxpx/supabase` at commit `8b9af568`.
2. Every copied file starts with the provenance header (TypeScript form):

   ```text
   // Derived from supabase/supabase <source path> @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
   ```

   CSS uses `/* … */`, MDX `{/* … */}`.
3. Every copied file has exactly one row below; the check fails when a file
   with the header has no row, a row's file is missing or lacks the header,
   or the commit in the header differs from the row.
4. The **review** column records the file-specific review before the first
   commit of the copy: the file's own header and notices, the package's
   license declaration, the repository license, trademark or brand content,
   referenced fonts and images, and the dependencies the file pulls in.
   `reviewed` means none of these raised a question; anything else names the
   open point (and an open decision if the owner must decide). The review is
   a compliance record, not legal advice.
5. **License basis** values: `Apache-2.0 / MIT (declared)` for Supabase
   packages that declare MIT; `Apache-2.0` for files outside such packages
   (`apps/studio`); `MIT (shadcn/ui)` added when a file derives from
   shadcn/ui; other third-party headers are named explicitly.
6. **Notices applied** values: `header` (the provenance header with the
   change notice), plus `LICENSES/Apache-2.0.txt`, `LICENSES/MIT-supabase.txt`,
   `LICENSES/MIT-shadcn.txt` as they apply; every row is covered by
   `THIRD_PARTY_NOTICES.md`.

## Register

| ExponetDB path | Source path | Commit | License basis | Notices applied | Changes | Review |
|---|---|---|---|---|---|---|

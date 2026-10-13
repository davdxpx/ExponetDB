# Design system

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05; brand values **[DECIDED]** 2026-10-13 as a neutral placeholder ([OD-11](../00-product/open-decisions.md#od-11-exponet-brand-input-for-the-web-app), resolved; the owner's brand replaces it when supplied); the system starts from Supabase's UI source under [ADR-0030](../01-architecture/adr/0030-supabase-ui-source-adoption.md) |
| Applies to | Wave 8 (tokens, primitives, patterns, design-system app), every UI wave |
| Read before | [`supabase-reference-audit.md`](./supabase-reference-audit.md), [`information-architecture.md`](./information-architecture.md) |

> Supabase Studio's interaction DNA (its UI source adopted by copy under
> [ADR-0030](../01-architecture/adr/0030-supabase-ui-source-adoption.md)) +
> the Exponet brand (a neutral placeholder until the owner supplies one) +
> ExponetDB's information architecture = ExponetDB. No Supabase branding.

## 1. Packages

**[DECIDED]** (layout in [`../01-architecture/package-architecture.md`](../01-architecture/package-architecture.md)):

| Package | Contains | Must not contain |
|---|---|---|
| `packages/tokens` | OKLCH token inputs, semantic CSS variables, light/dark themes, chart color slots, Tailwind v4 `@theme inline` mapping, utility classes (focus ring, shimmer, hit area) | components |
| `packages/ui` | primitives on Radix + `cva`: Button, Input, Textarea, Select, Combobox, Checkbox, Switch, RadioGroup, Label, Dialog, AlertDialog, Sheet, Popover, Tooltip, DropdownMenu, Tabs, Table, Badge, Card, Toast, Skeleton, ScrollArea, Separator | data fetching, routing, app state |
| `packages/ui-patterns` | composites: page layout family, dialogs (confirm, typed confirm, plan confirm), state components (loading, failed read, empty, stale, partial, not supported, not permitted), form layout and field arrays, filter bar, multi-select, command menu, charts, timestamp, info tooltip, admonition, status badges, key-value lists | Monaco, virtualized grids, framework imports (Next.js, router) |
| `packages/ui-data` | data grid (TanStack Table + Virtual), SQL editor and diff (Monaco, lazy-loaded), plan viewer, schema diff viewer, EXPLAIN plan viewer, schema tree, migration timeline | domain logic |
| `packages/icons` | `lucide-react` re-export plus a small factory for database glyphs | brand logos |
| `apps/design-system` | guidance pages, live demos, accessibility notes; source of truth for humans and agents | product features |

Framework seams defined once in `ui-patterns`: a link component contract, an
injected `navigate`, a color-scheme hook reading `data-theme`, and
`onTelemetry` callbacks. No component imports a router or a telemetry client.

**[DECIDED]** (Wave 8, ADR-0030) Origins: `packages/tokens`, `packages/ui` and
`packages/ui-patterns` start as copies of allowlisted Supabase files (see
[§1.1](#11-provenance-of-copied-files)); `packages/icons` is **native** (a
`lucide-react` re-export plus a few glyphs written here; the fork's icon
packages are never copied); `packages/ui-data` is written natively (the data
grid, SQL editor and viewers are not copied from Studio); `apps/design-system`
restates the guidance in ExponetDB's own words.

### 1.1 Provenance of copied files

**[DECIDED]** ([ADR-0030](../01-architecture/adr/0030-supabase-ui-source-adoption.md))
Every file that starts as a copy of Supabase source:

- is on the allowlist of the Wave 8 order §6.2 and comes from commit
  `8b9af568` of `davdxpx/supabase`;
- starts with the provenance header `Derived from supabase/supabase <source
  path> @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared
  MIT. Modified for ExponetDB.`;
- has one row in [`third-party-register.md`](./third-party-register.md) (license
  basis, notices, changes, review) and a file-specific license review before
  its first commit; `tooling/checks/third-party.ts` fails `bun run verify`
  otherwise;
- is ExponetDB code after the copy and is changed freely (the header stays);
- is covered by `LICENSES/` and `THIRD_PARTY_NOTICES.md` at the repository
  root.

Never copied: fonts, logos and wordmarks, the brand scale, telemetry and
feature flags, `packages/icons`, anything that imports `@supabase/*`, `next`
or `next-themes`, and Studio's data layer. Copied renderers that can turn data
into markup are neutralized, and copied code that injects `<style>` elements at
run time is replaced so the CSP stays free of `unsafe-*` (ADR-0030 §6).

## 2. Tokens

**[DECIDED]** model. **[DECIDED]** 2026-10-13 brand values as a neutral
placeholder ([OD-11](../00-product/open-decisions.md#od-11-exponet-brand-input-for-the-web-app),
resolved): replaced when the owner supplies a brand, through the token inputs
only.

- Inputs: `--hue`, `--surface-hue`, `--chroma`, `--surface`,
  `--foreground-lightness`, `--contrast`, `--elevation-step`. Everything else
  derives in OKLCH.
- Semantic layers: `background` (default, surface-100/200/300, overlay,
  muted), `foreground` (default, light, lighter, muted), `border` (default,
  strong, stronger, control), `primary` (the spot color, with the stepped
  scale `primary-200` to `primary-600`), `accent` (the neutral hover and
  selection surface, as in shadcn/ui), `destructive`, `warning`, `success`,
  `info`, and **`production`** (a reserved token used only for the production
  tier chip, banners and confirmation frames, so production is recognizable
  everywhere and never confused with an error color). **[OBSERVED]**
  (`packages/tokens`) production has its own fixed hue (320); `--hue` stays
  at least 45 degrees away from it, and the token tests pin the production,
  destructive and warning hues.
- **[OBSERVED]** Supported input ranges, proven by the contrast sweep in real
  Chromium (`packages/tokens/test/contrast.test.ts`, 114 pairs; text at least
  4.5:1, controls, rings and chart slots at least 3:1): surface light 0.96 to
  1, dark 0.14 to 0.22; foreground lightness light 0 to 0.15, dark 0.92 to 1;
  chroma 0 to 0.04; elevation step 0 to 0.04; contrast 0 to 1. Every text
  tier is body-text safe.
- Tier and state colors are semantic tokens, never hard-coded:
  `state-healthy`, `state-degraded`, `state-unhealthy`, `state-unknown`,
  `state-stale`.
- Dark and light themes from the same inputs; `data-theme` attribute; system
  preference respected. **[DECIDED]** `data-theme` on `<html>` is the **single**
  theme mechanism (no `.dark` class, no `next-themes`): a small theme provider
  sets the attribute, and the copied `dark:` variant matches
  `[data-theme*='dark']`, so a bare `.dark` class would do nothing.
- Charts use numbered color slots from tokens; no hex values in components.
- **[DECIDED]** (OD-11) Placeholder values: a hue near 255 (indigo-blue,
  clearly not Supabase's green); the wordmark is the text "ExponetDB" set in
  the UI font, with no logo mark; the source's `--brand-*` scale is not kept
  (no `brand` token exists; copied `brand` classes become `primary` and
  `primary-200` to `primary-600`).
- **[DECIDED]** (OD-11) Fonts: Inter (UI) and Source Code Pro (mono), both
  SIL OFL 1.1, self-hosted from pinned `@fontsource/*` packages with their
  license files (the CSP needs `font-src 'self'` for them); Circular is never
  used.

## 3. Database-specific patterns

The owner brief lists the patterns the system must have; each is a documented
component with a demo page and states.

| Pattern | Package | Notes |
|---|---|---|
| Forms | ui-patterns | one layout component for label, description, error, help; field arrays; dirty-state guard on navigation with an in-app dialog (never `window.confirm`) |
| Dialogs and confirmation flows | ui-patterns | graduated: plain confirm (reversible), warning confirm with checklist, typed confirmation (target path or object name), plan confirm (shows plan hash, tier, class); confirm button disabled until the typed text matches; dismissal blocked while pending |
| Destructive-action UX | ui-patterns | destructive variant only for actions that destroy; least-destructive alternative offered in the same dialog (cancel before terminate) |
| Plan/apply UX | ui-data | plan review page blocks: summary, steps, analysis, evidence, policy decision, approvals, expiry; apply and verify as separate indicators |
| Diff views | ui-data | text diff (Monaco), structured diff for settings and grants (before/after table), schema diff by object with classification badges |
| Query and result views | ui-data | virtualized grid, column type rendering, truncation with on-demand full value, copy and export with caps, untrusted-content rendering (no HTML, escaped) |
| Performance visualizations | ui-patterns (charts) | time series with explicit gaps (cause shown), stacked breakdowns, top-N tables with sparklines |
| Migrations timeline | ui-data | per project: bundles as nodes in DAG order, columns per environment, applied/verified/drifted markers, evidence links |
| Server/node state | ui-patterns | node card (agent version, heartbeat age, capabilities, skew), cluster card (version, role, placements) |
| Badges and status | ui-patterns | tier chip, state badge (with source and age on hover), classification badges (destructive, rewrite, non-transactional, security) |
| Audit and event surfaces | ui-patterns | event row (actor with client, action, subject, outcome, time), chain verification indicator, links to plan/operation/ledger |
| Tables and data grids | ui + ui-data | simple table (ui) for small lists; data grid (ui-data) for large or interactive data |
| Command patterns | ui-patterns | command menu with registry from route metadata and capabilities; shortcut ids; `G` + key navigation; `E` + key environment switch |
| Loading, empty, error states | ui-patterns | see [`information-architecture.md` §6](./information-architecture.md#6-states-every-page-must-render) |

## 4. Rules

- **Truthful states first**: every data component has explicit props for
  `failed`, `stale` and `partial`; there is no way to render a failed read as
  empty (type-level: the data prop is a `Readable<T>` union, not `T[]`).
- **Untrusted content** (object names, comments, statement text, row values,
  client names) is rendered as text, never as HTML or Markdown, and long values
  are truncated with an explicit control to expand.
- **Production cues** appear on every surface that can lead to a production
  change: chip in the header, frame on plan pages, path in typed confirmations.
- **Accessibility**: WCAG 2.2 AA; navigation uses navigation semantics (not
  `role="menu"`); sortable headers set `aria-sort`; focus is visible; dialogs
  trap focus and restore it; color is never the only signal (icons and text
  accompany state colors).
- **Copy**: professional, short, specific; buttons name the action ("Create
  plan", "Approve plan", "Apply to production"), never "Submit" or "OK".
  Error copy names what failed and what to do next, with the stable error code
  available for support.
- **No Supabase vocabulary** where ExponetDB has its own terms: "target", not
  "project"; "plan" and "operation", not "run"; "environment" and "tier", not
  "branch".

## 5. Design-system app

`apps/design-system` holds, per component: purpose, when to use and when not,
anatomy, states, accessibility notes, copy rules, live demo. Guidance pages:
layout widths, forms, tables vs grids, modality and dismissal, confirmation
ladder, plan/apply flow, truthful states, production cues, charts, copywriting.
An agent-readable index (Markdown) lets coding agents look up the pattern
before building a screen (the same role `.agents/skills` plays in the Supabase
reference).

## 6. Quality gates for UI work

- Visual regression snapshots for every pattern state (light and dark).
- Automated contrast checks over token combinations at the extremes of the
  theme inputs.
- Render tests: failed read never shows empty state; production chip present on
  production pages; typed confirmation requires the exact path.
- Bundle budgets: Monaco and the grid only load on pages that use them.

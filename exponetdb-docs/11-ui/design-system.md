# Design system

| | |
|---|---|
| Status | Baseline (Wave 0), awaiting owner approval; brand values are [OPEN: OD-11](../00-product/open-decisions.md#od-11-exponet-brand-input-for-the-web-app) |
| Applies to | Wave 8 (tokens, primitives, patterns, design-system app), every UI wave |
| Read before | [`supabase-reference-audit.md`](./supabase-reference-audit.md), [`information-architecture.md`](./information-architecture.md) |

> Supabase Studio's interaction DNA + Exponet brand + ExponetDB's information
> architecture = ExponetDB. No Supabase branding.

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

## 2. Tokens

**[DECIDED]** model, **[OPEN: OD-11]** brand values (hue, fonts, logo; see
[OD-11](../00-product/open-decisions.md#od-11-exponet-brand-input-for-the-web-app)).

- Inputs: `--hue`, `--surface-hue`, `--chroma`, `--surface`,
  `--foreground-lightness`, `--contrast`, `--elevation-step`. Everything else
  derives in OKLCH.
- Semantic layers: `background` (default, surface-100/200/300, overlay,
  muted), `foreground` (default, light, lighter, muted), `border` (default,
  strong, stronger, control), `accent`, `destructive`, `warning`, `success`,
  `info`, and **`production`** (a reserved token used only for the production
  tier chip, banners and confirmation frames, so production is recognizable
  everywhere and never confused with an error color).
- Tier and state colors are semantic tokens, never hard-coded:
  `state-healthy`, `state-degraded`, `state-unhealthy`, `state-unknown`,
  `state-stale`.
- Dark and light themes from the same inputs; `data-theme` attribute; system
  preference respected.
- Charts use numbered color slots from tokens; no hex values in components.
- Fonts: OFL-licensed sans and mono (for example Inter or IBM Plex Sans with
  JetBrains Mono); final choice with the Exponet brand.

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

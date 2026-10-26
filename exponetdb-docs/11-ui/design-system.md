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
| `packages/ui-patterns` | composites: page layout family, dialogs (confirm, typed confirm, plan confirm), state components (loading, failed read, empty, stale, partial, not supported, not permitted), form layout and field arrays, filter bar, multi-select, command menu, charts, timestamp, info tooltip, admonition, status badges, key-value lists | the SQL editor, virtualized grids, framework imports (Next.js, router) |
| `packages/ui-data` | data grid (TanStack Table + Virtual), SQL editor and diff (CodeMirror 6 in a shadow root, lazy-loaded; [OD-40](../00-product/open-decisions.md#od-40-the-sql-editor-component-under-the-web-apps-csp)), plan viewer, schema diff viewer, EXPLAIN plan viewer, schema tree, migration timeline | domain logic |
| `packages/icons` | `lucide-react` re-export plus a small factory for database glyphs; the brand glyphs of hosting providers copied from Simple Icons and `BrandGlyph` ([ADR-0033](../01-architecture/adr/0033-provider-glyphs-from-simple-icons.md)) | any other brand logo (ExponetDB's own mark comes from the brand inputs, OD-11) |
| `apps/design-system` | guidance pages, live demos, accessibility notes; source of truth for humans and agents | product features |

Framework seams defined once in `ui-patterns`: a link component contract, an
injected `navigate`, a color-scheme hook reading `data-theme`, and
`onTelemetry` callbacks. No component imports a router or a telemetry client.

**[DECIDED]** (Wave 8, ADR-0030) Origins: `packages/tokens`, `packages/ui` and
`packages/ui-patterns` start as copies of allowlisted Supabase files (see
[§1.1](#11-provenance-of-copied-files)); `packages/icons` is **native** (a
`lucide-react` re-export plus a few glyphs written here; the fork's icon
packages are never copied), except the provider glyphs, which are copied
from Simple Icons (CC0-1.0) under
[ADR-0033](../01-architecture/adr/0033-provider-glyphs-from-simple-icons.md)
(**[DECIDED]** 2026-10-21, the owner's decision S11); `packages/ui-data` is written natively (the data
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
  (`packages/tokens`) production has its own fixed hue (262, indigo-blue since S9); `--hue` stays
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
- **[DECIDED]** (OD-11, amended by S9) Placeholder values: the accent hue is
  178, a turquoise accent chosen by the owner (S9, 2026-10-13; it replaced the
  indigo-blue 255 placeholder and is clearly not Supabase's green); the wordmark is the text "ExponetDB" set in
  the UI font, with no logo mark; the source's `--brand-*` scale is not kept
  (no `brand` token exists; copied `brand` classes become `primary` and
  `primary-200` to `primary-600`).
- **[DECIDED]** (OD-11) Fonts: Inter (UI) and Source Code Pro (mono), both
  SIL OFL 1.1, self-hosted from pinned `@fontsource/*` packages with their
  license files (the CSP needs `font-src 'self'` for them); Circular is never
  used.
- **[DECIDED]** 2026-10-13 by the owner ([S5](../00-product/open-decisions.md#owner-decisions-in-the-wave-8-session-2026-10-13)):
  the Web App carries a light ExponetDB character everywhere and must not
  look like a one-to-one copy of Supabase. The means are the token inputs
  and small, consistent choices of shape (radius), spacing, density and
  emphasis (how the primary color, the production tier and states stand
  out), applied through tokens and shared components, never per page. It
  stays within the OD-11 placeholder: no new brand, font or logo.

### 2.1 ExponetDB character (owner decision S5, 2026-10-13)

**[DECIDED]** Every choice below is a token input or a shared component class,
never a per-page override. The hue and fonts stay within OD-11 (no new brand,
font or logo). Source = Supabase Studio at `8b9af568`.

| Choice | Token (file) | Source | ExponetDB | Why |
|---|---|---|---|---|
| Radius scale | `--radius` input; `--radius-sm/md/lg/xl` derived in `theme.css` | Tailwind 3 / 6 / 8 / 12 px (Studio 5.3 / 8 px) | 3 / 5 / 10 / 14 px | Crisp controls, soft panels: cards, dialogs and alerts (`lg`) read as calm panels, controls stay tight. One input moves the whole scale. `--radius-panel` and `--radius-item` follow it. |
| Row density | `--row-padding-y` (0.625rem), `--table-head-height` (2.25rem); `TableCell`, `TableHead` | cells `p-4` (16 px), head 40 px | cell 10 px vertical, head 36 px | Data screens show more rows; forms keep the comfortable 26 to 42 px control heights. |
| Surface layering | light `--surface` 0.965, `--elevation-step` 0.02; dark `--surface` 0.18, `--elevation-step` 0.03 | 0.97 / 0.015; 0.19 / 0.025 | as listed | Cards separate from the page by tone, so the border can stay a hairline. |
| Neutral tint | `--chroma` light 0.012, dark 0.014 | 0.008 / 0.01 | as listed | The neutral ramp carries a trace of the accent hue. |
| Primary action | `--button-shadow-primary` (`utilities.css`); `Button` primary | raised edge only | inner top highlight, spot-tinted drop shadow and edge | The primary action is recognizable at a glance. |
| Focus ring | `--focus-ring-width` (3px); `focus-ring` utility | 2 px | 3 px, same opaque `--ring` color | Stronger keyboard focus; color and its 3:1 contrast unchanged. |
| Headings and labels | `--heading-weight` 600, `--heading-tracking` -0.015em (`base.css`); `--label-weight` 500, `--label-tracking` 0.02em (`eyebrow` utility) | monospace uppercase labels (card title, column header, metric, chart title) | quiet sans labels | Calmer; removes the most recognizable Supabase trait. Used by `CardTitle`, `TableHead`, metric card, chart title, collapsible card section, inner side menu. |

The production tier token and the `state-*` tokens are unchanged by S5 and stay
distinct and accessible (contrast sweep, 117 pairs, still green).

**[DECIDED]** 2026-10-13 by the owner (S9): the accent is a **turquoise accent
chosen by the owner** (`--hue` 178). The reserved `production` hue moves from
magenta 320 to **indigo-blue 262**, clear of the teal accent, destructive red
and warning amber; `info` moves from 215 to 205 so production stays at least
delta E 0.12 from it (the token test pins the new hues). `destructive`,
`warning` and `state-*` keep their hues and meaning.

## 3. Database-specific patterns

The owner brief lists the patterns the system must have; each is a documented
component with a demo page and states.

| Pattern | Package | Notes |
|---|---|---|
| Forms | ui-patterns | one layout component for label, description, error, help; field arrays; dirty-state guard on navigation with an in-app dialog (never `window.confirm`) |
| Dialogs and confirmation flows | ui-patterns | graduated: plain confirm (reversible), warning confirm with checklist, typed confirmation (target path or object name), plan confirm (shows plan hash, tier, class); confirm button disabled until the typed text matches; dismissal blocked while pending. **[OBSERVED]** (Wave 8, `packages/ui-patterns/src/confirmations/`): built on `AlertDialog`; the typed text matches exactly (case-sensitive, NFC on both sides, no trimming, an empty expected text never matches) and the expected text is shown with invisible and direction characters made visible; plan classes are the contract's `low`, `standard`, `high`, `critical`: `high` needs the typed target path, `critical` the path and the typed effect (order §8), an unknown class the path; a production tier (anything not exactly `nonprod`) frames the dialog with the reserved token and says "Production"; typed text and ticks reset when the expected text, plan hash or tier changes; one press runs the action once; `onConfirm` receives exactly the facts shown |
| Destructive-action UX | ui-patterns | destructive variant only for actions that destroy; least-destructive alternative offered in the same dialog (cancel before terminate) |
| Plan/apply UX | ui-data | plan review page blocks: summary, steps, analysis, evidence, policy decision, approvals, expiry; apply and verify as separate indicators. **[OBSERVED]** (2026-10-21, the owner's design of the plan page) `PlanChecklist` ("Before it can run": one row per check with a state of its own shape and words: passed, waiting, blocked, not known, could not be read, no verdict yet; `applyVerifyChecks` gives the apply and verification rows, never a passed row for an applied change) and `PlanDetailsList` (the technical details: a fact that does not apply to the plan's kind is left out, "not known" only where it applies) |
| Diff views | ui-data | text diff (CodeMirror merge view), structured diff for settings and grants (before/after table), schema diff by object with classification badges |
| Query and result views | ui-data | virtualized grid, column type rendering, truncation with on-demand full value, copy and export with caps, untrusted-content rendering (no HTML, escaped) |
| Performance visualizations | ui-patterns (charts) | time series with explicit gaps (cause shown), stacked breakdowns, top-N tables with sparklines |
| Migrations timeline | ui-data | per project: bundles as nodes in DAG order, columns per environment, applied/verified/drifted markers, evidence links |
| Server/node state | ui-patterns | node card (agent version, heartbeat age, capabilities, skew), cluster card (version, role, placements) |
| Badges and status | ui-patterns | tier chip, state badge (with source and age on hover), classification badges (destructive, rewrite, non-transactional, security) |
| Audit and event surfaces | ui-patterns | event row (actor with client, action, subject, outcome, time), chain verification indicator, links to plan/operation/ledger |
| Tables and data grids | ui + ui-data | simple table (ui) for small lists; data grid (ui-data) for large or interactive data |
| Command patterns | ui-patterns | command menu with registry from route metadata and capabilities; shortcut ids; `G` + key navigation; `E` + key environment switch. **[OBSERVED]** (Wave 8, `src/command-menu/`, `src/shortcuts/`): commands carry an app path (navigated through the seam) or an action and an `enabled` flag the app computes (the menu decides no permission); `Mod+K` opens it, `?` opens the shortcut help that lists the shortcuts active on the page; sequences start with `G` or `E` and time out after one second; a chord is `Mod` plus a letter or `Mod+Enter` (the SQL editor's run, Phase 11); letter shortcuts are ignored in text fields and open dialogs and can be switched off in the help dialog (WCAG 2.1.4); a binding used twice is an error at definition |
| Loading, empty, error states | ui-patterns | see [`information-architecture.md` §6](./information-architecture.md#6-states-every-page-must-render) |
| Whole-card links | ui-patterns | **[PLANNED]** (UI/UX order 2026-10-26, ADR-0035, proposed; `src/link-card/`): `LinkCard` is one `<a>` through the link seam for an entire card (hover lifts it by one pixel and strengthens its edge, a press settles it, focus rings the whole card, all still under `prefers-reduced-motion`; a tone bar on its leading edge is never the only signal). A card holds no other control; untrusted names inside it use `expandable={false}` (cut with an ellipsis, no "Show all" button inside a link). A card with more than one action is a `Card` with real buttons; a card without a destination is a plain card with no pointer. |
| Pages of a list read whole | ui-patterns | **[PLANNED]** (same, `src/pager/`): `Pager` is a named navigation landmark with the range as a polite live region and Previous/Next that stay in place when disabled; `pageSlice`, `clampPage` and `pageCount` are its tested arithmetic. Its `note` says when the pages divide one whole read rather than server pages. A list the server pages by cursor uses "Load more" instead. |

## 4. Rules

- **Truthful states first**: every data component has explicit props for
  `failed`, `stale` and `partial`; there is no way to render a failed read as
  empty (type-level: the data prop is a `Readable<T>` union, not `T[]`).
  **[DECIDED]** (2026-10-20) A value keeps its place when its banner comes or
  goes: `ReadableView` renders `ready`, `stale` and `partial` in one shape, so a
  read that turns old never mounts the content again and nothing typed,
  focused or pressed in it is lost (before, a minute-old object read rebuilt
  the row browser and swallowed a "Load more rows" press).
- **Untrusted content** (object names, comments, statement text, row values,
  client names) is rendered as text, never as HTML or Markdown, and long values
  are truncated with an explicit control to expand. **[OBSERVED]** (Wave 8,
  `packages/ui-patterns/src/untrusted/`, `confirmations/marked-code.tsx`) It is
  laid out left to right in logical order (`dir="ltr"` with
  `unicode-bidi: isolate-override`): invisible, control and bidirectional
  characters are shown by code point, and letters of a right-to-left script stay
  where they are stored, so they cannot carry digits or punctuation elsewhere (a
  real-Chromium test pins the order). Every surface that shows foreign text uses
  these patterns or the same rule.
- **Production cues** appear on every surface that can lead to a production
  change: chip in the header, frame on plan pages, path in typed confirmations.
  **[DECIDED]** (owner, 2026-10-21) Production is marked **once, clearly**, not
  on every block: on the plan review page and the operation page the one chip
  sits beside the title (`PageHeaderTitle productionCue`), the reserved
  `production` frame surrounds the review (`PlanFrame`), and one short sentence
  heads it ("This plan changes production.", or for a plan or operation without
  a tier, such as a server or node plan, "This plan has no target tier; it is
  treated as production."). No block inside the frame repeats a chip beside its
  heading (`PlanBlock` carries none, in the default border): a chip on every
  block made a production page a wall of equally loud blocks. The typed
  confirmations and the plan confirmation keep their own production frame and
  words unchanged; they are the safety-critical moment. The test for production
  still fails closed: a tier that is not exactly `nonprod` is production.
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

**[OBSERVED]** (Wave 8 completion, 2026-10-20, `apps/design-system/vite.config.ts`,
`src/content/markdown-export.ts`) Pages are MDX with GitHub-flavored tables
(`remark-gfm`, a build-time dependency only; nothing is parsed in the
browser). The build writes `llms.txt` and one Markdown file per page under
`md/<area>/<slug>.md`: `import` and `export` statements are dropped, a live
demo becomes a line naming it, links to other pages of the site
(`/ui/table#states`) point at the exported file next to it
(`../ui/table.md#states`), and fenced code blocks and inline code are copied
untouched (an `import` line or a demo inside a fence is an example).

## 6. Quality gates for UI work

- Visual regression snapshots for every pattern state (light and dark).
- Automated contrast checks over token combinations at the extremes of the
  theme inputs.
- Render tests: failed read never shows empty state; production chip present on
  production pages; typed confirmation requires the exact path.
- Bundle budgets: the editor and the grid only load on pages that use them.

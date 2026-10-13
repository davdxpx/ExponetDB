# @exponetdb/tokens

The design tokens of the Web App ([`design-system.md` §2](../../exponetdb-docs/11-ui/design-system.md#2-tokens)):
OKLCH inputs, the semantic colors derived from them for a light and a dark theme, chart slots, the
Tailwind v4 mapping, self-hosted fonts and the utility classes of the primitives. CSS only: no
components, no JavaScript.

```css
/* the app's stylesheet */
@import 'tailwindcss';
@import '@exponetdb/tokens/tokens.css';

@source '../../../packages/ui/src'; /* the app adds its own @source globs */
```

## Files

| File | Holds |
|---|---|
| `src/tokens.css` | The single entry. Imports the parts below in the one order that works. |
| `src/fonts.css` | `@font-face` rules for Inter (400, 500, 600) and Source Code Pro (400, 500), `.woff2` only, Latin and Latin Extended. |
| `src/inputs.css` | The theme inputs: `:root` (hue and fixed hues), the light theme, the dark theme and the OS-preference fallback. |
| `src/semantic.css` | The derivation of every semantic color from the inputs (`:root` and every `[data-theme]`). |
| `src/theme.css` | The Tailwind v4 `@theme inline` mapping (`--color-*` and friends), the font stacks, the `dark:` and Radix state variants. |
| `src/animations.css` | Named animations and easings; imports `tw-animate-css` for the enter and exit utilities of the primitives. |
| `src/utilities.css` | `@utility` classes: focus rings, control surfaces, loading line, shimmer, hit areas. |
| `src/base.css` | Minimal base layer: border color, body colors and font, font smoothing. |

Every part is also exported (`@exponetdb/tokens/theme.css` and so on), but apps import the entry.

## Inputs and supported ranges

Everything else derives from these in OKLCH. A value outside the range may still render, but only the
range is covered by the contrast test (`test/contrast.test.ts`, real Chromium, both themes, the extremes
of every input).

| Input | Scope | Meaning | Supported range | Light / dark default |
|---|---|---|---|---|
| `--hue` | `:root` | Spot color (primary, chart slot 1). | 0 to 360, any | 255 (indigo-blue placeholder, OD-11) |
| `--surface-hue` | `:root` | Tint of the neutral ramp. | 0 to 360, any | `var(--hue)` |
| `--chroma` | theme | Strength of the neutral tint. | 0 to 0.04 | 0.008 / 0.01 |
| `--surface` | theme | Lightness of the page background. | light 0.96 to 1, dark 0.14 to 0.22 | 0.97 / 0.19 |
| `--foreground-lightness` | theme | Lightness of the strongest text. | light 0 to 0.15, dark 0.92 to 1 | 0.1 / 0.95 |
| `--contrast` | theme | Contrast knob; 0.5 is the baseline. | 0 to 1 | 0.5 / 0.5 |
| `--elevation-step` | theme | Lightness step per surface level (0 is flat). | 0 to 0.04 | 0.015 / 0.025 |

The knob never lowers text below an accessible floor: at `--contrast: 0` the secondary text tiers sit at
their floor (`--muted-foreground-floor`, `--tertiary-foreground-floor`) and the control border keeps its
alpha floor. Below 0.5 only decorative tokens (hairline borders, hover overlays) get fainter.
Per-theme constants such as the fill lightness, the scale ramps and the chart lightness are inputs too
(`inputs.css`); retune them with the contrast test running.

## Theme mechanism

`data-theme` on `<html>` is the single mechanism. There is no `.dark` class and no theme library.

- `data-theme="light"` and `data-theme="dark"` select a theme; a nested element can carry its own
  `data-theme` (a preview pane) and derives its own colors, because `semantic.css` derives on every
  `[data-theme]`.
- With the attribute absent or set to `system`, `prefers-color-scheme` decides (`color-scheme` follows).
- The theme provider of the app writes the **resolved** scheme (`light` or `dark`) to `data-theme`. The
  `dark:` variant is `@custom-variant dark (&:where([data-theme*='dark'] *, [data-theme*='dark']))`, so it
  matches the attribute only. With the resolved value on `<html>`, a system dark scheme needs no media
  query in the variant. Without a provider the CSS variables still follow the OS, only `dark:` utilities
  stay on the light values.

## Swapping the spot color

Change inputs only. Set `--hue` (and `--surface-hue` if the neutral tint should differ) on `:root`
after the import; both themes follow, and so do `primary`, its scale (`primary-200` to `primary-600`) and
chart slot 1. The hues of `success`, `warning`, `destructive`, `info`, `production` and the operational
states are fixed on purpose: an error stays red whatever the product color. Keep `--hue` at least 45
degrees away from `--production-hue` (320), which is reserved (a test checks the hues of production,
destructive and warning).

## Semantic layers

- **Surfaces**: `background`, `card` (`surface-100`), `muted` (`surface-200`), `secondary` (`surface-300`),
  `tertiary` (`surface-400`), `popover`, `accent` (the neutral hover and selection surface).
- **Text**: `foreground`, `foreground-light` (= `muted-foreground`), `foreground-lighter` and
  `foreground-muted` (= `tertiary-foreground`). All tiers are body-text safe: at least 4.5:1 on the page and
  on every surface above. No text token is "large text only".
- **Borders**: `border`, `border-overlay`, `border-strong`, `border-stronger` are decorative hairlines and
  have no contrast requirement; never use them alone to mark a control. `border-control` (alias `input`)
  and `border-control-hover` are the control boundaries: at least 3:1 on the page and on every surface.
- **Fills with a foreground**: `primary`, `primary-solid`, `success`, `warning`, `destructive`, `info`,
  `production` and the five states. The `-foreground` is at least 4.5:1 on its fill, and the fill itself is at
  least 4.5:1 as text on the page and on `card`.
- **Production** (`production`, `production-foreground`, `production-muted`, `border-production`): reserved for
  the production tier chip, banners and confirmation frames. A saturated magenta, clear of the error red, the
  warning amber and the spot color. Never use it for anything else.
- **State**: `state-healthy`, `state-degraded`, `state-unhealthy`, `state-unknown`, `state-stale`, each with a
  `-foreground`. Color is never the only signal: pair a state with an icon and a label.
- **Scales** `primary-`, `success-`, `warning-`, `destructive-` `200` to `600` for tinted surfaces: 200 and 300
  backgrounds, 400 and 500 borders, 600 text (at least 4.5:1 on 200 and 300).
- **Charts**: `chart-1` to `chart-8` (at least 3:1 on the page), `chart-n-fill`, `chart-reference`,
  `chart-muted`, `chart-status-*`. Components read these; no hex value reaches a component.
- **Focus**: `ring` is opaque `primary-bright`, at least 3:1 on the page and on surfaces.

## Utilities

`focus-ring`, `focus-inset`, `control-surface-shadows` (defines `--button-shadow-*`), `raised-control-surface`,
`line-loading-bg(-light)`, `shimmer` (+ `-once`, `-reverse`, `-none`, `-color-*`, `-duration-*`, `-spread-*`,
`-angle-*`), `hit-area` (+ `-<n>`, `-x-`, `-y-`, `-l-`, `-r-`, `-t-`, `-b-`, `-debug`), `highlight-*`,
`subhighlight-*`, `text-code-inline` (for `<code>`), `bg` (legacy alias of `bg-default`). Variants: `dark`, `data-open`, `data-closed`,
`data-open-parent`, `data-closed-parent`. Animation tokens: `animate-fade-in`, `animate-overlay-show`,
`animate-accordion-down`, `animate-caret-blink` and so on, plus `animate-in`, `fade-in-*`, `zoom-in-*`,
`slide-in-from-*` from `tw-animate-css`.

## Not provided, on purpose

- The source's stepped brand scale and its utilities (`bg-brand-500`, `text-brand-600`, `--brand-*`): the
  product color is `primary`, the scale is `primary-200` to `primary-600`, and `bg-brand-default` becomes
  `bg-primary`.
- The Radix color scales (`gray-*`, `green-*`, `slate-*` and so on) and the code-block palette: components
  use semantic tokens. Tailwind's own palette utilities still exist but are not part of the system.
- Fonts other than Inter and Source Code Pro; the proprietary face of the source is never used.

## Fonts

Inter and Source Code Pro (SIL OFL 1.1) come from the pinned `@fontsource` packages. `fonts.css` declares
only the `.woff2` files of the weights in use (the server delivers no other font format), as relative
`url()` values into this package's `node_modules`; Tailwind rebases them onto the app stylesheet and Vite
bundles the files, so the page loads fonts from its own origin (the CSP needs `font-src 'self'`). The
OFL texts ship in the packages next to the font files.

## Provenance

`inputs.css`, `semantic.css`, `theme.css`, `animations.css`, `utilities.css` and `base.css` start as copies of
allowlisted Supabase CSS at commit `8b9af568` and are ExponetDB code since
([ADR-0030](../../exponetdb-docs/01-architecture/adr/0030-supabase-ui-source-adoption.md)). Each starts with the
provenance header and has a row in [`third-party-register.md`](../../exponetdb-docs/11-ui/third-party-register.md).
`fonts.css`, `tokens.css` and this file are native.

## Tests

`cd packages/tokens && npx vitest run`

- `test/tokens.test.ts`: static checks (inputs, no leftovers, headers, token coverage, fonts, manifest) and
  the check that every variable the primitives of `packages/ui` read is declared here.
- `test/contrast.test.ts`: WCAG 2.x contrast of the pairs above in real Chromium (`playwright-core`) over
  both themes, six hues, both chroma extremes, three contrast settings, both elevation extremes and the
  surface and foreground-lightness extremes; prints the minimum ratio per pair.
- `test/theme.test.ts`: the theme mechanism, nested scopes, the reserved production color and the states.
- `test/tailwind.test.ts`: the Tailwind v4 compile of the entry, the utilities of the primitives, and a Vite
  build that bundles the `.woff2` files.

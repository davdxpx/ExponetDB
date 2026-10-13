import type { Browser } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launch, measurePairs, openTokenPage } from './support/browser.ts'
import { compileTokens } from './support/css.ts'
import {
  buildCombos,
  describeCombo,
  type Requirement,
  requirements,
  supportedRange,
} from './support/pairs.ts'
import { contrastRatio } from './support/wcag.ts'

/**
 * Automated WCAG 2.x contrast checks in real Chromium (design-system.md section 6). Each token is
 * resolved to sRGB through a 1x1 canvas after the browser has derived it from the inputs, so
 * oklch(), relative colors and alpha compositing are the browser's own. The sweep covers both
 * themes at the extremes of every supported input (README, "Supported ranges").
 *
 * Text pairs need 4.5:1. Non-text pairs (control borders, focus ring, selected chrome, chart
 * marks) need 3:1. No token is exempt as "large text only": every text tier is body-text safe.
 * Decorative tokens (hairline borders, hover overlays) have no requirement.
 */
interface Worst {
  readonly ratio: number
  readonly combo: string
}

const worst = new Map<string, Worst>()
const resolveErrors = new Set<string>()
let combosMeasured = 0
let browser: Browser | undefined

beforeAll(async () => {
  const css = await compileTokens([])
  browser = await launch()
  const page = await openTokenPage(browser, css)
  const combos = buildCombos()
  combosMeasured = combos.length
  const byId = new Map(requirements.map((r) => [r.id, r] as const))
  for (const result of await measurePairs(page, combos, requirements)) {
    for (const error of result.errors) resolveErrors.add(`${describeCombo(result.combo)}: ${error}`)
    for (const pair of result.pairs) {
      const ratio = contrastRatio(pair.fg, pair.bg)
      const current = worst.get(pair.id)
      if (byId.has(pair.id) && (current === undefined || ratio < current.ratio)) {
        worst.set(pair.id, { ratio, combo: describeCombo(result.combo) })
      }
    }
  }
}, 240_000)

afterAll(async () => {
  await browser?.close()
  const rows = [...worst.entries()]
    .map(([id, w]) => ({ id, ...w, min: requirements.find((r) => r.id === id)?.min ?? 0 }))
    .sort((a, b) => a.ratio - b.ratio)
  const lines = rows.map(
    (r) => `${r.ratio.toFixed(2).padStart(6)} (min ${r.min})  ${r.id}  @ ${r.combo}`,
  )
  console.log(
    `\nContrast: minimum ratio per pair over ${combosMeasured} input combinations\n${lines.join('\n')}\n`,
  )
})

describe('sweep', () => {
  it('covers both themes at the extremes of hue, chroma, contrast and elevation step', () => {
    const combos = buildCombos()
    expect(combos.length).toBeGreaterThanOrEqual(300)
    for (const theme of ['light', 'dark']) {
      const own = combos.filter((c) => c.theme === theme)
      for (const [input, values] of [
        ['--hue', supportedRange.hue],
        ['--chroma', supportedRange.chroma],
        ['--contrast', supportedRange.contrast],
        ['--elevation-step', supportedRange.elevationStep],
      ] as const) {
        for (const value of values) {
          expect(
            own.some((c) => c.inputs[input] === value),
            `${theme} ${input}=${value}`,
          ).toBe(true)
        }
      }
      for (const value of supportedRange.surface[theme as 'light' | 'dark']) {
        expect(own.some((c) => c.inputs['--surface'] === value)).toBe(true)
      }
      for (const value of supportedRange.foregroundLightness[theme as 'light' | 'dark']) {
        expect(own.some((c) => c.inputs['--foreground-lightness'] === value)).toBe(true)
      }
    }
  })

  it('resolves every token to a color in every combination', () => {
    expect([...resolveErrors]).toEqual([])
    expect(worst.size).toBe(requirements.length)
  })

  it('tests the pairs the design system names', () => {
    const ids = requirements.map((r) => r.id)
    for (const needed of [
      'foreground on background',
      'foreground on card (surface-100)',
      'foreground on muted (surface-200)',
      'foreground on secondary (surface-300)',
      'foreground-light on background',
      'primary-foreground on primary',
      'destructive-foreground on destructive',
      'warning-foreground on warning',
      'production-foreground on production',
      'info-foreground on info',
      'border-control on background',
      ...['healthy', 'degraded', 'unhealthy', 'unknown', 'stale'].map(
        (s) => `state-${s}-foreground on state-${s}`,
      ),
    ]) {
      expect(ids, needed).toContain(needed)
    }
  })
})

describe('text pairs: at least 4.5:1', () => {
  const text = requirements.filter((r) => r.kind === 'text')
  it.each(text)('$id', (pair: Requirement) => {
    const w = worst.get(pair.id)
    expect(w, `no measurement for ${pair.id}`).toBeDefined()
    expect(w?.ratio, `${pair.id} at ${w?.combo}`).toBeGreaterThanOrEqual(pair.min)
  })
})

describe('non-text pairs: at least 3:1', () => {
  const nonText = requirements.filter((r) => r.kind === 'non-text')
  it.each(nonText)('$id', (pair: Requirement) => {
    const w = worst.get(pair.id)
    expect(w, `no measurement for ${pair.id}`).toBeDefined()
    expect(w?.ratio, `${pair.id} at ${w?.combo}`).toBeGreaterThanOrEqual(pair.min)
  })
})

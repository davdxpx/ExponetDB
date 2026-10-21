import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, render } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, describe, expect, it } from 'vitest'
import { BRAND_GLYPHS, BrandGlyph, type BrandId } from '../src/index.ts'

afterEach(cleanup)

const BRANDS = Object.keys(BRAND_GLYPHS) as BrandId[]

// ---------------------------------------------------------------------------
// The page background of both themes, from the token inputs (packages/tokens)
// ---------------------------------------------------------------------------

// A path, not `new URL(…, import.meta.url)`: Vite rewrites that form with a template literal.
const TOKENS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tokens', 'src')
const tokens = (file: 'inputs.css' | 'semantic.css') => readFileSync(join(TOKENS, file), 'utf8')

/** The body of the first CSS block whose selector text is exactly `selector`. */
function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start === -1) throw new Error(`no block ${selector}`)
  const open = css.indexOf('{', start)
  return css.slice(open + 1, css.indexOf('}', open))
}

function input(body: string, name: string): number {
  const m = new RegExp(`${name}:\\s*([0-9.]+)\\s*;`).exec(body)
  if (m?.[1] === undefined) throw new Error(`no ${name}`)
  return Number(m[1])
}

/** OKLCH to linear sRGB, clamped to the gamut (Björn Ottosson's OKLab matrices). */
function oklchToLinear(l: number, c: number, hue: number): [number, number, number] {
  const h = (hue * Math.PI) / 180
  const a = c * Math.cos(h)
  const b = c * Math.sin(h)
  const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  const clamp = (v: number) => Math.min(1, Math.max(0, v))
  return [
    clamp(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3),
    clamp(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3),
    clamp(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3),
  ]
}

const encode = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)
const decode = (byte: number) => {
  const v = byte / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}
/** WCAG 2.x relative luminance of 8-bit sRGB channels. */
const luminance = (rgb: readonly number[]) =>
  0.2126 * decode(rgb[0] ?? 0) + 0.7152 * decode(rgb[1] ?? 0) + 0.0722 * decode(rgb[2] ?? 0)
const ratio = (x: number, y: number) => (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
const hexChannels = (hex: string) => [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))

/** `--background` of a theme as the browser paints it (8-bit sRGB). */
function background(theme: 'light' | 'dark'): number {
  const inputs = tokens('inputs.css')
  const hue = input(block(inputs, ':root'), '--hue')
  const body = block(
    inputs,
    theme === 'light' ? ':root,\n[data-theme="light"]' : '[data-theme="dark"]',
  )
  const rgb = oklchToLinear(input(body, '--surface'), input(body, '--chroma') * 0.5, hue).map((v) =>
    Math.round(encode(v) * 255),
  )
  return luminance(rgb)
}

describe('the provider glyphs', () => {
  it('derive the page background the way this test computes it', () => {
    // If the token derivation changes, the background below changes with it: update both.
    expect(tokens('semantic.css')).toContain(
      '--background: oklch(var(--surface) calc(var(--chroma) * 0.5) var(--surface-hue));',
    )
    expect(tokens('inputs.css')).toContain('--surface-hue: var(--hue);')
  })

  it('draw a brand in its color only where it reaches 3:1 on both themes', () => {
    const light = background('light')
    const dark = background('dark')
    expect(light).toBeGreaterThan(0.8)
    expect(dark).toBeLessThan(0.02)
    for (const brand of BRANDS) {
      const glyph = BRAND_GLYPHS[brand]
      const y = luminance(hexChannels(glyph.hex))
      const readable = ratio(y, light) >= 3 && ratio(y, dark) >= 3
      expect(glyph.mono, `${brand} #${glyph.hex}`).toBe(!readable)
    }
  })

  it('hold a title, a six-digit color and path data for every brand', () => {
    expect(BRANDS.length).toBeGreaterThanOrEqual(13)
    for (const brand of BRANDS) {
      const glyph = BRAND_GLYPHS[brand]
      expect(brand).toMatch(/^[a-z0-9]+$/)
      expect(glyph.title.length, brand).toBeGreaterThan(0)
      expect(glyph.hex, brand).toMatch(/^[0-9A-F]{6}$/)
      expect(glyph.path, brand).toMatch(/^M[0-9MmZzLlHhVvCcSsQqTtAa.,\s-]+$/)
    }
  })
})

describe('BrandGlyph', () => {
  it('is decorative by default: hidden from assistive technology, never focusable', () => {
    const { container } = render(<BrandGlyph brand="hetzner" />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
    expect(svg?.getAttribute('aria-label')).toBeNull()
    expect(svg?.getAttribute('focusable')).toBe('false')
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(svg?.getAttribute('width')).toBe('16')
    expect(svg?.querySelector('path')?.getAttribute('d')).toBe(BRAND_GLYPHS.hetzner.path)
  })

  it('carries a name when it stands alone', () => {
    const { container } = render(<BrandGlyph brand="googlecloud" label="Google Cloud" size={20} />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('role')).toBe('img')
    expect(svg?.getAttribute('aria-label')).toBe('Google Cloud')
    expect(svg?.getAttribute('aria-hidden')).toBeNull()
    expect(svg?.getAttribute('height')).toBe('20')
  })

  it('fills with the brand color, or with the text color for a mono brand', () => {
    for (const brand of BRANDS) {
      const { container, unmount } = render(<BrandGlyph brand={brand} />)
      const glyph = BRAND_GLYPHS[brand]
      expect(container.querySelector('svg')?.getAttribute('fill'), brand).toBe(
        glyph.mono ? 'currentColor' : `#${glyph.hex}`,
      )
      unmount()
    }
    expect(BRAND_GLYPHS.hetzner.mono).toBe(false)
    expect(BRAND_GLYPHS.ovh.mono).toBe(true)
  })

  it('passes axe, decorative next to a name and labelled on its own', async () => {
    const { container } = render(
      <ul>
        <li>
          <BrandGlyph brand="hetzner" /> Hetzner Cloud
        </li>
        <li>
          <BrandGlyph brand="scaleway" label="Scaleway" />
        </li>
      </ul>,
    )
    const result = await axe.run(container, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      rules: { 'color-contrast': { enabled: false } },
    })
    expect(result.violations.map((v) => v.id)).toEqual([])
  })
})

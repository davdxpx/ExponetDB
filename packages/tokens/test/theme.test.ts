import type { Browser, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launch, openTokenPage, readTokens } from './support/browser.ts'
import { compileTokens, readPart } from './support/css.ts'
import { referencedVariables } from './support/css-parse.ts'
import { deltaEOk, hueDistance, luminance, oklchHue, type Rgb } from './support/wcag.ts'

/**
 * The theme mechanism in real Chromium: data-theme on html is the only switch, the OS preference
 * applies while it is absent or "system", a nested scope derives its own colors, a class does
 * nothing, and the reserved production color stays clear of the other expressive colors.
 */
let browser: Browser
let page: Page

const darkProbe = 'dark:bg-production'

beforeAll(async () => {
  const css = await compileTokens([darkProbe])
  browser = await launch()
  page = await openTokenPage(browser, css)
}, 120_000)

afterAll(async () => {
  await browser.close()
})

async function setup(attrs: {
  dataTheme?: string
  className?: string
  scheme: 'light' | 'dark'
}): Promise<void> {
  await page.emulateMedia({ colorScheme: attrs.scheme })
  await page.evaluate((a) => {
    const root = document.documentElement
    root.removeAttribute('style')
    root.removeAttribute('class')
    root.removeAttribute('data-theme')
    if (a.dataTheme !== undefined) root.setAttribute('data-theme', a.dataTheme)
    if (a.className !== undefined) root.setAttribute('class', a.className)
  }, attrs)
}

async function isDark(): Promise<boolean> {
  const colors = await readTokens(page, ['background'])
  return luminance(colors['background'] as Rgb) < 0.2
}

describe('theme selection', () => {
  it('follows data-theme="light" and data-theme="dark" regardless of the OS', async () => {
    await setup({ dataTheme: 'light', scheme: 'dark' })
    expect(await isDark()).toBe(false)
    await setup({ dataTheme: 'dark', scheme: 'light' })
    expect(await isDark()).toBe(true)
  })

  it('follows the OS preference while data-theme is absent', async () => {
    await setup({ scheme: 'dark' })
    expect(await isDark()).toBe(true)
    await setup({ scheme: 'light' })
    expect(await isDark()).toBe(false)
  })

  it('follows the OS preference for data-theme="system"', async () => {
    await setup({ dataTheme: 'system', scheme: 'dark' })
    expect(await isDark()).toBe(true)
    await setup({ dataTheme: 'system', scheme: 'light' })
    expect(await isDark()).toBe(false)
  })

  it('ignores a .dark class entirely', async () => {
    await setup({ className: 'dark', scheme: 'light' })
    expect(await isDark()).toBe(false)
    await setup({ className: 'dark', dataTheme: 'light', scheme: 'dark' })
    expect(await isDark()).toBe(false)
  })

  it('sets the browser color scheme with the theme', async () => {
    for (const [dataTheme, scheme, expected] of [
      ['light', 'dark', 'light'],
      ['dark', 'light', 'dark'],
      ['system', 'dark', 'dark'],
    ] as const) {
      await setup({ dataTheme, scheme })
      const value = await page.evaluate(
        () => getComputedStyle(document.documentElement).colorScheme,
      )
      expect(value, `${dataTheme} with an OS ${scheme}`).toBe(expected)
    }
  })

  it('gives a nested data-theme scope its own derived colors', async () => {
    await setup({ dataTheme: 'light', scheme: 'light' })
    await page.evaluate(() => {
      const scope = document.createElement('div')
      scope.id = 'scope'
      scope.setAttribute('data-theme', 'dark')
      document.body.appendChild(scope)
    })
    const outer = await readTokens(page, ['background', 'foreground'])
    const inner = await readTokens(page, ['background', 'foreground'], '#scope')
    expect(luminance(outer['background'] as Rgb)).toBeGreaterThan(0.8)
    expect(luminance(inner['background'] as Rgb)).toBeLessThan(0.1)
    expect(luminance(inner['foreground'] as Rgb)).toBeGreaterThan(0.6)
    await page.evaluate(() => document.getElementById('scope')?.remove())
  })

  it('applies the dark: variant for the resolved scheme in data-theme only', async () => {
    const probe = async (): Promise<string> =>
      page.evaluate((cls) => {
        const el = document.createElement('div')
        el.className = cls
        document.body.appendChild(el)
        const value = getComputedStyle(el).backgroundColor
        el.remove()
        return value
      }, darkProbe)
    await setup({ dataTheme: 'light', scheme: 'light' })
    const off = await probe()
    expect(off).toBe('rgba(0, 0, 0, 0)')
    await setup({ dataTheme: 'dark', scheme: 'light' })
    expect(await probe()).not.toBe(off)
    // The app writes the resolved scheme, so a system dark scheme arrives as data-theme="dark".
    await setup({ dataTheme: 'light', scheme: 'dark' })
    expect(await probe()).toBe(off)
    await setup({ className: 'dark', scheme: 'dark' })
    expect(await probe()).toBe(off)
  })
})

describe('variables resolve in every theme', () => {
  const read = referencedVariables(readPart('theme'))
  const external = new Set(['--radius-md'])
  const names = [...read].filter((n) => !external.has(n))

  for (const [label, attrs] of [
    ['light', { dataTheme: 'light', scheme: 'light' }],
    ['dark', { dataTheme: 'dark', scheme: 'light' }],
    ['system dark', { dataTheme: 'system', scheme: 'dark' }],
    ['no attribute, OS dark', { scheme: 'dark' }],
  ] as const) {
    it(`gives every variable of theme.css a value (${label})`, async () => {
      await setup(attrs)
      const empty = await page.evaluate((all) => {
        const style = getComputedStyle(document.documentElement)
        return all.filter((n) => style.getPropertyValue(n).trim() === '')
      }, names)
      expect(empty).toEqual([])
    })
  }

  it('resolves every color token inside a color property', async () => {
    const colorNames = names
      .filter((n) => !/^--(card-padding-x|colors-(black|white))$/.test(n))
      .map((n) => n.slice(2))
    for (const theme of ['light', 'dark']) {
      await setup({ dataTheme: theme, scheme: 'light' })
      await readTokens(page, colorNames)
    }
  })
})

describe('the reserved production color', () => {
  const tokens = ['production', 'destructive', 'warning', 'primary', 'info', 'success']

  for (const theme of ['light', 'dark'] as const) {
    it(`is clearly distinct from error, warning and the spot color (${theme})`, async () => {
      await setup({ dataTheme: theme, scheme: 'light' })
      const c = await readTokens(page, tokens)
      const production = c['production'] as Rgb
      for (const other of ['destructive', 'warning', 'primary', 'info', 'success']) {
        const rgb = c[other] as Rgb
        expect(
          hueDistance(oklchHue(production), oklchHue(rgb)),
          `hue of production vs ${other}`,
        ).toBeGreaterThanOrEqual(35)
        expect(
          deltaEOk(production, rgb),
          `delta E of production vs ${other}`,
        ).toBeGreaterThanOrEqual(0.12)
      }
    })

    it(`does not move with the spot color hue (${theme})`, async () => {
      await setup({ dataTheme: theme, scheme: 'light' })
      const before = await readTokens(page, [
        'production',
        'destructive',
        'warning',
        'primary',
        'chart-1',
      ])
      await page.evaluate(() => document.documentElement.style.setProperty('--hue', '30'))
      const after = await readTokens(page, [
        'production',
        'destructive',
        'warning',
        'primary',
        'chart-1',
      ])
      expect(after['production']).toEqual(before['production'])
      expect(after['destructive']).toEqual(before['destructive'])
      expect(after['warning']).toEqual(before['warning'])
      expect(after['primary']).not.toEqual(before['primary'])
      expect(after['chart-1']).not.toEqual(before['chart-1'])
    })
  }

  it('stays off the error color for every spot color hue', async () => {
    for (const theme of ['light', 'dark'] as const) {
      for (const hue of [0, 25, 60, 120, 180, 255, 300, 340]) {
        await setup({ dataTheme: theme, scheme: 'light' })
        await page.evaluate(
          (h) => document.documentElement.style.setProperty('--hue', String(h)),
          hue,
        )
        const c = await readTokens(page, ['production', 'destructive'])
        expect(
          deltaEOk(c['production'] as Rgb, c['destructive'] as Rgb),
          `${theme} hue ${hue}`,
        ).toBeGreaterThanOrEqual(0.12)
      }
    }
  })
})

describe('operational state colors', () => {
  const states = ['healthy', 'degraded', 'unhealthy', 'unknown', 'stale'].map((s) => `state-${s}`)

  for (const theme of ['light', 'dark'] as const) {
    it(`keeps the five states apart from each other (${theme})`, async () => {
      await setup({ dataTheme: theme, scheme: 'light' })
      const c = await readTokens(page, states)
      for (let i = 0; i < states.length; i += 1) {
        for (let j = i + 1; j < states.length; j += 1) {
          const a = states[i] as string
          const b = states[j] as string
          expect(deltaEOk(c[a] as Rgb, c[b] as Rgb), `${a} vs ${b}`).toBeGreaterThanOrEqual(0.04)
        }
      }
    })

    it(`reads healthy as green, degraded as amber and unhealthy as red (${theme})`, async () => {
      await setup({ dataTheme: theme, scheme: 'light' })
      const c = await readTokens(page, states)
      expect(hueDistance(oklchHue(c['state-healthy'] as Rgb), 150)).toBeLessThan(20)
      expect(hueDistance(oklchHue(c['state-degraded'] as Rgb), 70)).toBeLessThan(20)
      expect(hueDistance(oklchHue(c['state-unhealthy'] as Rgb), 25)).toBeLessThan(20)
    })
  }
})

import { type Browser, chromium, type Page } from 'playwright-core'
import type { Rgb } from './wcag.ts'

export type Theme = 'light' | 'dark'

/** One setting of the theme inputs. Unset inputs keep the value of their theme. */
export interface Combo {
  readonly theme: Theme
  readonly inputs: Readonly<Record<string, string>>
}

/** A foreground and a background token. A translucent token composites over its backdrop. */
export interface PairSpec {
  readonly id: string
  readonly fg: string
  readonly bg: string
  /** Token a translucent background composites over; the page background when omitted. */
  readonly over?: string
}

export interface PairColors {
  readonly id: string
  readonly fg: Rgb
  readonly bg: Rgb
}

export async function launch(): Promise<Browser> {
  return chromium.launch()
}

/** A page with the given stylesheet and a probe element inside <body>. */
export async function openTokenPage(browser: Browser, css: string): Promise<Page> {
  const page = await browser.newPage()
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>` +
      '<body style="color: rgb(1, 2, 3)"><span id="probe">x</span></body></html>',
  )
  return page
}

interface InPageArgs {
  readonly combos: readonly Combo[]
  readonly pairs: readonly PairSpec[]
}

interface InPageResult {
  readonly combo: Combo
  readonly pairs: readonly PairColors[]
  readonly errors: readonly string[]
}

/**
 * Sets each combo on <html>, resolves the tokens of every pair to sRGB through a 1x1 canvas
 * (handles oklch() and color(srgb ...) computed values; a translucent color composites over its
 * backdrop on the canvas, as the browser composites it) and returns the colors.
 */
export async function measurePairs(
  page: Page,
  combos: readonly Combo[],
  pairs: readonly PairSpec[],
): Promise<InPageResult[]> {
  return page.evaluate(
    (args: InPageArgs): InPageResult[] => {
      const root = document.documentElement
      const probe = document.getElementById('probe') as HTMLElement
      const canvas = document.createElement('canvas')
      canvas.width = 1
      canvas.height = 1
      const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D

      function computed(token: string, errors: string[]): string {
        probe.style.color = `var(--${token})`
        const value = getComputedStyle(probe).color
        if (value === 'rgb(1, 2, 3)') {
          errors.push(`--${token} is invalid or empty`)
        }
        return value
      }

      function parseCanvas(value: string, errors: string[]): void {
        ctx.fillStyle = '#010203'
        ctx.fillStyle = value
        const first = ctx.fillStyle
        ctx.fillStyle = '#040506'
        ctx.fillStyle = value
        const second = ctx.fillStyle
        if (first !== second) {
          errors.push(`the canvas cannot parse ${value}`)
        }
      }

      function resolve(token: string, over: readonly [number, number, number], errors: string[]) {
        const value = computed(token, errors)
        parseCanvas(value, errors)
        ctx.clearRect(0, 0, 1, 1)
        ctx.fillStyle = `rgb(${over[0]}, ${over[1]}, ${over[2]})`
        ctx.fillRect(0, 0, 1, 1)
        ctx.fillStyle = value
        ctx.fillRect(0, 0, 1, 1)
        const d = ctx.getImageData(0, 0, 1, 1).data
        return [d[0] as number, d[1] as number, d[2] as number] as const
      }

      const out: InPageResult[] = []
      for (const combo of args.combos) {
        root.setAttribute('data-theme', combo.theme)
        root.removeAttribute('style')
        for (const [name, value] of Object.entries(combo.inputs)) {
          root.style.setProperty(name, value)
        }
        const errors: string[] = []
        const page = resolve('background', [255, 255, 255], errors)
        const cache = new Map<string, readonly [number, number, number]>()
        const opaque = (token: string, over: readonly [number, number, number]) => {
          const key = `${token}|${over.join(',')}`
          let hit = cache.get(key)
          if (hit === undefined) {
            hit = resolve(token, over, errors)
            cache.set(key, hit)
          }
          return hit
        }
        const pairs: PairColors[] = []
        for (const p of args.pairs) {
          const backdrop = p.over === undefined ? page : opaque(p.over, page)
          const bg = opaque(p.bg, backdrop)
          const fg = opaque(p.fg, bg)
          pairs.push({ id: p.id, fg, bg })
        }
        out.push({ combo, pairs, errors: Array.from(new Set(errors)) })
      }
      return out
    },
    { combos, pairs },
  )
}

/**
 * Reads tokens as they resolve right now inside `scope` (a CSS selector of an element that is
 * already in the page), without changing any attribute. Translucent tokens composite over white.
 */
export async function readTokens(
  page: Page,
  tokens: readonly string[],
  scope = 'html',
): Promise<Record<string, Rgb>> {
  return page.evaluate(
    (args: { tokens: readonly string[]; scope: string }): Record<string, Rgb> => {
      const host = document.querySelector(args.scope) as Element
      const probe = document.createElement('span')
      probe.style.color = 'rgb(1, 2, 3)'
      host.appendChild(probe)
      const canvas = document.createElement('canvas')
      canvas.width = 1
      canvas.height = 1
      const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D
      const out: Record<string, Rgb> = {}
      for (const token of args.tokens) {
        probe.style.color = 'rgb(1, 2, 3)'
        probe.style.color = `var(--${token})`
        const value = getComputedStyle(probe).color
        if (value === 'rgb(1, 2, 3)') {
          throw new Error(`--${token} does not resolve inside ${args.scope}`)
        }
        ctx.clearRect(0, 0, 1, 1)
        ctx.fillStyle = 'rgb(255, 255, 255)'
        ctx.fillRect(0, 0, 1, 1)
        ctx.fillStyle = value
        ctx.fillRect(0, 0, 1, 1)
        const d = ctx.getImageData(0, 0, 1, 1).data
        out[token] = [d[0] as number, d[1] as number, d[2] as number]
      }
      probe.remove()
      return out
    },
    { tokens, scope },
  )
}

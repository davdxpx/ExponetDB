import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { fixedClock } from '@exponetdb/kernel'
import { MetricsRegistry, silentLogger } from '@exponetdb/observability'
import { serve } from '@hono/node-server'
import { type Browser, chromium, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadWebAssets } from '../src/composition/access.ts'
import { createPublicApp, httpMetrics } from '../src/interfaces/http/app.ts'
import { WEB_CSP } from '../src/interfaces/http/web.ts'

/**
 * The CSP surface (Wave 8, order Phase 1; G8 criterion 7): every UI
 * primitive and data component that could inject styles or evaluate code,
 * rendered in its interactive states (overlays open, viewports scrolled,
 * toasts shown, editors typing) by the built design-system app's
 * `/csp-surface` page, served through the real `mountWeb` with the real
 * headers. Any CSP violation fails, with the case and the directive.
 * Never skipped: without the built design-system app it fails.
 */
const DIST = fileURLToPath(new URL('../../design-system/dist/', import.meta.url))

let browser: Browser
let origin = ''
let close: () => void = () => undefined

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const chosen = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(chosen))
    })
  })
}

/**
 * The browser members the evaluated functions use. The server's TypeScript
 * program has no DOM library, so they are named here; the functions run in
 * the page (serialized, so they reach these only through `globalThis`).
 */
interface PageRect {
  readonly left: number
  readonly top: number
  readonly width: number
}
interface PageNode {
  readonly parentElement: { closest(selector: string): unknown } | null
  readonly textContent: string | null
}
interface PageElement {
  readonly children: Iterable<PageElement>
  readonly shadowRoot: { readonly children: Iterable<PageElement> } | null
  readonly textContent: string | null
  getAttribute(name: string): string | null
}
interface PageDocument {
  readonly body: PageElement
  querySelectorAll(selector: string): Iterable<PageElement>
  createTreeWalker(root: PageElement, whatToShow: number): { nextNode(): PageNode | null }
  createRange(): {
    setStart(node: PageNode, offset: number): void
    setEnd(node: PageNode, offset: number): void
    getBoundingClientRect(): PageRect
  }
  addEventListener(
    type: 'securitypolicyviolation',
    listener: (event: { violatedDirective: string; blockedURI: string; sample: string }) => void,
  ): void
}
interface PageGlobals {
  readonly document: PageDocument
  readonly __cspViolations: string[]
}

/** Collects every `securitypolicyviolation` event and every CSP console message of a page. */
async function watch(page: Page): Promise<string[]> {
  const seen: string[] = []
  await page.addInitScript(() => {
    const store: string[] = []
    Object.defineProperty(globalThis, '__cspViolations', { value: store })
    ;(globalThis as unknown as PageGlobals).document.addEventListener(
      'securitypolicyviolation',
      (event) => {
        store.push(`${event.violatedDirective} ${event.blockedURI} ${event.sample}`)
      },
    )
  })
  page.on('console', (message) => {
    if (/Content.Security.Policy|Refused to/i.test(message.text())) {
      seen.push(message.text())
    }
  })
  page.on('pageerror', (error) => seen.push(`page error: ${error.message}`))
  return seen
}

beforeAll(async () => {
  const web = await loadWebAssets([DIST])
  if (web === undefined) {
    throw new Error(
      'the design-system app is not built: run `bun run --cwd apps/design-system build` first',
    )
  }
  const app = createPublicApp(
    {
      readiness: () => ({ status: 'ready', evaluatedAt: '2026-10-13T12:00:00.000Z', checks: [] }),
      version: '0.0.0-test',
      logger: silentLogger,
      metrics: httpMetrics(new MetricsRegistry()),
      clock: fixedClock(Date.parse('2026-10-13T12:00:00Z')),
    },
    { web },
  )
  const port = await freePort()
  origin = `http://localhost:${port}`
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port })
  close = () => server.close()
  browser = await chromium.launch({ headless: true })
})

afterAll(async () => {
  await browser?.close()
  close()
})

describe('the CSP surface in Chromium', () => {
  it('is served with the production policy', async () => {
    const res = await fetch(`${origin}/csp-surface`)
    expect(res.headers.get('content-security-policy')).toBe(WEB_CSP)
  })

  it('renders every case in its interactive state without a single CSP violation', async () => {
    const page = await browser.newPage()
    const logged = await watch(page)
    await page.goto(`${origin}/csp-surface`)
    const cases = await page.$$eval('[data-csp-case]', (links) =>
      links.map((l) => l.getAttribute('data-csp-case') ?? ''),
    )
    expect(cases.length, 'the surface lists its cases').toBeGreaterThan(10)
    const failures: string[] = []
    for (const name of cases) {
      const casePage = await browser.newPage()
      const caseConsole = await watch(casePage)
      await casePage.goto(`${origin}/csp-surface?case=${encodeURIComponent(name)}`)
      await casePage.waitForSelector('[data-csp-ready="true"]', { timeout: 15_000 })
      // Let effects, portals, animations and lazy chunks settle.
      await casePage.waitForTimeout(400)
      const events = await casePage.evaluate(
        () => (globalThis as unknown as PageGlobals).__cspViolations,
      )
      for (const v of [...events, ...caseConsole]) failures.push(`${name}: ${v}`)
      await casePage.close()
    }
    await page.close()
    expect([...logged, ...failures]).toEqual([])
  })

  it.each(['untrusted-bidi', 'data-grid', 'sql-editor', 'text-diff', 'plan-frame'])(
    'lays out untrusted text in logical order in %s, whatever right-to-left letters it holds',
    async (name) => {
      const page = await browser.newPage()
      await page.goto(`${origin}/csp-surface?case=${name}`)
      await page.waitForSelector('[data-csp-ready="true"]', { timeout: 15_000 })
      await page.waitForTimeout(300)
      // Every element (shadow roots included) holding the whole hostile line, innermost first;
      // in each, every visible character in stored order must sit right of the one before it on
      // its line: right-to-left letters may not carry digits or punctuation elsewhere (F1).
      const report = await page.evaluate(() => {
        const { document } = globalThis as unknown as PageGlobals
        const SHOW_TEXT = 4
        const holds = (text: string | null): boolean =>
          ['\u{5D0}', '+ 99', '\u{5D1}'].every((part) => text?.includes(part) === true)
        // Every element of the page and of every shadow root (a host's own textContent leaves out
        // its shadow tree, so the editors are reached through the collection, not the text).
        const all: PageElement[] = []
        const collect = (element: PageElement): void => {
          all.push(element)
          for (const child of element.children) collect(child)
          for (const child of element.shadowRoot?.children ?? []) collect(child)
        }
        collect(document.body)
        const roots = all.filter(
          (element) =>
            holds(element.textContent) && ![...element.children].some((c) => holds(c.textContent)),
        )
        const out: string[] = []
        for (const root of roots) {
          const chars: { ch: string; x: number; y: number }[] = []
          const walker = document.createTreeWalker(root, SHOW_TEXT)
          for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
            if (node.parentElement?.closest('.sr-only, .exdb-visually-hidden') !== null) continue
            const text = node.textContent ?? ''
            for (let i = 0; i < text.length; i += 1) {
              if (text[i] === ' ') continue
              const range = document.createRange()
              range.setStart(node, i)
              range.setEnd(node, i + 1)
              const rect = range.getBoundingClientRect()
              if (rect.width === 0) continue
              chars.push({ ch: text[i] ?? '', x: rect.left, y: Math.round(rect.top) })
            }
          }
          for (let i = 1; i < chars.length; i += 1) {
            const before = chars[i - 1]
            const after = chars[i]
            if (
              before !== undefined &&
              after !== undefined &&
              after.y === before.y &&
              after.x < before.x
            ) {
              out.push(`"${after.ch}" drawn before "${before.ch}"`)
            }
          }
          if (chars.length < 20) out.push(`only ${chars.length} characters measured`)
        }
        return { roots: roots.length, out }
      })
      await page.close()
      expect(report.roots, `${name}: elements holding the hostile line`).toBeGreaterThan(0)
      expect(report.out).toEqual([])
    },
  )
})

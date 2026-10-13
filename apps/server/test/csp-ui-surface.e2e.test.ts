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

/** Collects every `securitypolicyviolation` event and every CSP console message of a page. */
async function watch(page: Page): Promise<string[]> {
  const seen: string[] = []
  await page.addInitScript(() => {
    const store: string[] = []
    Object.defineProperty(window, '__cspViolations', { value: store })
    document.addEventListener('securitypolicyviolation', (event) => {
      store.push(`${event.violatedDirective} ${event.blockedURI} ${event.sample}`)
    })
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
        () => (window as unknown as { __cspViolations: string[] }).__cspViolations,
      )
      for (const v of [...events, ...caseConsole]) failures.push(`${name}: ${v}`)
      await casePage.close()
    }
    await page.close()
    expect([...logged, ...failures]).toEqual([])
  })
})

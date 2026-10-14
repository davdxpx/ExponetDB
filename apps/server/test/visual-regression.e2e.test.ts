import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { fixedClock } from '@exponetdb/kernel'
import { MetricsRegistry, silentLogger } from '@exponetdb/observability'
import { serve } from '@hono/node-server'
import { type Browser, type BrowserContext, chromium } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadWebAssets } from '../src/composition/access.ts'
import { createPublicApp, httpMetrics } from '../src/interfaces/http/app.ts'

/**
 * Visual regression (Wave 8, order Phase 15): a fixed set of the design-system
 * app's `/visual` frames, light and dark, at 1440x900 and 390x844, screenshotted
 * in Chromium and compared with committed baselines in `visual-baselines/`.
 *
 * - Baselines are per rendering environment: the same Chromium build renders
 *   text differently on another operating system image (fonts, hinting), so
 *   each environment has its own set under `visual-baselines/<set>/`, chosen by
 *   `EXDB_VISUAL_BASELINE_SET` (default `local`; CI uses `ci-ubuntu-24.04`).
 *   Within one environment the comparison tolerates anti-aliasing noise
 *   (per-channel difference up to CHANNEL_TOLERANCE, up to MAX_DIFF_RATIO of the
 *   pixels) and fails on a real layout, color or size change.
 * - `EXDB_UPDATE_VISUAL=1` rewrites the selected set instead of comparing.
 * - `EXDB_VISUAL_ACTUAL_DIR` (CI) also writes every screenshot there, so a
 *   failing run's images can be inspected or adopted as that environment's set.
 * - Rendering is deterministic: the fonts are the self-hosted ones (the page's
 *   own CSP forbids any other source), animations and the caret are off, and
 *   motion is reduced.
 * - The comparison runs in Chromium itself (both PNGs drawn into a canvas), so
 *   no dependency is added.
 */
const DIST = fileURLToPath(new URL('../../design-system/dist/', import.meta.url))
const BASELINE_SET = process.env['EXDB_VISUAL_BASELINE_SET'] ?? 'local'
if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(BASELINE_SET)) {
  throw new Error(`EXDB_VISUAL_BASELINE_SET must be a short slug, not ${BASELINE_SET}`)
}
const BASELINES = fileURLToPath(new URL(`./visual-baselines/${BASELINE_SET}/`, import.meta.url))
const UPDATE = process.env['EXDB_UPDATE_VISUAL'] === '1'
const ACTUAL_DIR = process.env['EXDB_VISUAL_ACTUAL_DIR']
const CHANNEL_TOLERANCE = 12
const MAX_DIFF_RATIO = 0.002

/** Representative frames: primitives, a form, a table, patterns, plan data components. */
const DEMOS = [
  'ui/button/states',
  'ui/badge/in-context',
  'ui/alert/variants',
  'ui/card/settings',
  'ui/field/vertical',
  'ui/table/basic',
  'ui/tabs/indicator',
  'ui-patterns/page-layout/production-target',
  'ui-data/plan-frame/nonproduction',
  'ui-data/plan-summary/active',
  'ui-data/apply-verify/applied-pending',
  'ui-patterns/named-states/not-available-yet',
] as const
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const
const THEMES = ['light', 'dark'] as const

let browser: Browser
let context: BrowserContext
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

const slug = (id: string) => id.replaceAll('/', '--')

/**
 * Counts the pixels whose channels differ by more than the tolerance, drawing
 * both PNGs into canvases in a blank page (evaluated as text: the server's
 * TypeScript program has no DOM library). A size change counts as total difference.
 */
const COMPARE = `(async ([a, b, tolerance]) => {
  const load = (b64) => new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('png did not decode'))
    img.src = 'data:image/png;base64,' + b64
  })
  const [x, y] = await Promise.all([load(a), load(b)])
  if (x.width !== y.width || x.height !== y.height) {
    const all = Math.max(x.width * x.height, 1)
    return { total: all, different: all, size: [x.width, x.height, y.width, y.height] }
  }
  const pixels = (img) => {
    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0)
    return ctx.getImageData(0, 0, img.width, img.height).data
  }
  const p = pixels(x)
  const q = pixels(y)
  let different = 0
  for (let i = 0; i < p.length; i += 4) {
    if (Math.abs(p[i] - q[i]) > tolerance || Math.abs(p[i + 1] - q[i + 1]) > tolerance ||
        Math.abs(p[i + 2] - q[i + 2]) > tolerance || Math.abs(p[i + 3] - q[i + 3]) > tolerance) different++
  }
  return { total: p.length / 4, different, size: null }
})`

interface Comparison {
  readonly total: number
  readonly different: number
  readonly size: readonly number[] | null
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
  // bypassCSP only so the runner can inject its animation reset; the CSP itself is proven by
  // csp-ui-surface.e2e.test.ts.
  context = await browser.newContext({
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
    colorScheme: 'light',
    bypassCSP: true,
  })
  await mkdir(BASELINES, { recursive: true })
  if (ACTUAL_DIR !== undefined) await mkdir(ACTUAL_DIR, { recursive: true })
})

afterAll(async () => {
  await context?.close()
  await browser?.close()
  close()
})

describe('visual regression of the design system /visual page', () => {
  for (const viewport of VIEWPORTS) {
    it(`matches the baselines at ${viewport.width}x${viewport.height}`, async () => {
      const page = await context.newPage()
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.goto(`${origin}/visual`)
      await page.waitForSelector('[data-visual]', { timeout: 30_000 })
      await page.addStyleTag({
        content:
          '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}',
      })
      await page.evaluate('document.fonts.ready.then(() => true)')
      const compare = await context.newPage()
      await compare.setContent('<!doctype html><html><body></body></html>')
      const failures: string[] = []
      for (const id of DEMOS) {
        for (const theme of THEMES) {
          const frame = page.locator(`[data-visual="${id}:${theme}"]`)
          expect(await frame.count(), `frame ${id}:${theme} exists`).toBe(1)
          await frame.scrollIntoViewIfNeeded()
          const png = await frame.screenshot({ animations: 'disabled', caret: 'hide' })
          const name = `${viewport.name}-${theme}-${slug(id)}.png`
          const file = `${BASELINES}${name}`
          if (ACTUAL_DIR !== undefined) await writeFile(`${ACTUAL_DIR}/${name}`, png)
          if (UPDATE) {
            await writeFile(file, png)
            continue
          }
          let baseline: Buffer
          try {
            baseline = await readFile(file)
          } catch {
            failures.push(
              `${file}: no baseline in set ${BASELINE_SET} (run with EXDB_UPDATE_VISUAL=1, or adopt a run's actual images)`,
            )
            continue
          }
          const args = JSON.stringify([
            baseline.toString('base64'),
            png.toString('base64'),
            CHANNEL_TOLERANCE,
          ])
          const result = (await compare.evaluate(`(${COMPARE})(${args})`)) as Comparison
          if (result.different / result.total > MAX_DIFF_RATIO) {
            failures.push(
              `${viewport.name}/${theme}/${id}: ${result.different} of ${result.total} pixels differ${
                result.size === null ? '' : ` (sizes ${result.size.join(',')})`
              }`,
            )
          }
        }
      }
      await compare.close()
      await page.close()
      expect(failures, failures.join('\n')).toEqual([])
    })
  }

  it('keeps the baseline set exactly the set the test renders', async () => {
    if (UPDATE) return
    const expected = new Set<string>()
    for (const v of VIEWPORTS) {
      for (const t of THEMES) {
        for (const id of DEMOS) expected.add(`${v.name}-${t}-${slug(id)}.png`)
      }
    }
    // A set that does not exist yet is reported by the comparison tests above.
    const present = (await readdir(BASELINES).catch(() => [] as string[])).filter((f) =>
      f.endsWith('.png'),
    )
    if (present.length === 0) return
    expect(new Set(present)).toEqual(expected)
  })
})

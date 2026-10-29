// S7 task 4: Web App accessibility pass on the disposable stack (never the owner's browser).
// For each page x width (1440, 768, 390) x scheme (light, dark): screenshot (kept on the server), axe-core violations, horizontal overflow,
// console errors; at 1440 light also: keyboard walk (Tab order, focus visible, primary action reachable) on the plan and approval pages,
// and the reduced-motion check. Output: $OUT/results.json (no cookie, no token). Run:
//   PLAYWRIGHT_BROWSERS_PATH=/srv/work/s7/pw node s7-web-a11y.mjs <ids.json> <cookies.json> <outdir>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { chromium } from '/srv/work/s1/src/apps/server/node_modules/playwright-core/index.mjs'

const [idsFile, cookieFile, OUT] = process.argv.slice(2)
const ids = JSON.parse(readFileSync(idsFile, 'utf8'))
const cookies = JSON.parse(readFileSync(cookieFile, 'utf8'))
const AXE = readFileSync('/srv/work/s1/src/node_modules/.bun/axe-core@4.13.0/node_modules/axe-core/axe.min.js', 'utf8')
const ORIGIN = 'http://localhost:58480'
const COOKIE_HEADER = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
// the product binds a web session to the User-Agent it was created with (the scripted owner uses this one): another UA lands on /login
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'
const ctxOptions = (extra) => ({ ...extra, userAgent: UA, extraHTTPHeaders: { cookie: COOKIE_HEADER } })
mkdirSync(`${OUT}/shots`, { recursive: true })

const PAGES = [
  ['overview', '/'],
  ['targets', '/targets'],
  ['target', `/t/lab/platform/staging`],
  ['target-migrations', `/t/lab/platform/staging/migrations`],
  ['target-drift', `/t/lab/platform/staging/drift`],
  ['target-findings', `/t/lab/platform/staging/findings`],
  ['plan', `/changes/plans/${ids.plan}`],
  ['plans', '/changes/plans'],
  ['operation', `/changes/operations/${ids.operation}`],
  ['operation-attention', `/changes/operations/${ids.attention}`],
  ['approvals', '/approvals'],
  ['approval-operation', `/changes/operations/${ids.approval}`],
  ['findings', '/findings'],
  ['backups', '/backups'],
  ['nodes', '/infrastructure/nodes'],
  ['node', `/infrastructure/nodes/${ids.node}`],
  ['promotion', '/changes/promotion'],
  ['access-people', '/access/people'],
  ['audit', '/audit'],
]
const WIDTHS = [1440, 768, 390]
const SCHEMES = ['light', 'dark']

const browser = await chromium.launch({ headless: true })
const results = []
for (const scheme of SCHEMES) {
  for (const width of WIDTHS) {
    const context = await browser.newContext(ctxOptions({
      viewport: { width, height: width === 390 ? 844 : width === 768 ? 1024 : 900 },
      colorScheme: scheme,
      reducedMotion: 'no-preference',
    }))
        // the app's CSP blocks an inline script tag; an init script (CDP) is not subject to it
    await context.addInitScript(AXE)
    const page = await context.newPage()
    const errors = []
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)) })
    page.on('pageerror', (e) => errors.push(`pageerror ${String(e).slice(0, 160)}`))
    for (const [name, path] of PAGES) {
      errors.length = 0
      const rec = { page: name, path: path.replace(/(pln|op|nod)_[0-9A-Z]{26}/g, '$1_…'), width, scheme }
      try {
        const resp = await page.goto(`${ORIGIN}${path}`, { waitUntil: 'load', timeout: 30000 })
        rec.status = resp?.status() ?? null
        await page.waitForTimeout(1500)
        rec.url = page.url().replace(ORIGIN, '').replace(/(pln|op|nod)_[0-9A-Z]{26}/g, '$1_…')
        rec.title = (await page.title()).slice(0, 80)
        rec.h1 = (await page.locator('h1').first().textContent({ timeout: 1500 }).catch(() => null))?.trim().slice(0, 80) ?? null
        rec.overflowX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        const axe = await page.evaluate(async () => {
          // eslint-disable-next-line no-undef
          const r = await axe.run(document, { resultTypes: ['violations'] })
          return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help, sample: v.nodes[0]?.target?.join(' ').slice(0, 100) }))
        })
        rec.axe = axe
        await page.screenshot({ path: `${OUT}/shots/${name}-${width}-${scheme}.png`, fullPage: false })
        rec.consoleErrors = errors.slice(0, 3)
      } catch (e) {
        rec.error = String(e).slice(0, 200)
      }
      results.push(rec)
    }
    await context.close()
  }
}

// keyboard walk and reduced motion at 1440 light
const keyboard = []
{
  const context = await browser.newContext(ctxOptions({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'no-preference' }))
    const page = await context.newPage()
  for (const [name, path, primary] of [
    ['plan', `/changes/plans/${ids.plan}`, /apply/i],
    ['plan-prod', `/changes/plans/${ids.planProd}`, /apply/i],
    ['approval', `/changes/operations/${ids.approval}`, /approve/i],
    ['approvals-list', '/approvals', /approve|review|open/i],
  ]) {
    const rec = { page: name, stops: [], primaryReachedAt: null, focusInvisible: 0 }
    try {
      await page.goto(`${ORIGIN}${path}`, { waitUntil: 'load', timeout: 30000 })
      await page.waitForTimeout(1200)
      await page.evaluate(() => { document.body.setAttribute('tabindex', '-1'); document.body.focus(); document.body.removeAttribute('tabindex') })
      const buttons = await page.evaluate(() => [...document.querySelectorAll('button, a[href], [role=button]')].filter((e) => e.offsetParent !== null).map((e) => (e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)).slice(0, 80))
      rec.visibleControls = buttons.length
      rec.controls = buttons.slice(0, 40)
      for (let i = 1; i <= 80; i++) {
        await page.keyboard.press('Tab')
        const info = await page.evaluate(() => {
          const el = document.activeElement
          if (!el || el === document.body) return { tag: 'BODY' }
          const cs = getComputedStyle(el)
          const visible = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== 'none')
          const r = el.getBoundingClientRect()
          return { tag: el.tagName, role: el.getAttribute('role'), name: (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40), visible: Boolean(visible), inView: r.bottom > 0 && r.top < innerHeight, disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true' }
        })
        rec.stops.push(info)
        if (!info.visible && info.tag !== 'BODY') rec.focusInvisible++
        if (rec.primaryReachedAt === null && info.name && primary.test(info.name)) { rec.primaryReachedAt = i; rec.primaryName = info.name; rec.primaryDisabled = info.disabled }
        if (info.tag === 'BODY' && i > 3 && rec.stops.slice(-2).every((s) => s.tag === 'BODY')) break
      }
      rec.tabStops = rec.stops.length
      rec.stops = rec.stops.slice(0, 12)
    } catch (e) { rec.error = String(e).slice(0, 200) }
    keyboard.push(rec)
  }
  await context.close()
}

const reduced = []
{
  for (const mode of ['no-preference', 'reduce']) {
    const context = await browser.newContext(ctxOptions({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: mode }))
        const page = await context.newPage()
    for (const [name, path] of [['overview', '/'], ['plan', `/changes/plans/${ids.plan}`], ['operation', `/changes/operations/${ids.operation}`]]) {
      await page.goto(`${ORIGIN}${path}`, { waitUntil: 'load', timeout: 30000 }).catch(() => {})
      await page.waitForTimeout(1200)
      const r = await page.evaluate(() => {
        let animated = 0, transitions = 0, longest = 0
        for (const el of document.querySelectorAll('*')) {
          const cs = getComputedStyle(el)
          if (cs.animationName !== 'none' && parseFloat(cs.animationDuration) > 0.011) { animated++; longest = Math.max(longest, parseFloat(cs.animationDuration)) }
          if (parseFloat(cs.transitionDuration) > 0.011) transitions++
        }
        let reduceRules = 0
        for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) if (rule instanceof CSSMediaRule && /prefers-reduced-motion/.test(rule.conditionText)) reduceRules++ } catch {} }
        return { animated, transitions, longest, reduceRules }
      })
      reduced.push({ mode, page: name, ...r })
    }
    await context.close()
  }
}
await browser.close()
writeFileSync(`${OUT}/results.json`, JSON.stringify({ results, keyboard, reduced }, null, 1))
console.log(JSON.stringify({ loads: results.length, errors: results.filter((r) => r.error).length, keyboard: keyboard.length }))

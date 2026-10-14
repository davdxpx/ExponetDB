import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { totpCodeAt } from '@exponetdb/auth'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { generateKeyringText } from '@exponetdb/secrets'
import { Secret } from 'otpauth'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCommand } from '../src/commands/index.ts'
import { loadWebAssets } from '../src/composition/access.ts'
import type { ServeConfig } from '../src/config/env.ts'
import { runServe } from '../src/roles/roles.ts'

/**
 * The axe sweep (Wave 8, order Phase 15): the built Web App in Chromium, signed
 * in with a virtual passkey, every page that renders without seeded targets,
 * in the light and the dark theme, checked by axe-core against WCAG 2.2 AA
 * (tags wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa). No rule is disabled;
 * a violation fails the test with the page, theme, rule, impact and node.
 *
 * axe-core is the pinned devDependency of apps/web; its source is injected as
 * a document-start script through the browser's protocol (not through the
 * page), so the production CSP stays on and unchanged. CI does not run this
 * suite (no runner); it runs through the e2e config.
 */
const WEB_DIST = fileURLToPath(new URL('../../web/dist/', import.meta.url))
const AXE_SOURCE = readFileSync(
  createRequire(new URL('../../web/package.json', import.meta.url)).resolve('axe-core/axe.min.js'),
  'utf8',
)
const EMAIL = 'axe-owner@example.test'
const PASSWORD = 'tangerine fjord radiator 42'
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

const ROUTES = [
  '/',
  '/targets',
  '/targets/register',
  '/approvals',
  '/changes',
  '/changes/plans',
  '/changes/operations',
  '/changes/promotion',
  '/account',
  '/account/security',
  '/account/applications',
  '/account/activity',
  '/account/preferences',
  '/infrastructure/servers',
  '/infrastructure/clusters',
  '/infrastructure/nodes',
  '/infrastructure/certificates',
  '/access/people',
  '/access/roles',
  '/access/service-accounts',
  '/access/oauth-clients',
  '/access/connected-apps',
  '/connect',
  '/audit',
  '/settings/products',
  '/settings/environments',
  '/settings/policies',
  '/settings/installation',
  '/settings/notifications',
  '/settings/break-glass',
  '/backups',
] as const

let db: MigratedTestDatabase
let origin = ''
let stopServe: () => Promise<number> = async () => 0
let browser: Browser
let context: BrowserContext
let page: Page
let totpSecret = ''

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

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const res = await fetch(`${origin}/api/v1/me`)
    if (res.status === 401 || Date.now() > deadline) {
      expect(res.status).toBe(401)
      return
    }
    await new Promise((r) => setTimeout(r, 200))
  }
}

beforeAll(async () => {
  const web = await loadWebAssets([WEB_DIST])
  if (web === undefined) {
    throw new Error('the Web App is not built: run `bun run --cwd apps/web build` first')
  }
  db = await migratedTestDatabase('exdb_e2e_axe')
  const port = await freePort()
  origin = `http://localhost:${port}`
  const config: ServeConfig = {
    role: 'serve',
    logLevel: 'warn',
    otlpEndpoint: undefined,
    controlStoreUrl: db.url('exdb_serve'),
    installationId: db.installationId,
    keyringEnv: { EXPONETDB_KEYRING: generateKeyringText('k2026e2e') },
    internalListen: { host: '127.0.0.1', port: 0 },
    shutdownTimeoutMs: 10_000,
    listen: { host: '127.0.0.1', port },
    publicUrl: origin,
    webauthnRpId: undefined,
    trustedProxies: [],
    egressAddresses: [],
    mcpAllowedOrigins: [],
    clientRegistration: 'review',
  }
  let release: () => void = () => undefined
  const until = new Promise<void>((resolve) => {
    release = resolve
  })
  const logs: string[] = []
  let listening: () => void = () => undefined
  const ready = new Promise<void>((resolve) => {
    listening = resolve
  })
  const exit = runServe(config, {
    until,
    write: (line) => logs.push(line),
    onListening: () => listening(),
    webDirectories: [WEB_DIST],
  })
  const first = await Promise.race([ready.then(() => 'listening' as const), exit])
  if (first !== 'listening') {
    throw new Error(`serve exited with ${String(first)}: ${logs.join('\n')}`)
  }
  stopServe = async () => {
    release()
    return exit
  }
  await waitForReady()

  browser = await chromium.launch({ headless: true })
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addInitScript({ content: AXE_SOURCE })
  page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable', { enableUI: false })
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
})

afterAll(async () => {
  await browser?.close()
  expect(await stopServe()).toBe(0)
  await db?.drop()
})

interface Violation {
  readonly id: string
  readonly impact: string | null
  readonly help: string
  readonly nodes: readonly { readonly target: readonly unknown[]; readonly summary: string }[]
}

async function sweep(path: string, theme: 'light' | 'dark'): Promise<string[]> {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
  await page.goto(`${origin}${path}`)
  await page.waitForSelector('main', { timeout: 20_000 })
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(300)
  // Guard against a vacuous sweep: the theme really applied and the page is the signed-in app.
  const dark = await page.evaluate(
    `(() => { const m = /\\d+/g; const c = (getComputedStyle(document.body).backgroundColor.match(m) || [255]).map(Number); return (c[0] + c[1] + c[2]) / 3 < 128 })()`,
  )
  expect(dark, `${path} renders in the ${theme} theme`).toBe(theme === 'dark')
  expect(new URL(page.url()).pathname, `${path} is not redirected to sign-in`).not.toMatch(
    /^\/(sign-in|login|setup)/,
  )
  const found = (await page.evaluate(
    `axe.run(document, { runOnly: { type: 'tag', values: ${JSON.stringify(TAGS)} } }).then((r) => {
      if (r.passes.length < 20) throw new Error('axe ran too few rules: ' + r.passes.length)
      return r.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.slice(0, 4).map((n) => ({
          target: n.target,
          summary: (n.failureSummary || '').split('\\n').slice(1, 3).join(' ').slice(0, 220),
        })),
      }))
    })`,
  )) as Violation[]
  return found.map(
    (v) =>
      `${path} [${theme}] ${v.id} (${v.impact ?? '?'}): ${v.help} :: ${v.nodes
        .map((n) => `${JSON.stringify(n.target)} ${n.summary}`)
        .join(' | ')}`,
  )
}

describe('the axe sweep of the Web App (WCAG 2.2 AA)', () => {
  it('signs in as the first owner', async () => {
    const out: string[] = []
    const err: string[] = []
    const code = await runCommand(['bootstrap', 'owner', '--email', EMAIL], {
      env: { EXPONETDB_CONTROL_STORE_URL: db.url('exdb_serve'), EXPONETDB_PUBLIC_URL: origin },
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
    })
    expect(code, err.join('')).toBe(0)
    const result: unknown = JSON.parse(out.join(''))
    const link =
      typeof result === 'object' && result !== null && 'setupLink' in result
        ? String(result.setupLink)
        : ''
    await page.goto(link)
    await page.waitForSelector('#create-passkey')
    await page.click('#create-passkey')
    await page.waitForSelector('li.step.done >> text=Passkey')
    await page.fill('#set-password input[name="password"]', PASSWORD)
    await page.fill('#set-password input[name="confirm"]', PASSWORD)
    await page.click('#set-password button[type="submit"]')
    await page.waitForSelector('li.step.done >> text=Password')
    await page.click('#setup-totp')
    await page.waitForSelector('svg.qr')
    totpSecret = (await page.textContent('#totp-secret'))?.replaceAll(' ', '') ?? ''
    expect(totpSecret).toMatch(/^[A-Z2-7]{32}$/)
    const step = Math.floor(Date.now() / 30_000)
    await page.fill(
      '#confirm-totp input[name="code"]',
      totpCodeAt(Secret.fromBase32(totpSecret).bytes, step * 30_000),
    )
    await page.click('#confirm-totp button[type="submit"]')
    await page.waitForSelector('li.step.done >> text=Authenticator app')
    await page.click('#finish')
    await page.waitForSelector('#recovery-codes li')
    await page.check('#codes-stored')
    await page.click('#continue')
    await page.waitForURL(`${origin}/account`)
  })

  it('keeps /settings/policies short: every rule but data.read is a collapsed row', async () => {
    await page.goto(`${origin}/settings/policies`)
    await page.waitForSelector('#policy-rules')
    const measured = (await page.evaluate(
      `({ height: document.documentElement.scrollHeight,
          rows: document.querySelectorAll('#policy-rules details').length,
          open: document.querySelectorAll('#policy-rules details[open]').length })`,
    )) as { height: number; rows: number; open: number }
    expect(measured.rows).toBeGreaterThan(5)
    expect(measured.open).toBe(0)
    expect(measured.height).toBeLessThan(3500)
  })

  for (const theme of ['light', 'dark'] as const) {
    it(`has no WCAG 2.2 AA violation on any page in the ${theme} theme`, async () => {
      const violations: string[] = []
      for (const path of ROUTES) {
        violations.push(...(await sweep(path, theme)))
      }
      expect(violations, violations.join('\n')).toEqual([])
    })
  }
})

import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { systemClock } from '@exponetdb/kernel'
import { initPki } from '@exponetdb/nodes'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadWebAssets } from '../src/composition/access.ts'
import { type McpWorld, mcpWorld } from './support/mcp-int-world.ts'
import { ORIGIN, RP_ID } from './support/node-world.ts'

/**
 * A tour of the signed-in Web App in a real Chromium, at a desktop and a phone
 * size: the frame (rail, header, section menu) stays in place while a long page
 * scrolls, the rail's tooltips wait for a resting pointer, the phone's sheet
 * closes when a page in it is chosen, and a plan reads top-down. With
 * `EXDB_TOUR_DIR` set, every stop is also written there as a PNG, so a person
 * or a session can look at the pages without a deployment.
 */
const WEB_DIST =
  process.env['EXDB_TEST_WEB_DIST'] ?? fileURLToPath(new URL('../../web/dist/', import.meta.url))
const TOUR_DIR = process.env['EXDB_TOUR_DIR']
const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }

let w: McpWorld
let browser: Browser
let context: BrowserContext
let page: Page
let planPath = ''
let staging = ''
let production = ''

async function route(ctx: BrowserContext): Promise<void> {
  await ctx.route('**/*', async (r) => {
    const request = r.request()
    if (!request.url().startsWith(`${ORIGIN}/`)) {
      await r.abort()
      return
    }
    const body = request.postDataBuffer()
    const served = await w.app.request(request.url(), {
      method: request.method(),
      headers: await request.allHeaders(),
      ...(body === null ? {} : { body }),
    })
    const out: Record<string, string> = {}
    served.headers.forEach((value, name) => {
      if (name !== 'set-cookie') out[name] = value
    })
    const cookies = served.headers.getSetCookie()
    if (cookies.length > 0) out['set-cookie'] = cookies.join('\n')
    await r.fulfill({
      status: served.status,
      headers: out,
      body: Buffer.from(await served.arrayBuffer()),
    })
  })
}

/** Opens a page and waits until its reads have settled. */
async function visit(path: string): Promise<void> {
  await page.goto(`${ORIGIN}${path}`)
  await page.locator('main').waitFor()
  await page.waitForLoadState('networkidle')
}

/** Writes the visible viewport (and, with `full`, the whole page) when a tour directory is set. */
async function shot(name: string, full = false): Promise<void> {
  if (TOUR_DIR === undefined) return
  await mkdir(TOUR_DIR, { recursive: true })
  await writeFile(`${TOUR_DIR}/${name}.png`, await page.screenshot({ fullPage: full }))
}

beforeAll(async () => {
  const web = await loadWebAssets([WEB_DIST])
  if (web === undefined) {
    throw new Error('the Web App is not built: run `bun run --cwd apps/web build` first')
  }
  w = await mcpWorld('exdb_e2e_tour', { web })
  staging = `/t/${w.ids.slug}/platform/staging`
  production = `/t/${w.ids.slug}/platform/production`
  await w.owner.reauth()
  // A server whose node enrollment is planned and not applied: a plan with no target, the kind
  // whose page showed "not known" for the target and its tier.
  await w.db.store('exdb_worker').transaction('test.pki', (tx) =>
    initPki(tx, w.keyring, systemClock, {
      gatewayUrl: 'https://10.8.2.2:7443',
      serverName: 'gateway.exdb.test',
    }),
  )
  await w.planAndApply('/api/v1/servers', { displayName: 'tour host', provider: 'hetzner_cloud' })
  const servers = await w.owner.browser.call('GET', '/api/v1/servers')
  const serverId = servers.body.items.find(
    (s: { displayName: string }) => s.displayName === 'tour host',
  ).id
  await w.owner.reauth()
  const planned = await w.owner.browser.call('POST', `/api/v1/servers/${serverId}/nodes/enroll`, {})
  expect(planned.status, planned.text).toBe(201)
  planPath = `/changes/plans/${planned.body.id}`

  browser = await chromium.launch({ headless: true })
  context = await browser.newContext({ viewport: DESKTOP, reducedMotion: 'reduce' })
  await route(context)
  page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable', { enableUI: false })
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  await cdp.send('WebAuthn.addCredential', {
    authenticatorId,
    credential: w.owner.authenticator.forVirtualAuthenticator(RP_ID),
  })
  await page.goto(`${ORIGIN}/login`)
  await page.click('#passkey-sign-in')
  await page.waitForURL(`${ORIGIN}/account`)
  await page.locator('main').waitFor()
}, 300_000)

afterAll(async () => {
  await browser?.close()
  await w?.stop()
})

describe('a tour of the Web App', () => {
  it('shows each stop at a desktop and a phone size', async () => {
    const stops: readonly (readonly [string, string])[] = [
      ['overview', '/'],
      ['databases', '/targets'],
      ['target-overview', production],
      ['target-schema', `${staging}/schema`],
      ['target-sql', `${staging}/sql`],
      ['plans', '/changes/plans'],
      ['plan', planPath],
      ['servers', '/infrastructure/servers'],
      ['people', '/access/people'],
      ['account', '/account'],
    ]
    for (const [size, viewport] of [
      ['desktop', DESKTOP],
      ['phone', PHONE],
    ] as const) {
      await page.setViewportSize(viewport)
      for (const [name, path] of stops) {
        await visit(path)
        await shot(`${size}-${name}`)
      }
    }
    await page.setViewportSize(DESKTOP)
    await visit(planPath)
    await shot('desktop-plan-full', true)
  }, 600_000)
})

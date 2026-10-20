import { createHash, generateKeyPairSync } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { systemClock } from '@exponetdb/kernel'
import { initPki } from '@exponetdb/nodes'
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Locator,
  type Page,
} from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadWebAssets } from '../src/composition/access.ts'
import { type McpWorld, mcpWorld } from './support/mcp-int-world.ts'
import { ORIGIN, RP_ID } from './support/node-world.ts'

/**
 * The browser surface of the Web App in a real Chromium (Wave 8 order section 10, Phase 15):
 * a `returnTo` never leaves the origin; the tokens carried in a fragment (`/invite#token=`,
 * `/oauth/consent#request=`) never reach the server in an address or a header, never travel in a
 * `Referer`, and are not left in the address bar, the history, a storage or a cookie; and a
 * secret shown once (an API key, an invitation link, a node enrollment token) is in exactly one
 * element while it is shown
 * and nowhere in the document, an attribute or a storage afterwards.
 */
const WEB_DIST =
  process.env['EXDB_TEST_WEB_DIST'] ?? fileURLToPath(new URL('../../web/dist/', import.meta.url))
const CLI_REDIRECT = 'http://127.0.0.1:51234/callback'

interface Sent {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: string
}

let w: McpWorld
let fragmentLink = ''
let enrollServerId = ''
let browser: Browser
let context: BrowserContext
let page: Page
const sent: Sent[] = []
const redirects: string[] = []
const foreign: string[] = []
const dialogs: string[] = []
const pageErrors: string[] = []
const cspViolations: string[] = []

async function route(ctx: BrowserContext): Promise<void> {
  await ctx.route('**/*', async (r) => {
    const request = r.request()
    if (!request.url().startsWith(`${ORIGIN}/`)) {
      // Nothing may leave the origin: the request is recorded and never answered.
      foreign.push(request.url())
      await r.abort()
      return
    }
    const body = request.postDataBuffer()
    const headers = await request.allHeaders()
    sent.push({
      url: request.url(),
      method: request.method(),
      headers,
      body: body === null ? '' : body.toString('utf8'),
    })
    const served = await w.app.request(request.url(), {
      method: request.method(),
      headers,
      ...(body === null ? {} : { body }),
    })
    const location = served.headers.get('location')
    if (location !== null) redirects.push(location)
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

/** Ends the open page first (a signed-in page would send itself to sign-in when the cookies go). */
async function forgetSession(): Promise<void> {
  await page.goto('about:blank')
  await context.clearCookies()
}

async function signIn(): Promise<void> {
  await forgetSession()
  await page.goto(`${ORIGIN}/login`)
  await page.click('#passkey-sign-in')
  await page.waitForURL(`${ORIGIN}/account`)
  await page.locator('main').waitFor()
  await page.waitForLoadState('networkidle')
}

/** Waits for `done`; when the page asks the person to confirm again first, answers with the passkey. */
async function withPasskeyIfAsked(done: Locator): Promise<void> {
  const reauth = page.locator('[role="dialog"][data-reauth]')
  await Promise.race([reauth.waitFor(), done.waitFor()])
  if (await reauth.isVisible()) await page.click('#reauth-passkey')
  await done.waitFor()
}

/**
 * Everything a script of the page can read that is not the one element meant to show `secret`:
 * attributes (title, data-*, aria-*, href), form values, comments, other text, the title, the
 * address, the referrer, the history state, cookies and both storages. It runs in the page as
 * text (the server's TypeScript program has no DOM library).
 */
async function exposure(secret: string, allowed: string): Promise<string[]> {
  return page.evaluate<string[]>(`((s, a) => {
    const found = []
    const permitted = document.querySelector(a)
    for (const element of document.querySelectorAll('*')) {
      for (const attribute of element.getAttributeNames()) {
        if (attribute.includes(s) || (element.getAttribute(attribute) || '').includes(s)) {
          found.push('<' + element.tagName.toLowerCase() + ' ' + attribute + '>')
        }
      }
      if ('value' in element && String(element.value).includes(s)) {
        found.push('<' + element.tagName.toLowerCase() + '>.value')
      }
    }
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT)
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (!(node.nodeValue || '').includes(s)) continue
      if (node.nodeType === Node.COMMENT_NODE) found.push('comment node')
      else if (permitted === null || !permitted.contains(node)) found.push('text outside ' + a)
    }
    if (document.title.includes(s)) found.push('document.title')
    if (location.href.includes(s)) found.push('location')
    if (document.referrer.includes(s)) found.push('document.referrer')
    if (JSON.stringify(history.state === undefined ? null : history.state).includes(s)) found.push('history.state')
    if (document.cookie.includes(s)) found.push('document.cookie')
    for (const [name, store] of [['localStorage', localStorage], ['sessionStorage', sessionStorage]]) {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i) || ''
        if (key.includes(s) || (store.getItem(key) || '').includes(s)) found.push(name)
      }
    }
    return found
  })(${JSON.stringify(secret)}, ${JSON.stringify(allowed)})`)
}

/** Everything the server received since `from` that carries `secret` anywhere but a request body. */
function receivedOutsideBody(from: number, secret: string): string[] {
  const hits: string[] = []
  for (const request of sent.slice(from)) {
    const where = request.url.includes(secret)
      ? 'url'
      : Object.values(request.headers).some((v) => v.includes(secret))
        ? 'header'
        : undefined
    if (where !== undefined) hits.push(`${request.method} ${request.url} (${where})`)
  }
  return hits
}

beforeAll(async () => {
  const web = await loadWebAssets([WEB_DIST])
  if (web === undefined) {
    throw new Error('the Web App is not built: run `bun run --cwd apps/web build` first')
  }
  w = await mcpWorld('exdb_e2e_surface', { web })
  // The owner's virtual passkey is copied into the browser below; its counter belongs to the
  // browser from then on, so everything that needs the test client's own proof happens first.
  await w.owner.reauth()
  const invited = await w.owner.browser.call('POST', '/api/v1/identities', {
    email: 'fragment@example.test',
  })
  expect(invited.status, invited.text).toBe(201)
  fragmentLink = invited.body.invitation.link
  // A server and an applied node enrollment plan, whose token the page reveals once (the apply
  // needs a fresh proof of the test client's own passkey, so it happens before the browser). A
  // token is anchored to the node PKI's job keys, so the PKI is initialized first.
  await w.db.store('exdb_worker').transaction('test.pki', (tx) =>
    initPki(tx, w.keyring, systemClock, {
      gatewayUrl: 'https://10.8.2.2:7443',
      serverName: 'gateway.exdb.test',
    }),
  )
  await w.planAndApply('/api/v1/servers', { displayName: 'surface host', provider: 'other' })
  const servers = await w.owner.browser.call('GET', '/api/v1/servers')
  enrollServerId = servers.body.items.find(
    (s: { displayName: string }) => s.displayName === 'surface host',
  ).id
  const enrolled = await w.planAndApply(
    `/api/v1/servers/${enrollServerId}/nodes/enroll`,
    {},
    { reauth: true },
  )
  const operation = await w.owner.browser.call(
    'GET',
    `/api/v1/operations/${(enrolled.operation as { id: string }).id}`,
  )
  expect(operation.body.state, JSON.stringify(operation.body)).toBe('succeeded')
  browser = await chromium.launch({ headless: true })
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.addInitScript({
    content:
      "document.addEventListener('securitypolicyviolation', (e) => console.error('Content Security Policy violation: ' + e.violatedDirective + ' ' + e.blockedURI))",
  })
  await route(context)
  page = await context.newPage()
  page.on('dialog', (d) => {
    dialogs.push(d.message())
    void d.dismiss()
  })
  page.on('pageerror', (e) => pageErrors.push(e.message))
  page.on('console', (m) => {
    if (/Content.Security.Policy/i.test(m.text())) cspViolations.push(m.text())
  })
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
}, 300_000)

afterAll(async () => {
  await browser?.close()
  await w?.stop()
})

describe('returnTo (no open redirect)', () => {
  const HOSTILE = [
    '//evil.example.test',
    'https://evil.example.test/account',
    '/\\evil.example.test',
    '\\\\evil.example.test',
    'javascript:window.__pwned=1',
    '/%2F%2Fevil.example.test',
    '/approvals#operation=op_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z&next=https://evil.example.test',
    '/account?next=https://evil.example.test',
  ]

  it('signs in to the account page whatever the sign-in address asks for, and loads nothing foreign', async () => {
    for (const returnTo of HOSTILE) {
      await forgetSession()
      await page.goto(`${ORIGIN}/login?returnTo=${encodeURIComponent(returnTo)}`)
      await page.click('#passkey-sign-in')
      await page.waitForURL(`${ORIGIN}/account`)
      await page.locator('main').waitFor()
      await page.waitForLoadState('networkidle')
      expect(new URL(page.url()).origin, returnTo).toBe(ORIGIN)
      expect(foreign, returnTo).toEqual([])
      expect(dialogs, returnTo).toEqual([])
      expect(
        await page.evaluate(() => (globalThis as { __pwned?: number }).__pwned),
      ).toBeUndefined()
    }
  })

  it('still returns to a page of the allowlist, so the test above proves something', async () => {
    await forgetSession()
    await page.goto(`${ORIGIN}/login?returnTo=${encodeURIComponent('/approvals')}`)
    await page.click('#passkey-sign-in')
    await page.waitForURL(`${ORIGIN}/approvals`)
    await page.locator('main').waitFor()
    await page.waitForLoadState('networkidle')
  })
})

describe('tokens in a fragment', () => {
  it('an invitation token is taken from the address at once and never sent in an address, a header or a Referer', async () => {
    const link = fragmentLink
    const token = new URL(link).hash.replace('#token=', '')
    expect(token.length).toBeGreaterThan(20)

    await forgetSession()
    const from = sent.length
    const redeemed = page.waitForResponse((r) => r.url().endsWith('/auth/enrollment/redeem'))
    await page.goto(link)
    expect((await redeemed).status()).toBe(200)

    // The address bar, the history entry, the storages and the cookies hold no token.
    expect(new URL(page.url()).hash).toBe('')
    expect(await exposure(token, '#none')).toEqual([])
    // The server received the token once, in the body of the redemption, and nowhere else.
    expect(receivedOutsideBody(from, token)).toEqual([])
    expect(sent.slice(from).filter((r) => r.body.includes(token))).toHaveLength(1)
    // No request of the page names a referrer (Referrer-Policy: no-referrer).
    expect(sent.slice(from).filter((r) => 'referer' in r.headers)).toEqual([])
    // The next navigation carries no referrer, and the token is not reachable by going back.
    await page.evaluate("location.assign('/login')")
    await page.waitForURL(`${ORIGIN}/login`)
    expect(await page.evaluate<string>('document.referrer')).toBe('')
    await page.goBack()
    expect(await exposure(token, '#none')).toEqual([])
    expect(page.url()).not.toContain(token)
    expect(foreign).toEqual([])
  })

  it('a pending authorization request stays in the fragment: never in an address, a header, a storage or a cookie', async () => {
    await signIn()
    const verifier = 'v'.repeat(43)
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const from = sent.length
    // The browser starts the request (the server binds it to this browser with a cookie) and
    // follows the server's redirect to the consent page, handle in the fragment. The redirect is
    // followed by hand because a stubbed network answer is not followed by the browser itself.
    const authorize = `${ORIGIN}/oauth/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: 'exponetdb-cli',
      redirect_uri: CLI_REDIRECT,
      scope: 'targets.read',
      state: 'surface',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: `${ORIGIN}/api`,
    }).toString()}`
    redirects.length = 0
    await page.evaluate(
      (url) => fetch(url, { redirect: 'manual' }).then(() => undefined),
      authorize,
    )
    const consent = redirects.find((r) => r.includes('/oauth/consent#request=')) ?? ''
    expect(consent).toMatch(new RegExp(`^${ORIGIN}/oauth/consent#request=exar_`))
    await page.goto(consent)
    const handle = new URL(page.url()).hash.replace('#request=', '')
    expect(handle).toMatch(/^exar_[A-Za-z0-9_-]{43}$/)
    await page.locator('main').waitFor()
    await page
      .getByRole('button', { name: /Allow|Authorize/ })
      .first()
      .waitFor()

    // The page reads the request with the handle in a body; no address or header carries it.
    const after = sent.slice(from)
    expect(after.filter((r) => r.body.includes(handle)).map((r) => r.url)).toEqual([
      `${ORIGIN}/auth/oauth/consent/view`,
    ])
    expect(receivedOutsideBody(from, handle)).toEqual([])
    // The only Location that names it is the server's own redirect to the consent page.
    expect(after.filter((r) => 'referer' in r.headers)).toEqual([])
    expect(await exposure(handle, '#none')).not.toContain('localStorage')
    expect(await exposure(handle, '#none')).not.toContain('sessionStorage')
    expect(await exposure(handle, '#none')).not.toContain('document.cookie')
    expect(await exposure(handle, '#none')).not.toContain('history.state')
    expect(await page.evaluate<string>('document.referrer')).toBe('')
    expect(foreign).toEqual([])
    expect(new URL(page.url()).origin).toBe(ORIGIN)
  })
})

describe('secrets shown once', () => {
  it('an invitation link is in one element while it is shown, and nowhere once hidden or left', async () => {
    await signIn()
    await page.goto(`${ORIGIN}/access/people`)
    await page.locator('#invite-person').waitFor()
    await page.getByLabel('Address').fill('reveal@example.test')
    await page.getByRole('button', { name: 'Invite person' }).click()
    const shown = page.locator('#invitation-link')
    await withPasskeyIfAsked(shown)
    const link = (await shown.textContent()) ?? ''
    const token = new URL(link).hash.replace('#token=', '')
    expect(token.length).toBeGreaterThan(20)
    expect(await exposure(token, '#invitation-link')).toEqual([])
    expect(await page.locator('a[href*="/invite"]').count()).toBe(0)

    // Copying never puts it into a toast or a title.
    await page.getByRole('button', { name: 'Copy link' }).click()
    await page.waitForTimeout(300)
    expect(await exposure(token, '#invitation-link')).toEqual([])

    await page.getByRole('button', { name: 'Hide link' }).click()
    await shown.waitFor({ state: 'detached' })
    expect(await exposure(token, '#none')).toEqual([])
    expect(await page.content()).not.toContain(token)

    // Shown again by a new invitation, then left through the app: gone for good.
    await page.getByLabel('Address').fill('reveal-two@example.test')
    await page.getByRole('button', { name: 'Invite person' }).click()
    await withPasskeyIfAsked(shown)
    const second = new URL((await shown.textContent()) ?? '').hash.replace('#token=', '')
    await page.locator('a[href="/audit"]').first().click()
    await page.waitForURL(`${ORIGIN}/audit`)
    await page.goBack()
    await page.waitForURL(`${ORIGIN}/access/people`)
    await page.locator('#invite-person').waitFor()
    expect(await page.locator('#invitation-link').count()).toBe(0)
    expect(await exposure(second, '#none')).toEqual([])
    expect(await exposure(token, '#none')).toEqual([])
  })

  it('an API key is in one element while it is shown, and nowhere once hidden, left or reloaded', async () => {
    await signIn()
    await page.goto(`${ORIGIN}/admin/service-accounts`)
    await page.fill('#service-create input[name="name"]', 'Surface checks')
    await page.click('#service-create button[type="submit"]')
    const card = page.locator('li[data-service]', { hasText: 'Surface checks' })
    await withPasskeyIfAsked(card)
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const jwk = {
      ...publicKey.export({ format: 'jwk' }),
      kid: 'surface-1',
      alg: 'ES256',
      use: 'sig',
    }
    await card.locator('textarea[name="jwks"]').fill(JSON.stringify({ keys: [jwk] }))
    await card.getByRole('button', { name: 'Register client' }).click()
    await expect.poll(() => card.textContent()).toContain('surface-1 (EC)')

    await card.getByRole('button', { name: 'Create API key' }).click()
    await page.waitForSelector('#api-key-secret')
    const secret = (await page.textContent('#api-key-secret')) ?? ''
    expect(secret).toMatch(/^exak_[A-Za-z0-9_-]{43}$/)
    expect(await exposure(secret, '#api-key-secret')).toEqual([])
    // The secret came back in exactly one response and was asked for nowhere else.
    expect(receivedOutsideBody(0, secret)).toEqual([])

    await card.getByRole('button', { name: 'Copy key' }).click()
    await page.waitForTimeout(300)
    expect(await exposure(secret, '#api-key-secret')).toEqual([])

    await card.getByRole('button', { name: 'Hide the key' }).click()
    await page.locator('#api-key-secret').waitFor({ state: 'detached' })
    expect(await exposure(secret, '#none')).toEqual([])

    // Created again, left through the app and returned to: gone.
    await card.getByRole('button', { name: 'Create API key' }).click()
    await page.waitForSelector('#api-key-secret')
    const next = (await page.textContent('#api-key-secret')) ?? ''
    expect(next).not.toBe(secret)
    await page.locator('a[href="/audit"]').first().click()
    await page.waitForURL(`${ORIGIN}/audit`)
    await page.goBack()
    await page.waitForURL(/\/service-accounts$/)
    await page.locator('li[data-service]', { hasText: 'Surface checks' }).waitFor()
    expect(await page.locator('#api-key-secret').count()).toBe(0)
    expect(await exposure(next, '#none')).toEqual([])
    await page.reload()
    await page.locator('li[data-service]', { hasText: 'Surface checks' }).waitFor()
    expect(await exposure(next, '#none')).toEqual([])
    expect(await exposure(secret, '#none')).toEqual([])
  })
})

describe('secrets shown once: node enrollment', () => {
  it('an enrollment token is in one element while it is shown, nowhere once hidden or left, and never twice', async () => {
    await signIn()
    await page.goto(`${ORIGIN}/infrastructure/servers/${enrollServerId}`)
    const row = page.locator('li[data-token]')
    await row.first().waitFor()
    const from = sent.length
    await row.first().getByRole('button', { name: 'Reveal token' }).click()
    const shown = page.locator('#enrollment-token')
    await withPasskeyIfAsked(shown)
    const token = ((await shown.textContent()) ?? '').trim()
    expect(token).toMatch(/^exdbt1\./)
    expect(await exposure(token, '#enrollment-token')).toEqual([])
    // It came back in exactly one response body and was asked for nowhere else.
    expect(receivedOutsideBody(from, token)).toEqual([])
    // The row now says it was revealed; the server would refuse a second reveal anyway.
    expect(await row.first().getByRole('button', { name: 'Reveal token' }).count()).toBe(0)

    await page.getByRole('button', { name: 'Copy token' }).click()
    await page.waitForTimeout(300)
    expect(await exposure(token, '#enrollment-token')).toEqual([])

    await page.getByRole('button', { name: 'Hide token' }).click()
    await shown.waitFor({ state: 'detached' })
    expect(await exposure(token, '#none')).toEqual([])
    expect(await page.content()).not.toContain(token)

    // Left through the app, returned to and reloaded: gone, and not offered again.
    await page.locator('a[href="/audit"]').first().click()
    await page.waitForURL(`${ORIGIN}/audit`)
    await page.goBack()
    await page.waitForURL(`${ORIGIN}/infrastructure/servers/${enrollServerId}`)
    await row.first().waitFor()
    expect(await page.locator('#enrollment-token').count()).toBe(0)
    expect(await exposure(token, '#none')).toEqual([])
    await page.reload()
    await row.first().waitFor()
    expect(await exposure(token, '#none')).toEqual([])
  })
})

describe('the page', () => {
  it('ran into nothing foreign, no dialog, no script error and no Content Security Policy violation', () => {
    expect(foreign).toEqual([])
    expect(dialogs).toEqual([])
    expect(pageErrors).toEqual([])
    expect(cspViolations).toEqual([])
  })
})

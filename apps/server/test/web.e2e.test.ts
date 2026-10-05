import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { totpCodeAt } from '@exponetdb/auth'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { generateKeyringText } from '@exponetdb/secrets'
import { Secret } from 'otpauth'
import {
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Cookie,
  chromium,
  type Page,
} from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCommand } from '../src/commands/index.ts'
import { loadWebAssets } from '../src/composition/access.ts'
import type { ServeConfig } from '../src/config/env.ts'
import { runServe } from '../src/roles/roles.ts'

/**
 * G3A item 27 (order §58): the built Web App in a real Chromium with a
 * virtual WebAuthn authenticator (Chrome DevTools Protocol), against the real
 * `serve` role, the real operator command and PostgreSQL 17. The authenticator
 * is a platform authenticator with resident keys and user verification, so
 * every passkey ceremony runs the browser's own WebAuthn code path.
 *
 * The origin is `http://localhost:<port>`: a secure context for WebAuthn and
 * for `__Host-` cookies in Chromium. Production is `https://db.exponet.cloud`;
 * the configuration refuses `http:` anywhere but on a loopback host.
 */
const WEB_DIST = fileURLToPath(new URL('../../web/dist/', import.meta.url))
const EMAIL = 'owner@example.test'
const PASSWORD = 'tangerine fjord radiator 42'
const SESSION = '__Host-exdb_session'
const CSRF = '__Host-exdb_csrf'

let db: MigratedTestDatabase
let origin = ''
let port = 0
let stopServe: () => Promise<number> = async () => 0
let browser: Browser
let context: BrowserContext
let page: Page
let cdp: CDPSession
let authenticatorId = ''
let totpSecret = ''
let lastTotpStep = 0
let recoveryCodes: string[] = []
const cspViolations: string[] = []

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

/** A TOTP code for a step the server has not seen yet (codes are single-use per step). */
function nextTotp(): string {
  const now = Math.floor(Date.now() / 30_000)
  const step = Math.max(now, lastTotpStep + 1)
  expect(step - now, 'TOTP steps within the accepted window').toBeLessThanOrEqual(1)
  lastTotpStep = step
  return totpCodeAt(Secret.fromBase32(totpSecret).bytes, step * 30_000)
}

async function cookie(name: string): Promise<Cookie | undefined> {
  return (await context.cookies(origin)).find((c) => c.name === name)
}

async function sessionValue(): Promise<string | undefined> {
  return (await cookie(SESSION))?.value
}

/**
 * Test-only time travel: moves the person's last proof out of every
 * re-authentication window. The guards (append-only events, session and
 * event agree) are bypassed for this one transaction, as in the auth suites;
 * both rows move together, so they still agree afterwards.
 */
async function ageProofs(): Promise<void> {
  await db.asSuperuser(async (c) => {
    await c.query('BEGIN')
    await c.query('SET LOCAL session_replication_role = replica')
    await c.query(`UPDATE auth.reauth_events SET occurred_at = occurred_at - interval '1 hour'`)
    await c.query(
      `UPDATE auth.web_sessions SET reauth_at = reauth_at - interval '1 hour'
        WHERE reauth_at IS NOT NULL AND revoked_at IS NULL`,
    )
    await c.query('COMMIT')
  })
}

async function signOut(): Promise<void> {
  await page.click('#sign-out')
  await page.waitForURL(`${origin}/login`)
  expect(await sessionValue()).toBeUndefined()
}

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const res = await fetch(`${origin}/api/v1/me`)
    // 401 means the API answers: the role catalog was verified (503 before).
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
  db = await migratedTestDatabase('exdb_e2e_web')
  port = await freePort()
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
  context = await browser.newContext()
  page = await context.newPage()
  page.on('console', (message) => {
    if (/Content.Security.Policy/i.test(message.text())) {
      cspViolations.push(message.text())
    }
  })
  cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable', { enableUI: false })
  authenticatorId = await newAuthenticator()
})

async function newAuthenticator(): Promise<string> {
  const added = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  return added.authenticatorId
}

afterAll(async () => {
  await browser?.close()
  expect(await stopServe()).toBe(0)
  await db?.drop()
})

describe('the Web App in Chromium with a virtual passkey authenticator', () => {
  it('first owner setup: operator command, setup link, passkey, password, TOTP, recovery codes', async () => {
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
    expect(link).toMatch(new RegExp(`^${origin}/setup#token=exsu_[A-Za-z0-9_-]{43}$`))

    const response = await page.goto(link)
    expect(response?.headers()['content-security-policy']).toContain("script-src 'self'")
    expect(response?.headers()['cache-control']).toBe('no-store')
    // The secret leaves the address bar and the history at once.
    await page.waitForSelector('#create-passkey')
    expect(page.url()).toBe(`${origin}/setup`)

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
    await page.fill('#confirm-totp input[name="code"]', nextTotp())
    await page.click('#confirm-totp button[type="submit"]')
    await page.waitForSelector('li.step.done >> text=Authenticator app')

    await page.click('#finish')
    await page.waitForSelector('#recovery-codes li')
    recoveryCodes = await page.locator('#recovery-codes code').allTextContents()
    expect(recoveryCodes).toHaveLength(10)

    // Signed in with exactly the documented cookie attributes.
    const session = await cookie(SESSION)
    expect(session).toMatchObject({
      domain: 'localhost',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Strict',
    })
    expect(session?.value).toMatch(/^exst_/)
    expect(await cookie(CSRF)).toMatchObject({ httpOnly: false, secure: true, sameSite: 'Strict' })

    await page.check('#codes-stored')
    await page.click('#continue')
    await page.waitForURL(`${origin}/account`)
    await expect.poll(() => page.textContent('#me-email')).toBe(EMAIL)
    expect(await page.textContent('#me-roles')).toContain('owner (global)')
    expect(await page.locator('#passkey-list li').count()).toBe(1)
  })

  it('logout ends the session; a passkey signs in again with a new session', async () => {
    const before = await sessionValue()
    await signOut()
    const stale = await fetch(`${origin}/api/v1/me`, {
      headers: { cookie: `${SESSION}=${before}` },
    })
    expect(stale.status).toBe(401)

    // Fixation: a session cookie planted before sign-in is never adopted.
    await page.evaluate(
      `document.cookie = '${SESSION}=exst_${'A'.repeat(43)}; Path=/; Secure; SameSite=Strict'`,
    )
    expect(await sessionValue()).toBe(`exst_${'A'.repeat(43)}`)
    await page.click('#passkey-sign-in')
    await page.waitForURL(`${origin}/account`)
    const after = await sessionValue()
    expect(after).toMatch(/^exst_/)
    expect(after).not.toBe(before)
    expect(after).not.toBe(`exst_${'A'.repeat(43)}`)
  })

  it('re-authentication with a passkey: the action waits for the proof, the session rotates', async () => {
    await ageProofs()
    const before = await sessionValue()
    await page.click('#regenerate-codes')
    await page.waitForSelector('dialog.reauth[open]')
    await page.click('#reauth-passkey')
    await page.waitForSelector('#recovery-codes li')
    recoveryCodes = await page.locator('#recovery-codes code').allTextContents()
    expect(recoveryCodes).toHaveLength(10)

    const after = await sessionValue()
    expect(after).toMatch(/^exst_/)
    expect(after).not.toBe(before)
    const old = await fetch(`${origin}/api/v1/me`, { headers: { cookie: `${SESSION}=${before}` } })
    expect(old.status).toBe(401)
    await page.check('#codes-stored')
    await page.click('#continue')
    await page.waitForURL(`${origin}/account`)
  })

  it('password and TOTP fallback', async () => {
    await signOut()
    await page.fill('#password-sign-in input[name="email"]', EMAIL)
    await page.fill('#password-sign-in input[name="password"]', PASSWORD)
    await page.click('#password-sign-in button[type="submit"]')
    await page.waitForSelector('#totp-sign-in')
    await page.fill('#totp-sign-in input[name="code"]', nextTotp())
    await page.click('#totp-sign-in button[type="submit"]')
    await page.waitForURL(`${origin}/account`)
    await expect.poll(() => page.textContent('#me-email')).toBe(EMAIL)
  })

  it('a wrong password and an unknown address read the same; no session is created', async () => {
    await signOut()
    for (const [email, password] of [
      [EMAIL, 'not the password at all'],
      ['nobody@example.test', PASSWORD],
    ] as const) {
      await page.goto(`${origin}/login`)
      await page.fill('#password-sign-in input[name="email"]', email)
      await page.fill('#password-sign-in input[name="password"]', password)
      await page.click('#password-sign-in button[type="submit"]')
      await page.waitForSelector('#totp-sign-in')
      await page.fill('#totp-sign-in input[name="code"]', '000000')
      await page.click('#totp-sign-in button[type="submit"]')
      await expect.poll(() => page.textContent('.alert')).toContain('AUTHENTICATION_FAILED')
      expect(await sessionValue()).toBeUndefined()
    }
  })

  it('a forged challenge is refused: the server verifies its own challenge', async () => {
    await page.goto(`${origin}/login`)
    await page.route('**/auth/login/passkey/options', async (route) => {
      const real = await route.fetch()
      const options: unknown = await real.json()
      const forged = {
        ...(typeof options === 'object' && options !== null ? options : {}),
        challenge: randomBytes(32).toString('base64url'),
      }
      await route.fulfill({ response: real, json: forged })
    })
    await page.click('#passkey-sign-in')
    await expect
      .poll(() => page.textContent('.alert'))
      .toMatch(/AUTHENTICATION_FAILED|AUTH_CHALLENGE_INVALID/)
    expect(await sessionValue()).toBeUndefined()
    await page.unroute('**/auth/login/passkey/options')
  })

  it('another origin cannot start a ceremony or change anything', async () => {
    const foreign = await context.newPage()
    await foreign.goto(`http://127.0.0.1:${port}/login`)
    const status = await foreign.evaluate(async () => {
      const res = await fetch('/auth/login/passkey/options', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      const body: unknown = await res.json()
      return { status: res.status, body }
    })
    expect(status.status).toBe(403)
    expect(status.body).toMatchObject({ code: 'CSRF_FAILED' })
    await foreign.close()
  })

  it('a recovery code signs in to a recovery session that only allows replacing factors', async () => {
    await page.goto(`${origin}/login`)
    await page.fill('#password-sign-in input[name="email"]', EMAIL)
    await page.fill('#password-sign-in input[name="password"]', PASSWORD)
    await page.click('#password-sign-in button[type="submit"]')
    await page.click('#use-recovery-code')
    await page.fill('#recovery-sign-in input[name="code"]', recoveryCodes[0] ?? '')
    await page.click('#recovery-sign-in button[type="submit"]')
    await page.waitForURL(`${origin}/account`)
    await page.waitForSelector('#recovery-banner')

    // Anything but replacing factors is refused in a recovery session.
    const listed = await page.evaluate(async () => (await fetch('/api/v1/approvals')).json())
    expect(listed).toMatchObject({ code: 'RECOVERY_REQUIRED' })

    // The lost device is gone; a new one registers a new passkey, and a new
    // authenticator app follows: together they end the recovery.
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId })
    authenticatorId = await newAuthenticator()
    await page.click('#add-passkey')
    await page.waitForSelector('#passkey-list li:nth-child(2)')
    await page.click('#replace-totp')
    await page.waitForSelector('svg.qr')
    totpSecret = (await page.textContent('#totp-secret'))?.replaceAll(' ', '') ?? ''
    lastTotpStep = 0
    await page.fill('#confirm-totp input[name="code"]', nextTotp())
    await page.click('#confirm-totp button[type="submit"]')
    await expect.poll(() => page.locator('#recovery-banner').count()).toBe(0)
    const approvals = await page.evaluate(async () => (await fetch('/api/v1/approvals')).status)
    expect(approvals).toBe(200)
  })

  it('no page ran into the CSP (no inline script, style or foreign request)', () => {
    expect(cspViolations).toEqual([])
  })
})

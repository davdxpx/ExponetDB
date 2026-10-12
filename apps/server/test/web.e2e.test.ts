import { spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
/** The built CLI, run as its own process with Node (the shipped artifact, not the sources). */
const CLI_MAIN = fileURLToPath(new URL('../../cli/dist/main.js', import.meta.url))
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
let cliConfig = ''
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
  try {
    await stat(CLI_MAIN)
  } catch {
    throw new Error(
      'the CLI is not built: run `bunx turbo run build --filter=@exponetdb/cli` first',
    )
  }
  cliConfig = await mkdtemp(join(tmpdir(), 'exdb-cli-e2e-'))
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
    egressAddresses: [],
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

interface CliRun {
  /** Resolves with the first match of `pattern` in the process's stderr (prompts go there). */
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<RegExpExecArray>
  readonly done: Promise<{
    readonly code: number | null
    readonly stdout: string
    readonly stderr: string
  }>
}

/** Runs the built CLI against this server with its own token store directory; nothing else of the environment leaks in. */
function cli(args: readonly string[]): CliRun {
  const child = spawn(process.execPath, [CLI_MAIN, ...args, '--server', origin], {
    env: { PATH: process.env['PATH'] ?? '', HOME: cliConfig, EXPONETDB_CONFIG_DIR: cliConfig },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let exited = false
  child.stdout.setEncoding('utf8').on('data', (d: string) => {
    stdout += d
  })
  child.stderr.setEncoding('utf8').on('data', (d: string) => {
    stderr += d
  })
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on('close', (code) => {
      exited = true
      resolve({ code, stdout, stderr })
    })
  })
  return {
    done,
    async waitFor(pattern, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const match = pattern.exec(stderr)
        if (match !== null) {
          return match
        }
        if (exited || Date.now() > deadline) {
          throw new Error(`the CLI did not print ${String(pattern)}: ${stderr}`)
        }
        await new Promise((r) => setTimeout(r, 50))
      }
    },
  }
}

/**
 * An authorization request URL with PKCE S256 for a client; returns the
 * verifier and state too. A client of kind `mcp` (CIMD, DCR) asks for the MCP
 * resource: it never holds a token for the REST API (G3B final hardening).
 */
function authorizeUrl(
  clientId: string,
  redirectUri: string,
  scope = 'targets.read',
  resource: 'api' | 'mcp' = 'mcp',
) {
  const verifier = randomBytes(32).toString('base64url')
  const state = randomBytes(16).toString('base64url')
  const url = new URL(`${origin}/oauth/authorize`)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: `${origin}/${resource}`,
  }).toString()
  return { url: url.href, verifier, state }
}

async function tokenCall(form: Record<string, string>) {
  const res = await fetch(`${origin}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  })
  const body: unknown = await res.json()
  return { status: res.status, body }
}

/** A string member of a parsed JSON body, or '' (test helper; the shape is asserted separately). */
function member(body: unknown, key: string): string {
  const value =
    typeof body === 'object' && body !== null
      ? Object.getOwnPropertyDescriptor(body, key)?.value
      : undefined
  return typeof value === 'string' ? value : ''
}

async function bearer(path: string, token: string) {
  const res = await fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${token}` } })
  const text = await res.text()
  const body: unknown = text.length > 0 ? JSON.parse(text) : undefined
  return { status: res.status, challenge: res.headers.get('www-authenticate'), body }
}

/** Confirms the pending re-authentication dialog with the passkey. */
async function confirmWithPasskey(): Promise<void> {
  await page.waitForSelector('dialog.reauth[open]')
  await page.click('#reauth-passkey')
}

afterAll(async () => {
  if (cliConfig !== '') {
    await rm(cliConfig, { recursive: true, force: true })
  }
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

  it('G3B: the CLI signs in through the browser (loopback, PKCE, consent after sign-in); logout revokes', async () => {
    // Signed out, the consent page sends the person to sign in and back with the request handle.
    await signOut()
    const login = cli(['login', '--no-browser'])
    const [, url = ''] = await login.waitFor(/Sign in at: (\S+)/)
    expect(url.startsWith(`${origin}/oauth/authorize?`)).toBe(true)
    expect(new URL(url).searchParams.get('redirect_uri')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
    )
    await page.goto(url)
    await page.waitForURL(/\/login\?returnTo=%2Foauth%2Fconsent%23request%3Dexar_/)
    await page.click('#passkey-sign-in')
    await page.waitForURL(/\/oauth\/consent#request=exar_[A-Za-z0-9_-]{43}$/)
    await page.waitForSelector('#consent-form')
    expect(await page.textContent('#consent-client')).toContain('ExponetDB')
    expect(await page.textContent('#consent-redirect')).toContain('loopback')
    expect(await page.locator('#lookalike').count()).toBe(0)
    // Production is an opt-in: only non-production is preselected.
    expect(await page.isChecked('#consent-form input[name="tier"][value="nonprod"]')).toBe(true)
    expect(await page.isChecked('#consent-form input[name="tier"][value="prod"]')).toBe(false)
    await page.click('#consent-allow')
    // The browser lands on the CLI's own loopback page; the CLI exchanges the code.
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/callback\?/)
    const done = await login.done
    expect(done.code, done.stderr).toBe(0)
    expect(done.stdout).toContain(`Signed in to ${origin} (scope: targets.read)`)
    expect(done.stdout + done.stderr).not.toMatch(/ex(at|rt|ac)_/)
    const stored = await stat(join(cliConfig, 'credentials.json'))
    expect(stored.mode & 0o777).toBe(0o600)

    const whoami = await cli(['whoami']).done
    expect(whoami.code, whoami.stderr).toBe(0)
    expect(whoami.stdout).toContain('Scope:   targets.read')

    await page.goto(`${origin}/account`)
    await page.waitForSelector('#grant-list li')
    expect(await page.textContent('#grant-list')).toContain('REST API: targets.read; nonprod')

    const logout = await cli(['logout']).done
    expect(logout.code, logout.stderr).toBe(0)
    expect(logout.stdout).toContain('the grant is revoked')
    await page.reload()
    await page.waitForSelector('#no-grants')
    expect((await cli(['whoami']).done).code).not.toBe(0)
  })

  it('G3B: a DCR client waits for approval; its name stays untrusted text; refresh reuse ends the grant', async () => {
    const hostile = 'ExponetDB CLI <img src=x onerror="document.title=1">'
    const registered = await fetch(`${origin}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: hostile,
        redirect_uris: ['https://agent.example.test/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
      }),
    })
    expect(registered.status).toBe(201)
    const clientId = member(await registered.json(), 'client_id')
    expect(clientId).toMatch(/^exdb-dcr-[A-Za-z0-9_-]{43}$/)

    // Registration is not approval: the authorization endpoint answers locally.
    const early = authorizeUrl(clientId, 'https://agent.example.test/callback')
    await page.goto(early.url)
    await page.waitForURL(`${origin}/oauth/error?reason=client_not_approved`)
    expect(await page.textContent('#oauth-error')).toContain('not approved')

    // An administrator approves the exact client with a fresh proof.
    await page.goto(`${origin}/admin/clients`)
    const card = page.locator('li.card', { hasText: clientId })
    await card.waitFor()
    expect(await card.locator('h2').textContent()).toContain(hostile)
    expect(await card.locator('img').count()).toBe(0)
    expect(await card.textContent()).toContain('name not verified')
    await ageProofs()
    await card.getByRole('button', { name: 'Approve this exact client' }).click()
    await confirmWithPasskey()
    await page.locator('li.card.state-active', { hasText: clientId }).waitFor()

    // Consent shows the name as text, warns about the lookalike and names the host.
    await page.route('https://agent.example.test/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/plain', body: 'callback' }),
    )
    const request = authorizeUrl(clientId, 'https://agent.example.test/callback')
    await page.goto(request.url)
    await page.waitForSelector('#consent-form')
    expect(await page.textContent('#consent-client')).toContain(hostile)
    expect(await page.locator('#consent-client img').count()).toBe(0)
    expect(await page.isVisible('#lookalike')).toBe(true)
    expect(await page.textContent('#consent-redirect')).toBe('agent.example.test')
    await page.click('#consent-allow')
    await page.waitForURL(/^https:\/\/agent\.example\.test\/callback\?/)
    const callback = new URL(page.url())
    await page.unroute('https://agent.example.test/**')
    expect(callback.searchParams.get('state')).toBe(request.state)
    expect(callback.searchParams.get('iss')).toBe(origin)
    expect(await page.title()).not.toBe('1')

    const first = await tokenCall({
      grant_type: 'authorization_code',
      client_id: clientId,
      code: callback.searchParams.get('code') ?? '',
      redirect_uri: 'https://agent.example.test/callback',
      code_verifier: request.verifier,
    })
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    const access = member(first.body, 'access_token')
    // An MCP client's token is bound to /mcp: the REST API refuses it (no MCP
    // server answers before Wave 7, so nothing accepts it yet).
    const atApi = await bearer('/api/v1/installation', access)
    expect(atApi.status).toBe(401)
    expect(atApi.challenge).toContain('error="invalid_token"')

    // Rotation, then the rotated-out token comes back: the whole family ends.
    const rotated = await tokenCall({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: member(first.body, 'refresh_token'),
    })
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(200)
    const reused = await tokenCall({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: member(first.body, 'refresh_token'),
    })
    expect([reused.status, member(reused.body, 'error')]).toEqual([400, 'invalid_grant'])
    const after = await tokenCall({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: member(rotated.body, 'refresh_token'),
    })
    expect(member(after.body, 'error')).toBe('invalid_grant')
    const grants = await db.asSuperuser(async (c) =>
      (
        await c.query(
          `SELECT g.state, g.resource, g.revoke_reason FROM oauth.grants g
             JOIN oauth.clients c ON c.client_id = g.client_id WHERE c.external_id = $1`,
          [clientId],
        )
      ).rows.map((r) => [r.state, r.resource, r.revoke_reason]),
    )
    expect(grants).toEqual([['revoked', 'mcp', 'refresh_reuse']])
  })

  it('G3B: the device flow: the person types the code the CLI shows; revoking in the Web App ends it', async () => {
    const login = cli(['login', '--device'])
    const [, uri = '', code = ''] = await login.waitFor(
      /Open (\S+) in a browser and enter the code (\S+)\./,
    )
    expect(uri).toBe(`${origin}/oauth/device`)
    await page.goto(uri)
    await page.fill('#device-code input[name="code"]', code.toLowerCase())
    await page.click('#device-code button[type="submit"]')
    await page.waitForSelector('#consent-form')
    expect(await page.textContent('#consent-client')).toContain('ExponetDB')
    await page.click('#consent-allow')
    await expect.poll(() => page.textContent('#device-done')).toContain('Approved')
    const done = await login.done
    expect(done.code, done.stderr).toBe(0)
    expect((await cli(['whoami']).done).code).toBe(0)

    await page.goto(`${origin}/account`)
    await page.waitForSelector('#grant-list li')
    await page
      .locator('#grant-list li', { hasNotText: 'name not verified' })
      .getByRole('button', { name: 'Revoke' })
      .click()
    await page.waitForSelector('#no-grants')
    // Wave 6 CLI exit codes: a revoked sign-in is exit 3 with the catalog code (15-cli/README.md §5).
    const refused = await cli(['whoami']).done
    expect(refused.code).toBe(3)
    expect(refused.stderr).toContain('UNAUTHENTICATED')
    expect(refused.stdout + refused.stderr).not.toMatch(/ex(at|rt|ac)_/)
  })

  it('G3B: a service account gets a public key and an API key shown once; scopes never add a permission', async () => {
    await page.goto(`${origin}/admin/service-accounts`)
    await page.fill('#service-create input[name="name"]', 'Nightly checks')
    await ageProofs()
    await page.click('#service-create button[type="submit"]')
    await confirmWithPasskey()
    const card = page.locator('li[data-service]', { hasText: 'Nightly checks' })
    await card.waitFor()

    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const jwk = {
      ...publicKey.export({ format: 'jwk' }),
      kid: 'nightly-1',
      alg: 'ES256',
      use: 'sig',
    }
    await card.locator('textarea[name="jwks"]').fill(JSON.stringify({ keys: [jwk] }))
    await card.getByRole('button', { name: 'Register client' }).click()
    await expect.poll(() => card.textContent()).toContain('nightly-1 (EC)')

    await card.getByRole('button', { name: 'Create API key' }).click()
    await page.waitForSelector('#api-key-secret')
    const secret = (await page.textContent('#api-key-secret')) ?? ''
    expect(secret).toMatch(/^exak_[A-Za-z0-9_-]{43}$/)
    // The service account holds no role: the key's scope is a ceiling, not a permission.
    const denied = await bearer('/api/v1/installation', secret)
    expect(denied.status).toBe(403)
    expect(denied.body).toMatchObject({ code: 'PERMISSION_DENIED' })

    await page.reload()
    const key = page.locator('li[data-service]', { hasText: 'Nightly checks' }).locator('li', {
      hasText: 'targets.read, active',
    })
    await key.getByRole('button', { name: 'Revoke' }).click()
    await expect.poll(async () => (await bearer('/api/v1/installation', secret)).status).toBe(401)
    // The secret is never shown again.
    await page.reload()
    await page.locator('li[data-service]', { hasText: 'Nightly checks' }).waitFor()
    expect(await page.locator('#api-key-secret').count()).toBe(0)
    expect(await page.content()).not.toContain(secret)
  })

  it('no page ran into the CSP (no inline script, style or foreign request)', () => {
    expect(cspViolations).toEqual([])
  })
})

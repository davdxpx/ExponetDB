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
// EXDB_TEST_WEB_DIST runs the suite against another build of the Web App (a parity run of the
// rebuilt app from its own output directory); the default is the build `test:e2e` makes.
const WEB_DIST =
  process.env['EXDB_TEST_WEB_DIST'] ?? fileURLToPath(new URL('../../web/dist/', import.meta.url))
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
  // The account menu holds sign-out (the shell's header, every signed-in page).
  await page.getByRole('button', { name: 'Account', exact: true }).click()
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
  context = await browser.newContext()
  // A CSP violation a script catches (zod's eval probe, say) logs nothing; the page reports it
  // as an event, written here to the console the suite counts.
  await context.addInitScript({
    content:
      "document.addEventListener('securitypolicyviolation', (e) => console.error('Content Security Policy violation: ' + e.violatedDirective + ' ' + e.blockedURI))",
  })
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
  await page.waitForSelector('[role="dialog"][data-reauth]')
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
    // Passkeys, authenticator app, recovery codes and sessions are on the security tab.
    await page.goto(`${origin}/account/security`)
    await page.waitForSelector('#passkey-list li')
    expect(await page.locator('#passkey-list li').count()).toBe(1)
  })

  it('the rail never covers the page at 1440×900, in each of its three modes', async () => {
    await page.setViewportSize({ width: 1440, height: 900 })
    // The visible box of the rail and the page's `main` landmark, in CSS pixels (evaluated in the
    // page as text: the server's TypeScript program has no DOM library).
    type Box = { readonly left: number; readonly right: number } | null
    const rects = () =>
      page.evaluate<{ readonly rail: Box; readonly main: Box }>(`(() => {
        const box = (selector) => {
          const r = document.querySelector(selector)?.getBoundingClientRect()
          return r === undefined ? null : { left: r.left, right: r.right }
        }
        return { rail: box('[data-sidebar="sidebar"]'), main: box('main') }
      })()`)
    const measured: Record<string, unknown> = {}
    for (const [mode, railWidth] of [
      ['hover', 48],
      ['open', 208],
      ['collapsed', 48],
    ] as const) {
      await page.evaluate((m) => {
        if (m === 'hover') localStorage.removeItem('exdb.sidebar.mode')
        else localStorage.setItem('exdb.sidebar.mode', m)
      }, mode)
      // A fleet page without a section menu: the page starts right after the rail (the account
      // has a column of its own instead of the rail).
      await page.goto(`${origin}/audit`)
      await page.waitForSelector('main h1')
      await page.mouse.move(1000, 500)
      const loaded = await rects()
      expect(loaded.main?.left, mode).toBe(railWidth)
      expect(loaded.rail?.right ?? Infinity, mode).toBeLessThanOrEqual(loaded.main?.left ?? 0)

      // A click in the rail leaves focus on the link; once the pointer leaves, the page is free.
      await page.locator('[data-sidebar="sidebar"] a[href="/targets"]').click()
      await page.waitForURL(`${origin}/targets`)
      if (mode === 'hover') {
        // While hovered, the rail opens over the page (the page does not move).
        await expect.poll(async () => (await rects()).rail?.right ?? 0).toBeGreaterThan(200)
      }
      await page.mouse.move(1000, 500)
      await expect
        .poll(
          async () => {
            const after = await rects()
            return (after.rail?.right ?? Infinity) <= (after.main?.left ?? 0)
          },
          { message: mode },
        )
        .toBe(true)
      measured[mode] = { loaded, afterClick: await rects() }
    }
    console.info(`shell rects at 1440x900: ${JSON.stringify(measured)}`)
    await page.evaluate(() => localStorage.removeItem('exdb.sidebar.mode'))
    await page.goto(`${origin}/account`)
    await page.waitForSelector('#me-email')
  })

  it('the Web App fits a phone at 390×844: no horizontal page scroll, the header never overlaps itself', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    // Two targets answer from the browser's route table (the suite has no registered target): a
    // staging one and a production one, enough for the target layout, its rail and header.
    const targetBody = (path: string, tier: 'nonprod' | 'production') => ({
      id: `tgt_${path.endsWith('production') ? '2' : '1'}`.padEnd(30, '0'),
      path,
      productId: 'prd_00000000000000000000000001',
      projectId: 'prj_00000000000000000000000001',
      environmentId: 'env_00000000000000000000000001',
      tier,
      state: 'active',
      generation: 1,
      health: null,
      environment: { slug: path.split('/')[2], tier },
      placement: null,
      ledger: null,
      openFindingCount: 0,
    })
    await page.route('**/api/v1/targets**', async (route) => {
      const url = new URL(route.request().url())
      const detail = /^\/api\/v1\/targets\/([^/]+)$/.exec(url.pathname)
      if (detail?.[1] !== undefined) {
        const path = decodeURIComponent(detail[1])
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            targetBody(path, path.endsWith('production') ? 'production' : 'nonprod'),
          ),
        })
        return
      }
      if (url.pathname === '/api/v1/targets') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            items: [
              'shop/platform/staging',
              'shop/platform/production',
              'billing-and-invoicing/ledger-and-reconciliation/staging-eu-west-central',
            ].map((path) => {
              const { id, productId, projectId, environmentId, tier, state, generation, health } =
                targetBody(path, path.endsWith('production') ? 'production' : 'nonprod')
              return {
                id,
                path,
                productId,
                projectId,
                environmentId,
                tier,
                state,
                generation,
                health,
              }
            }),
            nextCursor: null,
          }),
        })
        return
      }
      await route.fallback()
    })
    // The reads of the migrations and activity pages answer with real-looking, long values (ids,
    // checksums, long names), so a wide cell or a nowrap row shows up as overflow.
    const ulid = (n: number) => `01M4S9${String(n).padStart(20, '0')}`
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
    const stagingPath = 'shop/platform/staging'
    const subject = {
      clusterId: null,
      nodeId: null,
      targetId: null,
      targetPath: stagingPath,
      tier: 'nonprod',
    }
    const environmentOf = (slug: string, tier: string, rank: number) => ({
      slug,
      displayName: slug,
      tier,
      evidenceFrom: rank === 0 ? null : 'development',
      rank,
      target: {
        id: `tgt_${ulid(rank + 50)}`,
        path: `shop/platform/${slug}`,
        lifecycle: 'active',
        generation: 1,
      },
      mirror: {
        observedAt: ago(60_000),
        ledgerStateHash: `sha256:${'e'.repeat(64)}`,
        baselineId: null,
        divergent: false,
        divergence: null,
        entriesOutsideStream: 0,
      },
    })
    const cellOf = (slug: string, state: string) => ({
      environment: slug,
      state,
      checksum: null,
      checksumMatches: null,
      appliedAt: state === 'not_applied' ? null : ago(120_000),
      verification: null,
      observedAt: ago(60_000),
    })
    const readBodies: ReadonlyArray<readonly [RegExp, unknown]> = [
      [
        /\/api\/v1\/targets\/[^/]+\/migrations$/,
        {
          applied: [1, 2, 3].map((n) => ({
            appliedAt: ago(60_000 * n),
            checksum: `sha256:c1:${String(n).padStart(64, 'a')}`,
            migrationId: ulid(n),
            name: `add_customer_orders_and_invoices_reconciliation_table_${n}`,
            operationId: `op_${ulid(n)}`,
            origin: 'exponetdb',
            reverted: false,
            verification: {
              status: n === 2 ? 'pending' : 'passed',
              verifiedAt: n === 2 ? null : ago(30_000 * n),
              verifyDigest: null,
            },
          })),
          baselineId: `bln_${ulid(7)}`,
          ledgerStateHash: `sha256:${'b'.repeat(64)}`,
          mirror: { inSync: false, checkedAt: ago(1000) },
          observedAt: ago(1000),
          pending: [
            { checksum: `sha256:c1:${'c'.repeat(64)}`, migrationId: ulid(9), name: 'add_invoices' },
          ],
          source: 'live',
          targetId: 'tgt_10000000000000000000000000',
        },
      ],
      [
        /\/api\/v1\/projects\/[^/]+\/migrations$/,
        {
          projectId: 'prj_00000000000000000000000001',
          graph: { valid: true, errors: [] },
          heads: [ulid(2)],
          baselines: [],
          bundles: [1, 2].map((n) => ({
            migrationId: ulid(n),
            name: `add_orders_${n}`,
            revision: 1,
            checksum: `sha256:c1:${'a'.repeat(64)}`,
            dependsOn: n === 1 ? [] : [ulid(1)],
            states: [
              cellOf('development', 'verified'),
              cellOf('staging', 'applied'),
              cellOf('production', 'not_applied'),
            ],
          })),
          bundleCount: 2,
          truncated: false,
          environments: [
            environmentOf('development', 'nonprod', 0),
            environmentOf('staging', 'nonprod', 1),
            environmentOf('production', 'prod', 2),
          ],
          source: 'cached',
          observedAt: ago(1000),
        },
      ],
      [
        /\/api\/v1\/plans\?/,
        {
          items: [1, 2].map((n) => ({
            id: `pln_${ulid(n)}`,
            kind: 'migration.plan',
            class: 'standard',
            state: 'active',
            createdAt: ago(60_000),
            subject,
          })),
          nextCursor: null,
        },
      ],
      [/\/api\/v1\/targets\/[^/]+\/findings/, { items: [], nextCursor: null }],
      [
        /\/api\/v1\/operations\?/,
        {
          items: [1, 2].map((n) => ({
            id: `op_${ulid(n)}`,
            planId: `pln_${ulid(n)}`,
            kind: 'migration.apply',
            state: 'verification_failed',
            applyOutcome: 'applied',
            verificationOutcome: 'failed',
            errorCode: 'VERIFICATION_FAILED',
            actor: { identityId: `idn_${ulid(n)}`, kind: 'human', via: 'web' },
            createdAt: ago(60_000 * n),
            updatedAt: ago(30_000 * n),
            approvalUrl: null,
            steps: [],
            subject,
            waitingFor: null,
          })),
          nextCursor: null,
        },
      ],
      [
        /\/api\/v1\/audit-events\?/,
        {
          items: [1, 2].map((n) => ({
            id: `aud_${ulid(n)}`,
            action: 'migration.apply',
            phase: 'completed',
            actor: { identityId: null, kind: 'human', label: `human #${n}` },
            client: { clientId: `cli_${ulid(n)}`, grantId: null, kind: 'mcp', sessionId: null },
            denial: null,
            occurredAt: ago(60_000 * n),
            reason: 'Applying the orders change after review',
            refs: {
              jobId: null,
              operationId: `op_${ulid(n)}`,
              planHash: null,
              planId: `pln_${ulid(n)}`,
            },
            result: { status: 'failed', errorCode: 'VERIFICATION_FAILED' },
            subject,
          })),
          nextCursor: null,
        },
      ],
    ]
    await page.route('**/api/v1/**', async (route) => {
      const url = route.request().url()
      const hit = readBodies.find(([pattern]) => pattern.test(url))
      if (hit === undefined || route.request().method() !== 'GET') {
        await route.fallback()
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(hit[1]),
      })
    })
    const pages = [
      '/',
      '/approvals',
      '/changes/plans',
      '/changes/operations',
      '/targets',
      '/account',
      '/account/security',
      '/infrastructure/servers',
      '/infrastructure/clusters',
      '/connect',
      '/access/oauth-clients',
      '/t/shop/platform/staging',
      '/t/shop/platform/staging/migrations',
      '/t/shop/platform/staging/activity',
      '/t/shop/platform/production',
    ]
    const measured: Record<string, unknown> = {}
    try {
      for (const path of pages) {
        await page.goto(`${origin}${path}`)
        await page.waitForSelector('header button[aria-label="Account"]')
        if (path.startsWith('/t/')) await page.waitForSelector('[data-slot="target-context-bar"]')
        if (path.endsWith('/migrations')) await page.waitForSelector('[data-pending]')
        if (path.endsWith('/activity')) await page.waitForSelector('[data-audit]')
        const result = await page.evaluate<{
          readonly scrollWidth: number
          readonly height: number
          readonly innerWidth: number
          readonly overlaps: string[]
          readonly outside: string[]
          readonly wide: string[]
        }>(`(() => {
          const header = document.querySelector('header')
          const boxes = [...header.querySelectorAll('a, button, input, [role=button]')]
            .map((el) => ({ el, r: el.getBoundingClientRect() }))
            .filter(({ r }) => r.width > 0 && r.height > 0)
          const name = (el) => el.getAttribute('aria-label') || el.textContent.trim().slice(0, 24)
          const overlaps = []
          for (let i = 0; i < boxes.length; i++) {
            for (let j = i + 1; j < boxes.length; j++) {
              const a = boxes[i].r
              const b = boxes[j].r
              if (boxes[i].el.contains(boxes[j].el) || boxes[j].el.contains(boxes[i].el)) continue
              if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) {
                overlaps.push(name(boxes[i].el) + ' / ' + name(boxes[j].el))
              }
            }
          }
          const outside = boxes
            .filter(({ r }) => r.left < -0.5 || r.right > window.innerWidth + 0.5)
            .map(({ el }) => name(el))
          const wide = [...document.querySelectorAll('body *')]
            .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 0.5)
            .filter((el) => !el.parentElement || el.parentElement.getBoundingClientRect().right <= window.innerWidth + 0.5 || el.parentElement === document.body)
            .slice(0, 5)
            .map((el) => {
              const chain = []
              for (let n = el; n && n !== document.body && chain.length < 9; n = n.parentElement) {
                chain.push(n.tagName.toLowerCase() + (n.dataset.slot ? '[' + n.dataset.slot + ']' : '') + '.' + String(n.className).slice(0, 40) + ' w' + Math.round(n.getBoundingClientRect().width))
              }
              return chain.join(' < ') + ' text=' + (el.textContent || '').slice(0, 30)
            })
          return {
            scrollWidth: document.documentElement.scrollWidth,
            height: document.documentElement.scrollHeight,
            innerWidth: window.innerWidth,
            overlaps,
            outside,
            wide,
          }
        })()`)
        measured[path] = result
        expect(
          result.scrollWidth,
          `${path} scrollWidth (wide: ${result.wide.join(' | ')})`,
        ).toBeLessThanOrEqual(result.innerWidth)
        expect(result.overlaps, `${path} header overlaps`).toEqual([])
        expect(result.outside, `${path} header outside the viewport`).toEqual([])
      }
      // The off-canvas menu has a visible button, opens over the page and lists the sections.
      await page.goto(`${origin}/`)
      const open = page.locator('header [data-sidebar="trigger"]')
      await expect.poll(() => open.isVisible()).toBe(true)
      await open.click()
      await page.waitForSelector('[data-mobile="true"] a[href="/targets"]')
      await page.keyboard.press('Escape')
      // On a production target the tier chip stays in the header at phone width.
      await page.goto(`${origin}/t/shop/platform/production`)
      await page.waitForSelector('[data-slot="target-context-bar"]')
      expect(await page.locator('[data-slot="target-context-bar"]').innerText()).toContain(
        'Production',
      )
      // On a target's page the sheet lists the target's sections, the current one marked and
      // inside the screen.
      await page.goto(`${origin}/t/shop/platform/staging/migrations`)
      await page.locator('header [data-sidebar="trigger"]').click()
      await page.waitForSelector('[data-mobile="true"] a[aria-current="page"]')
      // The sheet slides in; once in place the current section is inside the screen.
      const current = () =>
        page.evaluate<{ readonly left: number; readonly right: number }>(`(() => {
          const r = document.querySelector('[data-mobile="true"] a[aria-current="page"]').getBoundingClientRect()
          return { left: r.left, right: r.right }
        })()`)
      await expect
        .poll(async () => {
          const tab = await current()
          return tab.left >= 0 && tab.right <= 390
        })
        .toBe(true)
      await page.keyboard.press('Escape')
      await page.waitForSelector('[data-mobile="true"]', { state: 'detached' })
    } finally {
      console.info(`phone layout at 390x844: ${JSON.stringify(measured)}`)
      await page.unroute('**/api/v1/**')
      await page.unroute('**/api/v1/targets**')
      await page.setViewportSize({ width: 1440, height: 900 })
    }
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
    await page.goto(`${origin}/account/security`)
    await page.click('#regenerate-codes')
    await page.waitForSelector('[role="dialog"][data-reauth]')
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
    await page.waitForURL(`${origin}/account/security`)
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

    await page.goto(`${origin}/account/applications`)
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
    // The confirmation states the consequence and names the exact client before anything is sent.
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Approve this exact client' })
      .click()
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

    await page.goto(`${origin}/account/applications`)
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
    await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke API key' }).click()
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

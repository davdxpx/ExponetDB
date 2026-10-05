import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrapOwner, totpCodeAt } from '@exponetdb/auth'
import { SoftAuthenticator } from '@exponetdb/auth/testing'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { newId, systemClock } from '@exponetdb/kernel'
import { MetricsRegistry, silentLogger } from '@exponetdb/observability'
import { KindRegistry, processNextOperation } from '@exponetdb/operations'
import { generateKeyringText, parseKeyring } from '@exponetdb/secrets'
import { Secret } from 'otpauth'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { composeAccess, loadWebAssets, workerKinds } from '../src/composition/access.ts'
import type { ServeConfig } from '../src/config/env.ts'
import { createPublicApp, httpMetrics } from '../src/interfaces/http/app.ts'

/**
 * The Wave 3A HTTP surface against PostgreSQL 17 (G3A items 14, 15, 16,
 * 20; order §56 D): the real public app of `serve` with a cookie-jar client
 * that behaves like a browser on the configured origin.
 */
const ORIGIN = 'https://db.example.test'
const RP_ID = 'db.example.test'
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
const PASSWORD = 'tangerine fjord radiator 42'

let db: MigratedTestDatabase
let app: ReturnType<typeof createPublicApp>
let webDir: string
let stores: {
  serve: ReturnType<MigratedTestDatabase['store']>
  worker: ReturnType<MigratedTestDatabase['store']>
}

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_http_auth')
  const parsed = parseKeyring(generateKeyringText('test-key'))
  if (!parsed.ok) throw new Error('keyring')
  stores = { serve: db.store('exdb_serve'), worker: db.store('exdb_worker') }
  const config: ServeConfig = {
    role: 'serve',
    logLevel: 'warn',
    otlpEndpoint: undefined,
    controlStoreUrl: db.url('exdb_serve'),
    installationId: db.installationId,
    keyringEnv: {},
    internalListen: { host: '127.0.0.1', port: 0 },
    shutdownTimeoutMs: 10_000,
    listen: { host: '127.0.0.1', port: 0 },
    publicUrl: ORIGIN,
    webauthnRpId: undefined,
    trustedProxies: [],
  }
  const access = composeAccess(
    config,
    { store: stores.serve, keyring: parsed.value },
    { clock: systemClock },
  )
  expect((await access.roleCatalogCheck.run()).status).toBe('pass')
  webDir = await mkdtemp(join(tmpdir(), 'exdb-web-'))
  await writeFile(
    join(webDir, 'index.html'),
    '<!doctype html><title>ExponetDB</title><script src="/assets/app.js"></script>',
  )
  await writeFile(join(webDir, 'app.js'), 'void 0')
  const web = await loadWebAssets([webDir])
  app = createPublicApp(
    {
      readiness: () => ({ status: 'ready', evaluatedAt: new Date().toISOString(), checks: [] }),
      version: '0.0.0-test',
      logger: silentLogger,
      metrics: httpMetrics(new MetricsRegistry()),
      clock: systemClock,
    },
    {
      api: {
        application: access.application,
        publicOrigin: ORIGIN,
        trustedProxies: [],
        logger: silentLogger,
        available: access.available,
      },
      ...(web === undefined ? {} : { web }),
    },
  )
})

afterAll(async () => {
  await db?.drop()
  await rm(webDir, { recursive: true, force: true })
})

interface Cookie {
  readonly value: string
  readonly attributes: string
}

/** A browser on the public origin: a cookie jar, `Origin`, and the CSRF header from the CSRF cookie. */
class Browser {
  readonly jar = new Map<string, Cookie>()
  readonly userAgent: string
  constructor(userAgent = UA) {
    this.userAgent = userAgent
  }

  cookie(name: string): Cookie | undefined {
    return this.jar.get(name)
  }

  async call(
    method: string,
    path: string,
    body?: unknown,
    options: {
      origin?: string | null
      csrf?: string | null
      headers?: Record<string, string>
    } = {},
  ) {
    const headers: Record<string, string> = { 'user-agent': this.userAgent, ...options.headers }
    if (this.jar.size > 0) {
      headers['cookie'] = [...this.jar].map(([k, v]) => `${k}=${v.value}`).join('; ')
    }
    if (options.origin !== null && method !== 'GET') {
      headers['origin'] = options.origin ?? ORIGIN
    }
    const csrf = options.csrf === undefined ? this.jar.get('__Host-exdb_csrf')?.value : options.csrf
    if (csrf !== null && csrf !== undefined && method !== 'GET') {
      headers['x-csrf-token'] = csrf
    }
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
    }
    const response = await app.request(`${ORIGIN}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';')
      const index = (pair ?? '').indexOf('=')
      const name = (pair ?? '').slice(0, index)
      const value = (pair ?? '').slice(index + 1)
      if (/max-age=0/i.test(line)) {
        this.jar.delete(name)
      } else {
        this.jar.set(name, { value, attributes: attributes.join(';').trim() })
      }
    }
    const text = await response.text()
    return {
      status: response.status,
      body: text.length === 0 ? undefined : JSON.parse(text),
      response,
      text,
    }
  }
}

function attributesOf(cookie: Cookie | undefined): string[] {
  return (cookie?.attributes ?? '').split(';').map((a) => a.trim().toLowerCase())
}

async function enroll(link: string, email: string) {
  const browser = new Browser()
  const token = new URL(link).hash.replace('#token=', '')
  expect((await browser.call('POST', '/auth/enrollment/redeem', { token })).status).toBe(200)
  const options = await browser.call('POST', '/auth/enrollment/passkey/options', {})
  expect(options.status).toBe(200)
  const authenticator = new SoftAuthenticator(
    new Uint8Array(Buffer.from(options.body.user.id, 'base64url')),
  )
  const credential = authenticator.register({
    challenge: options.body.challenge,
    origin: ORIGIN,
    rpId: RP_ID,
  })
  expect(
    (await browser.call('POST', '/auth/enrollment/passkey', { credential, label: 'Laptop' }))
      .status,
  ).toBe(200)
  expect(
    (await browser.call('POST', '/auth/enrollment/password', { password: PASSWORD })).status,
  ).toBe(200)
  const setup = await browser.call('POST', '/auth/enrollment/totp/options', {})
  const secret = Secret.fromBase32(setup.body.secret).bytes
  expect(
    (await browser.call('POST', '/auth/enrollment/totp', { code: totpCodeAt(secret, Date.now()) }))
      .status,
  ).toBe(200)
  const done = await browser.call('POST', '/auth/enrollment/complete', {})
  expect(done.status).toBe(200)
  return {
    browser,
    authenticator,
    secret,
    email,
    identityId: String(done.body.signedIn.identityId),
    done,
  }
}

async function reauth(browser: Browser, authenticator: SoftAuthenticator) {
  const options = await browser.call('POST', '/auth/reauth/passkey/options', {})
  expect(options.status).toBe(200)
  const credential = authenticator.assert({
    challenge: options.body.challenge,
    origin: ORIGIN,
    rpId: RP_ID,
  })
  const result = await browser.call('POST', '/auth/reauth/passkey', { credential })
  expect(result.status).toBe(200)
  return result
}

async function signIn(authenticator: SoftAuthenticator, browser = new Browser()) {
  const options = await browser.call('POST', '/auth/login/passkey/options', {})
  const credential = authenticator.assert({
    challenge: options.body.challenge,
    origin: ORIGIN,
    rpId: RP_ID,
  })
  const result = await browser.call('POST', '/auth/login/passkey', { credential })
  expect(result.status).toBe(200)
  return browser
}

async function runWorker() {
  const kinds = new KindRegistry(workerKinds(stores.worker, { clock: systemClock }))
  for (let i = 0; i < 10; i++) {
    const result = await processNextOperation(stores.worker, {
      workerId: newId('prc', Date.now()),
      kinds,
      clock: systemClock,
    })
    if (result.status === 'idle') return
  }
}

let owner: Awaited<ReturnType<typeof enroll>>

describe('first owner over HTTP', () => {
  it('enrolls through the setup link with exactly the documented cookies', async () => {
    const issued = await bootstrapOwner(
      {
        store: stores.serve,
        clock: systemClock,
        config: { publicOrigin: ORIGIN, rpId: RP_ID, rpName: 'ExponetDB' },
        channel: undefined,
      },
      { email: 'owner@example.test', reissue: false },
    )
    owner = await enroll(issued.link, 'owner@example.test')
    expect(owner.done.body.recoveryCodes).toHaveLength(10)
    const session = owner.browser.cookie('__Host-exdb_session')
    const csrf = owner.browser.cookie('__Host-exdb_csrf')
    expect(session?.value).toMatch(/^exst_[A-Za-z0-9_-]{43}$/)
    expect(csrf?.value).toMatch(/^exck_[A-Za-z0-9_-]{43}$/)
    expect(attributesOf(session)).toEqual([
      'path=/',
      'secure',
      'httponly',
      'samesite=strict',
      'max-age=43200',
    ])
    expect(attributesOf(csrf)).toEqual(['path=/', 'secure', 'samesite=strict', 'max-age=43200'])
    expect(owner.browser.cookie('__Host-exdb_ceremony')).toBeUndefined()
    for (const cookie of [session, csrf]) {
      expect(cookie?.attributes.toLowerCase()).not.toContain('domain')
    }
    const me = await owner.browser.call('GET', '/api/v1/me')
    expect(me.status).toBe(200)
    expect(me.body.bindings.map((b: { roleId: string }) => b.roleId)).toEqual(['owner'])
    expect(me.response.headers.get('cache-control')).toBe('no-store')
    expect(me.response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    )
    expect(me.response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(me.response.headers.get('x-content-type-options')).toBe('nosniff')
  })
})

describe('request protection', () => {
  it('state changes need the exact Origin and the CSRF token of the session', async () => {
    const b = owner.browser
    for (const options of [
      { origin: null },
      { origin: 'https://evil.example.test' },
      { origin: 'http://db.example.test' },
    ]) {
      const r = await b.call('POST', '/api/v1/me/sessions/revoke-others', {}, options)
      expect(r.status).toBe(403)
      expect(r.body.code).toBe('CSRF_FAILED')
      expect(r.response.headers.get('content-type')).toBe('application/problem+json')
    }
    const crossSite = await b.call(
      'POST',
      '/api/v1/me/sessions/revoke-others',
      {},
      { headers: { 'sec-fetch-site': 'cross-site' } },
    )
    expect(crossSite.body.code).toBe('CSRF_FAILED')
    expect(
      (await b.call('POST', '/api/v1/me/sessions/revoke-others', {}, { csrf: null })).body.code,
    ).toBe('CSRF_FAILED')
    expect(
      (
        await b.call(
          'POST',
          '/api/v1/me/sessions/revoke-others',
          {},
          { csrf: `exck_${'A'.repeat(43)}` },
        )
      ).body.code,
    ).toBe('CSRF_FAILED')
    expect((await b.call('POST', '/api/v1/me/sessions/revoke-others', {})).status).toBe(200)
    // A pre-session ceremony is protected by Origin too.
    expect(
      (await new Browser().call('POST', '/auth/login/passkey/options', {}, { origin: null })).body
        .code,
    ).toBe('CSRF_FAILED')
  })

  it('a bearer token with the session cookie is ambiguous; alone it authenticates nothing yet', async () => {
    const both = await owner.browser.call('GET', '/api/v1/me', undefined, {
      headers: { authorization: 'Bearer exat_x' },
    })
    expect([both.status, both.body.code]).toEqual([400, 'AMBIGUOUS_CREDENTIALS'])
    const bearer = await new Browser().call('GET', '/api/v1/me', undefined, {
      headers: { authorization: 'Bearer exat_x' },
    })
    expect([bearer.status, bearer.body.code]).toEqual([401, 'UNAUTHENTICATED'])
    const none = await new Browser().call('GET', '/api/v1/me')
    expect([none.status, none.body.code]).toEqual([401, 'UNAUTHENTICATED'])
  })

  it('validates bodies against the contract and answers unknown paths with a problem', async () => {
    const r = await new Browser().call('POST', '/auth/login/password', { email: 'not-an-address' })
    expect(r.status).toBe(422)
    expect(r.body.code).toBe('VALIDATION_FAILED')
    expect(r.body.details.errors.length).toBeGreaterThan(0)
    const missing = await new Browser().call('GET', '/api/v1/nothing-here')
    expect([missing.status, missing.body.code]).toEqual([404, 'NOT_FOUND'])
  })

  it('serves the Web App page with its own strict CSP', async () => {
    const page = await app.request(`${ORIGIN}/login`)
    expect(page.status).toBe(200)
    const csp = page.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).not.toContain('unsafe-inline')
    expect(page.headers.get('cache-control')).toBe('no-store')
    expect(page.headers.get('x-frame-options')).toBe('DENY')
  })
})

describe('sessions', () => {
  it('never adopts a planted session value (no fixation) and rotates on re-authentication', async () => {
    const browser = new Browser()
    browser.jar.set('__Host-exdb_session', { value: `exst_${'P'.repeat(43)}`, attributes: '' })
    await signIn(owner.authenticator, browser)
    const issued = browser.cookie('__Host-exdb_session')?.value
    expect(issued).not.toBe(`exst_${'P'.repeat(43)}`)
    const planted = new Browser()
    planted.jar.set('__Host-exdb_session', { value: `exst_${'P'.repeat(43)}`, attributes: '' })
    expect((await planted.call('GET', '/api/v1/me')).body.code).toBe('SESSION_EXPIRED')
    const before = browser.cookie('__Host-exdb_session')?.value
    await reauth(browser, owner.authenticator)
    const after = browser.cookie('__Host-exdb_session')?.value
    expect(after).not.toBe(before)
    const stale = new Browser()
    stale.jar.set('__Host-exdb_session', { value: before ?? '', attributes: '' })
    expect((await stale.call('GET', '/api/v1/me')).body.code).toBe('SESSION_EXPIRED')
    expect((await browser.call('GET', '/api/v1/me')).status).toBe(200)
  })

  it('logout clears the cookies and ends the session; revoking ends another session', async () => {
    const browser = await signIn(owner.authenticator)
    const token = browser.cookie('__Host-exdb_session')?.value ?? ''
    const out = await browser.call('POST', '/auth/logout', {})
    expect(out.status).toBe(200)
    const cleared = out.response.headers.getSetCookie()
    expect(cleared.some((c) => c.startsWith('__Host-exdb_session=;') && /max-age=0/i.test(c))).toBe(
      true,
    )
    const replay = new Browser()
    replay.jar.set('__Host-exdb_session', { value: token, attributes: '' })
    expect((await replay.call('GET', '/api/v1/me')).body.code).toBe('SESSION_EXPIRED')

    const second = await signIn(owner.authenticator)
    const list = await owner.browser.call('GET', '/api/v1/me/sessions')
    const other = list.body.items.find((s: { current: boolean }) => !s.current)
    expect(other).toBeDefined()
    expect(
      (await owner.browser.call('POST', `/api/v1/me/sessions/${other.id}/revoke`, {})).body,
    ).toEqual({ revoked: 1 })
    expect((await second.call('GET', '/api/v1/me')).status).toBe(401)
  })

  it('an idle session expires after 30 minutes on the database clock', async () => {
    const browser = await signIn(owner.authenticator)
    const me = await browser.call('GET', '/api/v1/me')
    await db.asSuperuser(async (c) => {
      await c.query('BEGIN')
      await c.query('SET LOCAL session_replication_role = replica')
      await c.query(
        `UPDATE auth.web_sessions SET last_seen_at = last_seen_at - interval '31 minutes' WHERE session_id = $1`,
        [me.body.session.id],
      )
      await c.query('COMMIT')
    })
    expect((await browser.call('GET', '/api/v1/me')).body.code).toBe('SESSION_EXPIRED')
  })
})

describe('sign-in', () => {
  it('the password step reveals nothing about accounts or passwords', async () => {
    const shapes = []
    for (const [email, password] of [
      ['owner@example.test', PASSWORD],
      ['owner@example.test', 'not the password at all'],
      ['nobody@example.test', PASSWORD],
    ]) {
      const browser = new Browser()
      const r = await browser.call('POST', '/auth/login/password', { email, password })
      shapes.push({
        status: r.status,
        body: r.text,
        cookies: r.response.headers.getSetCookie().map((c) => c.replace(/=[^;]*/, '=*')),
      })
    }
    expect(shapes[1]).toEqual(shapes[0])
    expect(shapes[2]).toEqual(shapes[0])
  })
})

describe('access management over HTTP', () => {
  let invitee: Awaited<ReturnType<typeof enroll>>

  it('invites (fresh re-authentication), plans and applies a role binding, executed by the worker', async () => {
    const tooOld = await owner.browser.call('POST', '/api/v1/identities', {
      email: 'viewer@example.test',
    })
    expect([tooOld.status, tooOld.body.code]).toEqual([401, 'REAUTH_REQUIRED'])
    await reauth(owner.browser, owner.authenticator)
    const invited = await owner.browser.call('POST', '/api/v1/identities', {
      email: 'viewer@example.test',
    })
    expect(invited.status).toBe(201)
    expect(invited.body.invitation.delivery).toEqual({ status: 'not_configured', channel: 'none' })
    expect(invited.body.identity.state).toBe('invited')
    invitee = await enroll(invited.body.invitation.link, 'viewer@example.test')

    const plan = await owner.browser.call(
      'POST',
      '/api/v1/role-bindings',
      { identityId: invitee.identityId, roleId: 'admin', scope: { kind: 'global' } },
      { headers: { 'idempotency-key': 'grant-admin-1' } },
    )
    expect(plan.status).toBe(201)
    expect(plan.body.state).toBe('active')
    expect(plan.body.change.content.roleId).toBe('admin')
    const replay = await owner.browser.call(
      'POST',
      '/api/v1/role-bindings',
      { identityId: invitee.identityId, roleId: 'admin', scope: { kind: 'global' } },
      { headers: { 'idempotency-key': 'grant-admin-1' } },
    )
    expect(replay.body.id).toBe(plan.body.id)
    const applied = await owner.browser.call('POST', `/api/v1/plans/${plan.body.id}/apply`, {})
    expect(applied.status).toBe(202)
    expect(applied.body.state).toBe('queued')
    await runWorker()
    const bindings = await owner.browser.call(
      'GET',
      `/api/v1/role-bindings?identity=${invitee.identityId}`,
    )
    expect(bindings.body.items.map((b: { roleId: string }) => b.roleId)).toEqual(['admin'])
    expect((await invitee.browser.call('GET', '/api/v1/identities')).status).toBe(200)
  })

  it('a removed binding takes effect on the next request (no stale privileges)', async () => {
    const bindings = await owner.browser.call(
      'GET',
      `/api/v1/role-bindings?identity=${invitee.identityId}`,
    )
    const id = bindings.body.items[0].id
    const plan = await owner.browser.call('DELETE', `/api/v1/role-bindings/${id}`)
    expect(plan.status).toBe(201)
    await reauth(owner.browser, owner.authenticator)
    expect(
      (await owner.browser.call('POST', `/api/v1/plans/${plan.body.id}/apply`, {})).status,
    ).toBe(202)
    await runWorker()
    const denied = await invitee.browser.call('GET', '/api/v1/identities')
    expect([denied.status, denied.body.code]).toEqual([403, 'PERMISSION_DENIED'])
  })

  it('a disabled identity loses its session at once; the last owner cannot be disabled', async () => {
    const disabled = await owner.browser.call(
      'POST',
      `/api/v1/identities/${invitee.identityId}/disable`,
      {
        reason: 'test',
      },
    )
    expect(disabled.status).toBe(200)
    expect(disabled.body.state).toBe('disabled')
    expect((await invitee.browser.call('GET', '/api/v1/me')).body.code).toBe('SESSION_EXPIRED')
    const self = await owner.browser.call(
      'POST',
      `/api/v1/identities/${owner.identityId}/disable`,
      {},
    )
    expect([self.status, self.body.code]).toEqual([403, 'POLICY_DENIED'])
    expect(self.body.details.rules.map((r: { id: string }) => r.id)).toContain('access.last-owner')
  })

  it('an erasure waits for approval: the queue shows the exact change; a critical self-approval cools on the server', async () => {
    await reauth(owner.browser, owner.authenticator)
    const plan = await owner.browser.call(
      'POST',
      `/api/v1/identities/${invitee.identityId}/erasure-plans`,
      {},
    )
    expect([plan.status, plan.body.class]).toEqual([201, 'critical'])
    const applied = await owner.browser.call('POST', `/api/v1/plans/${plan.body.id}/apply`, {})
    expect([applied.status, applied.body.state]).toEqual([202, 'awaiting_approval'])
    expect(applied.body.approvalUrl).toBe(`${ORIGIN}/approvals#operation=${applied.body.id}`)

    const queue = await owner.browser.call('GET', '/api/v1/approvals')
    expect(queue.status).toBe(200)
    expect(queue.body.items).toEqual([
      expect.objectContaining({
        operationId: applied.body.id,
        planHash: plan.body.planHash,
        class: 'critical',
        ownPlan: true,
        required: 1,
        change: expect.objectContaining({ content: { identityId: invitee.identityId } }),
      }),
    ])

    const path = `/api/v1/approvals/${applied.body.id}/approve`
    const unacknowledged = await owner.browser.call('POST', path, { planHash: plan.body.planHash })
    expect(unacknowledged.body.code).toBe('SELF_APPROVAL_UNACKNOWLEDGED')
    const otherHash = await owner.browser.call('POST', path, {
      planHash: `sha256:${'0'.repeat(64)}`,
      acknowledgeSelfApproval: true,
    })
    expect(otherHash.body.code).toBe('PLAN_STALE')
    const approved = await owner.browser.call('POST', path, {
      planHash: plan.body.planHash,
      acknowledgeSelfApproval: true,
    })
    expect(approved.status).toBe(200)
    expect(approved.body.selfApproval).toBe(true)
    expect(Date.parse(approved.body.notBefore) - Date.parse(approved.body.decidedAt)).toBe(600_000)
    const early = await owner.browser.call('POST', `/api/v1/plans/${plan.body.id}/apply`, {})
    expect(early.body.code).toBe('APPROVAL_COOLING_PERIOD')
  })
})

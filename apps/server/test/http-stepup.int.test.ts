import { bootstrapOwner, totpCodeAt } from '@exponetdb/auth'
import { SoftAuthenticator } from '@exponetdb/auth/testing'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { newId, systemClock } from '@exponetdb/kernel'
import { initPki } from '@exponetdb/nodes'
import { createLogger, MetricsRegistry } from '@exponetdb/observability'
import { KindRegistry, processNextOperation } from '@exponetdb/operations'
import {
  generateKeyringText,
  type Keyring,
  parseKeyring,
  registerActiveKey,
} from '@exponetdb/secrets'
import { Secret } from 'otpauth'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { composeAccess, workerKinds } from '../src/composition/access.ts'
import type { ServeConfig } from '../src/config/env.ts'
import { createPublicApp, httpMetrics } from '../src/interfaces/http/app.ts'

/**
 * CLI step-ups over HTTP (ADR-0026), real PostgreSQL 17: a person's
 * first-party CLI asks for a step-up for one bound action, the same person
 * confirms it in the Web App with the code and a fresh re-authentication,
 * and the bound request redeems the receipt once. Covered: a stale second
 * factor, a wrong code (attempts), a cross-origin confirmation, a receipt
 * for another plan or another grant, a replay, an expired receipt, a
 * revoked grant, and the enrollment token's reveal through the CLI.
 */
const ORIGIN = 'https://db.example.test'
const RP_ID = 'db.example.test'
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'
const PASSWORD = 'tangerine fjord radiator 42'
const CLI_REDIRECT = 'http://127.0.0.1:51234/callback'
const SCOPES = 'targets.read nodes.read nodes.plan registry.manage'

let db: MigratedTestDatabase
let keyring: Keyring
let app: ReturnType<typeof createPublicApp>
let kinds: KindRegistry
let owner: { browser: Browser; authenticator: SoftAuthenticator }
let serverId = ''

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_http_stepup')
  const parsed = parseKeyring(generateKeyringText('test-key'))
  if (!parsed.ok) throw new Error('keyring')
  keyring = parsed.value
  const serve = db.store('exdb_serve')
  const worker = db.store('exdb_worker')
  await registerActiveKey(worker, keyring)
  await worker.transaction('test.pki', (tx) =>
    initPki(tx, keyring, systemClock, {
      gatewayUrl: 'https://10.8.2.2:7443',
      serverName: 'gateway.exdb.test',
    }),
  )
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
    egressAddresses: [],
  }
  const logger = createLogger({ role: 'serve', level: 'warn', write: () => undefined })
  const access = composeAccess(config, { store: serve, keyring }, { clock: systemClock })
  expect((await access.roleCatalogCheck.run()).status).toBe('pass')
  expect((await access.scopeCatalogCheck.run()).status).toBe('pass')
  app = createPublicApp(
    {
      readiness: () => ({ status: 'ready', evaluatedAt: new Date().toISOString(), checks: [] }),
      version: '0.0.0-test',
      logger,
      metrics: httpMetrics(new MetricsRegistry()),
      clock: systemClock,
    },
    {
      api: {
        application: access.application,
        publicOrigin: ORIGIN,
        trustedProxies: [],
        logger,
        available: access.available,
      },
    },
  )
  kinds = new KindRegistry(
    workerKinds({ store: worker, keyring }, { clock: systemClock }, db.installationId),
  )
  owner = await enrollOwner()
  await reauth()
  const planned = await owner.browser.call('POST', '/api/v1/servers', {
    displayName: 'db host',
    provider: 'other',
  })
  expect(planned.status).toBe(201)
  expect(
    (await owner.browser.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})).status,
  ).toBe(202)
  await drive()
  serverId = (await owner.browser.call('GET', '/api/v1/servers')).body.items[0].id
}, 120_000)

afterAll(async () => {
  await db?.drop()
})

class Browser {
  readonly jar = new Map<string, string>()

  async call(method: string, path: string, body?: unknown, origin = ORIGIN) {
    const headers: Record<string, string> = { 'user-agent': UA }
    if (this.jar.size > 0) headers['cookie'] = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
    if (method !== 'GET') {
      headers['origin'] = origin
      const csrf = this.jar.get('__Host-exdb_csrf')
      if (csrf !== undefined) headers['x-csrf-token'] = csrf
    }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await app.request(`${ORIGIN}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';')
      const index = (pair ?? '').indexOf('=')
      const name = (pair ?? '').slice(0, index)
      if (/max-age=0/i.test(line)) this.jar.delete(name)
      else this.jar.set(name, (pair ?? '').slice(index + 1))
    }
    const text = await response.text()
    return {
      status: response.status,
      body: text.length === 0 ? undefined : JSON.parse(text),
      response,
    }
  }
}

async function enrollOwner() {
  const issued = await bootstrapOwner(
    {
      store: db.store('exdb_serve'),
      clock: systemClock,
      config: { publicOrigin: ORIGIN, rpId: RP_ID, rpName: 'ExponetDB' },
      channel: undefined,
    },
    { email: 'owner@example.test', reissue: false },
  )
  return enrollWithLink(issued.link)
}

/** A person completes enrollment from a one-time link (passkey, password, TOTP). */
async function enrollWithLink(link: string) {
  const browser = new Browser()
  const token = new URL(link).hash.replace('#token=', '')
  expect((await browser.call('POST', '/auth/enrollment/redeem', { token })).status).toBe(200)
  const options = await browser.call('POST', '/auth/enrollment/passkey/options', {})
  const authenticator = new SoftAuthenticator(
    new Uint8Array(Buffer.from(options.body.user.id, 'base64url')),
  )
  const credential = authenticator.register({
    challenge: options.body.challenge,
    origin: ORIGIN,
    rpId: RP_ID,
  })
  await browser.call('POST', '/auth/enrollment/passkey', { credential, label: 'Laptop' })
  await browser.call('POST', '/auth/enrollment/password', { password: PASSWORD })
  const setup = await browser.call('POST', '/auth/enrollment/totp/options', {})
  const secret = Secret.fromBase32(setup.body.secret).bytes
  await browser.call('POST', '/auth/enrollment/totp', { code: totpCodeAt(secret, Date.now()) })
  expect((await browser.call('POST', '/auth/enrollment/complete', {})).status).toBe(200)
  return { browser, authenticator }
}

async function reauth() {
  const options = await owner.browser.call('POST', '/auth/reauth/passkey/options', {})
  const credential = owner.authenticator.assert({
    challenge: options.body.challenge,
    origin: ORIGIN,
    rpId: RP_ID,
  })
  expect((await owner.browser.call('POST', '/auth/reauth/passkey', { credential })).status).toBe(
    200,
  )
}

/** Test-only aging of the session's re-authentication, as the auth suites do. */
async function staleReauth() {
  await db.asSuperuser(async (c) => {
    await c.query('BEGIN')
    await c.query('SET LOCAL session_replication_role = replica')
    await c.query(`UPDATE auth.reauth_events SET occurred_at = occurred_at - interval '10 minutes'`)
    await c.query(
      `UPDATE auth.web_sessions SET reauth_at = reauth_at - interval '10 minutes' WHERE reauth_at IS NOT NULL`,
    )
    await c.query('COMMIT')
  })
}

async function drive() {
  for (let i = 0; i < 20; i++) {
    const r = await processNextOperation(db.store('exdb_worker'), {
      workerId: newId('prc', Date.now()),
      kinds,
      clock: systemClock,
    })
    if (r.status === 'idle') return
  }
}

async function form(path: string, fields: Record<string, string>) {
  const response = await app.request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  })
  const text = await response.text()
  return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text) }
}

/** The first-party CLI's loopback sign-in, driven through the owner's browser. */
async function cliToken(): Promise<string> {
  await reauth()
  const verifier =
    'v'.repeat(20) + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
  const challenge = Buffer.from(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  ).toString('base64url')
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: 'exponetdb-cli',
    redirect_uri: CLI_REDIRECT,
    scope: SCOPES,
    state: 'cli-state',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${ORIGIN}/api`,
  })
  const authorize = await owner.browser.call('GET', `/oauth/authorize?${query.toString()}`)
  const location = authorize.response.headers.get('location') ?? ''
  const request = location.slice(location.indexOf('#request=') + '#request='.length)
  expect((await owner.browser.call('POST', '/auth/oauth/consent/view', { request })).status).toBe(
    200,
  )
  const decided = await owner.browser.call('POST', '/auth/oauth/consent', {
    request,
    decision: 'allow',
    scopes: SCOPES.split(' '),
    tiers: ['nonprod', 'prod'],
    lifetimeDays: 30,
    acknowledgeProduction: true,
  })
  expect(decided.status, JSON.stringify(decided.body)).toBe(200)
  const redirect = new URL(decided.body.redirectTo)
  const issued = await form('/oauth/token', {
    grant_type: 'authorization_code',
    client_id: 'exponetdb-cli',
    code: redirect.searchParams.get('code') ?? '',
    redirect_uri: CLI_REDIRECT,
    code_verifier: verifier,
  })
  expect(issued.status).toBe(200)
  return issued.body.access_token
}

async function cli(token: string, method: string, path: string, body?: unknown, stepUp?: string) {
  const response = await app.request(`${ORIGIN}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(stepUp === undefined ? {} : { 'exponetdb-step-up': stepUp }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text) }
}

/** The person confirms a step-up in the browser with the code the CLI shows. */
async function confirm(stepUpId: string, userCode: string, origin = ORIGIN) {
  return owner.browser.call('POST', `/api/v1/step-ups/${stepUpId}/confirm`, { userCode }, origin)
}

async function enrollPlan(token: string) {
  const planned = await cli(token, 'POST', `/api/v1/servers/${serverId}/nodes/enroll`, {})
  expect([planned.status, planned.body?.code]).toEqual([201, undefined])
  return planned.body
}

describe('CLI step-up (ADR-0026)', () => {
  let token = ''

  it('applies a node.enroll plan from the CLI only with a confirmed, bound receipt', async () => {
    token = await cliToken()
    const plan = await enrollPlan(token)
    // Without a receipt: a bearer token proves no presence.
    expect((await cli(token, 'POST', `/api/v1/plans/${plan.id}/apply`, {})).body.code).toBe(
      'REAUTH_REQUIRED',
    )
    const requested = await cli(token, 'POST', '/api/v1/step-ups', {
      action: 'plan.apply',
      planId: plan.id,
    })
    expect(requested.status).toBe(201)
    expect(requested.body).toMatchObject({
      id: expect.stringMatching(/^stu_/),
      action: 'plan.apply',
      state: 'pending',
      planHash: plan.planHash,
      verificationUri: `${ORIGIN}/step-up#id=${requested.body.id}`,
      userCode: expect.stringMatching(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/),
      clientName: expect.any(String),
    })
    const { id, userCode } = requested.body
    // The browser view never repeats the code.
    expect((await owner.browser.call('GET', `/api/v1/step-ups/${id}`)).body).toMatchObject({
      state: 'pending',
      userCode: null,
    })
    // A receipt that is not confirmed yet does not count.
    expect((await cli(token, 'POST', `/api/v1/plans/${plan.id}/apply`, {}, id)).body.code).toBe(
      'REAUTH_REQUIRED',
    )
    // A cross-origin confirmation is refused; so is one without a fresh second factor.
    expect((await confirm(id, userCode, 'https://evil.example.test')).body.code).toBe('CSRF_FAILED')
    await staleReauth()
    expect((await confirm(id, userCode)).body.code).toBe('REAUTH_REQUIRED')
    await reauth()
    // A wrong code counts as an attempt and changes nothing else.
    const wrong = await confirm(id, 'ZZZZ-ZZZZ')
    expect(wrong.body.code).toBe('VALIDATION_FAILED')
    const attempts = await db.asSuperuser((c) =>
      c.query('SELECT attempts, state FROM stepup.step_ups WHERE step_up_id = $1', [id]),
    )
    expect(attempts.rows[0]).toEqual({ attempts: 1, state: 'pending' })
    const confirmed = await confirm(id, userCode.toLowerCase().replace('-', ''))
    expect(confirmed.status).toBe(200)
    expect(confirmed.body).toMatchObject({
      state: 'confirmed',
      receiptExpiresAt: expect.any(String),
    })
    // Redeemed once with the bound apply.
    const applied = await cli(token, 'POST', `/api/v1/plans/${plan.id}/apply`, {}, id)
    expect(applied.status, JSON.stringify(applied.body)).toBe(202)
    expect((await cli(token, 'GET', `/api/v1/step-ups/${id}`)).body.state).toBe('redeemed')
    await drive()
    expect((await cli(token, 'GET', `/api/v1/operations/${applied.body.id}`)).body).toMatchObject({
      state: 'succeeded',
      actor: { kind: 'human', via: 'cli' },
    })
    const audit = await db.asSuperuser((c) =>
      c.query(`SELECT action FROM audit.audit_events WHERE action LIKE 'step_up.%' ORDER BY seq`),
    )
    expect(audit.rows.map((r) => r.action)).toEqual([
      'step_up.requested',
      'step_up.confirmed',
      'step_up.redeemed',
    ])
    expect(
      JSON.stringify(await db.asSuperuser((c) => c.query('SELECT event FROM audit.audit_events'))),
    ).not.toContain(userCode)

    // The reveal through the CLI: its own step-up, bound to the token; once.
    const tokenId: string = plan.change.content.tokenId
    expect(
      (await cli(token, 'POST', `/api/v1/enrollment-tokens/${tokenId}/reveal`, {})).body.code,
    ).toBe('REAUTH_REQUIRED')
    // The redeemed receipt is not a proof for anything else.
    expect(
      (await cli(token, 'POST', `/api/v1/enrollment-tokens/${tokenId}/reveal`, {}, id)).body.code,
    ).toBe('REAUTH_REQUIRED')
    const reveal = await cli(token, 'POST', '/api/v1/step-ups', {
      action: 'node.enrollment_token.reveal',
      tokenId,
    })
    expect(reveal.status).toBe(201)
    await reauth()
    expect((await confirm(reveal.body.id, reveal.body.userCode)).status).toBe(200)
    const revealed = await cli(
      token,
      'POST',
      `/api/v1/enrollment-tokens/${tokenId}/reveal`,
      {},
      reveal.body.id,
    )
    expect(revealed.status, JSON.stringify(revealed.body)).toBe(200)
    expect(revealed.body.token).toMatch(/^exdbt1\./)
    expect(
      (await cli(token, 'POST', `/api/v1/enrollment-tokens/${tokenId}/reveal`, {}, reveal.body.id))
        .status,
    ).toBe(401)
  })

  it('refuses a receipt for another plan, from another grant, after its expiry, and a step-up no action needs', async () => {
    const other = await cliToken()
    const first = await enrollPlan(token)
    const second = await enrollPlan(token)
    const requested = await cli(token, 'POST', '/api/v1/step-ups', {
      action: 'plan.apply',
      planId: first.id,
    })
    await reauth()
    expect((await confirm(requested.body.id, requested.body.userCode)).status).toBe(200)
    // Another plan (another plan hash): not this receipt.
    expect(
      (await cli(token, 'POST', `/api/v1/plans/${second.id}/apply`, {}, requested.body.id)).body
        .code,
    ).toBe('REAUTH_REQUIRED')
    // Another grant of the same person and client: not this receipt either.
    expect(
      (await cli(other, 'POST', `/api/v1/plans/${first.id}/apply`, {}, requested.body.id)).body
        .code,
    ).toBe('REAUTH_REQUIRED')
    // Expired: the receipt lasts 120 seconds after the confirmation.
    await db.asSuperuser(async (c) => {
      await c.query('BEGIN')
      await c.query('SET LOCAL session_replication_role = replica')
      await c.query(
        `UPDATE stepup.step_ups SET confirmed_at = confirmed_at - interval '5 minutes',
                receipt_expires_at = receipt_expires_at - interval '5 minutes' WHERE step_up_id = $1`,
        [requested.body.id],
      )
      await c.query('COMMIT')
    })
    expect(
      (await cli(token, 'POST', `/api/v1/plans/${first.id}/apply`, {}, requested.body.id)).body
        .code,
    ).toBe('REAUTH_REQUIRED')
    expect((await cli(token, 'GET', `/api/v1/step-ups/${requested.body.id}`)).body.state).toBe(
      'expired',
    )
    // A server plan needs no fresh proof: no step-up for it.
    const server = await cli(token, 'POST', '/api/v1/servers', {
      displayName: 'other host',
      provider: 'other',
    })
    expect(server.status).toBe(201)
    expect(
      (
        await cli(token, 'POST', '/api/v1/step-ups', {
          action: 'plan.apply',
          planId: server.body.id,
        })
      ).body.code,
    ).toBe('CONFLICT')
    // An unknown action, and an enrollment token of nobody's reach, are refused.
    expect(
      (await cli(token, 'POST', '/api/v1/step-ups', { action: 'plan.withdraw' })).body.code,
    ).toBe('VALIDATION_FAILED')
    expect(
      (
        await cli(token, 'POST', '/api/v1/step-ups', {
          action: 'node.enrollment_token.reveal',
          tokenId: `ent_${'0'.repeat(26)}`,
        })
      ).body.code,
    ).toBe('NOT_FOUND')
  })

  it('ends a step-up after five wrong codes, refuses a revoked grant, and never lets a session redeem', async () => {
    const plan = await enrollPlan(token)
    const requested = await cli(token, 'POST', '/api/v1/step-ups', {
      action: 'plan.apply',
      planId: plan.id,
    })
    await reauth()
    for (let i = 0; i < 4; i++) {
      expect((await confirm(requested.body.id, 'ZZZZ-ZZZZ')).body.code).toBe('VALIDATION_FAILED')
    }
    expect((await confirm(requested.body.id, 'ZZZZ-ZZZZ')).body.code).toBe('CONFLICT')
    expect((await confirm(requested.body.id, requested.body.userCode)).body.code).toBe('CONFLICT')
    expect((await cli(token, 'GET', `/api/v1/step-ups/${requested.body.id}`)).body.state).toBe(
      'refused',
    )
    // A Web App session never names a receipt.
    const session = await app.request(`${ORIGIN}/api/v1/plans/${plan.id}/apply`, {
      method: 'POST',
      headers: { 'exponetdb-step-up': requested.body.id, origin: ORIGIN },
    })
    expect(session.status).toBe(422)
    expect(((await session.json()) as { code: string }).code).toBe('VALIDATION_FAILED')
    // A step-up pending when the grant is revoked cannot be confirmed.
    const pending = await cli(token, 'POST', '/api/v1/step-ups', {
      action: 'plan.apply',
      planId: plan.id,
    })
    const grants = await owner.browser.call('GET', '/api/v1/me/grants')
    for (const g of grants.body.items) {
      await owner.browser.call('POST', `/api/v1/me/grants/${g.id}/revoke`, {})
    }
    await reauth()
    expect((await confirm(pending.body.id, pending.body.userCode)).body.code).toBe('CONFLICT')
    const refused = await db.asSuperuser((c) =>
      c.query('SELECT state, refused_reason FROM stepup.step_ups WHERE step_up_id = $1', [
        pending.body.id,
      ]),
    )
    expect(refused.rows[0]).toEqual({ state: 'refused', refused_reason: 'grant_revoked' })
    // The binding never changes, and a step-up is never deleted.
    const guard = await db
      .asSuperuser((c) =>
        c.query(
          `UPDATE stepup.step_ups SET action = 'plan.apply', plan_hash = NULL WHERE step_up_id = $1`,
          [pending.body.id],
        ),
      )
      .catch((e: unknown) => e)
    expect(String(guard)).toMatch(/keeps its binding|violates check constraint/)
  })

  it('never lets a machine credential create or redeem a step-up', async () => {
    await reauth()
    const account = await owner.browser.call('POST', '/api/v1/service-accounts', {
      displayName: 'Deploy bot',
    })
    expect(account.status).toBe(201)
    await reauth()
    const key = await owner.browser.call(
      'POST',
      `/api/v1/service-accounts/${account.body.id}/api-keys`,
      {
        scopes: ['targets.read'],
        restrictions: { tiers: ['nonprod'], targets: { kind: 'all' } },
        lifetimeDays: 30,
      },
    )
    expect(key.status).toBe(201)
    const machine = await cli(key.body.secret, 'POST', '/api/v1/step-ups', {
      action: 'node.enrollment_token.reveal',
      tokenId: `ent_${'0'.repeat(26)}`,
    })
    expect([machine.status, machine.body.code]).toEqual([403, 'PERMISSION_DENIED'])
  })

  it('answers another signed-in person as if the step-up did not exist', async () => {
    await reauth()
    const invited = await owner.browser.call('POST', '/api/v1/identities', {
      email: 'colleague@example.test',
      displayName: 'Colleague',
    })
    expect(invited.status, JSON.stringify(invited.body)).toBe(201)
    const colleague = await enrollWithLink(invited.body.invitation.link)
    const fresh = await cliToken()
    const plan = await enrollPlan(fresh)
    const requested = await cli(fresh, 'POST', '/api/v1/step-ups', {
      action: 'plan.apply',
      planId: plan.id,
    })
    expect(requested.status).toBe(201)
    const options = await colleague.browser.call('POST', '/auth/reauth/passkey/options', {})
    const credential = colleague.authenticator.assert({
      challenge: options.body.challenge,
      origin: ORIGIN,
      rpId: RP_ID,
    })
    expect(
      (await colleague.browser.call('POST', '/auth/reauth/passkey', { credential })).status,
    ).toBe(200)
    expect(
      (await colleague.browser.call('GET', `/api/v1/step-ups/${requested.body.id}`)).status,
    ).toBe(404)
    const foreign = await colleague.browser.call(
      'POST',
      `/api/v1/step-ups/${requested.body.id}/confirm`,
      {
        userCode: requested.body.userCode,
      },
    )
    expect([foreign.status, foreign.body.code]).toEqual([404, 'NOT_FOUND'])
    expect((await cli(fresh, 'GET', `/api/v1/step-ups/${requested.body.id}`)).body.state).toBe(
      'pending',
    )
  })
})

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isAuthError, oauth, type SessionContext } from '../src/index.ts'
import { invitePerson, signIn } from './support/access.ts'
import {
  age,
  type Enrolled,
  enrollFirstOwner,
  type Harness,
  harness,
  meta,
  ORIGIN,
} from './support/flows.ts'

/**
 * The device authorization grant (RFC 8628) against PostgreSQL 17: the
 * first-party CLI starts, the person verifies the user code in a Web App
 * session, the CLI polls (pending, slow_down, then tokens once); denial,
 * expiry, wrong clients and code guessing are refused.
 */
let h: Harness
let owner: Enrolled
let session: SessionContext

let ip = 0
const m = () => {
  ip += 1
  return meta(`198.51.${Math.floor(ip / 250)}.${(ip % 250) + 1}`)
}

const deps = () => ({ auth: h.deps, grants: { deviceCode: oauth.deviceCodeGrant } })

function form(fields: Record<string, string>): oauth.TokenRequest {
  return {
    body: new URLSearchParams(fields).toString(),
    contentType: 'application/x-www-form-urlencoded',
    authorizationHeader: false,
  }
}

async function start(fields: Record<string, string> = {}) {
  return oauth.startDeviceAuthorization(
    deps(),
    m(),
    form({
      client_id: 'exponetdb-cli',
      scope: 'targets.read',
      resource: `${ORIGIN}/api`,
      ...fields,
    }),
  )
}

async function poll(deviceCode: string, clientId = 'exponetdb-cli') {
  return oauth.tokenEndpoint(
    deps(),
    m(),
    form({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId,
      device_code: deviceCode,
    }),
  )
}

async function oauthError(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    if (error instanceof oauth.OAuthError) return error.error
    if (isAuthError(error)) return error.code
    throw error
  }
}

async function verify(userCode: string, decision: 'allow' | 'deny' = 'allow', who = session) {
  await oauth.countDeviceAttempt(h.deps, who)
  return h.deps.store.transaction('test.device', (tx) =>
    oauth.decideDevice(tx, h.deps, m(), who, {
      userCode,
      decision,
      scopes: ['targets.read'],
      tiers: ['nonprod'],
      lifetimeDays: 30,
    }),
  )
}

/** Moves the last poll back so the next one is within the interval. */
async function waitInterval() {
  await age(
    h,
    `UPDATE oauth.device_codes SET last_polled_at = last_polled_at - interval '2 minutes'`,
    [],
  )
}

beforeAll(async () => {
  h = await harness('exdb_it_auth_oauth_device')
  owner = await enrollFirstOwner(h)
  session = await signIn(h, owner)
})

afterAll(async () => {
  await h?.db.drop()
})

describe('device authorization (RFC 8628)', () => {
  it('starts a device authorization for the CLI only, without a complete verification URI', async () => {
    const started = await start()
    expect(started.device_code).toMatch(/^exdc_[A-Za-z0-9_-]{43}$/)
    expect(started.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/)
    expect(started.verification_uri).toBe(`${ORIGIN}/oauth/device`)
    expect(started).not.toHaveProperty('verification_uri_complete')
    expect(started.expires_in).toBe(600)
    expect(started.interval).toBe(5)
    expect(await oauthError(start({ scope: 'plans.approve' }))).toBe('invalid_scope')
    expect(await oauthError(start({ resource: `${ORIGIN}/mcp` }))).toBe('invalid_target')
    // The Web App is a known public client, but never a device client.
    expect(await oauthError(start({ client_id: 'exponetdb-web' }))).toBe('unauthorized_client')
    expect(await oauthError(start({ client_id: 'unknown' }))).toBe('invalid_client')
  })

  it('answers pending, slows a fast poller down, then issues tokens exactly once', async () => {
    const started = await start()
    expect(await oauthError(poll(started.device_code))).toBe('authorization_pending')
    expect(await oauthError(poll(started.device_code))).toBe('slow_down')
    const { rows } = await h.db.asSuperuser((c) =>
      c.query('SELECT interval_seconds FROM oauth.device_codes ORDER BY device_id DESC LIMIT 1'),
    )
    expect(rows[0]?.interval_seconds).toBe(10)
    expect(await verify(started.user_code.toLowerCase())).toEqual({ status: 'approved' })
    await waitInterval()
    const tokens = await poll(started.device_code)
    expect(tokens.access_token).toMatch(/^exat_/)
    expect(tokens.refresh_token).toMatch(/^exrt_/)
    expect(tokens.scope).toBe('targets.read')
    await waitInterval()
    expect(await oauthError(poll(started.device_code))).toBe('invalid_grant')
    // The code was decided once.
    expect(await oauthError(verify(started.user_code))).toBe('USER_CODE_INVALID')
  })

  it('never loses an approval that lands while a poll reads: pending, then tokens (no orphaned grant)', async () => {
    const started = await start()
    const cli = await oauth.readClientByExternalId(h.deps.store, 'exponetdb-cli')
    if (cli === undefined) throw new Error('no CLI client')
    const params = oauth.parseForm(
      form({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: 'exponetdb-cli',
        device_code: started.device_code,
      }),
    )
    let approved = false
    const outcome = await h.deps.store.transaction('test.device.race', (tx) => {
      // The approval commits between the poll's unlocked read and its row lock.
      const racing = new Proxy(tx, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver)
          if (prop !== 'query' || typeof value !== 'function') {
            return value
          }
          return async (name: string, ...rest: unknown[]) => {
            if (name === 'oauth.device.poll' && !approved) {
              approved = true
              expect(await verify(started.user_code)).toEqual({ status: 'approved' })
            }
            return value.call(target, name, ...rest)
          }
        },
      })
      return oauth.deviceCodeGrant(racing, cli, params)
    })
    expect(approved).toBe(true)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.error).toBe('authorization_pending')
    }
    await waitInterval()
    expect((await poll(started.device_code)).access_token).toMatch(/^exat_/)
  })

  it('reports a denial and an expiry', async () => {
    const denied = await start()
    expect(await verify(denied.user_code, 'deny')).toEqual({ status: 'denied' })
    expect(await oauthError(poll(denied.device_code))).toBe('access_denied')
    const late = await start()
    await age(
      h,
      `UPDATE oauth.device_codes SET created_at = created_at - interval '11 minutes',
              expires_at = expires_at - interval '11 minutes' WHERE state = 'pending'`,
      [],
    )
    expect(await oauthError(poll(late.device_code))).toBe('expired_token')
    expect(await oauthError(verify(late.user_code))).toBe('USER_CODE_INVALID')
  })

  it('never hands a device code to another client, nor tokens of a revoked grant', async () => {
    const started = await start()
    expect(await oauthError(poll(`exdc_${'A'.repeat(43)}`))).toBe('invalid_grant')
    await verify(started.user_code)
    await h.withoutGuards(async (c) => {
      await c.query(
        `UPDATE oauth.grants SET state = 'revoked', revoked_at = now(), revoke_reason = 'owner'
          WHERE grant_id = (SELECT grant_id FROM oauth.device_codes ORDER BY device_id DESC LIMIT 1)`,
      )
    })
    await waitInterval()
    expect(await oauthError(poll(started.device_code))).toBe('invalid_grant')
  })

  it('refuses a person who holds nothing, and counts every guess', async () => {
    const nobody = await invitePerson(h, session, 'nobody-device@example.test')
    const nobodySession = await signIn(h, nobody)
    const started = await start()
    expect(await oauthError(verify(started.user_code, 'allow', nobodySession))).toBe(
      'SCOPE_NOT_DELEGABLE',
    )
    const results: (string | undefined)[] = []
    for (let i = 0; i < 12; i++) {
      results.push(await oauthError(verify('BCDF-GHJK', 'allow', nobodySession)))
    }
    expect(results.slice(0, 8).every((r) => r === 'USER_CODE_INVALID')).toBe(true)
    expect(results.slice(-1)).toEqual(['RATE_LIMITED'])
    // Even the right code is refused while the person is limited.
    expect(await oauthError(verify(started.user_code, 'allow', nobodySession))).toBe('RATE_LIMITED')
    expect(oauth.normalizeUserCode('bcdf ghjk')).toBe('BCDFGHJK')
    expect(oauth.normalizeUserCode('BCDF-GHJA')).toBeUndefined()
  })
})

import { verifyAuditChain } from '@exponetdb/audit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bootstrapOwner,
  enrollment,
  isAuthError,
  loadSession,
  type OperatorDeps,
} from '../src/index.ts'
import { SoftAuthenticator } from './support/authenticator.ts'
import {
  age,
  ceremonyHandle,
  decodeBase32,
  errorCode,
  type Harness,
  harness,
  meta,
  ORIGIN,
  PASSWORD,
  RP_ID,
  tokenOf,
  totpNow,
  UA,
  value,
} from './support/flows.ts'

/**
 * First-owner bootstrap (G3A item 5) against PostgreSQL 17: the setup
 * link, its exact 30-minute lifetime, single use, the explicit re-issue
 * for a pending owner, concurrency, and activation only after passkey,
 * password, TOTP and recovery codes are in place.
 */
let h: Harness
let operator: OperatorDeps

beforeAll(async () => {
  h = await harness('exdb_it_auth_boot')
  operator = { store: h.deps.store, clock: h.clock, config: h.deps.config, channel: undefined }
})

afterAll(async () => {
  await h?.db.drop()
})

async function expectAuthError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise
  } catch (error) {
    expect(isAuthError(error) ? error.code : error).toBe(code)
    return
  }
  throw new Error(`expected ${code}`)
}

describe('first-owner bootstrap', () => {
  it('issues a 256-bit setup link in the fragment, valid exactly 30 minutes, stored only as a hash', async () => {
    const issued = await bootstrapOwner(operator, { email: 'first@example.test', reissue: false })
    const url = new URL(issued.link)
    expect(url.origin).toBe(ORIGIN)
    expect(url.pathname).toBe('/setup')
    expect(url.search).toBe('')
    const token = tokenOf(issued.link)
    expect(token).toMatch(/^exsu_[A-Za-z0-9_-]{43}$/)
    const rows = await h.db.asSuperuser(async (c) => {
      const r = await c.query(
        `SELECT token_hash, expires_at - created_at = interval '30 minutes' AS exact
           FROM auth.capabilities WHERE identity_id = $1`,
        [issued.identityId],
      )
      return r.rows
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].exact).toBe(true)
    expect(String(rows[0].token_hash)).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(String(rows[0].token_hash)).not.toContain(token.slice(5))
  })

  it('refuses a second bootstrap while one is pending unless --reissue, which invalidates the old link', async () => {
    await expectAuthError(
      bootstrapOwner(operator, { email: 'first@example.test', reissue: false }),
      'bootstrap_pending',
    )
    const old = await h.db.asSuperuser(
      async (c) =>
        (
          await c.query(
            `SELECT capability_id FROM auth.capabilities WHERE kind = 'setup' AND invalidated_at IS NULL`,
          )
        ).rows,
    )
    const again = await bootstrapOwner(operator, { email: 'First@Example.test', reissue: true })
    expect(again.reissued).toBe(true)
    const live = await h.db.asSuperuser(
      async (c) =>
        (
          await c.query(
            `SELECT capability_id FROM auth.capabilities WHERE kind = 'setup'
             AND redeemed_at IS NULL AND invalidated_at IS NULL`,
          )
        ).rows,
    )
    expect(live).toHaveLength(1)
    expect(live[0].capability_id).not.toBe(old[0].capability_id)
  })

  it('an expired setup link is refused; a re-issue works again', async () => {
    const issued = await bootstrapOwner(operator, { email: 'first@example.test', reissue: true })
    await age(
      h,
      `UPDATE auth.capabilities SET created_at = created_at - interval '31 minutes',
              expires_at = expires_at - interval '31 minutes' WHERE identity_id = $1 AND redeemed_at IS NULL
                AND invalidated_at IS NULL`,
      [issued.identityId],
    )
    const expired = await enrollment.redeem(h.deps, meta(), tokenOf(issued.link))
    expect(errorCode(expired)).toBe('LINK_INVALID')
    const fresh = await bootstrapOwner(operator, { email: 'first@example.test', reissue: true })
    const redeemed = await enrollment.redeem(h.deps, meta(), tokenOf(fresh.link))
    expect(value(redeemed).kind).toBe('setup')
    expect(value(redeemed).steps).toEqual({ passkey: false, password: false, totp: false })
    // Single use: the same link cannot be redeemed again.
    expect(errorCode(await enrollment.redeem(h.deps, meta(), tokenOf(fresh.link)))).toBe(
      'LINK_INVALID',
    )
  })

  it('a corrected address with --reissue readdresses the one pending first owner', async () => {
    const before = await bootstrapOwner(operator, { email: 'first@example.test', reissue: true })
    const corrected = await bootstrapOwner(operator, { email: 'owner@example.test', reissue: true })
    expect(corrected.identityId).toBe(before.identityId)
    const back = await bootstrapOwner(operator, { email: 'first@example.test', reissue: true })
    expect(back.identityId).toBe(before.identityId)
    const states = await h.db.asSuperuser(
      async (c) => (await c.query('SELECT state, email FROM auth.identities WHERE bootstrap')).rows,
    )
    expect(states).toEqual([{ state: 'invited', email: 'first@example.test' }])
    // The link issued before the correction no longer works.
    expect(errorCode(await enrollment.redeem(h.deps, meta(), tokenOf(corrected.link)))).toBe(
      'LINK_INVALID',
    )
  })

  it('concurrent bootstrap runs serialize: one pending first owner and one live link', async () => {
    const results = await Promise.all([
      bootstrapOwner(operator, { email: 'race@example.test', reissue: true }),
      bootstrapOwner(operator, { email: 'race@example.test', reissue: true }),
      bootstrapOwner(operator, { email: 'race@example.test', reissue: true }),
    ])
    expect(new Set(results.map((r) => r.identityId)).size).toBe(1)
    const counts = await h.db.asSuperuser(
      async (c) =>
        (
          await c.query(
            `SELECT (SELECT count(*)::int FROM auth.identities WHERE bootstrap AND state = 'invited') AS pending,
                  (SELECT count(*)::int FROM auth.capabilities WHERE kind = 'setup'
                     AND redeemed_at IS NULL AND invalidated_at IS NULL) AS live`,
          )
        ).rows[0],
    )
    expect(counts).toEqual({ pending: 1, live: 1 })
    // Only the last link issued works.
    const last = await h.db.asSuperuser(
      async (c) =>
        (
          await c.query(
            `SELECT count(*)::int AS n FROM auth.capabilities WHERE kind = 'setup' AND invalidated_at IS NOT NULL`,
          )
        ).rows[0].n,
    )
    expect(last).toBeGreaterThanOrEqual(2)
    await expectAuthError(
      bootstrapOwner(operator, { email: 'race@example.test', reissue: false }),
      'bootstrap_pending',
    )
  })

  it('does not activate before passkey, password and confirmed TOTP; then activates the owner with recovery codes', async () => {
    const issued = await bootstrapOwner(operator, { email: 'owner@example.test', reissue: true })
    const m = meta()
    const redeemed = await enrollment.redeem(h.deps, m, tokenOf(issued.link))
    const handle = ceremonyHandle(redeemed)
    expect(errorCode(await enrollment.complete(h.deps, m, handle))).toBe('ENROLLMENT_INCOMPLETE')

    const creation = value(await enrollment.passkeyOptions(h.deps, handle))
    expect(creation.authenticatorSelection?.userVerification).toBe('required')
    expect(creation.authenticatorSelection?.residentKey).toBe('required')
    const authenticator = new SoftAuthenticator(
      new Uint8Array(Buffer.from(creation.user.id, 'base64url')),
    )
    // A registration without user verification is refused.
    const noUv = authenticator.register({
      challenge: creation.challenge,
      origin: ORIGIN,
      rpId: RP_ID,
      userVerified: false,
    })
    expect(errorCode(await enrollment.passkey(h.deps, handle, noUv, undefined))).toBe(
      'AUTH_CHALLENGE_INVALID',
    )
    // The registration challenge was consumed by that attempt: a replay of a good response fails too.
    const good = authenticator.register({
      challenge: creation.challenge,
      origin: ORIGIN,
      rpId: RP_ID,
    })
    expect(errorCode(await enrollment.passkey(h.deps, handle, good, undefined))).toBe(
      'AUTH_CHALLENGE_INVALID',
    )
    const second = value(await enrollment.passkeyOptions(h.deps, handle))
    value(
      await enrollment.passkey(
        h.deps,
        handle,
        authenticator.register({ challenge: second.challenge, origin: ORIGIN, rpId: RP_ID }),
        'Laptop',
      ),
    )
    expect(errorCode(await enrollment.password(h.deps, handle, 'short'))).toBe('PASSWORD_REJECTED')
    expect(errorCode(await enrollment.password(h.deps, handle, 'owner@example.test is me'))).toBe(
      'PASSWORD_REJECTED',
    )
    value(await enrollment.password(h.deps, handle, PASSWORD))
    expect(errorCode(await enrollment.complete(h.deps, m, handle))).toBe('ENROLLMENT_INCOMPLETE')
    const setup = value(await enrollment.totpOptions(h.deps, handle))
    expect(setup.otpauthUri.startsWith('otpauth://totp/ExponetDB:')).toBe(true)
    expect(setup.qr.rows).toHaveLength(setup.qr.size)
    const secret = decodeBase32(setup.secret)
    expect(errorCode(await enrollment.totp(h.deps, m, handle, '000000'))).toBe(
      'AUTHENTICATION_FAILED',
    )
    const state = value(await enrollment.totp(h.deps, m, handle, totpNow(secret)))
    expect(state.steps).toEqual({ passkey: true, password: true, totp: true })

    const done = await enrollment.complete(h.deps, m, handle)
    const completed = value(done)
    expect(completed.recoveryCodes).toHaveLength(10)
    expect(new Set(completed.recoveryCodes).size).toBe(10)
    expect(completed.signedIn.assurance).toBe('full')
    const session = done.cookies.session
    if (session === undefined || session === 'clear') {
      throw new Error('no session')
    }
    const loaded = await loadSession(h.deps.store, session.token, { userAgent: UA })
    expect(loaded?.identityId).toBe(issued.identityId)

    const binding = await h.db.asSuperuser(
      async (c) =>
        (
          await c.query(
            `SELECT b.role_id, b.scope_kind, b.origin, i.state FROM auth.role_bindings b
             JOIN auth.identities i USING (identity_id) WHERE b.identity_id = $1`,
            [issued.identityId],
          )
        ).rows,
    )
    expect(binding).toEqual([
      { role_id: 'owner', scope_kind: 'global', origin: 'bootstrap', state: 'active' },
    ])
    // The enrollment ceremony is over.
    expect(errorCode(await enrollment.complete(h.deps, m, handle))).toBe('AUTH_CHALLENGE_INVALID')
  })

  it('closes the bootstrap once an owner exists', async () => {
    await expectAuthError(
      bootstrapOwner(operator, { email: 'late@example.test', reissue: true }),
      'bootstrap_closed',
    )
  })

  it('keeps an intact audit chain without personal data or secrets', async () => {
    const verification = await verifyAuditChain(h.deps.store)
    expect(verification.ok).toBe(true)
    const events = await h.db.asSuperuser(async (c) =>
      (await c.query('SELECT event::text AS text FROM audit.audit_events')).rows.map((r) =>
        String(r.text),
      ),
    )
    const joined = events.join('\n')
    expect(joined).toContain('auth.bootstrap.owner_activated')
    expect(joined).not.toMatch(/@example\.test/)
    expect(joined).not.toMatch(/ex(?:su|iv|rc|st|ck|ch)_[A-Za-z0-9_-]{43}/)
    expect(joined).not.toContain(PASSWORD)
  })
})

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  finishPasskeyLogin,
  finishPasskeyReauth,
  loadSession,
  logout,
  passwordLogin,
  pruneAuthState,
  RATE_LIMITS,
  recoveryCodeLogin,
  SECOND_STEP_FLOOR_MS,
  type SessionContext,
  selfService,
  startPasskeyLogin,
  startPasskeyReauth,
  totpLogin,
  totpReauth,
  verifyCsrf,
} from '../src/index.ts'
import { SoftAuthenticator } from '../src/testing/authenticator.ts'
import {
  age,
  ceremonyHandle,
  decodeBase32,
  type Enrolled,
  enrollFirstOwner,
  errorCode,
  type Harness,
  harness,
  meta,
  ORIGIN,
  PASSWORD,
  RP_ID,
  resetTotpStep,
  sessionSecrets,
  totpNow,
  UA,
  value,
} from './support/flows.ts'

/**
 * Sign-in, sessions, CSRF and re-authentication against PostgreSQL 17
 * (G3A items 1, 2, 3, 14, 15, 16, 22, 23).
 */
let h: Harness
let owner: Enrolled

beforeAll(async () => {
  h = await harness('exdb_it_auth_login')
  owner = await enrollFirstOwner(h)
})

afterAll(async () => {
  await h?.db.drop()
})

async function session(token: string, userAgent = UA): Promise<SessionContext> {
  const loaded = await loadSession(h.deps.store, token, { userAgent })
  if (loaded === undefined) {
    throw new Error('session not live')
  }
  return loaded
}

async function passkeyLogin(authenticator: SoftAuthenticator, ip?: string) {
  const m = meta(ip)
  const started = await startPasskeyLogin(h.deps, m)
  const options = value(started)
  const assertion = authenticator.assert({
    challenge: options.challenge,
    origin: ORIGIN,
    rpId: RP_ID,
  })
  return {
    started,
    options,
    finished: await finishPasskeyLogin(h.deps, m, ceremonyHandle(started), assertion),
  }
}

describe('passkey sign-in', () => {
  it('names no account in the options and signs in with user verification', async () => {
    const { options, finished } = await passkeyLogin(owner.authenticator)
    expect(options.allowCredentials).toBeUndefined()
    expect(options.userVerification).toBe('required')
    const signedIn = value(finished)
    expect(signedIn.identityId).toBe(owner.identityId)
    expect(signedIn.assurance).toBe('full')
    const secrets = sessionSecrets(finished)
    expect(secrets.token).toMatch(/^exst_[A-Za-z0-9_-]{43}$/)
    expect(secrets.csrfToken).toMatch(/^exck_[A-Za-z0-9_-]{43}$/)
    expect(finished.cookies.ceremony).toBe('clear')
    const live = await session(secrets.token)
    expect(live.reauthMethod).toBe('passkey')
    expect(live.reauthAgeSeconds).toBeLessThanOrEqual(5)
  })

  it('refuses a replayed challenge, a missing user verification and another origin', async () => {
    const m = meta()
    const started = await startPasskeyLogin(h.deps, m)
    const handle = ceremonyHandle(started)
    const options = value(started)
    const noUv = owner.authenticator.assert({
      challenge: options.challenge,
      origin: ORIGIN,
      rpId: RP_ID,
      userVerified: false,
    })
    expect(errorCode(await finishPasskeyLogin(h.deps, m, handle, noUv))).toBe(
      'AUTHENTICATION_FAILED',
    )
    // The challenge was consumed by the failed attempt: a correct assertion for it is refused.
    const good = owner.authenticator.assert({
      challenge: options.challenge,
      origin: ORIGIN,
      rpId: RP_ID,
    })
    expect(errorCode(await finishPasskeyLogin(h.deps, m, handle, good))).toBe(
      'AUTH_CHALLENGE_INVALID',
    )
    const next = await startPasskeyLogin(h.deps, m)
    const evil = owner.authenticator.assert({
      challenge: value(next).challenge,
      origin: 'https://evil.example.test',
      rpId: RP_ID,
    })
    expect(errorCode(await finishPasskeyLogin(h.deps, m, ceremonyHandle(next), evil))).toBe(
      'AUTHENTICATION_FAILED',
    )
  })

  it('refuses an expired challenge (5 minutes, database clock)', async () => {
    const m = meta()
    const started = await startPasskeyLogin(h.deps, m)
    await age(
      h,
      `UPDATE auth.challenges SET created_at = created_at - interval '6 minutes',
              expires_at = expires_at - interval '6 minutes'
        WHERE kind = 'passkey_login' AND webauthn_challenge = $1`,
      [value(started).challenge],
    )
    const assertion = owner.authenticator.assert({
      challenge: value(started).challenge,
      origin: ORIGIN,
      rpId: RP_ID,
    })
    expect(errorCode(await finishPasskeyLogin(h.deps, m, ceremonyHandle(started), assertion))).toBe(
      'AUTH_CHALLENGE_EXPIRED',
    )
  })

  it('refuses an unknown credential without telling which accounts exist', async () => {
    const stranger = new SoftAuthenticator(new Uint8Array(32).fill(7))
    const { finished } = await passkeyLogin(stranger)
    expect(errorCode(finished)).toBe('AUTHENTICATION_FAILED')
  })
})

describe('password and TOTP fallback', () => {
  it('answers identically for a right password, a wrong one and an unknown address', async () => {
    const right = await passwordLogin(h.deps, meta('198.51.100.1'), owner.email, PASSWORD)
    const wrong = await passwordLogin(
      h.deps,
      meta('198.51.100.2'),
      owner.email,
      'nope nope nope nope',
    )
    const unknown = await passwordLogin(
      h.deps,
      meta('198.51.100.3'),
      'nobody@example.test',
      PASSWORD,
    )
    for (const outcome of [right, wrong, unknown]) {
      expect(value(outcome)).toEqual({ next: 'second_factor', methods: ['totp', 'recovery_code'] })
      expect(ceremonyHandle(outcome)).toMatch(/^exch_[A-Za-z0-9_-]{43}$/)
      expect(outcome.cookies.session).toBeUndefined()
    }
    // Only the right password leads anywhere; the decoy handles fail like a wrong code.
    await resetTotpStep(h, owner.identityId)
    const code = totpNow(owner.totpSecret)
    expect(errorCode(await totpLogin(h.deps, meta(), ceremonyHandle(wrong), code))).toBe(
      'AUTHENTICATION_FAILED',
    )
    expect(errorCode(await totpLogin(h.deps, meta(), ceremonyHandle(unknown), code))).toBe(
      'AUTHENTICATION_FAILED',
    )
    const signedIn = await totpLogin(h.deps, meta(), ceremonyHandle(right), code)
    expect(value(signedIn).assurance).toBe('full')
    expect((await session(sessionSecrets(signedIn).token)).reauthMethod).toBe('totp')
  })

  it('never accepts the same TOTP code twice', async () => {
    await resetTotpStep(h, owner.identityId)
    const code = totpNow(owner.totpSecret)
    const first = await passwordLogin(h.deps, meta(), owner.email, PASSWORD)
    value(await totpLogin(h.deps, meta(), ceremonyHandle(first), code))
    const second = await passwordLogin(h.deps, meta(), owner.email, PASSWORD)
    expect(errorCode(await totpLogin(h.deps, meta(), ceremonyHandle(second), code))).toBe(
      'AUTHENTICATION_FAILED',
    )
  })

  it('treats an expired second step like a wrong code (no oracle on the password)', async () => {
    await resetTotpStep(h, owner.identityId)
    const first = await passwordLogin(h.deps, meta(), owner.email, PASSWORD)
    await age(
      h,
      `UPDATE auth.challenges SET created_at = created_at - interval '6 minutes',
              expires_at = expires_at - interval '6 minutes'
        WHERE kind = 'second_factor' AND consumed_at IS NULL`,
      [],
    )
    expect(
      errorCode(await totpLogin(h.deps, meta(), ceremonyHandle(first), totpNow(owner.totpSecret))),
    ).toBe('AUTHENTICATION_FAILED')
  })

  it('a concurrent burst of guesses for one address is held to the limit (attempts take turns)', async () => {
    const burst = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        passwordLogin(
          h.deps,
          meta(`203.0.113.${20 + i}`),
          'burst@example.test',
          `wrong guess ${i}`,
        ),
      ),
    )
    const checked = burst.filter((o) => errorCode(o) !== 'RATE_LIMITED').length
    // Three failures may pass before the first delay; every other guess is refused unchecked.
    expect(checked).toBeLessThanOrEqual(RATE_LIMITS.acct.delayAfter)
    await age(h, 'DELETE FROM auth.rate_limits', [])
  })

  it('the second step answers no faster for a decoy than for a real ceremony', async () => {
    const decoy = await passwordLogin(h.deps, meta('203.0.113.60'), owner.email, 'not the password')
    const started = performance.now()
    expect(
      errorCode(await totpLogin(h.deps, meta('203.0.113.60'), ceremonyHandle(decoy), '000000')),
    ).toBe('AUTHENTICATION_FAILED')
    expect(performance.now() - started).toBeGreaterThanOrEqual(SECOND_STEP_FLOOR_MS)
    await age(h, 'DELETE FROM auth.rate_limits', [])
  })

  it('rate-limits an account address with progressive delays and a lock, whether or not it exists', async () => {
    const policy = RATE_LIMITS.acct
    let limited: string | undefined
    let attempts = 0
    for (let i = 0; i < policy.maxFailures + 1 && limited === undefined; i++) {
      // Each attempt from another client address, so only the account bucket counts.
      await age(
        h,
        `UPDATE auth.rate_limits SET locked_until = NULL WHERE bucket LIKE 'acct:%' AND failures < $1`,
        [policy.maxFailures],
      )
      const outcome = await passwordLogin(
        h.deps,
        meta(`203.0.113.${i + 1}`),
        'ghost@example.test',
        'wrong wrong wrong',
      )
      attempts += 1
      limited = errorCode(outcome)
    }
    expect(attempts).toBe(policy.maxFailures + 1)
    expect(limited).toBe('RATE_LIMITED')
    const audits = await h.db.asSuperuser(async (c) =>
      (
        await c.query(
          `SELECT event::jsonb->'changes' AS changes FROM audit.audit_events WHERE action = 'auth.login.failures'
            ORDER BY seq`,
        )
      ).rows.map((r) => r.changes),
    )
    expect(audits.some((c) => c.bucket === 'acct' && c.locked === true)).toBe(true)
    expect(JSON.stringify(audits)).not.toContain('ghost')
  })

  it('a locked identity fails silently at the second step (no distinct answer)', async () => {
    await resetTotpStep(h, owner.identityId)
    const handles: string[] = []
    for (let i = 0; i < RATE_LIMITS.idn.maxFailures; i++) {
      const step = await passwordLogin(h.deps, meta(`192.0.2.${100 + i}`), owner.email, PASSWORD)
      handles.push(ceremonyHandle(step))
    }
    for (const handle of handles) {
      await age(
        h,
        `UPDATE auth.rate_limits SET locked_until = NULL WHERE bucket LIKE 'idn:%' AND failures < $1`,
        [RATE_LIMITS.idn.maxFailures],
      )
      expect(errorCode(await totpLogin(h.deps, meta(), handle, '000000'))).toBe(
        'AUTHENTICATION_FAILED',
      )
    }
    const locked = await passwordLogin(h.deps, meta('192.0.2.250'), owner.email, PASSWORD)
    expect(
      errorCode(await totpLogin(h.deps, meta(), ceremonyHandle(locked), totpNow(owner.totpSecret))),
    ).toBe('AUTHENTICATION_FAILED')
    const notified = await h.db.asSuperuser(
      async (c) =>
        (await c.query(`SELECT status FROM auth.notifications WHERE kind = 'auth.lockout'`)).rows,
    )
    expect(notified).toEqual([{ status: 'unavailable' }])
    // Later suites start from clean counters (this test drove the shared client address too).
    await age(h, 'DELETE FROM auth.rate_limits', [])
  })
})

describe('web sessions', () => {
  it('stores only hashes; the cookie and CSRF values appear nowhere in the Control Store', async () => {
    const { finished } = await passkeyLogin(owner.authenticator)
    const secrets = sessionSecrets(finished)
    const dump = await h.db.asSuperuser(async (c) => {
      const tables = await c.query(
        `SELECT table_schema, table_name FROM information_schema.tables
          WHERE table_schema IN ('auth', 'approvals', 'audit', 'secrets', 'operations') AND table_type = 'BASE TABLE'`,
      )
      const parts: string[] = []
      for (const t of tables.rows) {
        const rows = await c.query(
          `SELECT t::text AS row FROM "${t.table_schema}"."${t.table_name}" t`,
        )
        parts.push(...rows.rows.map((r) => String(r.row)))
      }
      return parts.join('\n')
    })
    expect(dump).not.toContain(secrets.token)
    expect(dump).not.toContain(secrets.token.slice(5))
    expect(dump).not.toContain(secrets.csrfToken.slice(5))
    expect(dump).not.toContain(PASSWORD)
    for (const code of owner.recoveryCodes) {
      expect(dump).not.toContain(code)
      expect(dump).not.toContain(code.replaceAll('-', ''))
    }
  })

  it('expires after 30 idle minutes and after 12 hours, on the database clock', async () => {
    const idle = sessionSecrets((await passkeyLogin(owner.authenticator)).finished)
    const live = await session(idle.token)
    await age(
      h,
      `UPDATE auth.web_sessions SET last_seen_at = last_seen_at - interval '31 minutes' WHERE session_id = $1`,
      [live.sessionId],
    )
    expect(await loadSession(h.deps.store, idle.token, { userAgent: UA })).toBeUndefined()

    const old = sessionSecrets((await passkeyLogin(owner.authenticator)).finished)
    const oldLive = await session(old.token)
    await age(
      h,
      `UPDATE auth.web_sessions SET created_at = created_at - interval '12 hours 1 minute',
              absolute_expires_at = absolute_expires_at - interval '12 hours 1 minute' WHERE session_id = $1`,
      [oldLive.sessionId],
    )
    expect(await loadSession(h.deps.store, old.token, { userAgent: UA })).toBeUndefined()
  })

  it('is bound to the device family and ends with the session epoch', async () => {
    const secrets = sessionSecrets((await passkeyLogin(owner.authenticator)).finished)
    const firefox =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0'
    expect(await loadSession(h.deps.store, secrets.token, { userAgent: firefox })).toBeUndefined()
    expect(await loadSession(h.deps.store, secrets.token, { userAgent: UA })).toBeDefined()
    expect(await loadSession(h.deps.store, `${secrets.token}x`, { userAgent: UA })).toBeUndefined()
    expect(await loadSession(h.deps.store, secrets.csrfToken, { userAgent: UA })).toBeUndefined()
  })

  it('verifies CSRF as double submit against the stored hash', async () => {
    const secrets = sessionSecrets((await passkeyLogin(owner.authenticator)).finished)
    const live = await session(secrets.token)
    expect(verifyCsrf(live, secrets.csrfToken, secrets.csrfToken)).toBe(true)
    expect(verifyCsrf(live, undefined, secrets.csrfToken)).toBe(false)
    expect(verifyCsrf(live, secrets.csrfToken, undefined)).toBe(false)
    const other = sessionSecrets((await passkeyLogin(owner.authenticator)).finished)
    expect(verifyCsrf(live, other.csrfToken, other.csrfToken)).toBe(false)
    expect(verifyCsrf(live, secrets.token, secrets.token)).toBe(false)
  })

  it('logout revokes the session and clears the cookies', async () => {
    const secrets = sessionSecrets((await passkeyLogin(owner.authenticator)).finished)
    const out = await logout(h.deps, meta(), await session(secrets.token))
    expect(out.cookies).toEqual({ session: 'clear', ceremony: 'clear' })
    expect(await loadSession(h.deps.store, secrets.token, { userAgent: UA })).toBeUndefined()
  })
})

describe('re-authentication', () => {
  it('a TOTP re-authentication records the proof and rotates both secrets', async () => {
    const secrets = sessionSecrets((await passkeyLogin(owner.authenticator)).finished)
    const before = await session(secrets.token)
    await resetTotpStep(h, owner.identityId)
    const result = await totpReauth(h.deps, meta(), before, totpNow(owner.totpSecret))
    const reauth = value(result)
    expect(reauth.method).toBe('totp')
    const rotated = sessionSecrets(result)
    expect(rotated.token).not.toBe(secrets.token)
    expect(rotated.csrfToken).not.toBe(secrets.csrfToken)
    expect(await loadSession(h.deps.store, secrets.token, { userAgent: UA })).toBeUndefined()
    const after = await session(rotated.token)
    expect(after.sessionId).toBe(before.sessionId)
    expect(after.reauthMethod).toBe('totp')
    expect(after.reauthAt).toBe(reauth.reauthAt)
    expect(verifyCsrf(after, secrets.csrfToken, secrets.csrfToken)).toBe(false)
  })

  it('a passkey re-authentication needs a fresh challenge of this session', async () => {
    const secrets = sessionSecrets((await passkeyLogin(owner.authenticator)).finished)
    const live = await session(secrets.token)
    const options = value(await startPasskeyReauth(h.deps, live))
    expect(options.allowCredentials?.length).toBe(1)
    const assertion = owner.authenticator.assert({
      challenge: options.challenge,
      origin: ORIGIN,
      rpId: RP_ID,
    })
    const result = await finishPasskeyReauth(h.deps, meta(), live, assertion)
    expect(value(result).method).toBe('passkey')
    // Replaying the same assertion fails: the challenge is consumed.
    const again = await session(sessionSecrets(result).token)
    expect(errorCode(await finishPasskeyReauth(h.deps, meta(), again, assertion))).toBe(
      'AUTH_CHALLENGE_INVALID',
    )
  })

  it('a wrong TOTP code is refused and counted', async () => {
    const secrets = sessionSecrets((await passkeyLogin(owner.authenticator)).finished)
    expect(
      errorCode(await totpReauth(h.deps, meta(), await session(secrets.token), '000000')),
    ).toBe('AUTHENTICATION_FAILED')
  })
})

describe('recovery codes', () => {
  it('a recovery code opens a restricted session, ends the other sessions and is used once', async () => {
    const other = sessionSecrets((await passkeyLogin(owner.authenticator)).finished)
    const step = await passwordLogin(h.deps, meta(), owner.email, PASSWORD)
    const code = owner.recoveryCodes[0] ?? ''
    const recovered = await recoveryCodeLogin(
      h.deps,
      meta(),
      ceremonyHandle(step),
      code.toLowerCase(),
    )
    const signedIn = value(recovered)
    expect(signedIn.assurance).toBe('recovery')
    expect(signedIn.recoveryRequired).toBe(true)
    expect(await loadSession(h.deps.store, other.token, { userAgent: UA })).toBeUndefined()
    const restricted = await session(sessionSecrets(recovered).token)
    expect(restricted.assurance).toBe('recovery')
    expect(restricted.reauthMethod).toBe('recovery_code')

    const again = await passwordLogin(h.deps, meta(), owner.email, PASSWORD)
    expect(errorCode(await recoveryCodeLogin(h.deps, meta(), ceremonyHandle(again), code))).toBe(
      'AUTHENTICATION_FAILED',
    )

    // New passkey and new authenticator end the recovery: a full session with new secrets.
    const options = value(await selfService.passkeyOptions(h.deps, restricted))
    const replacement = new SoftAuthenticator(
      new Uint8Array(Buffer.from(options.user.id, 'base64url')),
    )
    const added = await selfService.addPasskey(
      h.deps,
      meta(),
      restricted,
      replacement.register({ challenge: options.challenge, origin: ORIGIN, rpId: RP_ID }),
      undefined,
    )
    expect(value(added).kind).toBe('passkey')
    expect(added.cookies.session).toBeUndefined()
    const setup = value(await selfService.totpOptions(h.deps, restricted))
    const replaced = await selfService.replaceTotp(
      h.deps,
      meta(),
      restricted,
      totpNow(decodeBase32(setup.secret)),
    )
    expect(value(replaced).kind).toBe('totp')
    const upgraded = await session(sessionSecrets(replaced).token)
    expect(upgraded.assurance).toBe('full')
    expect(upgraded.recoveryRequired).toBe(false)
  })
})

describe('maintenance', () => {
  it('the worker prunes ended challenges and idle rate-limit buckets, nothing live', async () => {
    const live = await startPasskeyLogin(h.deps, meta('198.51.100.200'))
    expect(errorCode(live)).toBeUndefined()
    await passwordLogin(h.deps, meta('198.51.100.201'), 'idle@example.test', 'wrong password here')
    // Age everything that exists so far by three days, then add fresh rows.
    await age(
      h,
      `UPDATE auth.challenges SET expires_at = expires_at - interval '3 days',
                    created_at = created_at - interval '3 days'`,
      [],
    )
    await age(h, `UPDATE auth.rate_limits SET updated_at = updated_at - interval '3 days'`, [])
    await startPasskeyLogin(h.deps, meta('198.51.100.202'))
    await passwordLogin(h.deps, meta('198.51.100.203'), 'fresh@example.test', 'wrong password here')
    const before = await h.db.asSuperuser(
      async (c) =>
        (
          await c.query(
            `SELECT (SELECT count(*)::int FROM auth.challenges WHERE expires_at > now()) AS live_challenges,
                    (SELECT count(*)::int FROM auth.rate_limits WHERE updated_at > now() - interval '1 hour') AS live_buckets`,
          )
        ).rows[0],
    )
    const pruned = await pruneAuthState(h.db.store('exdb_worker'))
    expect(pruned.challenges).toBeGreaterThan(0)
    expect(pruned.rateLimits).toBeGreaterThan(0)
    const after = await h.db.asSuperuser(
      async (c) =>
        (
          await c.query(
            `SELECT (SELECT count(*)::int FROM auth.challenges WHERE expires_at > now()) AS live_challenges,
                    (SELECT count(*)::int FROM auth.challenges WHERE expires_at < now() - interval '2 days') AS old_challenges,
                    (SELECT count(*)::int FROM auth.rate_limits WHERE updated_at > now() - interval '1 hour') AS live_buckets,
                    (SELECT count(*)::int FROM auth.rate_limits WHERE updated_at < now() - interval '1 day') AS old_buckets`,
          )
        ).rows[0],
    )
    expect(after).toEqual({ ...before, old_challenges: 0, old_buckets: 0 })
    await age(h, 'DELETE FROM auth.rate_limits', [])
  })
})

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  ARGON2_PARAMS,
  checkPasswordPolicy,
  commonPasswordCount,
  deviceLabel,
  dummyVerify,
  hashPassword,
  isCommonPassword,
  needsRehash,
  newRecoveryCodes,
  newToken,
  newTotpSecret,
  normalizeRecoveryCode,
  parseAuthConfig,
  parseToken,
  qrMatrix,
  RECOVERY_CODE_COUNT,
  recoveryCodeHash,
  safeEqual,
  tokenHash,
  totpBase32,
  totpCodeAt,
  totpUri,
  verifyPassword,
  verifyTotp,
} from '../src/index.ts'

describe('opaque tokens', () => {
  it('carry a kind prefix and 256 random bits, and are never equal', () => {
    const a = newToken('session')
    const b = newToken('session')
    expect(a).toMatch(/^exst_[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(a.slice(5), 'base64url')).toHaveLength(32)
    expect(a).not.toBe(b)
    expect(newToken('setup')).toMatch(/^exsu_/)
    expect(newToken('invitation')).toMatch(/^exiv_/)
    expect(newToken('recovery')).toMatch(/^exrc_/)
    expect(newToken('csrf')).toMatch(/^exck_/)
    expect(newToken('ceremony')).toMatch(/^exch_/)
  })

  it('hash with domain separation: the same text under another kind is another hash', () => {
    const t = newToken('session')
    expect(tokenHash('session', t)).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(tokenHash('session', t)).toBe(tokenHash('session', t))
    expect(tokenHash('session', t)).not.toBe(tokenHash('csrf', t))
  })

  it('parse only exact shapes of the expected kind', () => {
    const t = newToken('setup')
    expect(parseToken('setup', t)).toBe(t)
    expect(parseToken('invitation', t)).toBeUndefined()
    expect(parseToken('setup', `${t}x`)).toBeUndefined()
    expect(parseToken('setup', t.slice(0, -1))).toBeUndefined()
    expect(parseToken('setup', `exsu_${'+'.repeat(43)}`)).toBeUndefined()
    expect(parseToken('setup', 42)).toBeUndefined()
  })

  it('compare in constant time', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
  })
})

describe('trusted configuration', () => {
  it('takes origin and RP id from configuration, requiring HTTPS except on loopback', () => {
    expect(parseAuthConfig({ publicUrl: 'https://db.exponet.cloud' })).toEqual({
      publicOrigin: 'https://db.exponet.cloud',
      rpId: 'db.exponet.cloud',
      rpName: 'ExponetDB',
      // Open client registration is the default (owner decision 2026-10-13, oauth.md §3).
      clientRegistration: 'open',
    })
    expect(
      parseAuthConfig({ publicUrl: 'https://db.exponet.cloud', clientRegistration: 'review' })
        .clientRegistration,
    ).toBe('review')
    expect(parseAuthConfig({ publicUrl: 'http://localhost:8080' }).publicOrigin).toBe(
      'http://localhost:8080',
    )
    expect(
      parseAuthConfig({ publicUrl: 'https://db.exponet.cloud', rpId: 'exponet.cloud' }).rpId,
    ).toBe('exponet.cloud')
  })

  it('refuses plain HTTP, paths, credentials, wildcards, IP RP ids and unrelated RP ids', () => {
    for (const bad of [
      { publicUrl: 'http://db.exponet.cloud' },
      { publicUrl: 'https://db.exponet.cloud/app' },
      { publicUrl: 'https://u:p@db.exponet.cloud' },
      { publicUrl: 'https://db.exponet.cloud/?x=1' },
      { publicUrl: 'https://*.exponet.cloud' },
      { publicUrl: 'not a url' },
      { publicUrl: 'https://db.exponet.cloud', rpId: 'attacker.example' },
      { publicUrl: 'https://db.exponet.cloud', rpId: 'cloud.exponet' },
      { publicUrl: 'https://db.exponet.cloud', rpId: '*.exponet.cloud' },
      { publicUrl: 'http://127.0.0.1:8080' },
    ]) {
      expect(() => parseAuthConfig(bad), JSON.stringify(bad)).toThrow()
    }
  })
})

describe('password policy (no composition rules, offline list)', () => {
  it('requires 14 to 256 code points and no control characters', () => {
    expect(checkPasswordPolicy('a'.repeat(13).replace(/a/g, 'x1'))).toEqual({ ok: true })
    expect(checkPasswordPolicy('kurz-und-gut')).toEqual({ ok: false, reason: 'too_short' })
    expect(checkPasswordPolicy('🔑'.repeat(13))).toEqual({ ok: false, reason: 'too_short' })
    expect(checkPasswordPolicy('🔑Correct horse')).toEqual({ ok: true })
    expect(checkPasswordPolicy(`${'Zq9!'.repeat(64)}x`)).toEqual({ ok: false, reason: 'too_long' })
    expect(checkPasswordPolicy('correct horse\nbattery staple')).toEqual({
      ok: false,
      reason: 'control_characters',
    })
  })

  it('refuses common passwords and their trivial variants, case-insensitively', () => {
    expect(commonPasswordCount()).toBe(49_233)
    expect(isCommonPassword('iseedeadpeople')).toBe(true)
    expect(checkPasswordPolicy('1qaz2wsx3EDC4RFV')).toEqual({ ok: false, reason: 'common' })
    expect(checkPasswordPolicy('password12345678')).toEqual({ ok: false, reason: 'common' })
    expect(checkPasswordPolicy('passwordpasswordpassword')).toEqual({ ok: false, reason: 'common' })
    expect(checkPasswordPolicy('aaaaaaaaaaaaaaaa')).toEqual({ ok: false, reason: 'common' })
    expect(checkPasswordPolicy('tangerine fjord radiator')).toEqual({ ok: true })
  })

  it('refuses the e-mail address or its local part inside the password', () => {
    expect(checkPasswordPolicy('xxowner.alphaxx-tail', 'owner.alpha@example.test')).toEqual({
      ok: false,
      reason: 'contains_email',
    })
  })
})

describe('Argon2id', () => {
  it('hashes with memory 64 MiB, 3 passes, parallelism 1 and a unique salt; verifies and refuses', async () => {
    const a = await hashPassword('tangerine fjord radiator')
    const b = await hashPassword('tangerine fjord radiator')
    expect(a).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/)
    expect(a).not.toBe(b)
    expect(ARGON2_PARAMS).toEqual({ memoryCost: 65536, timeCost: 3, parallelism: 1, outputLen: 32 })
    expect(await verifyPassword(a, 'tangerine fjord radiator')).toBe(true)
    expect(await verifyPassword(a, 'tangerine fjord radiatoR')).toBe(false)
    expect(await verifyPassword('not a hash', 'x')).toBe(false)
    expect(needsRehash(a)).toBe(false)
  }, 30_000)

  it('flags weaker stored parameters for a rehash and spends work on unknown accounts', async () => {
    const weak =
      '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$YXQzMmJ5dGVzb2ZvdXRwdXRmb3J0ZXN0aW5ncHVycG9zZQ'
    expect(needsRehash(weak)).toBe(true)
    expect(needsRehash('garbage')).toBe(true)
    const started = performance.now()
    expect(await dummyVerify('whatever-attempted')).toBe(false)
    expect(performance.now() - started).toBeGreaterThan(5)
  }, 30_000)
})

describe('TOTP (RFC 6238, SHA-1, 6 digits, 30 s)', () => {
  const secret = newTotpSecret()
  const t = Date.UTC(2026, 9, 5, 12, 0, 15)
  const step = Math.floor(t / 30_000)

  it('uses 160-bit secrets and a standard otpauth URI', () => {
    expect(secret).toHaveLength(20)
    expect(totpBase32(secret)).toMatch(/^[A-Z2-7]{32}$/)
    const uri = totpUri(secret, 'owner@example.test')
    expect(uri).toMatch(/^otpauth:\/\/totp\/ExponetDB:owner%40example\.test\?/)
    expect(uri).toContain('algorithm=SHA1')
    expect(uri).toContain('digits=6')
    expect(uri).toContain('period=30')
  })

  it('accepts the current step and one step either side, nothing further', () => {
    const now = totpCodeAt(secret, t)
    expect(verifyTotp(secret, now, t, null)).toEqual({ ok: true, step })
    expect(verifyTotp(secret, totpCodeAt(secret, t - 30_000), t, null)).toEqual({
      ok: true,
      step: step - 1,
    })
    expect(verifyTotp(secret, totpCodeAt(secret, t + 30_000), t, null)).toEqual({
      ok: true,
      step: step + 1,
    })
    const far = totpCodeAt(secret, t - 60_000)
    if (
      far !== now &&
      far !== totpCodeAt(secret, t - 30_000) &&
      far !== totpCodeAt(secret, t + 30_000)
    ) {
      expect(verifyTotp(secret, far, t, null)).toEqual({ ok: false, reason: 'invalid' })
    }
    expect(verifyTotp(secret, '12345', t, null)).toEqual({ ok: false, reason: 'invalid' })
    expect(verifyTotp(secret, 'abcdef', t, null)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('refuses a step at or before the last accepted one (replay)', () => {
    const now = totpCodeAt(secret, t)
    expect(verifyTotp(secret, now, t, step)).toEqual({ ok: false, reason: 'replayed' })
    expect(verifyTotp(secret, totpCodeAt(secret, t - 30_000), t, step - 1)).toEqual({
      ok: false,
      reason: 'replayed',
    })
    expect(verifyTotp(secret, now, t, step - 1)).toEqual({ ok: true, step })
  })

  it('renders the QR matrix locally', () => {
    const qr = qrMatrix(totpUri(secret, 'owner@example.test'))
    expect(qr.size).toBeGreaterThanOrEqual(21)
    expect(qr.rows).toHaveLength(qr.size)
    expect(qr.rows.every((r) => /^[01]+$/.test(r) && r.length === qr.size)).toBe(true)
  })
})

describe('recovery codes', () => {
  it('issues ten distinct 80-bit Crockford codes', () => {
    const codes = newRecoveryCodes()
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT)
    expect(new Set(codes).size).toBe(10)
    for (const c of codes) {
      expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/)
    }
  })

  it('normalizes typed input the Crockford way and refuses anything else', () => {
    expect(normalizeRecoveryCode('abcd-efgh-jkmn-pqrs')).toBe('ABCDEFGHJKMNPQRS')
    expect(normalizeRecoveryCode(' o1il 2345 6789 ABCD ')).toBe(
      '0111234567 89ABCD'.replace(' ', ''),
    )
    expect(normalizeRecoveryCode('UUUU-UUUU-UUUU-UUUU')).toBeUndefined()
    expect(normalizeRecoveryCode('ABCD-EFGH-JKMN')).toBeUndefined()
  })

  it('hashes per set: the same code of another set is another hash', () => {
    fc.assert(
      fc.property(fc.constantFrom(...newRecoveryCodes()), (code) => {
        const a = recoveryCodeHash('fac_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z', code)
        expect(a).toBe(recoveryCodeHash('fac_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z', code.toLowerCase()))
        expect(a).not.toBe(recoveryCodeHash('fac_01JB2Z6G8M4Q7R9T1V3W5X7Y90', code))
      }),
    )
  })
})

describe('device labels', () => {
  it('keep only browser and system family', () => {
    expect(
      deviceLabel(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      ),
    ).toBe('Safari on macOS')
    expect(
      deviceLabel(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      ),
    ).toBe('Chrome on Linux')
    expect(
      deviceLabel('Mozilla/5.0 (Windows NT 10.0; rv:131.0) Gecko/20100101 Firefox/131.0'),
    ).toBe('Firefox on Windows')
    expect(deviceLabel(undefined)).toBe('Unknown device')
    expect(deviceLabel('<script>alert(1)</script>')).toBe('Unknown device')
  })
})

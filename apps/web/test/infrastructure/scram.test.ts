import { createHash, createHmac, pbkdf2Sync, webcrypto } from 'node:crypto'
import { isScramSha256Verifier } from '@exponetdb/contracts'
import { describe, expect, it } from 'vitest'
import {
  isScramSafePassword,
  SCRAM_ITERATIONS,
  scramSha256Verifier,
} from '../../src/features/infrastructure/scram.ts'

/** The verifier computed independently with node:crypto (RFC 5802, RFC 7677, PostgreSQL's format). */
function reference(password: string, salt: Buffer, iterations: number): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256')
  const clientKey = createHmac('sha256', salted).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest()
  const serverKey = createHmac('sha256', salted).update('Server Key').digest()
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
}

const PASSWORD = 'correct horse battery staple'

describe('the SCRAM-SHA-256 verifier of the browser', () => {
  it('matches the verifier node:crypto computes for the same salt and iteration count', async () => {
    const salt = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex')
    for (const iterations of [4096, 10_000]) {
      const verifier = await scramSha256Verifier(PASSWORD, {
        salt: new Uint8Array(salt),
        iterations,
        crypto: webcrypto as unknown as Crypto,
      })
      expect(verifier).toBe(reference(PASSWORD, salt, iterations))
    }
  })

  it('proves the RFC 7677 exchange of user "user" with password "pencil"', async () => {
    // RFC 7677 section 3: the server's salt and iteration count, the messages and the proofs.
    const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64')
    const verifier = await scramSha256Verifier('pencil', { salt: new Uint8Array(salt) })
    expect(verifier).toBe(reference('pencil', salt, 4096))
    const [, keys = ''] = verifier.split('$').slice(1)
    const [storedKey = '', serverKey = ''] = keys.split(':')
    const nonce = 'rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0'
    const authMessage = [
      'n=user,r=rOprNGfwEbeRWgbNEkqO',
      `r=${nonce},s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096`,
      `c=biws,r=${nonce}`,
    ].join(',')
    const serverSignature = createHmac('sha256', Buffer.from(serverKey, 'base64'))
      .update(authMessage)
      .digest('base64')
    expect(serverSignature).toBe('6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=')
    const clientSignature = createHmac('sha256', Buffer.from(storedKey, 'base64'))
      .update(authMessage)
      .digest()
    const proof = Buffer.from('dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=', 'base64')
    const clientKey = Buffer.from(proof.map((byte, i) => byte ^ (clientSignature[i] ?? 0)))
    expect(createHash('sha256').update(clientKey).digest('base64')).toBe(storedKey)
  })

  it('uses 4096 iterations and a fresh 16-byte random salt, in the format the contract accepts', async () => {
    const one = await scramSha256Verifier(PASSWORD)
    const two = await scramSha256Verifier(PASSWORD)
    expect(SCRAM_ITERATIONS).toBe(4096)
    expect(isScramSha256Verifier(one)).toBe(true)
    expect(one).not.toBe(two)
    const salt = /^SCRAM-SHA-256\$4096:([^$]+)\$/.exec(one)?.[1] ?? ''
    expect(Buffer.from(salt, 'base64')).toHaveLength(16)
    // The verifier never contains the password, in any encoding.
    for (const text of [one, two]) {
      expect(text).not.toContain(PASSWORD)
      expect(text).not.toContain(Buffer.from(PASSWORD).toString('base64'))
    }
  })

  it('refuses a password SASLprep could change, and never names the password in the error', async () => {
    expect(isScramSafePassword('plain ascii ~!')).toBe(true)
    expect(isScramSafePassword('pässwort-ünïcode')).toBe(false)
    expect(isScramSafePassword('tab\tinside')).toBe(false)
    const secret = ['geheimes', 'pässwort-123'].join('-')
    const failure = await scramSha256Verifier(secret).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TypeError)
    expect(String(failure)).not.toContain(secret)
    await expect(scramSha256Verifier(PASSWORD, { iterations: 1000 })).rejects.toThrow(TypeError)
  })
})

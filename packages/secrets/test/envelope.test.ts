import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  expectOk,
  isJsonArray,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  parseJson,
} from '@exponetdb/kernel'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  checkContext,
  dataKeyAad,
  isKeyId,
  type Keyring,
  open,
  parseKeyring,
  type RandomSource,
  rewrap,
  type SealedSecret,
  type SecretContext,
  SecretError,
  seal,
  secretAad,
} from '../src/index.ts'

/**
 * se1 golden vectors (tooling/golden/secret-envelope.json), derived with the
 * Python `cryptography` package from the specification, and the properties
 * envelope encryption must hold: substitution, tampering and wrong keys fail.
 */
const file = fileURLToPath(new URL('../../../tooling/golden/secret-envelope.json', import.meta.url))
const parsed = parseJson(readFileSync(file, 'utf8'))
if (!parsed.ok || !isJsonObject(parsed.value) || !isJsonArray(parsed.value['vectors'])) {
  throw new Error('secret-envelope.json is not a vector file')
}
const vectors = parsed.value['vectors'].filter(isJsonObject)

const hex = (value: unknown): Buffer => Buffer.from(String(value), 'hex')
const obj = (value: JsonValue | undefined): JsonObject => {
  if (!isJsonObject(value)) {
    throw new Error('expected an object in the vector')
  }
  return value
}
const contextOf = (c: JsonObject) =>
  checkContext({
    secretId: c['secretId'],
    purpose: c['purpose'],
    subjectId: c['subjectId'],
    version: c['version'],
  })

function keyringOf(entries: readonly { keyId: string; key: Buffer; status?: string }[]): Keyring {
  return expectOk(
    parseKeyring(
      JSON.stringify({
        format: 'exponetdb.keyring/v1',
        keys: entries.map((e, i) => ({
          keyId: e.keyId,
          status: e.status ?? (i === 0 ? 'active' : 'decrypt_only'),
          key: e.key.toString('base64'),
        })),
      }),
    ),
    'test keyring',
  )
}

/** Returns the given byte strings in order, as the envelope draws them. */
function scripted(...values: Buffer[]): RandomSource {
  const queue = [...values]
  return (bytes) => {
    const next = queue.shift()
    if (next === undefined || next.length !== bytes) {
      throw new Error('unexpected draw')
    }
    return next
  }
}

const results = new Map<string, SealedSecret>()

describe('se1 golden vectors', () => {
  it('cover contexts, binary and unicode plaintext, versions, subjects, rewrap and refusals', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(21)
  })

  for (const v of vectors) {
    it(`${String(v['id'])}: ${String(v['description'])}`, () => {
      const master = obj(v['masterKey'])
      const context = obj(v['context'])
      const expectedError = v['expectedError']
      if (typeof expectedError === 'string') {
        const checked = contextOf(context)
        const code = checked.ok
          ? isKeyId(master['keyId'])
            ? 'none'
            : 'invalid_key_id'
          : checked.error
        expect(code).toBe(expectedError)
        return
      }
      const expected = obj(v['expected'])
      const random = obj(v['random'])
      const ctx = expectOk(contextOf(context), 'vector context')
      const keyring = keyringOf([{ keyId: String(master['keyId']), key: hex(master['keyHex']) }])
      expect(secretAad(ctx)).toBe(expected['aad'])
      expect(dataKeyAad(ctx, keyring.activeKeyId)).toBe(expected['dataKeyAad'])
      expect(keyring.checkValue(keyring.activeKeyId)).toBe(expected['checkValue'])
      const sealed = seal(
        keyring,
        ctx,
        hex(v['plaintextHex']),
        scripted(hex(random['dataKeyHex']), hex(random['wrapNonceHex']), hex(random['nonceHex'])),
      )
      expect(Buffer.from(sealed.wrappedKey).toString('hex')).toBe(expected['wrappedKeyHex'])
      expect(Buffer.from(sealed.ciphertext).toString('hex')).toBe(expected['ciphertextHex'])
      expect(open(keyring, ctx, sealed).toString('hex')).toBe(v['plaintextHex'])
      results.set(String(v['id']), sealed)
      for (const other of Array.isArray(v['differsFrom']) ? v['differsFrom'] : []) {
        expect(
          Buffer.from(sealed.ciphertext).equals(
            Buffer.from(results.get(String(other))?.ciphertext ?? []),
          ),
        ).toBe(false)
      }
      for (const other of Array.isArray(v['sameCiphertextAs']) ? v['sameCiphertextAs'] : []) {
        expect(Buffer.from(sealed.ciphertext).toString('hex')).toBe(
          Buffer.from(results.get(String(other))?.ciphertext ?? []).toString('hex'),
        )
      }
    })
  }
})

const key = (n: number) => Buffer.alloc(32, n)
const ring = keyringOf([{ keyId: 'k1', key: key(1) }])
const context: SecretContext = expectOk(
  checkContext({
    secretId: 'sec_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z',
    purpose: 'pg_credential',
    subjectId: 'cls_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z/exponetdb_reader',
    version: 1,
  }),
  'context',
)
const plaintext = Buffer.from('a password that never leaves memory')

function failsToOpen(keyring: Keyring, ctx: SecretContext, sealed: SealedSecret): SecretError {
  try {
    open(keyring, ctx, sealed)
  } catch (error) {
    if (error instanceof SecretError) {
      return error
    }
    throw error
  }
  throw new Error('opened a secret that must not open')
}

describe('envelope encryption', () => {
  it('round-trips and draws fresh randomness for every seal', () => {
    const a = seal(ring, context, plaintext)
    const b = seal(ring, context, plaintext)
    expect(open(ring, context, a)).toEqual(plaintext)
    expect(Buffer.from(a.nonce).equals(Buffer.from(b.nonce))).toBe(false)
    expect(Buffer.from(a.wrapNonce).equals(Buffer.from(b.wrapNonce))).toBe(false)
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false)
  })

  it('never repeats a nonce across many seals', () => {
    const nonces = new Set<string>()
    for (let i = 0; i < 2000; i++) {
      const s = seal(ring, context, plaintext)
      nonces.add(Buffer.from(s.nonce).toString('hex'))
      nonces.add(Buffer.from(s.wrapNonce).toString('hex'))
    }
    expect(nonces.size).toBe(4000)
  })

  it('fails on any changed byte of ciphertext, tag, nonce or wrapped key', () => {
    const sealed = seal(ring, context, plaintext)
    const flip = (bytes: Uint8Array, at: number) => {
      const copy = Buffer.from(bytes)
      copy[at] = (copy[at] ?? 0) ^ 0x01
      return copy
    }
    for (const at of [0, plaintext.length - 1, plaintext.length, sealed.ciphertext.length - 1]) {
      expect(
        failsToOpen(ring, context, { ...sealed, ciphertext: flip(sealed.ciphertext, at) }).code,
      ).toBe('secret_decrypt_failed')
    }
    expect(failsToOpen(ring, context, { ...sealed, nonce: flip(sealed.nonce, 0) }).code).toBe(
      'secret_decrypt_failed',
    )
    expect(
      failsToOpen(ring, context, { ...sealed, wrapNonce: flip(sealed.wrapNonce, 11) }).code,
    ).toBe('secret_decrypt_failed')
    for (const at of [0, 31, 32, 47]) {
      expect(
        failsToOpen(ring, context, { ...sealed, wrappedKey: flip(sealed.wrappedKey, at) }).code,
      ).toBe('secret_decrypt_failed')
    }
    expect(
      failsToOpen(ring, context, { ...sealed, ciphertext: sealed.ciphertext.subarray(0, 10) }).code,
    ).toBe('secret_decrypt_failed')
  })

  it('fails when any field of the associated data differs (substitution)', () => {
    const sealed = seal(ring, context, plaintext)
    const variants: SecretContext[] = [
      {
        ...context,
        secretId: expectOk(
          checkContext({ ...context, secretId: 'sec_01JB2Z6G8M4Q7R9T1V3W5X7YA0' }),
          'id',
        ).secretId,
      },
      { ...context, purpose: 'pg_credential.other' },
      { ...context, subjectId: 'cls_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z/exponetdb_observer' },
      { ...context, version: 2 },
    ]
    for (const variant of variants) {
      expect(failsToOpen(ring, variant, sealed).code).toBe('secret_decrypt_failed')
    }
  })

  it('fails with a wrong master key under the same id and names a missing key id', () => {
    const sealed = seal(ring, context, plaintext)
    const impostor = keyringOf([{ keyId: 'k1', key: key(2) }])
    expect(failsToOpen(impostor, context, sealed).code).toBe('secret_decrypt_failed')
    const other = keyringOf([{ keyId: 'k9', key: key(1) }])
    expect(failsToOpen(other, context, sealed)).toMatchObject({
      code: 'secret_key_unavailable',
      keyId: 'k1',
    })
    // A wrapped key relabeled with another id fails too (the id is in the data key AAD).
    const both = keyringOf([
      { keyId: 'k9', key: key(1) },
      { keyId: 'k1', key: key(1) },
    ])
    expect(failsToOpen(both, context, { ...sealed, keyId: 'k9' }).code).toBe(
      'secret_decrypt_failed',
    )
  })

  it('rewraps under the active key without touching the ciphertext; the old key can then go', () => {
    const sealed = seal(ring, context, plaintext)
    const rotated = keyringOf([
      { keyId: 'k2', key: key(2) },
      { keyId: 'k1', key: key(1) },
    ])
    const wrapped = rewrap(rotated, context, sealed)
    expect(wrapped.keyId).toBe('k2')
    const onlyNew = keyringOf([{ keyId: 'k2', key: key(2) }])
    expect(open(onlyNew, context, { ...sealed, ...wrapped })).toEqual(plaintext)
    expect(failsToOpen(onlyNew, context, sealed).code).toBe('secret_key_unavailable')
  })

  it('refuses empty and oversized plaintext', () => {
    expect(() => seal(ring, context, new Uint8Array())).toThrow(SecretError)
    expect(() => seal(ring, context, new Uint8Array(65_537))).toThrow(SecretError)
    expect(open(ring, context, seal(ring, context, new Uint8Array(65_536)))).toHaveLength(65_536)
  })

  it('errors never carry key material, plaintext or ciphertext', () => {
    const sealed = seal(ring, context, plaintext)
    const error = failsToOpen(keyringOf([{ keyId: 'k1', key: key(2) }]), context, sealed)
    const text = `${String(error)} ${JSON.stringify(error)} ${error.stack ?? ''}`
    for (const needle of [
      key(1).toString('base64'),
      key(1).toString('hex'),
      plaintext.toString(),
      Buffer.from(sealed.ciphertext).toString('hex'),
    ]) {
      expect(text).not.toContain(needle)
    }
  })

  it('property: any plaintext round-trips and any single flipped bit is detected', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 512 }),
        fc.nat(),
        fc.integer({ min: 0, max: 7 }),
        (bytes, position, bit) => {
          const sealed = seal(ring, context, bytes)
          expect(open(ring, context, sealed)).toEqual(Buffer.from(bytes))
          const tampered = Buffer.from(sealed.ciphertext)
          const at = position % tampered.length
          tampered[at] = (tampered[at] ?? 0) ^ (1 << bit)
          expect(failsToOpen(ring, context, { ...sealed, ciphertext: tampered }).code).toBe(
            'secret_decrypt_failed',
          )
        },
      ),
      { numRuns: 200 },
    )
  })
})

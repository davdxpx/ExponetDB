import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { expectOk } from '@exponetdb/kernel'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addKeyToKeyringText,
  generateKeyringText,
  KEYRING_ENV,
  KEYRING_FILE_ENV,
  loadKeyring,
  parseKeyring,
  SecretError,
} from '../src/index.ts'

const K1 = Buffer.alloc(32, 1).toString('base64')
const K2 = Buffer.alloc(32, 2).toString('base64')

const text = (keys: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ format: 'exponetdb.keyring/v1', keys, ...extra })

describe('keyring parser', () => {
  it('accepts one active key and any number of decrypt-only keys', () => {
    const keyring = expectOk(
      parseKeyring(
        text([
          { keyId: 'k2026b', status: 'active', key: K2 },
          { keyId: 'k2026a', status: 'decrypt_only', key: K1 },
        ]),
      ),
      'keyring',
    )
    expect(keyring.activeKeyId).toBe('k2026b')
    expect(keyring.keys).toEqual([
      { keyId: 'k2026b', status: 'active' },
      { keyId: 'k2026a', status: 'decrypt_only' },
    ])
  })

  const refusals: [string, string, number | undefined][] = [
    ['not json', 'not_json', undefined],
    ['[]', 'not_object', undefined],
    [text([], { extra: 1 }), 'unknown_member', undefined],
    [JSON.stringify({ format: 'exponetdb.keyring/v1' }), 'missing_member', undefined],
    [
      text([{ keyId: 'a', status: 'active', key: K1 }], { format: 'exponetdb.keyring/v2' }),
      'unsupported_format',
      undefined,
    ],
    [text([]), 'no_keys', undefined],
    [
      text(
        Array.from({ length: 17 }, (_, i) => ({
          keyId: `k${i}`,
          status: i === 0 ? 'active' : 'decrypt_only',
          key: K1,
        })),
      ),
      'too_many_keys',
      undefined,
    ],
    [text(['k1']), 'invalid_entry', 0],
    [text([{ keyId: 'a', status: 'active', key: K1, note: 'x' }]), 'unknown_member', 0],
    [text([{ keyId: 'a', status: 'active' }]), 'missing_member', 0],
    [text([{ keyId: 'Upper', status: 'active', key: K1 }]), 'invalid_key_id', 0],
    [text([{ keyId: 'a|b', status: 'active', key: K1 }]), 'invalid_key_id', 0],
    [
      text([
        { keyId: 'a', status: 'active', key: K1 },
        { keyId: 'a', status: 'decrypt_only', key: K2 },
      ]),
      'duplicate_key_id',
      1,
    ],
    [text([{ keyId: 'a', status: 'retired', key: K1 }]), 'invalid_status', 0],
    [
      text([{ keyId: 'a', status: 'active', key: Buffer.alloc(16).toString('base64') }]),
      'invalid_key',
      0,
    ],
    [
      text([{ keyId: 'a', status: 'active', key: Buffer.alloc(33).toString('base64') }]),
      'invalid_key',
      0,
    ],
    [
      text([{ keyId: 'a', status: 'active', key: `${Buffer.alloc(32).toString('base64url')}x` }]),
      'invalid_key',
      0,
    ],
    [text([{ keyId: 'a', status: 'active', key: `${K1.slice(0, 42)}B=` }]), 'invalid_key', 0],
    [text([{ keyId: 'a', status: 'active', key: ` ${K1}` }]), 'invalid_key', 0],
    [text([{ keyId: 'a', status: 'decrypt_only', key: K1 }]), 'no_active_key', undefined],
    [
      text([
        { keyId: 'a', status: 'active', key: K1 },
        { keyId: 'b', status: 'active', key: K2 },
      ]),
      'multiple_active_keys',
      undefined,
    ],
    [
      `{"format":"exponetdb.keyring/v1","format":"exponetdb.keyring/v1","keys":[]}`,
      'not_json',
      undefined,
    ],
  ]
  for (const [input, code, entry] of refusals) {
    it(`refuses: ${code}${entry === undefined ? '' : ` (entry ${entry})`}`, () => {
      const result = parseKeyring(input)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toEqual(entry === undefined ? { code } : { code, entry })
      }
    })
  }

  it('never prints or serializes key material', () => {
    const keyring = expectOk(
      parseKeyring(text([{ keyId: 'k1', status: 'active', key: K1 }])),
      'keyring',
    )
    const shown = `${inspect(keyring, { depth: 10, showHidden: true })} ${JSON.stringify(keyring)} ${String(keyring)}`
    expect(shown).not.toContain(K1)
    expect(shown).not.toContain(Buffer.alloc(32, 1).toString('hex'))
    expect(shown).toContain('k1')
  })

  it('cannot be used after destroy', () => {
    const keyring = expectOk(
      parseKeyring(text([{ keyId: 'k1', status: 'active', key: K1 }])),
      'keyring',
    )
    keyring.destroy()
    expect(() => keyring.checkValue('k1')).toThrow(SecretError)
  })
})

describe('keyring generation and rotation', () => {
  it('generates one fresh active 256-bit key', () => {
    const a = expectOk(parseKeyring(generateKeyringText('k2026a')), 'generated')
    expect(a.keys).toEqual([{ keyId: 'k2026a', status: 'active' }])
    const b = expectOk(parseKeyring(generateKeyringText('k2026a')), 'generated')
    expect(a.checkValue('k2026a')).not.toBe(b.checkValue('k2026a'))
    expect(() => generateKeyringText('Bad Id')).toThrow(SecretError)
  })

  it('adds a new active key and keeps the old keys for decryption only', () => {
    const first = generateKeyringText('k2026a')
    const before = expectOk(parseKeyring(first), 'first')
    const rotated = expectOk(parseKeyring(addKeyToKeyringText(first, 'k2026b')), 'rotated')
    expect(rotated.activeKeyId).toBe('k2026b')
    expect(rotated.keys).toEqual([
      { keyId: 'k2026a', status: 'decrypt_only' },
      { keyId: 'k2026b', status: 'active' },
    ])
    expect(rotated.checkValue('k2026a')).toBe(before.checkValue('k2026a'))
    expect(() => addKeyToKeyringText(first, 'k2026a')).toThrow(SecretError)
    expect(() => addKeyToKeyringText('{}', 'k2026b')).toThrow(SecretError)
  })
})

describe('keyring loading', () => {
  let dir = ''
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'exdb-keyring-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads inline JSON or an owner-only file, never both', async () => {
    const inline = generateKeyringText('k1')
    expect((await loadKeyring({ [KEYRING_ENV]: inline })).activeKeyId).toBe('k1')
    const path = join(dir, 'keyring.json')
    await writeFile(path, generateKeyringText('k2'), { mode: 0o600 })
    expect((await loadKeyring({ [KEYRING_FILE_ENV]: path })).activeKeyId).toBe('k2')
    await expect(
      loadKeyring({ [KEYRING_ENV]: inline, [KEYRING_FILE_ENV]: path }),
    ).rejects.toMatchObject({
      code: 'keyring_ambiguous',
    })
    await expect(loadKeyring({})).rejects.toMatchObject({ code: 'keyring_missing' })
  })

  it('refuses a file readable by group or others and an unreadable file', async () => {
    const path = join(dir, 'open.json')
    await writeFile(path, generateKeyringText('k3'))
    await chmod(path, 0o644)
    await expect(loadKeyring({ [KEYRING_FILE_ENV]: path })).rejects.toMatchObject({
      code: 'keyring_file_permissions',
    })
    await expect(
      loadKeyring({ [KEYRING_FILE_ENV]: join(dir, 'missing.json') }),
    ).rejects.toMatchObject({
      code: 'keyring_unreadable',
    })
  })

  it('reports an invalid keyring by refusal code and entry, never by its text', async () => {
    const bad = text([{ keyId: 'k1', status: 'active', key: `${K1.slice(0, 40)}AAB=` }])
    const error = await loadKeyring({ [KEYRING_ENV]: bad }).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'keyring_invalid', detail: 'invalid_key', entry: 0 })
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(K1.slice(0, 40))
  })
})

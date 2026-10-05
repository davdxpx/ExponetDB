import { createHmac, randomBytes } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { err, isJsonArray, isJsonObject, ok, parseJson, type Result } from '@exponetdb/kernel'
import { isKeyId } from './context.ts'
import { SecretError } from './errors.ts'

/**
 * The keyring of master keys ([secrets.md §2](../../../exponetdb-docs/08-auth-and-security/secrets.md#2-envelope-encryption)).
 *
 *   {"format":"exponetdb.keyring/v1",
 *    "keys":[{"keyId":"k2026a","status":"active","key":"<base64, 32 bytes>"}]}
 *
 * Parsed strictly: unknown members, duplicate members or ids, anything but
 * exactly one `active` key, keys that are not canonical base64 of exactly 32
 * bytes are refused. Key material never leaves this module except into
 * `node:crypto`: the object carries ids and statuses only (it prints and
 * serializes without keys), refusals carry an entry index, never text.
 * Master keys never go to the Control Store, logs, errors or audit; the
 * store holds only a key check value per id (an HMAC under the key).
 */
export const KEYRING_FORMAT = 'exponetdb.keyring/v1'
export const MAX_KEYS = 16
export type KeyStatus = 'active' | 'decrypt_only'

export type KeyringRefusal =
  | 'not_json'
  | 'not_object'
  | 'unsupported_format'
  | 'unknown_member'
  | 'missing_member'
  | 'no_keys'
  | 'too_many_keys'
  | 'invalid_entry'
  | 'invalid_key_id'
  | 'duplicate_key_id'
  | 'invalid_key'
  | 'invalid_status'
  | 'no_active_key'
  | 'multiple_active_keys'

export interface KeyringError {
  readonly code: KeyringRefusal
  /** Index of the offending entry in `keys`, when one is at fault. */
  readonly entry?: number
}

export interface KeyInfo {
  readonly keyId: string
  readonly status: KeyStatus
}

const material = new WeakMap<Keyring, ReadonlyMap<string, Buffer>>()

export class Keyring {
  readonly activeKeyId: string
  readonly keys: readonly KeyInfo[]

  private constructor(keys: readonly KeyInfo[], activeKeyId: string) {
    this.keys = keys
    this.activeKeyId = activeKeyId
  }

  /** @internal Built only by {@link parseKeyring}. */
  static create(entries: readonly (KeyInfo & { readonly key: Buffer })[]): Keyring {
    const active = entries.filter((e) => e.status === 'active')
    if (
      active.length !== 1 ||
      new Set(entries.map((e) => e.keyId)).size !== entries.length ||
      entries.some((e) => e.key.length !== 32)
    ) {
      throw new SecretError('keyring_invalid')
    }
    const keyring = new Keyring(
      entries.map((e) => ({ keyId: e.keyId, status: e.status })),
      active[0]?.keyId ?? '',
    )
    material.set(keyring, new Map(entries.map((e) => [e.keyId, e.key])))
    return keyring
  }

  has(keyId: string): boolean {
    return this.keys.some((k) => k.keyId === keyId)
  }

  /** `hmac-sha256:<hex>` of the fixed message under the key: identifies it without revealing it. */
  checkValue(keyId: string): string {
    return `hmac-sha256:${createHmac('sha256', keyFor(this, keyId))
      .update('exponetdb/master-key-check/v1', 'utf8')
      .digest('hex')}`
  }

  /** Overwrites the key material in memory (shutdown). The keyring is unusable afterwards. */
  destroy(): void {
    for (const key of material.get(this)?.values() ?? []) {
      key.fill(0)
    }
    material.delete(this)
  }

  toJSON(): { readonly activeKeyId: string; readonly keys: readonly KeyInfo[] } {
    return { activeKeyId: this.activeKeyId, keys: this.keys }
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `Keyring(${this.keys.map((k) => `${k.keyId}:${k.status}`).join(', ')})`
  }
}

/** @internal The key bytes, for `envelope.ts` only (not exported from the package). */
export function keyFor(keyring: Keyring, keyId: string): Buffer {
  const key = material.get(keyring)?.get(keyId)
  if (key === undefined) {
    throw new SecretError('secret_key_unavailable', { keyId })
  }
  return key
}

const BASE64_32 = /^[A-Za-z0-9+/]{43}=$/

function decodeKey(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || !BASE64_32.test(value)) {
    return undefined
  }
  const bytes = Buffer.from(value, 'base64')
  return bytes.length === 32 && bytes.toString('base64') === value ? bytes : undefined
}

export function parseKeyring(text: string): Result<Keyring, KeyringError> {
  const parsed = parseJson(text)
  if (!parsed.ok) {
    return err({ code: 'not_json' })
  }
  const doc = parsed.value
  if (!isJsonObject(doc)) {
    return err({ code: 'not_object' })
  }
  for (const name of Object.keys(doc)) {
    if (name !== 'format' && name !== 'keys') {
      return err({ code: 'unknown_member' })
    }
  }
  if (!Object.hasOwn(doc, 'format') || !Object.hasOwn(doc, 'keys')) {
    return err({ code: 'missing_member' })
  }
  if (doc['format'] !== KEYRING_FORMAT) {
    return err({ code: 'unsupported_format' })
  }
  const list = doc['keys']
  if (!isJsonArray(list) || list.length === 0) {
    return err({ code: 'no_keys' })
  }
  if (list.length > MAX_KEYS) {
    return err({ code: 'too_many_keys' })
  }
  const entries: (KeyInfo & { key: Buffer })[] = []
  const seen = new Set<string>()
  for (const [entry, item] of list.entries()) {
    if (!isJsonObject(item)) {
      return err({ code: 'invalid_entry', entry })
    }
    for (const name of Object.keys(item)) {
      if (name !== 'keyId' && name !== 'status' && name !== 'key') {
        return err({ code: 'unknown_member', entry })
      }
    }
    if (!['keyId', 'status', 'key'].every((name) => Object.hasOwn(item, name))) {
      return err({ code: 'missing_member', entry })
    }
    const keyId = item['keyId']
    if (!isKeyId(keyId)) {
      return err({ code: 'invalid_key_id', entry })
    }
    if (seen.has(keyId)) {
      return err({ code: 'duplicate_key_id', entry })
    }
    seen.add(keyId)
    const status = item['status']
    if (status !== 'active' && status !== 'decrypt_only') {
      return err({ code: 'invalid_status', entry })
    }
    const key = decodeKey(item['key'])
    if (key === undefined) {
      return err({ code: 'invalid_key', entry })
    }
    entries.push({ keyId, status, key })
  }
  const active = entries.filter((e) => e.status === 'active').length
  if (active === 0) {
    return err({ code: 'no_active_key' })
  }
  if (active > 1) {
    return err({ code: 'multiple_active_keys' })
  }
  return ok(Keyring.create(entries))
}

function parsedOrThrow(text: string): Keyring {
  const parsed = parseKeyring(text)
  if (!parsed.ok) {
    throw new SecretError('keyring_invalid', {
      detail: parsed.error.code,
      ...(parsed.error.entry === undefined ? {} : { entry: parsed.error.entry }),
    })
  }
  return parsed.value
}

export const KEYRING_ENV = 'EXPONETDB_KEYRING'
export const KEYRING_FILE_ENV = 'EXPONETDB_KEYRING_FILE'

/**
 * Loads the keyring from `EXPONETDB_KEYRING` (inline JSON) or
 * `EXPONETDB_KEYRING_FILE` (a file readable by the owner only). Exactly one
 * of them must be set.
 */
export async function loadKeyring(
  env: Readonly<Record<string, string | undefined>>,
): Promise<Keyring> {
  const inline = env[KEYRING_ENV]
  const file = env[KEYRING_FILE_ENV]
  const hasInline = inline !== undefined && inline.length > 0
  const hasFile = file !== undefined && file.length > 0
  if (hasInline && hasFile) {
    throw new SecretError('keyring_ambiguous')
  }
  if (hasInline) {
    return parsedOrThrow(inline)
  }
  if (!hasFile) {
    throw new SecretError('keyring_missing')
  }
  let text: string
  try {
    const info = await stat(file)
    if ((info.mode & 0o077) !== 0) {
      throw new SecretError('keyring_file_permissions')
    }
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error instanceof SecretError) {
      throw error
    }
    throw new SecretError('keyring_unreadable')
  }
  return parsedOrThrow(text)
}

export interface GeneratedKey {
  readonly keyId: string
  readonly status: KeyStatus
  readonly key: string
}

function newKey(keyId: string): GeneratedKey {
  if (!isKeyId(keyId)) {
    throw new SecretError('keyring_invalid', { detail: 'invalid_key_id' })
  }
  return { keyId, status: 'active', key: randomBytes(32).toString('base64') }
}

function serialize(keys: readonly GeneratedKey[]): string {
  return `${JSON.stringify({ format: KEYRING_FORMAT, keys }, null, 2)}\n`
}

/** `exponetdb keyring generate`: a new keyring text with one fresh active key (CSPRNG). */
export function generateKeyringText(keyId: string): string {
  return serialize([newKey(keyId)])
}

/**
 * Rotation step 1 (secrets.md §3): adds a fresh active key and turns every
 * existing key into `decrypt_only`. The re-wrap job then moves every data key
 * to the new key; an old key is removed only when nothing references it.
 */
export function addKeyToKeyringText(text: string, keyId: string): string {
  parsedOrThrow(text).destroy()
  const parsed = parseJson(text)
  const list = parsed.ok && isJsonObject(parsed.value) ? parsed.value['keys'] : undefined
  if (!isJsonArray(list)) {
    throw new SecretError('keyring_invalid')
  }
  const existing: GeneratedKey[] = list.filter(isJsonObject).map((entry) => ({
    keyId: String(entry['keyId']),
    status: 'decrypt_only',
    key: String(entry['key']),
  }))
  if (existing.some((k) => k.keyId === keyId)) {
    throw new SecretError('keyring_invalid', { detail: 'duplicate_key_id' })
  }
  if (existing.length + 1 > MAX_KEYS) {
    throw new SecretError('keyring_invalid', { detail: 'too_many_keys' })
  }
  return serialize([...existing, newKey(keyId)])
}

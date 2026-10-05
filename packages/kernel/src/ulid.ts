import { InvariantError } from './errors.ts'

/** Crockford base32 alphabet used by ULIDs (no I, L, O, U). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * Canonical ULID text: 26 uppercase Crockford characters, the first one `0` to
 * `7` so the value fits in 128 bits. ExponetDB accepts only this form; a
 * lowercase ULID is refused, never folded.
 */
export const CANONICAL_ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/

export type UlidRefusal = 'not_canonical' | 'invalid_ulid'

export function isCanonicalUlid(value: string): boolean {
  return CANONICAL_ULID_PATTERN.test(value)
}

/** Reason why `value` is not a canonical ULID, or undefined when it is one. */
export function ulidRefusal(value: string): UlidRefusal | undefined {
  if (CANONICAL_ULID_PATTERN.test(value)) {
    return undefined
  }
  return CANONICAL_ULID_PATTERN.test(asciiUppercase(value)) ? 'not_canonical' : 'invalid_ulid'
}

function asciiUppercase(value: string): string {
  return value.replace(/[a-z]/g, (c) => c.toUpperCase())
}

const MAX_TIME_MS = 2 ** 48 - 1

/**
 * Creates a ULID. `random` must return cryptographically random bytes; the
 * default uses Web Crypto, available in Node.js 24 and browsers.
 *
 * The timestamp makes ids roughly sortable for humans. It is never an ordering
 * guarantee: migration order comes from the dependency graph, operation order
 * from the Control Store.
 */
export function newUlid(
  timeMs: number,
  random: (size: number) => Uint8Array = defaultRandom,
): string {
  if (!Number.isInteger(timeMs) || timeMs < 0 || timeMs > MAX_TIME_MS) {
    throw new InvariantError('ULID time must be an integer between 0 and 2^48 - 1')
  }
  let time = ''
  let t = timeMs
  for (let i = 0; i < 10; i++) {
    time = charAt(t % 32) + time
    t = Math.floor(t / 32)
  }
  const bytes = random(10)
  if (bytes.length !== 10) {
    throw new InvariantError('ULID randomness must be 10 bytes')
  }
  // 80 bits of randomness as 16 base32 characters, most significant first.
  let bits = 0n
  for (const byte of bytes) {
    bits = (bits << 8n) | BigInt(byte)
  }
  let rand = ''
  for (let i = 0; i < 16; i++) {
    rand = charAt(Number(bits & 31n)) + rand
    bits >>= 5n
  }
  return time + rand
}

function charAt(index: number): string {
  const c = CROCKFORD[index]
  if (c === undefined) {
    throw new InvariantError('base32 index out of range')
  }
  return c
}

function defaultRandom(size: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(size))
}

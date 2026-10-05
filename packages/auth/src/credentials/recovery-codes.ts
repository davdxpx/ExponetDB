import { randomBytes } from 'node:crypto'
import { tokenHash } from '../tokens.ts'

/**
 * Recovery codes (identity.md §2): ten single-use codes of 80 random bits,
 * written as 16 Crockford base32 characters in groups of four
 * (`7XK2-M9QD-...`). Shown once; only a SHA-256 hash bound to the factor
 * (the set) is stored. Input is forgiving the Crockford way: case, spaces
 * and dashes are ignored, `O` reads as `0`, `I` and `L` as `1`.
 */
export const RECOVERY_CODE_COUNT = 10
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return out
}

export function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const code = encode(new Uint8Array(randomBytes(10)))
    return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}-${code.slice(12, 16)}`
  })
}

/** The canonical 16 characters of a typed code, or undefined when it cannot be one. */
export function normalizeRecoveryCode(input: string): string | undefined {
  const compact = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  return /^[0-9A-HJKMNP-TV-Z]{16}$/.test(compact) ? compact : undefined
}

export function recoveryCodeHash(factorId: string, code: string): string {
  const canonical = normalizeRecoveryCode(code) ?? code
  return tokenHash('recovery_code', `${factorId}\n${canonical}`)
}

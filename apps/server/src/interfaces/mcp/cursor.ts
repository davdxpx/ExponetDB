import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { canonicalize } from '@exponetdb/kernel'

/**
 * Sealed list cursors of `/mcp` (Wave 7 order §22, ADR-0027 §7): a cursor
 * an agent holds is opaque, bound to the grant, the tool and its filters,
 * and expires. The use case's own cursor travels inside, sealed with
 * AES-256-GCM under the installation key `mcp.cursor_key`; the binding is
 * the additional authenticated data, so a cursor of another grant, another
 * tool or other filters does not open, and neither does an edited or
 * expired one. A cursor still never authorizes anything: the use case
 * decides every page again.
 *
 * Format: `c1_` and the base64url of 12 bytes nonce, the ciphertext and
 * the 16-byte tag (the contracts' cursor alphabet).
 */
export const CURSOR_TTL_SECONDS = 3600
const PREFIX = 'c1_'
const AAD = 'exponetdb.mcp.cursor/v1'

export interface CursorBinding {
  /** The grant (or API key) the cursor was issued to. */
  readonly grant: string
  /** The tool or method (`targets_list`, `resources/list`). */
  readonly tool: string
  /** The call's filters (every argument except the cursor and the page size). */
  readonly filters: unknown
}

export interface CursorCodec {
  seal(binding: CursorBinding, inner: string): Promise<string>
  /** The use case's cursor, or undefined for anything that does not open. */
  open(binding: CursorBinding, sealed: string): Promise<string | undefined>
}

function aad(binding: CursorBinding): Buffer {
  const value: unknown = JSON.parse(JSON.stringify(binding.filters ?? null))
  const canonical = canonicalize(value)
  const filters = createHash('sha256')
    .update(canonical.ok ? canonical.value : JSON.stringify(value))
    .digest('hex')
  return Buffer.from(`${AAD}\u0000${binding.grant}\u0000${binding.tool}\u0000${filters}`, 'utf8')
}

export function createCursorCodec(
  key: () => Promise<Buffer>,
  nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
): CursorCodec {
  return {
    async seal(binding, inner) {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', await key(), nonce)
      cipher.setAAD(aad(binding))
      const plain = Buffer.from(JSON.stringify({ c: inner, e: nowSeconds() + CURSOR_TTL_SECONDS }))
      const sealed = Buffer.concat([
        nonce,
        cipher.update(plain),
        cipher.final(),
        cipher.getAuthTag(),
      ])
      return PREFIX + sealed.toString('base64url')
    },
    async open(binding, sealed) {
      if (!sealed.startsWith(PREFIX)) return undefined
      const bytes = Buffer.from(sealed.slice(PREFIX.length), 'base64url')
      if (bytes.length < 12 + 16 + 1) return undefined
      try {
        const decipher = createDecipheriv('aes-256-gcm', await key(), bytes.subarray(0, 12))
        decipher.setAAD(aad(binding))
        decipher.setAuthTag(bytes.subarray(bytes.length - 16))
        const plain = Buffer.concat([
          decipher.update(bytes.subarray(12, bytes.length - 16)),
          decipher.final(),
        ])
        const value = JSON.parse(plain.toString('utf8')) as { c?: unknown; e?: unknown }
        if (typeof value.c !== 'string' || typeof value.e !== 'number') return undefined
        return value.e >= nowSeconds() ? value.c : undefined
      } catch {
        return undefined
      }
    },
  }
}

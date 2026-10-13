import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { McpKeySet } from '@exponetdb/auth'
import { canonicalize } from '@exponetdb/kernel'

/**
 * The `requestState` of an approval round (ADR-0027 §7, Wave 7 order §12
 * and §24): the only state ExponetDB hands a client between a request and
 * its retry. It travels through the client, so it is sealed (AES-256-GCM
 * under the installation key `mcp.request_state_key`), bound to the
 * identity, the client, the grant, the tool and the digest of the
 * arguments, and expires after ten minutes. It holds the id of the
 * operation the elicitation is about; the retry only reads that operation,
 * so a repeated or replayed state changes nothing, and an elicitation's
 * answer is never read as a decision.
 *
 * Format: `rs1.<key version>.` and the base64url of 12 bytes nonce, the
 * ciphertext and the 16-byte tag. The key is the installation key of the
 * purpose `mcp.request_state_key` (no other key opens a state); the version
 * is that secret's version, and it is bound in the additional data. A state
 * seals under the newest version; the newest two open, so an operator's
 * rotation (`exponetdb keyring rotate-mcp-key`) cuts no round off. Every
 * failure is `undefined`, never a reason.
 */
export const REQUEST_STATE_TTL_SECONDS = 600
const PREFIX = 'rs1.'
const AAD = 'exponetdb.mcp.request-state/v1'
/** Large enough for the payload, small enough for a client to echo cheaply. */
const MAX_LENGTH = 1024

export interface RequestStateBinding {
  readonly identityId: string
  readonly clientId: string | null
  readonly grantId: string | null
  readonly tool: string
  /** The call's arguments (the digest is bound, never the values). */
  readonly args: unknown
}

export interface RequestStateCodec {
  seal(binding: RequestStateBinding, operationId: string): Promise<string>
  /** The operation id, or undefined for anything that does not open, is foreign or expired. */
  open(binding: RequestStateBinding, state: string): Promise<string | undefined>
}

function digest(args: unknown): string {
  const value: unknown = JSON.parse(JSON.stringify(args ?? null))
  const canonical = canonicalize(value)
  return createHash('sha256')
    .update(canonical.ok ? canonical.value : JSON.stringify(value))
    .digest('hex')
}

function aad(version: number): Buffer {
  return Buffer.from(`${AAD}\u0000${version}`, 'utf8')
}

interface Payload {
  readonly i: string
  readonly c: string | null
  readonly g: string | null
  readonly t: string
  readonly d: string
  readonly o: string
  readonly e: number
  readonly n: string
}

/** One key as a key set (tests, and a single-version installation). */
export function singleKey(key: Buffer, version = 1): McpKeySet {
  return { current: { version, key } }
}

export function createRequestStateCodec(
  keys: () => Promise<McpKeySet>,
  nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
): RequestStateCodec {
  return {
    async seal(binding, operationId) {
      const payload: Payload = {
        i: binding.identityId,
        c: binding.clientId,
        g: binding.grantId,
        t: binding.tool,
        d: digest(binding.args),
        o: operationId,
        e: nowSeconds() + REQUEST_STATE_TTL_SECONDS,
        n: randomBytes(12).toString('base64url'),
      }
      const { current } = await keys()
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', current.key, nonce)
      cipher.setAAD(aad(current.version))
      const sealed = Buffer.concat([
        nonce,
        cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')),
        cipher.final(),
        cipher.getAuthTag(),
      ])
      return `${PREFIX}${current.version}.${sealed.toString('base64url')}`
    },
    async open(binding, state) {
      if (state.length > MAX_LENGTH) return undefined
      const m = /^rs1\.([1-9][0-9]{0,8})\.([A-Za-z0-9_-]+)$/.exec(state)
      if (m === null) return undefined
      const version = Number(m[1])
      const bytes = Buffer.from(m[2] ?? '', 'base64url')
      if (bytes.length < 12 + 16 + 1) return undefined
      const set = await keys()
      // Only the newest two versions open; an older or unknown version is refused like a forgery.
      const key = [set.current, set.previous].find((k) => k?.version === version)?.key
      if (key === undefined) return undefined
      let payload: Partial<Payload>
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
        decipher.setAAD(aad(version))
        decipher.setAuthTag(bytes.subarray(bytes.length - 16))
        const plain = Buffer.concat([
          decipher.update(bytes.subarray(12, bytes.length - 16)),
          decipher.final(),
        ])
        payload = JSON.parse(plain.toString('utf8')) as Partial<Payload>
      } catch {
        return undefined
      }
      const bound =
        payload.i === binding.identityId &&
        payload.c === binding.clientId &&
        payload.g === binding.grantId &&
        payload.t === binding.tool &&
        payload.d === digest(binding.args) &&
        typeof payload.e === 'number' &&
        payload.e >= nowSeconds() &&
        typeof payload.o === 'string'
      return bound ? payload.o : undefined
    },
  }
}

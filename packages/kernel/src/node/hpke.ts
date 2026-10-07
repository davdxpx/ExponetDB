import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto'
import { rawPublicKey, x25519PrivateKey, x25519PublicKey } from './encoding.ts'

/**
 * HPKE ([RFC 9180](https://www.rfc-editor.org/rfc/rfc9180)), base mode,
 * single shot, for DHKEM(X25519, HKDF-SHA256) and HKDF-SHA256 with AES-GCM.
 * Only what `ns1` needs: no PSK, auth or export modes, sequence number 0.
 * Written from the RFC; checked against its test vectors (A.1.1).
 */

const KEM_ID = 0x0020
const KDF_ID = 0x0001
const N_SECRET = 32
const N_NONCE = 12

export type HpkeAead = 'aes-128-gcm' | 'aes-256-gcm'
const AEAD: Record<HpkeAead, { readonly id: number; readonly nk: number }> = {
  'aes-128-gcm': { id: 0x0001, nk: 16 },
  'aes-256-gcm': { id: 0x0002, nk: 32 },
}

function i2osp(n: number, width: number): Buffer {
  const b = Buffer.alloc(width)
  b.writeUIntBE(n, 0, width)
  return b
}

function extract(salt: Uint8Array, ikm: Uint8Array): Buffer {
  return createHmac('sha256', salt.length === 0 ? Buffer.alloc(32) : salt)
    .update(ikm)
    .digest()
}

function expand(prk: Uint8Array, info: Uint8Array, length: number): Buffer {
  const blocks: Buffer[] = []
  let previous = Buffer.alloc(0)
  for (let i = 1; blocks.length * 32 < length; i++) {
    previous = createHmac('sha256', prk)
      .update(Buffer.concat([previous, info, Buffer.from([i])]))
      .digest()
    blocks.push(previous)
  }
  return Buffer.concat(blocks).subarray(0, length)
}

const HPKE_V1 = Buffer.from('HPKE-v1')

function labeledExtract(suite: Buffer, salt: Uint8Array, label: string, ikm: Uint8Array): Buffer {
  return extract(salt, Buffer.concat([HPKE_V1, suite, Buffer.from(label), ikm]))
}

function labeledExpand(
  suite: Buffer,
  prk: Uint8Array,
  label: string,
  info: Uint8Array,
  length: number,
): Buffer {
  return expand(
    prk,
    Buffer.concat([i2osp(length, 2), HPKE_V1, suite, Buffer.from(label), info]),
    length,
  )
}

const KEM_SUITE = Buffer.concat([Buffer.from('KEM'), i2osp(KEM_ID, 2)])

function dhkemSharedSecret(dh: Uint8Array, enc: Uint8Array, pkR: Uint8Array): Buffer {
  const eaePrk = labeledExtract(KEM_SUITE, new Uint8Array(0), 'eae_prk', dh)
  return labeledExpand(KEM_SUITE, eaePrk, 'shared_secret', Buffer.concat([enc, pkR]), N_SECRET)
}

interface Context {
  readonly key: Buffer
  readonly nonce: Buffer
}

function keySchedule(aead: HpkeAead, sharedSecret: Uint8Array, info: Uint8Array): Context {
  const { id, nk } = AEAD[aead]
  const suite = Buffer.concat([
    Buffer.from('HPKE'),
    i2osp(KEM_ID, 2),
    i2osp(KDF_ID, 2),
    i2osp(id, 2),
  ])
  const empty = new Uint8Array(0)
  const pskIdHash = labeledExtract(suite, empty, 'psk_id_hash', empty)
  const infoHash = labeledExtract(suite, empty, 'info_hash', info)
  const context = Buffer.concat([Buffer.from([0]), pskIdHash, infoHash])
  const secret = labeledExtract(suite, sharedSecret, 'secret', empty)
  return {
    key: labeledExpand(suite, secret, 'key', context, nk),
    nonce: labeledExpand(suite, secret, 'base_nonce', context, N_NONCE),
  }
}

export interface HpkeSealed {
  readonly enc: Uint8Array
  readonly ct: Uint8Array
}

/** Test seam: the intermediate values of RFC 9180 §5 for one seal. */
export interface HpkeTrace {
  readonly sharedSecret: Uint8Array
  readonly key: Uint8Array
  readonly baseNonce: Uint8Array
}

/**
 * Seals `pt` to the X25519 public key `pkR`. The ephemeral key is drawn at
 * random unless a test passes `ephemeralSecret`.
 */
export function hpkeSeal(
  pkR: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  pt: Uint8Array,
  aead: HpkeAead,
  options: { readonly ephemeralSecret?: Uint8Array; readonly trace?: (t: HpkeTrace) => void } = {},
): HpkeSealed {
  const skE: KeyObject =
    options.ephemeralSecret === undefined
      ? generateKeyPairSync('x25519').privateKey
      : x25519PrivateKey(options.ephemeralSecret)
  const enc = rawPublicKey(skE)
  const dh = diffieHellman({ privateKey: skE, publicKey: x25519PublicKey(pkR) })
  const shared = dhkemSharedSecret(dh, enc, pkR)
  const ctx = keySchedule(aead, shared, info)
  options.trace?.({ sharedSecret: shared, key: ctx.key, baseNonce: ctx.nonce })
  const cipher = createCipheriv(aead, ctx.key, ctx.nonce)
  cipher.setAAD(aad)
  const ct = Buffer.concat([cipher.update(pt), cipher.final(), cipher.getAuthTag()])
  return { enc, ct: new Uint8Array(ct) }
}

/** Opens a sealed value with the recipient's X25519 secret; `undefined` when it does not open. */
export function hpkeOpen(
  skR: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  sealed: HpkeSealed,
  aead: HpkeAead,
): Uint8Array | undefined {
  if (sealed.enc.length !== 32 || sealed.ct.length < 16) {
    return undefined
  }
  try {
    const recipient = x25519PrivateKey(skR)
    const dh = diffieHellman({ privateKey: recipient, publicKey: x25519PublicKey(sealed.enc) })
    const shared = dhkemSharedSecret(dh, sealed.enc, rawPublicKey(recipient))
    const ctx = keySchedule(aead, shared, info)
    const decipher = createDecipheriv(aead, ctx.key, ctx.nonce)
    decipher.setAAD(aad)
    decipher.setAuthTag(sealed.ct.subarray(sealed.ct.length - 16))
    const pt = Buffer.concat([
      decipher.update(sealed.ct.subarray(0, sealed.ct.length - 16)),
      decipher.final(),
    ])
    return new Uint8Array(pt)
  } catch {
    return undefined
  }
}

import { canonicalBytes } from '../jcs.ts'
import type { JsonObject, JsonValue } from '../json.ts'
import { isJsonObject } from '../json.ts'
import { b64u, fromB64u, fromB64uOf } from './encoding.ts'
import { type HpkeTrace, hpkeOpen, hpkeSeal } from './hpke.ts'

/**
 * The sealed value `ns1`: HPKE base mode, DHKEM(X25519, HKDF-SHA256),
 * HKDF-SHA256, AES-256-GCM, to the node's bound encryption key
 * ([protocol.md §7.6](../../../../exponetdb-docs/07-node-agent/protocol.md#76-sealed-value-ns1)).
 */

export interface SealContext {
  readonly installationId: string
  readonly nodeId: string
  readonly jobId: string
  readonly operationId: string
  readonly capability: { readonly name: string; readonly major: number }
  /** The argument the value fills. */
  readonly field: string
}

export interface Ns1Value {
  readonly enc: string
  readonly ct: string
}

/** `info` of a seal: JCS of purpose and the context. */
export function sealInfo(context: SealContext): Uint8Array {
  const value: JsonObject = {
    purpose: 'exponetdb/sealed/ns1',
    installationId: context.installationId,
    nodeId: context.nodeId,
    jobId: context.jobId,
    operationId: context.operationId,
    capability: { name: context.capability.name, major: context.capability.major },
    field: context.field,
  }
  const bytes = canonicalBytes(value)
  if (!bytes.ok) {
    throw new TypeError(`not canonicalizable: ${bytes.error.code}`)
  }
  return bytes.value
}

/** Seals `plaintext` to the node's raw X25519 public key; the `args` form `{ ns1: … }`. */
export function sealNs1(
  nodeEncryptionKey: Uint8Array,
  context: SealContext,
  plaintext: Uint8Array,
  options: { readonly ephemeralSecret?: Uint8Array; readonly trace?: (t: HpkeTrace) => void } = {},
): { readonly ns1: Ns1Value } {
  const sealed = hpkeSeal(
    nodeEncryptionKey,
    sealInfo(context),
    new Uint8Array(0),
    plaintext,
    'aes-256-gcm',
    options,
  )
  return { ns1: { enc: b64u(sealed.enc), ct: b64u(sealed.ct) } }
}

/** Reads the `{ ns1: { enc, ct } }` form strictly; `undefined` when it is something else. */
export function parseNs1(value: JsonValue | undefined): Ns1Value | undefined {
  if (!isJsonObject(value) || Object.keys(value).length !== 1) {
    return undefined
  }
  const inner = value['ns1']
  if (
    !isJsonObject(inner) ||
    Object.keys(inner).length !== 2 ||
    typeof inner['enc'] !== 'string' ||
    typeof inner['ct'] !== 'string'
  ) {
    return undefined
  }
  return { enc: inner['enc'], ct: inner['ct'] }
}

/** Opens an `ns1` value with the node's X25519 secret; `undefined` when it does not open. */
export function openNs1(
  nodeEncryptionSecret: Uint8Array,
  context: SealContext,
  value: Ns1Value,
): Uint8Array | undefined {
  const enc = fromB64uOf(value.enc, 32)
  const ct = fromB64u(value.ct)
  if (enc === undefined || ct === undefined) {
    return undefined
  }
  return hpkeOpen(
    nodeEncryptionSecret,
    sealInfo(context),
    new Uint8Array(0),
    { enc, ct },
    'aes-256-gcm',
  )
}

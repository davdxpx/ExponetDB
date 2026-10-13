import {
  createHash,
  createSign,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
} from 'node:crypto'

/**
 * A software WebAuthn authenticator for tests only: ES256 key pair, `none`
 * attestation, discoverable credential with a user handle. It encodes CBOR
 * and signs exactly as the WebAuthn specification describes, so the
 * production verification (the `@simplewebauthn/server` library) is tested
 * against independently produced responses, including malformed and
 * adversarial ones. Production code never imports it.
 */
type Cbor = number | string | Uint8Array | Map<Cbor, Cbor> | readonly Cbor[]

function head(major: number, value: number): number[] {
  if (value < 24) return [(major << 5) | value]
  if (value < 0x100) return [(major << 5) | 24, value]
  if (value < 0x10000) return [(major << 5) | 25, value >> 8, value & 0xff]
  return [
    (major << 5) | 26,
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]
}

export function cbor(value: Cbor): Uint8Array {
  const out: number[] = []
  const write = (v: Cbor): void => {
    if (typeof v === 'number') {
      out.push(...(v >= 0 ? head(0, v) : head(1, -1 - v)))
    } else if (typeof v === 'string') {
      const bytes = Buffer.from(v, 'utf8')
      out.push(...head(3, bytes.length), ...bytes)
    } else if (v instanceof Uint8Array) {
      out.push(...head(2, v.length), ...v)
    } else if (v instanceof Map) {
      out.push(...head(5, v.size))
      for (const [k, item] of v) {
        write(k)
        write(item)
      }
    } else {
      out.push(...head(4, v.length))
      for (const item of v) write(item)
    }
  }
  write(value)
  return Uint8Array.from(out)
}

const b64 = (bytes: Uint8Array | Buffer): string => Buffer.from(bytes).toString('base64url')
const sha256 = (data: Uint8Array | string): Buffer => createHash('sha256').update(data).digest()

export interface CeremonyInput {
  readonly challenge: string
  readonly origin: string
  readonly rpId: string
  readonly userVerified?: boolean
  readonly userPresent?: boolean
  readonly crossOrigin?: boolean
  readonly type?: string
}

export class SoftAuthenticator {
  readonly credentialId: Uint8Array = new Uint8Array(randomBytes(32))
  readonly userHandle: Uint8Array
  readonly #key: KeyObject
  readonly #publicJwk: { x: string; y: string }
  counter: number
  readonly synced: boolean

  constructor(userHandle: Uint8Array, options: { synced?: boolean } = {}) {
    this.userHandle = userHandle
    this.synced = options.synced ?? true
    this.counter = 0
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    this.#key = privateKey
    const jwk = publicKey.export({ format: 'jwk' })
    this.#publicJwk = { x: String(jwk.x), y: String(jwk.y) }
  }

  get id(): string {
    return b64(this.credentialId)
  }

  /**
   * The credential in the shape of the Chrome DevTools Protocol's
   * `WebAuthn.addCredential` (standard base64): a browser test loads the same
   * passkey into a virtual authenticator. Tests only.
   */
  forVirtualAuthenticator(rpId: string): {
    readonly credentialId: string
    readonly isResidentCredential: true
    readonly rpId: string
    readonly privateKey: string
    readonly userHandle: string
    readonly signCount: number
  } {
    return {
      credentialId: Buffer.from(this.credentialId).toString('base64'),
      isResidentCredential: true,
      rpId,
      privateKey: this.#key.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      userHandle: Buffer.from(this.userHandle).toString('base64'),
      signCount: this.counter,
    }
  }

  #clientData(kind: 'webauthn.create' | 'webauthn.get', input: CeremonyInput): string {
    return b64(
      Buffer.from(
        JSON.stringify({
          type: input.type ?? kind,
          challenge: input.challenge,
          origin: input.origin,
          crossOrigin: input.crossOrigin ?? false,
        }),
      ),
    )
  }

  #flags(input: CeremonyInput, attested: boolean): number {
    let flags = 0
    if (input.userPresent ?? true) flags |= 0x01
    if (input.userVerified ?? true) flags |= 0x04
    if (this.synced) flags |= 0x08 | 0x10
    if (attested) flags |= 0x40
    return flags
  }

  register(input: CeremonyInput) {
    const cose = new Map<Cbor, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, new Uint8Array(Buffer.from(this.#publicJwk.x, 'base64url'))],
      [-3, new Uint8Array(Buffer.from(this.#publicJwk.y, 'base64url'))],
    ])
    const authData = Buffer.concat([
      sha256(input.rpId),
      Buffer.from([this.#flags(input, true)]),
      Buffer.from([0, 0, 0, 0]),
      Buffer.alloc(16),
      Buffer.from([this.credentialId.length >> 8, this.credentialId.length & 0xff]),
      Buffer.from(this.credentialId),
      Buffer.from(cbor(cose)),
    ])
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', new Uint8Array(authData)],
      ]),
    )
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: this.#clientData('webauthn.create', input),
        attestationObject: b64(attestationObject),
        transports: ['internal' as const, 'hybrid' as const],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform' as const,
    }
  }

  assert(input: CeremonyInput & { readonly userHandle?: Uint8Array | null }) {
    if (!this.synced) {
      this.counter += 1
    }
    const counter = Buffer.alloc(4)
    counter.writeUInt32BE(this.counter)
    const authData = Buffer.concat([
      sha256(input.rpId),
      Buffer.from([this.#flags(input, false)]),
      counter,
    ])
    const clientDataJSON = this.#clientData('webauthn.get', input)
    const signer = createSign('SHA256')
    signer.update(Buffer.concat([authData, sha256(Buffer.from(clientDataJSON, 'base64url'))]))
    const signature = signer.sign(this.#key)
    const handle = input.userHandle === undefined ? this.userHandle : input.userHandle
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: {
        clientDataJSON,
        authenticatorData: b64(authData),
        signature: b64(signature),
        ...(handle === null ? {} : { userHandle: b64(handle) }),
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform' as const,
    }
  }
}

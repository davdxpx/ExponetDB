import { createHash, createPublicKey, type KeyObject, sign } from 'node:crypto'
import { isIP } from 'node:net'
import {
  bitString,
  boolean,
  type Der,
  explicit,
  implicit,
  octetString,
  oid,
  sequence,
  set,
  smallInteger,
  time,
  unsignedInteger,
  utf8String,
} from './der.ts'

/**
 * Certificates of fixed profiles (enrollment.md §1, §2; ADR-0024 §2): the
 * agent PKI is Ed25519 throughout, the PostgreSQL server PKI held by the
 * worker is P-256 (OD-17). The issuer decides every name and extension; the
 * host only contributes a public key whose possession it proved.
 */

export type KeyAlgorithm = 'ed25519' | 'p256'

/** A public key as raw bytes: 32 for Ed25519, the 65-byte uncompressed point for P-256. */
export interface PublicKeyInfo {
  readonly algorithm: KeyAlgorithm
  readonly raw: Uint8Array
}

/** A key that signs certificates. */
export interface Signer {
  readonly publicKey: PublicKeyInfo
  sign(data: Uint8Array): Uint8Array
}

export type Profile =
  | 'root'
  | 'server_ca'
  | 'issuing_ca'
  | 'gateway'
  | 'node'
  | 'postgres_root'
  | 'postgres_server'

const OID = {
  ed25519: '1.3.101.112',
  ecPublicKey: '1.2.840.10045.2.1',
  prime256v1: '1.2.840.10045.3.1.7',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  subjectKeyIdentifier: '2.5.29.14',
  keyUsage: '2.5.29.15',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  authorityKeyIdentifier: '2.5.29.35',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
  clientAuth: '1.3.6.1.5.5.7.3.2',
} as const

/** The rules of each profile. */
const PROFILES: Record<
  Profile,
  {
    readonly ca: boolean
    readonly pathLen?: number
    readonly eku: readonly string[]
    readonly key: KeyAlgorithm
    readonly maxLifetimeHours: number
  }
> = {
  root: { ca: true, eku: [], key: 'ed25519', maxLifetimeHours: 10 * 365 * 24 },
  server_ca: {
    ca: true,
    pathLen: 0,
    eku: [OID.serverAuth],
    key: 'ed25519',
    maxLifetimeHours: 5 * 365 * 24,
  },
  issuing_ca: {
    ca: true,
    pathLen: 0,
    eku: [OID.clientAuth],
    key: 'ed25519',
    maxLifetimeHours: 5 * 365 * 24,
  },
  gateway: { ca: false, eku: [OID.serverAuth], key: 'ed25519', maxLifetimeHours: 90 * 24 },
  node: { ca: false, eku: [OID.clientAuth], key: 'ed25519', maxLifetimeHours: 72 },
  postgres_root: { ca: true, eku: [], key: 'p256', maxLifetimeHours: 10 * 365 * 24 },
  postgres_server: { ca: false, eku: [OID.serverAuth], key: 'p256', maxLifetimeHours: 90 * 24 },
}

export interface CertificateRequest {
  readonly profile: Profile
  /** 16 random bytes (positive after encoding). */
  readonly serial: Uint8Array
  readonly commonName: string
  readonly publicKey: PublicKeyInfo
  readonly notBefore: Date
  readonly notAfter: Date
  /** node: the one SAN URI. */
  readonly uri?: string
  readonly dnsNames?: readonly string[]
  readonly ipAddresses?: readonly string[]
}

/** The issuer of a certificate: its subject and its signing key. */
export interface Issuer {
  readonly commonName: string
  readonly signer: Signer
}

function algorithmIdentifier(algorithm: KeyAlgorithm): Der {
  return algorithm === 'ed25519' ? sequence(oid(OID.ed25519)) : sequence(oid(OID.ecdsaSha256))
}

function subjectPublicKeyInfo(key: PublicKeyInfo): Der {
  if (key.algorithm === 'ed25519') {
    if (key.raw.length !== 32) {
      throw new RangeError('an Ed25519 public key is 32 bytes')
    }
    return sequence(sequence(oid(OID.ed25519)), bitString(key.raw))
  }
  if (key.raw.length !== 65 || key.raw[0] !== 0x04) {
    throw new RangeError('a P-256 public key is the 65-byte uncompressed point')
  }
  return sequence(sequence(oid(OID.ecPublicKey), oid(OID.prime256v1)), bitString(key.raw))
}

function name(commonName: string): Der {
  if (commonName.length === 0 || commonName.length > 64) {
    throw new RangeError('a common name is 1 to 64 characters')
  }
  return sequence(set(sequence(oid(OID.commonName), utf8String(commonName))))
}

/** RFC 5280 §4.2.1.2 method 1: SHA-1 over the subjectPublicKey bits. */
export function keyIdentifier(key: PublicKeyInfo): Uint8Array {
  return new Uint8Array(createHash('sha1').update(key.raw).digest())
}

function extension(id: string, critical: boolean, value: Der): Der {
  return critical
    ? sequence(oid(id), boolean(true), octetString(value))
    : sequence(oid(id), octetString(value))
}

function ipBytes(text: string): Uint8Array {
  const kind = isIP(text)
  if (kind === 4) {
    return new Uint8Array(text.split('.').map((p) => Number(p)))
  }
  if (kind === 6) {
    const [head = '', tail = ''] = text.split('::')
    const h = head === '' ? [] : head.split(':')
    const t = text.includes('::') ? (tail === '' ? [] : tail.split(':')) : []
    const groups = text.includes('::')
      ? [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t]
      : h
    const out = new Uint8Array(16)
    groups.forEach((g, i) => {
      const n = Number.parseInt(g, 16)
      out[i * 2] = n >> 8
      out[i * 2 + 1] = n & 0xff
    })
    return out
  }
  throw new RangeError(`not an IP address: ${text}`)
}

const DNS_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/
const NODE_URI =
  /^urn:exponet:exponetdb:node:ins_[0-7][0-9A-HJKMNP-TV-Z]{25}:nod_[0-7][0-9A-HJKMNP-TV-Z]{25}$/

function check(req: CertificateRequest): void {
  const p = PROFILES[req.profile]
  if (req.publicKey.algorithm !== p.key) {
    throw new RangeError(`${req.profile} certificates carry ${p.key} keys`)
  }
  if (req.serial.length !== 16) {
    throw new RangeError('a serial is 16 random bytes')
  }
  const hours = (req.notAfter.getTime() - req.notBefore.getTime()) / 3_600_000
  if (!(hours > 0) || hours > p.maxLifetimeHours) {
    throw new RangeError(`${req.profile} certificates live at most ${p.maxLifetimeHours} hours`)
  }
  const dns = req.dnsNames ?? []
  const ips = req.ipAddresses ?? []
  if (dns.some((d) => d.length > 253 || !DNS_NAME.test(d))) {
    throw new RangeError('a DNS name is invalid')
  }
  switch (req.profile) {
    case 'node':
      if (
        req.uri === undefined ||
        !NODE_URI.test(req.uri) ||
        !req.uri.endsWith(`:${req.commonName}`) ||
        dns.length + ips.length > 0
      ) {
        throw new RangeError('a node certificate has CN nod_… and exactly its node URI')
      }
      break
    case 'gateway':
    case 'postgres_server':
      if (dns.length + ips.length === 0 || req.uri !== undefined) {
        throw new RangeError(`a ${req.profile} certificate names at least one DNS name or address`)
      }
      break
    default:
      if (dns.length + ips.length > 0 || req.uri !== undefined) {
        throw new RangeError('a CA certificate has no subject alternative name')
      }
  }
}

/**
 * Encodes and signs a certificate. A root (or postgres_root) is self-signed:
 * pass its own signer as the issuer with the same common name.
 */
export function issueCertificate(req: CertificateRequest, issuer: Issuer): Uint8Array {
  check(req)
  const p = PROFILES[req.profile]
  const selfSigned = req.profile === 'root' || req.profile === 'postgres_root'
  if (selfSigned && issuer.commonName !== req.commonName) {
    throw new RangeError('a root is its own issuer')
  }
  const issuerAlgorithm = issuer.signer.publicKey.algorithm
  const extensions: Der[] = [
    extension(
      OID.basicConstraints,
      true,
      p.ca
        ? sequence(boolean(true), ...(p.pathLen === undefined ? [] : [smallInteger(p.pathLen)]))
        : sequence(),
    ),
    // keyCertSign | cRLSign for CAs (bits 5, 6), digitalSignature (bit 0) otherwise.
    extension(
      OID.keyUsage,
      true,
      p.ca ? bitString(new Uint8Array([0x06]), 1) : bitString(new Uint8Array([0x80]), 7),
    ),
  ]
  if (p.eku.length > 0) {
    extensions.push(extension(OID.extKeyUsage, false, sequence(...p.eku.map((e) => oid(e)))))
  }
  const names: Der[] = [
    ...(req.uri === undefined ? [] : [implicit(6, new TextEncoder().encode(req.uri))]),
    ...(req.dnsNames ?? []).map((d) => implicit(2, new TextEncoder().encode(d))),
    ...(req.ipAddresses ?? []).map((a) => implicit(7, ipBytes(a))),
  ]
  if (names.length > 0) {
    extensions.push(extension(OID.subjectAltName, false, sequence(...names)))
  }
  extensions.push(
    extension(OID.subjectKeyIdentifier, false, octetString(keyIdentifier(req.publicKey))),
  )
  if (!selfSigned) {
    extensions.push(
      extension(
        OID.authorityKeyIdentifier,
        false,
        sequence(implicit(0, keyIdentifier(issuer.signer.publicKey))),
      ),
    )
  }
  const tbs = sequence(
    explicit(0, smallInteger(2)),
    unsignedInteger(req.serial),
    algorithmIdentifier(issuerAlgorithm),
    name(issuer.commonName),
    sequence(time(req.notBefore), time(req.notAfter)),
    name(req.commonName),
    subjectPublicKeyInfo(req.publicKey),
    explicit(3, sequence(...extensions)),
  )
  const signature = issuer.signer.sign(tbs)
  return sequence(tbs, algorithmIdentifier(issuerAlgorithm), bitString(signature))
}

/** A Signer for a private KeyObject (Ed25519 or P-256). */
export function keySigner(privateKey: KeyObject): Signer {
  const type = privateKey.asymmetricKeyType
  const pub = createPublicKey(privateKey)
  if (type === 'ed25519') {
    const der = pub.export({ format: 'der', type: 'spki' })
    const raw = new Uint8Array(der.subarray(der.length - 32))
    return {
      publicKey: { algorithm: 'ed25519', raw },
      sign: (data) => new Uint8Array(sign(null, data, privateKey)),
    }
  }
  if (type === 'ec' && privateKey.asymmetricKeyDetails?.namedCurve === 'prime256v1') {
    const der = pub.export({ format: 'der', type: 'spki' })
    const raw = new Uint8Array(der.subarray(der.length - 65))
    return {
      publicKey: { algorithm: 'p256', raw },
      sign: (data) => new Uint8Array(sign('sha256', data, { key: privateKey, dsaEncoding: 'der' })),
    }
  }
  throw new TypeError('a certificate signer is an Ed25519 or P-256 private key')
}

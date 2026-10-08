import { createPrivateKey } from 'node:crypto'
import {
  type Issuer,
  issueCertificate,
  keySigner,
  type Profile,
  type Signer,
} from '../src/index.ts'

/**
 * A deterministic agent PKI (Ed25519 signatures are deterministic) for the
 * cross-language fixture tooling/fixtures/node-pki: test keys from fixed
 * seeds, never real key material.
 */

export const PKI_TIME = new Date('2026-10-07T12:00:00Z')
export const INSTALLATION = 'ins_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z'
export const NODE = 'nod_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z'
export const SERVER_NAME = 'gateway.exdb.internal'

const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex')

export function seed(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte)
}

export function ed25519Signer(s: Uint8Array): Signer {
  return keySigner(
    createPrivateKey({ key: Buffer.concat([PKCS8, s]), format: 'der', type: 'pkcs8' }),
  )
}

const serial = (n: number) => new Uint8Array(16).fill(n)
const hours = (n: number) => new Date(PKI_TIME.getTime() + n * 3_600_000)

export interface FixtureCert {
  readonly name: string
  readonly profile: Profile
  readonly seed: number
  readonly der: Uint8Array
}

/** Every certificate of the fixture, named by its file. */
export function buildFixture(): FixtureCert[] {
  const root = ed25519Signer(seed(1))
  const serverCa = ed25519Signer(seed(2))
  const issuingCa = ed25519Signer(seed(3))
  const gateway = ed25519Signer(seed(4))
  const node = ed25519Signer(seed(5))
  const rootIssuer: Issuer = { commonName: 'ExponetDB Agent Root CA', signer: root }
  const serverIssuer: Issuer = { commonName: 'ExponetDB Gateway Server CA', signer: serverCa }
  const issuingIssuer: Issuer = { commonName: 'ExponetDB Agent Issuing CA', signer: issuingCa }
  const out: FixtureCert[] = []
  const add = (name: string, profile: Profile, s: number, der: Uint8Array) =>
    out.push({ name, profile, seed: s, der })
  const ca = (profile: Profile, commonName: string, signer: Signer, n: number, issuer: Issuer) =>
    issueCertificate(
      {
        profile,
        serial: serial(n),
        commonName,
        publicKey: signer.publicKey,
        notBefore: hours(-1),
        notAfter: hours(24 * 365),
      },
      issuer,
    )
  add('root', 'root', 1, ca('root', rootIssuer.commonName, root, 1, rootIssuer))
  add(
    'server-ca',
    'server_ca',
    2,
    ca('server_ca', serverIssuer.commonName, serverCa, 2, rootIssuer),
  )
  add(
    'issuing-ca',
    'issuing_ca',
    3,
    ca('issuing_ca', issuingIssuer.commonName, issuingCa, 3, rootIssuer),
  )
  const gatewayCert = (issuer: Issuer, n: number) =>
    issueCertificate(
      {
        profile: 'gateway',
        serial: serial(n),
        commonName: SERVER_NAME,
        publicKey: gateway.publicKey,
        notBefore: hours(-1),
        notAfter: hours(24 * 89),
        dnsNames: [SERVER_NAME],
        ipAddresses: ['10.8.2.2'],
      },
      issuer,
    )
  const nodeCert = (issuer: Issuer, n: number) =>
    issueCertificate(
      {
        profile: 'node',
        serial: serial(n),
        commonName: NODE,
        publicKey: node.publicKey,
        notBefore: hours(-1),
        notAfter: hours(71),
        uri: `urn:exponet:exponetdb:node:${INSTALLATION}:${NODE}`,
      },
      issuer,
    )
  add('gateway', 'gateway', 4, gatewayCert(serverIssuer, 4))
  add('node', 'node', 5, nodeCert(issuingIssuer, 5))
  // EKU separation: a node certificate from the server CA and a gateway
  // certificate from the issuing CA must never verify.
  add('node-from-server-ca', 'node', 5, nodeCert(serverIssuer, 6))
  add('gateway-from-issuing-ca', 'gateway', 4, gatewayCert(issuingIssuer, 7))
  return out
}

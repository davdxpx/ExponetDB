import { randomBytes } from 'node:crypto'
import { appendAuditEvent } from '@exponetdb/audit'
import type { Queryable, Tx } from '@exponetdb/control-store'
import { type Clock, isId } from '@exponetdb/kernel'
import { ed25519PrivateKey, keyFingerprint, rawPublicKey } from '@exponetdb/kernel/node'
import { createSecret, type Keyring, readSecret } from '@exponetdb/secrets'
import { NodeError } from './errors.ts'
import { type Issuer, issueCertificate, keySigner, type Signer } from './x509/certificate.ts'

/**
 * The agent PKI on the Control Plane side ([control-plane.md §1, §3](../../../exponetdb-docs/07-node-agent/control-plane.md#3-pki-bootstrap-exponetdb-server-node-pki-init)):
 * the one-time ceremony (`exponetdb-server node-pki init`, run as the worker
 * login), the gateway's loader, and the gateway's own short-lived TLS
 * identity, minted from the server CA in memory. The root's private key is
 * returned once for the owner and never stored; the CA keys are
 * gateway-consumer secrets, the job-signing key a worker-consumer secret.
 */

export const PKI_NAMES = {
  root: 'ExponetDB Agent Root CA',
  serverCa: 'ExponetDB Gateway Server CA',
  issuingCa: 'ExponetDB Agent Issuing CA',
  gateway: 'ExponetDB Gateway',
} as const

const HOUR = 3_600_000
const YEAR_HOURS = 365 * 24
/** The gateway's TLS certificate lives three days and is minted again daily. */
export const GATEWAY_CERTIFICATE_HOURS = 72

const GATEWAY_URL =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::[1-9][0-9]{0,4})?$/
const SERVER_NAME =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/

function serial(): Uint8Array {
  return new Uint8Array(randomBytes(16))
}

function seedSigner(seed: Uint8Array): Signer {
  return keySigner(ed25519PrivateKey(seed))
}

/** `jobkey_<yyyy>_<mm>_<6 random characters>`. */
export function newJobKeyId(atMs: number): string {
  const d = new Date(atMs)
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  const suffix = [...randomBytes(6)].map((b) => alphabet[b & 31]).join('')
  return `jobkey_${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}_${suffix}`
}

export interface PkiInit {
  /** The private gateway listener as the token carries it: `https://host[:port]`, never `:443`. */
  readonly gatewayUrl: string
  /** The DNS name the gateway's server certificate carries. */
  readonly serverName: string
}

export interface InitializedPki {
  readonly rootFingerprint: string
  readonly rootCertificate: Uint8Array
  /** PKCS#8 PEM of the root key, for the owner's offline copy; never stored. */
  readonly rootPrivateKeyPem: string
  readonly jobKeyId: string
}

/**
 * Runs the ceremony in the caller's (worker) transaction: four fresh Ed25519
 * keys, the root, the two CAs, the CA keys as gateway-consumer secrets, the
 * first job-signing key as a worker-consumer secret, one audit event. A
 * second ceremony is refused by the schema (one PKI per installation).
 */
export async function initPki(
  tx: Tx,
  keyring: Keyring,
  clock: Clock,
  init: PkiInit,
): Promise<InitializedPki> {
  if (
    !GATEWAY_URL.test(init.gatewayUrl) ||
    init.gatewayUrl.endsWith(':443') ||
    init.serverName.length > 253 ||
    !SERVER_NAME.test(init.serverName)
  ) {
    throw new NodeError('VALIDATION_FAILED')
  }
  const now = clock.nowMs()
  const seeds = {
    root: new Uint8Array(randomBytes(32)),
    serverCa: new Uint8Array(randomBytes(32)),
    issuingCa: new Uint8Array(randomBytes(32)),
    jobKey: new Uint8Array(randomBytes(32)),
  }
  try {
    const root = seedSigner(seeds.root)
    const rootIssuer: Issuer = { commonName: PKI_NAMES.root, signer: root }
    const notBefore = new Date(now - HOUR)
    const ca = (
      profile: 'root' | 'server_ca' | 'issuing_ca',
      commonName: string,
      signer: Signer,
      years: number,
    ) =>
      issueCertificate(
        {
          profile,
          serial: serial(),
          commonName,
          publicKey: signer.publicKey,
          notBefore,
          notAfter: new Date(notBefore.getTime() + years * YEAR_HOURS * HOUR),
        },
        rootIssuer,
      )
    const rootCertificate = ca('root', PKI_NAMES.root, root, 10)
    const serverCaCertificate = ca('server_ca', PKI_NAMES.serverCa, seedSigner(seeds.serverCa), 5)
    const issuingCaCertificate = ca(
      'issuing_ca',
      PKI_NAMES.issuingCa,
      seedSigner(seeds.issuingCa),
      5,
    )
    const rootFingerprint = keyFingerprint(rootCertificate)

    const serverCaKey = await createSecret(
      tx,
      keyring,
      {
        purpose: 'node.pki',
        subjectId: 'server_ca',
        consumer: 'gateway',
        plaintext: seeds.serverCa,
      },
      { clock },
    )
    const issuingCaKey = await createSecret(
      tx,
      keyring,
      {
        purpose: 'node.pki',
        subjectId: 'issuing_ca',
        consumer: 'gateway',
        plaintext: seeds.issuingCa,
      },
      { clock },
    )
    await tx.query(
      'nodes.pki.insert',
      `INSERT INTO nodes.pki (root_certificate, root_fingerprint, issuing_ca_certificate, issuing_ca_key_secret_id,
                              server_ca_certificate, server_ca_key_secret_id, gateway_url, gateway_server_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        Buffer.from(rootCertificate),
        rootFingerprint,
        Buffer.from(issuingCaCertificate),
        issuingCaKey.secretId,
        Buffer.from(serverCaCertificate),
        serverCaKey.secretId,
        init.gatewayUrl,
        init.serverName,
      ],
    )
    const jobKeyId = await addJobKey(tx, keyring, clock, seeds.jobKey)
    await appendAuditEvent(
      tx,
      {
        action: 'node_pki.initialized',
        phase: 'completed',
        actor: { kind: 'system', identityId: null, label: 'system:maintenance' },
        changes: { rootFingerprint, jobKeyId, gatewayUrl: init.gatewayUrl },
        result: { status: 'succeeded' },
      },
      { clock },
    )
    const rootPrivateKeyPem = ed25519PrivateKey(seeds.root)
      .export({ format: 'pem', type: 'pkcs8' })
      .toString()
    return { rootFingerprint, rootCertificate, rootPrivateKeyPem, jobKeyId }
  } finally {
    for (const s of Object.values(seeds)) {
      s.fill(0)
    }
  }
}

/** Records a job-signing key: the seed as a worker-consumer secret, the public key and its fingerprint. */
export async function addJobKey(
  tx: Tx,
  keyring: Keyring,
  clock: Clock,
  seed: Uint8Array,
): Promise<string> {
  const keyId = newJobKeyId(clock.nowMs())
  const publicKey = rawPublicKey(ed25519PrivateKey(seed))
  const ref = await createSecret(
    tx,
    keyring,
    { purpose: 'node.job_key', subjectId: keyId, consumer: 'worker', plaintext: seed },
    { clock },
  )
  await tx.query(
    'nodes.job_key.insert',
    `INSERT INTO nodes.job_keys (key_id, public_key, fingerprint, secret_id, state)
     VALUES ($1, $2, $3, $4, 'active')`,
    [keyId, Buffer.from(publicKey), keyFingerprint(publicKey), ref.secretId],
  )
  return keyId
}

/** What the gateway serves the agent API with. */
export interface GatewayPki {
  readonly rootCertificate: Uint8Array
  readonly rootFingerprint: string
  readonly serverCaCertificate: Uint8Array
  readonly issuingCaCertificate: Uint8Array
  /** Signs node certificates (profile `node`). */
  readonly issuing: Issuer
  /** Signs the gateway's own TLS certificate (profile `gateway`). */
  readonly server: Issuer
  readonly gatewayUrl: string
  readonly serverName: string
}

/**
 * The gateway's view of the PKI: the certificates and its two CA keys
 * (gateway-consumer secrets). `undefined` until `node-pki init` ran.
 */
export async function loadGatewayPki(
  q: Queryable,
  keyring: Keyring,
): Promise<GatewayPki | undefined> {
  const { rows } = await q.query(
    'nodes.pki.load',
    `SELECT root_certificate, root_fingerprint, issuing_ca_certificate, issuing_ca_key_secret_id,
            server_ca_certificate, server_ca_key_secret_id, gateway_url, gateway_server_name
       FROM nodes.pki`,
  )
  const row = rows[0]
  if (row === undefined) {
    return undefined
  }
  const signer = async (secretId: string): Promise<Signer> => {
    if (!isId('sec', secretId)) {
      throw new NodeError('INTERNAL')
    }
    const seed = await readSecret(q, keyring, { secretId, consumer: 'gateway' })
    try {
      return seedSigner(seed)
    } finally {
      seed.fill(0)
    }
  }
  return {
    rootCertificate: row.bytes('root_certificate'),
    rootFingerprint: row.text('root_fingerprint'),
    serverCaCertificate: row.bytes('server_ca_certificate'),
    issuingCaCertificate: row.bytes('issuing_ca_certificate'),
    issuing: {
      commonName: PKI_NAMES.issuingCa,
      signer: await signer(row.text('issuing_ca_key_secret_id')),
    },
    server: {
      commonName: PKI_NAMES.serverCa,
      signer: await signer(row.text('server_ca_key_secret_id')),
    },
    gatewayUrl: row.text('gateway_url'),
    serverName: row.text('gateway_server_name'),
  }
}

/** PEM of a DER certificate. */
export function certificatePem(der: Uint8Array): string {
  const b64 = Buffer.from(der).toString('base64')
  const lines = b64.match(/.{1,64}/g) ?? []
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`
}

export interface GatewayIdentity {
  /** The gateway certificate, the server CA and the root, as PEM (the agent pins the root in the chain). */
  readonly certificateChainPem: string
  readonly privateKeyPem: string
  readonly notAfter: Date
}

/**
 * A fresh TLS identity for the gateway listener: a new key in memory and a
 * certificate from the server CA for the configured server name. Never
 * stored; minted at start and again before it expires.
 */
export function mintGatewayIdentity(pki: GatewayPki, clock: Clock): GatewayIdentity {
  const key = ed25519PrivateKey(new Uint8Array(randomBytes(32)))
  const notBefore = new Date(clock.nowMs() - 5 * 60_000)
  const notAfter = new Date(notBefore.getTime() + GATEWAY_CERTIFICATE_HOURS * HOUR)
  const der = issueCertificate(
    {
      profile: 'gateway',
      serial: serial(),
      commonName: PKI_NAMES.gateway,
      publicKey: { algorithm: 'ed25519', raw: rawPublicKey(key) },
      notBefore,
      notAfter,
      dnsNames: [pki.serverName],
    },
    pki.server,
  )
  return {
    certificateChainPem:
      certificatePem(der) +
      certificatePem(pki.serverCaCertificate) +
      certificatePem(pki.rootCertificate),
    privateKeyPem: key.export({ format: 'pem', type: 'pkcs8' }).toString(),
    notAfter,
  }
}

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  verify,
} from 'node:crypto'
import type { ControlStore, Queryable } from '@exponetdb/control-store'
import { type Clock, canonicalBytes, isId } from '@exponetdb/kernel'
import { b64u, fromB64uOf } from '@exponetdb/kernel/node'
import { createSecret, type Keyring, readSecret } from '@exponetdb/secrets'
import { NodeError } from './errors.ts'
import { certificatePem } from './pki.ts'
import { issueCertificate, keySigner } from './x509/certificate.ts'

/**
 * The installation's PostgreSQL CA (OD-17, [control-plane.md §9.5](../../../exponetdb-docs/07-node-agent/control-plane.md#95-tls-the-postgresql-ca-od-17)):
 * a P-256 root whose key is a worker-consumer secret. Server keys are made
 * on the host; the worker only signs a certificate for a public key whose
 * proof of possession it checked.
 */
export const POSTGRES_CA_NAME = 'ExponetDB PostgreSQL CA'
const POSTGRES_CA_YEARS = 10
const HOUR = 3_600_000

export interface PostgresCa {
  readonly certificate: Uint8Array
  readonly fingerprint: string
}

export function certificateFingerprint(der: Uint8Array): string {
  return `sha256:${createHash('sha256').update(der).digest('hex')}`
}

/** The recorded PostgreSQL CA, if any (serve reads the certificate only). */
export async function postgresCa(q: Queryable): Promise<PostgresCa | undefined> {
  const { rows } = await q.query(
    'nodes.postgres_ca.read',
    'SELECT certificate, fingerprint FROM nodes.postgres_ca',
  )
  const row = rows[0]
  return row === undefined
    ? undefined
    : { certificate: row.bytes('certificate'), fingerprint: row.text('fingerprint') }
}

/**
 * Creates the PostgreSQL CA once (`exponetdb node-pki postgres-ca`, as the
 * worker), or returns the one recorded. The private key exists only as the
 * worker-consumer secret.
 */
export async function ensurePostgresCa(
  store: ControlStore,
  keyring: Keyring,
  clock: Clock,
): Promise<PostgresCa & { readonly created: boolean }> {
  return store.transaction('nodes.postgres_ca.ensure', async (tx) => {
    await tx.query('nodes.postgres_ca.lock', `SELECT pg_catalog.pg_advisory_xact_lock(1162108993)`)
    const existing = await postgresCa(tx)
    if (existing !== undefined) {
      return { ...existing, created: false }
    }
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' })
    const now = clock.nowMs()
    const signer = keySigner(privateKey)
    const certificate = issueCertificate(
      {
        profile: 'postgres_root',
        serial: new Uint8Array(randomBytes(16)),
        commonName: POSTGRES_CA_NAME,
        publicKey: signer.publicKey,
        notBefore: new Date(now - HOUR),
        notAfter: new Date(now + POSTGRES_CA_YEARS * 365 * 24 * HOUR - 2 * HOUR),
      },
      { commonName: POSTGRES_CA_NAME, signer },
    )
    const ref = await createSecret(
      tx,
      keyring,
      {
        purpose: 'node.postgres_ca_key',
        subjectId: 'postgres_ca',
        consumer: 'worker',
        plaintext: new Uint8Array(pkcs8),
      },
      { clock },
    )
    pkcs8.fill(0)
    const fingerprint = certificateFingerprint(certificate)
    await tx.query(
      'nodes.postgres_ca.insert',
      'INSERT INTO nodes.postgres_ca (certificate, fingerprint, key_secret_id) VALUES ($1, $2, $3)',
      [Buffer.from(certificate), fingerprint, ref.secretId],
    )
    return { certificate, fingerprint, created: true }
  })
}

export function postgresCaPem(ca: PostgresCa): string {
  return certificatePem(ca.certificate)
}

/** The DER certificates of a PEM bundle. */
export function pemCertificates(bundle: string): Uint8Array[] {
  const out: Uint8Array[] = []
  for (const m of bundle.matchAll(
    /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+)-----END CERTIFICATE-----/g,
  )) {
    out.push(new Uint8Array(Buffer.from((m[1] ?? '').replaceAll(/\s+/g, ''), 'base64')))
  }
  return out
}

/** Whether a cluster's CA bundle contains this CA certificate (byte for byte). */
export function bundleTrusts(caBundle: string, ca: PostgresCa): boolean {
  const wanted = Buffer.from(ca.certificate)
  return pemCertificates(caBundle).some((der) => wanted.equals(Buffer.from(der)))
}

/** JCS({purpose: "exponetdb/pgtls-pop/v1", jobId, publicKey}), as the agent signs it. */
function proofValue(jobId: string, publicKey: string): Uint8Array {
  const bytes = canonicalBytes({ purpose: 'exponetdb/pgtls-pop/v1', jobId, publicKey })
  if (!bytes.ok) {
    throw new NodeError('INTERNAL')
  }
  return bytes.value
}

/** A P-256 public key from its uncompressed point (65 bytes). */
function p256PublicKey(point: Uint8Array) {
  return createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: b64u(point.subarray(1, 33)),
      y: b64u(point.subarray(33, 65)),
    },
    format: 'jwk',
  })
}

/** Checks the host's proof of possession of a staged key (ECDSA P-256 SHA-256, r || s). */
export function tlsProofValid(jobId: string, publicKey: string, proof: string): boolean {
  const point = fromB64uOf(publicKey, 65)
  const signature = fromB64uOf(proof, 64)
  if (point === undefined || signature === undefined || point[0] !== 0x04) {
    return false
  }
  try {
    return verify(
      'sha256',
      proofValue(jobId, publicKey),
      { key: p256PublicKey(point), dsaEncoding: 'ieee-p1363' },
      signature,
    )
  } catch {
    return false
  }
}

/**
 * Issues a PostgreSQL server certificate for a host key (worker): P-256,
 * the planned names, at most 90 days; returns the DER certificate and the
 * CA certificate that completes the chain.
 */
export async function issuePostgresServerCertificate(
  q: Queryable,
  keyring: Keyring,
  clock: Clock,
  request: {
    readonly publicKey: string
    readonly dnsNames: readonly string[]
    readonly ipAddresses: readonly string[]
    readonly validityDays: number
  },
): Promise<{ readonly certificate: Uint8Array; readonly ca: Uint8Array }> {
  const { rows } = await q.query(
    'nodes.postgres_ca.key',
    'SELECT certificate, key_secret_id FROM nodes.postgres_ca',
  )
  const row = rows[0]
  const secretId = row?.text('key_secret_id')
  if (row === undefined || secretId === undefined || !isId('sec', secretId)) {
    throw new NodeError('REGISTRY_CONFLICT', { reason: 'postgres_ca_missing' })
  }
  const point = fromB64uOf(request.publicKey, 65)
  if (point === undefined) {
    throw new NodeError('VALIDATION_FAILED')
  }
  const pkcs8 = await readSecret(q, keyring, { secretId, consumer: 'worker' })
  try {
    const signer = keySigner(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }))
    const now = clock.nowMs()
    const certificate = issueCertificate(
      {
        profile: 'postgres_server',
        serial: new Uint8Array(randomBytes(16)),
        commonName: request.dnsNames[0] ?? request.ipAddresses[0] ?? 'postgres',
        publicKey: { algorithm: 'p256', raw: point },
        notBefore: new Date(now - 5 * 60_000),
        notAfter: new Date(now + request.validityDays * 24 * HOUR - 5 * 60_000),
        dnsNames: request.dnsNames,
        ipAddresses: request.ipAddresses,
      },
      { commonName: POSTGRES_CA_NAME, signer },
    )
    return { certificate, ca: row.bytes('certificate') }
  } finally {
    pkcs8.fill(0)
  }
}

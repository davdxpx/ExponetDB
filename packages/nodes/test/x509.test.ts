import { execFileSync } from 'node:child_process'
import { createPrivateKey, generateKeyPairSync, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { issueCertificate, keySigner } from '../src/index.ts'
import {
  buildFixture,
  ed25519Signer,
  INSTALLATION,
  NODE,
  PKI_TIME,
  SERVER_NAME,
  seed,
} from './pki-fixture.ts'

const FIXTURE_DIR = join(import.meta.dirname, '..', '..', '..', 'tooling', 'fixtures', 'node-pki')
const pem = (der: Uint8Array) =>
  `-----BEGIN CERTIFICATE-----\n${Buffer.from(der)
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`

describe('fixed-profile certificates (ADR-0024 §2)', () => {
  const certs = new Map(buildFixture().map((c) => [c.name, c]))
  const x = (name: string) =>
    new X509Certificate(Buffer.from(certs.get(name)?.der ?? new Uint8Array()))

  it('reproduces the committed fixture byte for byte (Ed25519 is deterministic)', () => {
    const manifest = JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8')) as {
      certificates: { name: string; seed: number }[]
    }
    expect(manifest.certificates.map((c) => c.name).sort()).toEqual([...certs.keys()].sort())
    for (const c of certs.values()) {
      expect(
        Buffer.from(readFileSync(join(FIXTURE_DIR, `${c.name}.der`))).equals(Buffer.from(c.der)),
        c.name,
      ).toBe(true)
    }
  })

  it('parses with the expected subjects, extensions and chain', () => {
    const root = x('root')
    const issuing = x('issuing-ca')
    const node = x('node')
    const gateway = x('gateway')
    expect(root.ca && issuing.ca && x('server-ca').ca).toBe(true)
    expect(node.ca || gateway.ca).toBe(false)
    expect(node.subject).toBe(`CN=${NODE}`)
    expect(node.subjectAltName).toBe(`URI:urn:exponet:exponetdb:node:${INSTALLATION}:${NODE}`)
    expect(gateway.subjectAltName).toBe(`DNS:${SERVER_NAME}, IP Address:10.8.2.2`)
    expect(node.checkIssued(issuing)).toBe(true)
    expect(node.verify(issuing.publicKey)).toBe(true)
    expect(issuing.verify(root.publicKey)).toBe(true)
    expect(root.verify(root.publicKey)).toBe(true)
    expect(new Date(node.validTo).getTime() - PKI_TIME.getTime()).toBe(71 * 3_600_000)
  })

  it('verifies with openssl, including the EKU separation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'node-pki-'))
    for (const [name, c] of certs) {
      writeFileSync(join(dir, `${name}.pem`), pem(c.der))
    }
    const verify = (purpose: string, leaf: string, intermediate: string) => {
      try {
        execFileSync(
          'openssl',
          [
            'verify',
            '-x509_strict',
            '-attime',
            String(PKI_TIME.getTime() / 1000),
            '-purpose',
            purpose,
            '-CAfile',
            join(dir, 'root.pem'),
            '-untrusted',
            join(dir, `${intermediate}.pem`),
            join(dir, `${leaf}.pem`),
          ],
          { stdio: 'pipe' },
        )
        return true
      } catch {
        return false
      }
    }
    expect(verify('sslclient', 'node', 'issuing-ca')).toBe(true)
    expect(verify('sslserver', 'gateway', 'server-ca')).toBe(true)
    expect(verify('sslclient', 'node-from-server-ca', 'server-ca')).toBe(false)
    expect(verify('sslserver', 'gateway-from-issuing-ca', 'issuing-ca')).toBe(false)
    expect(verify('sslserver', 'node', 'issuing-ca')).toBe(false)
  })

  it('refuses requests outside the profiles', () => {
    const signer = ed25519Signer(seed(9))
    const issuer = { commonName: 'Issuing', signer }
    const base = {
      profile: 'node' as const,
      serial: new Uint8Array(16).fill(1),
      commonName: NODE,
      publicKey: signer.publicKey,
      notBefore: PKI_TIME,
      notAfter: new Date(PKI_TIME.getTime() + 72 * 3_600_000),
      uri: `urn:exponet:exponetdb:node:${INSTALLATION}:${NODE}`,
    }
    expect(() => issueCertificate(base, issuer)).not.toThrow()
    expect(() =>
      issueCertificate(
        { ...base, notAfter: new Date(PKI_TIME.getTime() + 73 * 3_600_000) },
        issuer,
      ),
    ).toThrow(/72 hours/)
    expect(() =>
      issueCertificate(
        {
          ...base,
          uri: `urn:exponet:exponetdb:node:${INSTALLATION}:nod_01JB2Z6G8M4Q7R9T1V3W5X7YA0`,
        },
        issuer,
      ),
    ).toThrow()
    expect(() => issueCertificate({ ...base, dnsNames: ['evil.example'] }, issuer)).toThrow()
    const { uri: _uri, ...withoutUri } = base
    expect(() => issueCertificate({ ...withoutUri, profile: 'gateway' }, issuer)).toThrow()
    expect(() => issueCertificate({ ...base, profile: 'root' }, issuer)).toThrow()
    expect(() => issueCertificate({ ...base, serial: new Uint8Array(8) }, issuer)).toThrow()
  })

  it('issues P-256 PostgreSQL server certificates that openssl verifies', () => {
    const rootKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
    const leafKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
    const root = keySigner(rootKey)
    const leaf = keySigner(leafKey)
    const now = new Date()
    const issuer = { commonName: 'ExponetDB PostgreSQL CA', signer: root }
    const rootDer = issueCertificate(
      {
        profile: 'postgres_root',
        serial: new Uint8Array(16).fill(1),
        commonName: issuer.commonName,
        publicKey: root.publicKey,
        notBefore: now,
        notAfter: new Date(now.getTime() + 24 * 3_600_000),
      },
      issuer,
    )
    const leafDer = issueCertificate(
      {
        profile: 'postgres_server',
        serial: new Uint8Array(16).fill(2),
        commonName: 'db-host-01.internal',
        publicKey: leaf.publicKey,
        notBefore: now,
        notAfter: new Date(now.getTime() + 24 * 3_600_000),
        dnsNames: ['db-host-01.internal'],
        ipAddresses: ['10.8.2.3', 'fd00::3'],
      },
      issuer,
    )
    const dir = mkdtempSync(join(tmpdir(), 'pg-pki-'))
    writeFileSync(join(dir, 'root.pem'), pem(rootDer))
    writeFileSync(join(dir, 'leaf.pem'), pem(leafDer))
    const out = execFileSync('openssl', [
      'verify',
      '-x509_strict',
      '-purpose',
      'sslserver',
      '-verify_hostname',
      'db-host-01.internal',
      '-CAfile',
      join(dir, 'root.pem'),
      join(dir, 'leaf.pem'),
    ]).toString()
    expect(out).toContain('OK')
    expect(new X509Certificate(Buffer.from(leafDer)).subjectAltName).toBe(
      'DNS:db-host-01.internal, IP Address:10.8.2.3, IP Address:FD00:0:0:0:0:0:0:3',
    )
    expect(() =>
      keySigner(
        createPrivateKey(
          generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({
            format: 'pem',
            type: 'pkcs8',
          }),
        ),
      ),
    ).toThrow()
  })
})

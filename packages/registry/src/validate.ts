import { X509Certificate } from 'node:crypto'
import { isIP } from 'node:net'
import { RegistryError } from './errors.ts'

/**
 * Semantic checks of registry requests beyond the contract schemas: the
 * TLS name rule of an endpoint, the CA bundle, managed schema scopes. The
 * Control Store repeats the structural ones (CHECKs and guards).
 */
export function invalid(path: string, code: string, message: string): RegistryError {
  return new RegistryError('VALIDATION_FAILED', { errors: [{ path, code, message }] })
}

export function isIpAddress(host: string): boolean {
  return isIP(host) !== 0
}

/**
 * The name a server certificate is verified against: a DNS host is its own
 * name (a different name would be a second, silent trust decision); an IP
 * host must name the DNS name its certificate carries.
 */
export function tlsServerNameFor(
  host: string,
  tlsServerName: string | undefined,
  path = '',
): string {
  if (isIpAddress(host)) {
    if (tlsServerName === undefined) {
      throw invalid(
        `${path}/tlsServerName`,
        'required',
        'An IP address needs the DNS name its server certificate carries.',
      )
    }
    return tlsServerName
  }
  if (!/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host) || !host.includes('.')) {
    if (host !== 'localhost') {
      throw invalid(`${path}/host`, 'invalid', 'A host is a DNS name or an IP address.')
    }
  }
  if (tlsServerName !== undefined && tlsServerName.toLowerCase() !== host.toLowerCase()) {
    throw invalid(
      `${path}/tlsServerName`,
      'mismatch',
      'For a DNS host the TLS server name is the host itself.',
    )
  }
  return host
}

export interface CaCertificate {
  readonly subject: string
  readonly notAfter: string
  readonly fingerprint256: string
  readonly ca: boolean
}

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g

/** Parses a PEM CA bundle: certificates only, at most 16, each one valid X.509. */
export function parseCaBundle(pem: string): CaCertificate[] {
  if (/PRIVATE KEY/.test(pem)) {
    throw invalid('/caBundle', 'private_key', 'A CA bundle never contains a private key.')
  }
  const blocks = [...pem.matchAll(PEM_BLOCK)]
  if (blocks.length === 0 || blocks.length > 16) {
    throw invalid('/caBundle', 'invalid', 'A CA bundle holds 1 to 16 PEM certificates.')
  }
  const rest = pem.replace(PEM_BLOCK, '').trim()
  if (rest.length > 0) {
    throw invalid('/caBundle', 'invalid', 'A CA bundle holds PEM certificates and nothing else.')
  }
  return blocks.map((block, i) => {
    if (block[1] !== 'CERTIFICATE') {
      throw invalid(`/caBundle/${i}`, 'invalid', 'Only CERTIFICATE blocks are accepted.')
    }
    let cert: X509Certificate
    try {
      cert = new X509Certificate(block[0])
    } catch {
      throw invalid(`/caBundle/${i}`, 'invalid', 'The certificate cannot be parsed.')
    }
    return {
      subject: cert.subject.replace(/\n/g, ', ').slice(0, 512),
      notAfter: new Date(cert.validTo).toISOString(),
      fingerprint256: cert.fingerprint256,
      ca: cert.ca,
    }
  })
}

/** A managed scope with unique, sorted schema names (schema-fingerprints.md §2). */
export function managedScope(input: {
  readonly includeSchemas?: readonly string[] | undefined
  readonly excludeSchemas?: readonly string[] | undefined
}): { includeSchemas?: string[]; excludeSchemas: string[] } {
  const sorted = (list: readonly string[]) => [...new Set(list)].sort()
  const exclude = sorted(input.excludeSchemas ?? [])
  if (input.includeSchemas === undefined) {
    return { excludeSchemas: exclude }
  }
  const include = sorted(input.includeSchemas)
  if (include.length === 0) {
    throw invalid(
      '/managedScope/includeSchemas',
      'empty',
      'Name at least one schema, or omit the list.',
    )
  }
  return { includeSchemas: include, excludeSchemas: exclude }
}

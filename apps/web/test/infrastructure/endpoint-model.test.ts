import { describe, expect, it } from 'vitest'
import {
  caBundleProblem,
  type EndpointDraft,
  emptyEndpoint,
  endpointProblems,
  endpointRequest,
  isClusterName,
  isDatabaseName,
  MAX_CA_BUNDLE,
} from '../../src/features/infrastructure/endpoint-model.ts'

const draft = (over: Partial<EndpointDraft> = {}): EndpointDraft => ({
  ...emptyEndpoint(),
  host: 'db.example.test',
  label: 'main',
  ...over,
})

describe('the endpoint a person types', () => {
  it('accepts a DNS host, an address with a TLS server name and a pooler with its mode', () => {
    expect(endpointProblems(draft())).toEqual({})
    expect(
      endpointProblems(draft({ host: '10.8.2.5', tlsServerName: 'db.internal.example' })),
    ).toEqual({})
    expect(
      endpointProblems(draft({ host: '2001:db8::1', tlsServerName: 'db.internal.example' })),
    ).toEqual({})
    expect(endpointProblems(draft({ kind: 'pooler', poolerMode: 'session' }))).toEqual({})
  })

  it('refuses a URL, a connection string, a space and a control character as a host', () => {
    for (const host of [
      '',
      'postgres://user:pw@host/db',
      'host:5432/db',
      'db example',
      'db\nexample',
      'db;example',
      'db/example',
      'x'.repeat(254),
    ]) {
      expect(endpointProblems(draft({ host })).host).toBe('infra.endpoint.host.invalid')
    }
  })

  it('refuses a port outside 1 to 65535 and one that is not a whole number', () => {
    for (const port of ['', '0', '65536', '-1', '5432.5', '54e2', '1234567', ' ', 'abc']) {
      expect(endpointProblems(draft({ port })).port).toBe('infra.endpoint.port.invalid')
    }
    for (const port of ['1', '5432', ' 6432 ', '65535']) {
      expect(endpointProblems(draft({ port })).port).toBeUndefined()
    }
  })

  it('refuses an empty, long or control-character label', () => {
    for (const label of ['', '   ', 'x'.repeat(65), 'a\u0007b', 'a\nb']) {
      expect(endpointProblems(draft({ label })).label).toBe('infra.endpoint.label.invalid')
    }
    expect(endpointProblems(draft({ label: 'x'.repeat(64) })).label).toBeUndefined()
  })

  it('needs a TLS server name for an address, and checks the one given', () => {
    expect(endpointProblems(draft({ host: '10.8.2.5' })).tls).toBe('infra.endpoint.tls.required')
    expect(endpointProblems(draft({ host: '::1' })).tls).toBe('infra.endpoint.tls.required')
    for (const tlsServerName of ['-bad', 'bad-', 'has space', 'a/b', '.x', 'ünï.example']) {
      expect(endpointProblems(draft({ tlsServerName })).tls).toBe('infra.endpoint.tls.invalid')
    }
    // A bad host reports itself, not a missing TLS name.
    expect(endpointProblems(draft({ host: 'a b' })).tls).toBeUndefined()
  })

  it('needs a mode for a pooler and sends it for a pooler only', () => {
    expect(endpointProblems(draft({ kind: 'pooler' })).poolerMode).toBe(
      'infra.endpoint.poolerMode.required',
    )
    expect(
      endpointRequest(draft({ kind: 'private', poolerMode: 'session', port: ' 6432 ' })),
    ).toEqual({ kind: 'private', host: 'db.example.test', port: 6432, label: 'main' })
    expect(endpointRequest(draft({ kind: 'pooler', poolerMode: 'transaction' }))).toEqual({
      kind: 'pooler',
      host: 'db.example.test',
      port: 5432,
      label: 'main',
      poolerMode: 'transaction',
    })
  })

  it('sends the TLS server name only when typed, trimmed', () => {
    expect(endpointRequest(draft({ tlsServerName: '  db.example.test ' }))).toMatchObject({
      tlsServerName: 'db.example.test',
    })
    expect(endpointRequest(draft({ tlsServerName: '   ' }))).not.toHaveProperty('tlsServerName')
  })
})

describe('the CA bundle a person pastes', () => {
  const cert = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----'
  // Assembled at runtime so the repository secret scanner does not read it as key material.
  const key = ['-----BEGIN', 'PRIVATE KEY-----\nabc\n-----END', 'PRIVATE KEY-----'].join(' ')

  it('accepts certificates, and refuses a key, an empty bundle and one that is too long', () => {
    expect(caBundleProblem(cert)).toBeUndefined()
    expect(caBundleProblem(`${cert}\n${cert}\n`)).toBeUndefined()
    expect(caBundleProblem(cert + key)).toBe('key')
    expect(caBundleProblem(key)).toBe('key')
    expect(caBundleProblem('')).toBe('required')
    expect(caBundleProblem('not a certificate')).toBe('required')
    expect(caBundleProblem(`-----BEGIN CERTIFICATE-----\n${'A'.repeat(MAX_CA_BUNDLE)}`)).toBe(
      'long',
    )
  })
})

describe('names', () => {
  it('accepts a database name of 1 to 63 characters and a cluster name of 1 to 120, without control characters', () => {
    expect(isDatabaseName('orders')).toBe(true)
    expect(isDatabaseName('x'.repeat(63))).toBe(true)
    for (const bad of ['', 'x'.repeat(64), 'a\u0000b', 'a\nb'])
      expect(isDatabaseName(bad)).toBe(false)
    expect(isClusterName('x'.repeat(120))).toBe(true)
    for (const bad of ['', 'x'.repeat(121), 'a\tb']) expect(isClusterName(bad)).toBe(false)
  })
})

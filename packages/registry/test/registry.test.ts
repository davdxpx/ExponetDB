import { generateKeyPairSync } from 'node:crypto'
import { TargetError } from '@exponetdb/postgres'
import { describe, expect, it } from 'vitest'
import { Body, ContentInvalid, directEndpoints, RegistryError, refusedLogin } from '../src/index.ts'
import type { EndpointRecord } from '../src/records.ts'
import { managedScope, parseCaBundle, tlsServerNameFor } from '../src/validate.ts'

/** Pure registry rules: TLS names, CA bundles, managed scopes, endpoint order, plan content. */
function code(fn: () => unknown): string | undefined {
  try {
    fn()
    return undefined
  } catch (error) {
    return error instanceof RegistryError ? error.code : 'other'
  }
}

describe('endpoint TLS names', () => {
  it('uses a DNS host as its own TLS name and refuses another name', () => {
    expect(tlsServerNameFor('db.example.test', undefined)).toBe('db.example.test')
    expect(tlsServerNameFor('db.example.test', 'DB.example.test')).toBe('db.example.test')
    expect(code(() => tlsServerNameFor('db.example.test', 'other.example.test'))).toBe(
      'VALIDATION_FAILED',
    )
  })

  it('requires an explicit DNS name for an IP host', () => {
    expect(tlsServerNameFor('10.0.0.5', 'db.example.test')).toBe('db.example.test')
    expect(tlsServerNameFor('fd00::5', 'db.example.test')).toBe('db.example.test')
    expect(code(() => tlsServerNameFor('10.0.0.5', undefined))).toBe('VALIDATION_FAILED')
  })

  it('refuses something that is neither a DNS name nor an address', () => {
    expect(code(() => tlsServerNameFor('nodots', undefined))).toBe('VALIDATION_FAILED')
    expect(code(() => tlsServerNameFor('-bad.example', undefined))).toBe('VALIDATION_FAILED')
  })
})

describe('CA bundles', () => {
  // The test CA of the TLS servers is parsed by the integration suite (cluster registration).
  it('refuses a private key, text outside PEM blocks and non-certificate blocks', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    expect(code(() => parseCaBundle(keyPem))).toBe('VALIDATION_FAILED')
    expect(code(() => parseCaBundle('hello'))).toBe('VALIDATION_FAILED')
    expect(
      code(() => parseCaBundle('-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----')),
    ).toBe('VALIDATION_FAILED')
    expect(
      code(() =>
        parseCaBundle('-----BEGIN CERTIFICATE-----\nnotbase64\n-----END CERTIFICATE-----'),
      ),
    ).toBe('VALIDATION_FAILED')
  })
})

describe('managed scope', () => {
  it('sorts and deduplicates names and refuses an empty include list', () => {
    expect(managedScope({ excludeSchemas: ['b', 'a', 'b'] })).toEqual({
      excludeSchemas: ['a', 'b'],
    })
    expect(managedScope({ includeSchemas: ['public', 'app'], excludeSchemas: [] })).toEqual({
      includeSchemas: ['app', 'public'],
      excludeSchemas: [],
    })
    expect(code(() => managedScope({ includeSchemas: [] }))).toBe('VALIDATION_FAILED')
  })
})

describe('endpoint selection', () => {
  const e = (id: string, kind: EndpointRecord['kind'], state: 'active' | 'retired' = 'active') =>
    ({
      endpointId: `end_01M4A0000000000000000000${id}`,
      clusterId: 'cls_01M4A000000000000000000001',
      kind,
      poolerMode: kind === 'pooler' ? 'transaction' : null,
      host: 'h',
      port: 5432,
      tlsServerName: 'h.example',
      label: id,
      state,
      createdAt: '2026-10-06T00:00:00Z',
      retiredAt: null,
    }) as EndpointRecord

  it('prefers private over public, never a pooler, a retired endpoint or a socket of an external cluster', () => {
    const list = [
      e('01', 'public'),
      e('02', 'pooler'),
      e('03', 'private'),
      e('04', 'private', 'retired'),
      e('05', 'local_socket'),
    ]
    expect(directEndpoints(list, { managementMode: 'external' }).map((x) => x.label)).toEqual([
      '03',
      '01',
    ])
    expect(directEndpoints(list, { managementMode: 'agent' }).map((x) => x.label)).toEqual([
      '03',
      '01',
      '05',
    ])
  })
})

describe('plan content', () => {
  it('re-checks every member it reads and refuses a malformed one', () => {
    const body = new Body({
      targetId: 'tgt_01M4A000000000000000000001',
      n: 1,
      flag: true,
      list: ['a'],
    })
    expect(body.id('tgt', 'targetId')).toBe('tgt_01M4A000000000000000000001')
    expect(body.int('n')).toBe(1)
    expect(body.bool('flag')).toBe(true)
    expect(body.strings('list')).toEqual(['a'])
    expect(() => body.id('cls', 'targetId')).toThrow(ContentInvalid)
    expect(() => body.text('n')).toThrow(ContentInvalid)
    expect(() => body.int('missing')).toThrow(ContentInvalid)
    expect(() => new Body([1, 2])).toThrow(ContentInvalid)
  })
})

describe('refused credential logins', () => {
  it('tells a refused authentication method from a wrong password', () => {
    const failure = (reason: ConstructorParameters<typeof TargetError>[1]) =>
      refusedLogin(new TargetError('TARGET_CREDENTIAL_INVALID', reason))
    expect(failure('auth_method')).toEqual({
      status: 'failed',
      failureCode: 'authentication_method',
    })
    expect(failure('auth_failed')).toEqual({
      status: 'failed',
      failureCode: 'authentication_failed',
    })
    expect(failure('superuser_login')).toEqual({ status: 'failed', failureCode: 'role_attributes' })
    expect(refusedLogin(new TargetError('TARGET_UNAVAILABLE', 'connection_lost'))).toEqual({
      status: 'pending',
      reason: 'connection_lost',
    })
  })
})

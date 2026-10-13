import { describe, expect, it } from 'vitest'
import { oauth } from '../src/index.ts'

/**
 * The strict protocol parsers of the authorization server (oauth.md §3–§5):
 * repeated parameters, scope syntax, redirect URI matching, the bearer
 * header and the discovery documents.
 */
describe('protocol parameters', () => {
  it('sees a repeated parameter and never picks one of its values', () => {
    const params = oauth.parseProtocolParams('a=1&b=2&a=3', 8192)
    expect(params?.repeated.has('a')).toBe(true)
    expect(params?.get('a')).toBeUndefined()
    expect(params?.get('b')).toBe('2')
  })

  it('treats an empty value as omitted, decodes form encoding and refuses malformed escapes', () => {
    const params = oauth.parseProtocolParams('state=&scope=targets.read+schema.read', 8192)
    expect(params?.get('state')).toBeUndefined()
    expect(params?.has('state')).toBe(true)
    expect(params?.get('scope')).toBe('targets.read schema.read')
    expect(oauth.parseProtocolParams('a=%E0%A4%A', 8192)).toBeUndefined()
    expect(oauth.parseProtocolParams(`a=${'x'.repeat(9000)}`, 8192)).toBeUndefined()
  })

  it('accepts only exact catalog scopes, single spaces and no repeats or wildcards', () => {
    expect(oauth.parseScopeParam('targets.read schema.read')).toEqual([
      'targets.read',
      'schema.read',
    ])
    for (const bad of [
      'targets.read  schema.read',
      ' targets.read',
      'targets.read targets.read',
      'targets.*',
      'migrations.apply',
      'migrations.apply:*',
      'offline_access',
      'openid',
      '',
    ]) {
      expect(oauth.parseScopeParam(bad), bad).toBeUndefined()
    }
  })

  it('checks state, PKCE challenge and verifier shapes', () => {
    expect(oauth.isValidState('xyz')).toBe(true)
    expect(oauth.isValidState('a\u0000b')).toBe(false)
    expect(oauth.isValidState('x'.repeat(513))).toBe(false)
    expect(oauth.isValidCodeChallenge('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(true)
    expect(oauth.isValidCodeChallenge('short')).toBe(false)
    expect(oauth.isValidCodeVerifier('a'.repeat(42))).toBe(false)
    expect(oauth.isValidCodeVerifier('a'.repeat(43))).toBe(true)
    expect(oauth.isValidCodeVerifier('a'.repeat(129))).toBe(false)
  })
})

describe('PKCE S256 verification (RFC 7636 §4.6), compared in constant time', () => {
  // RFC 7636 Appendix B.
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
  const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

  it('accepts the right verifier', () => {
    expect(oauth.pkceMatches(verifier, challenge)).toBe(true)
  })

  it('refuses a wrong verifier of the same length', () => {
    const wrong = `${verifier.slice(0, -1)}${verifier.endsWith('k') ? 'j' : 'k'}`
    expect(wrong).toHaveLength(verifier.length)
    expect(oauth.pkceMatches(wrong, challenge)).toBe(false)
  })

  it('refuses an invalid verifier and an invalid challenge before hashing', () => {
    expect(oauth.pkceMatches('a'.repeat(42), challenge)).toBe(false)
    expect(oauth.pkceMatches(`${verifier} `, challenge)).toBe(false)
    expect(oauth.pkceMatches('a'.repeat(129), challenge)).toBe(false)
    expect(oauth.pkceMatches(verifier, 'short')).toBe(false)
    expect(oauth.pkceMatches(verifier, `${challenge}=`)).toBe(false)
    expect(oauth.pkceMatches(verifier, challenge.replace('E', '+'))).toBe(false)
  })

  it('refuses a challenge that does not decode to exactly 32 bytes', () => {
    // 43 base64url characters carry 258 bits; a non-canonical last character
    // decodes to the same 32 bytes and is refused by the round trip.
    const noncanonical = `${challenge.slice(0, -1)}N`
    expect(Buffer.from(noncanonical, 'base64url')).toEqual(Buffer.from(challenge, 'base64url'))
    expect(oauth.pkceMatches(verifier, noncanonical)).toBe(false)
    // A 44-character value (33 bytes) never reaches the comparison.
    expect(oauth.pkceMatches(verifier, `${challenge}A`)).toBe(false)
  })
})

describe('redirect URIs (oauth.md §3, RFC 8252 §7.3)', () => {
  const registered = [
    'https://client.example.test/callback',
    'http://127.0.0.1/callback',
    'http://[::1]/callback',
  ]

  it('matches exactly, with no prefix, case, path or query variation', () => {
    expect(oauth.matchRedirectUri(registered, 'https://client.example.test/callback')).toBe(
      'https://client.example.test/callback',
    )
    for (const bad of [
      'https://client.example.test/callback/',
      'https://client.example.test/callback?x=1',
      'https://client.example.test/callbackx',
      'https://client.example.test:443/callback',
      'https://CLIENT.example.test/callback',
      'https://evil.example.test/callback',
      'https://client.example.test.evil.example/callback',
      'https://user@client.example.test/callback',
      'https://client.example.test/callback#frag',
      'http://client.example.test/callback',
    ]) {
      expect(oauth.matchRedirectUri(registered, bad), bad).toBeUndefined()
    }
  })

  it('lets a loopback redirect vary only its port', () => {
    expect(oauth.matchRedirectUri(registered, 'http://127.0.0.1:53817/callback')).toBe(
      'http://127.0.0.1:53817/callback',
    )
    expect(oauth.matchRedirectUri(registered, 'http://[::1]:8080/callback')).toBe(
      'http://[::1]:8080/callback',
    )
    for (const bad of [
      'http://127.0.0.1:53817/other',
      'http://127.0.0.1:53817/callback?x=1',
      'http://127.0.0.2:53817/callback',
      'http://localhost:53817/callback',
      'https://127.0.0.1:53817/callback',
    ]) {
      expect(oauth.matchRedirectUri(registered, bad), bad).toBeUndefined()
    }
  })

  it('refuses non-HTTPS, user information, fragments and non-canonical spellings', () => {
    for (const bad of [
      'ftp://client.example.test/cb',
      'javascript:alert(1)',
      'https://client.example.test/a/../callback',
      'https://client.example.test/cb#',
      'http://example.test/cb',
      'https://client.example.test/c b',
    ]) {
      expect(oauth.parseRedirectUri(bad), bad).toBeUndefined()
    }
  })
})

describe('client fingerprint', () => {
  const base = {
    externalId: 'https://client.example.test/metadata.json',
    redirectUris: ['https://client.example.test/a', 'https://client.example.test/b'],
    tokenEndpointAuthMethod: 'none' as const,
    applicationType: 'web' as const,
    grantTypes: ['authorization_code', 'refresh_token'],
    jwks: [],
  }

  it('ignores order and changes with every security-relevant member', () => {
    const fingerprint = oauth.clientFingerprint(base)
    expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(
      oauth.clientFingerprint({ ...base, redirectUris: [...base.redirectUris].reverse() }),
    ).toBe(fingerprint)
    for (const changed of [
      { ...base, redirectUris: ['https://client.example.test/a'] },
      { ...base, applicationType: 'native' as const },
      { ...base, grantTypes: ['authorization_code'] },
      { ...base, externalId: 'https://client.example.test/other.json' },
    ]) {
      expect(oauth.clientFingerprint(changed)).not.toBe(fingerprint)
    }
  })
})

describe('bearer header (RFC 6750 §2.1)', () => {
  it('takes exactly one Bearer header and nothing else', () => {
    expect(oauth.bearerValue([])).toBeUndefined()
    expect(oauth.bearerValue([`Bearer exat_${'A'.repeat(43)}`])).toBe(`exat_${'A'.repeat(43)}`)
    expect(oauth.bearerValue([`bearer exat_${'A'.repeat(43)}`])).toBe(`exat_${'A'.repeat(43)}`)
    expect(oauth.bearerValue(['Basic dXNlcjpwYXNz'])).toBe('invalid')
    expect(oauth.bearerValue(['Bearer a', 'Bearer b'])).toBe('invalid')
    expect(oauth.bearerValue([`Bearer exat_${'A'.repeat(43)}, Bearer x`])).toBe('invalid')
  })

  it('builds challenges from fixed values only', () => {
    expect(oauth.bearerChallenge('https://db.example.test', 'api')).toBe(
      'Bearer resource_metadata="https://db.example.test/.well-known/oauth-protected-resource/api"',
    )
    expect(
      oauth.bearerChallenge('https://db.example.test', 'api', {
        code: 'insufficient_scope',
        scope: 'migrations.apply:nonprod',
      }),
    ).toBe(
      'Bearer error="insufficient_scope", resource_metadata="https://db.example.test/.well-known/oauth-protected-resource/api", scope="migrations.apply:nonprod"',
    )
    // MCP: a first challenge names the baseline scopes; a step-up names held and needed ones.
    expect(
      oauth.bearerChallenge('https://db.example.test', 'mcp', {
        scope: ['targets.read', 'schema.read', 'diagnostics.read'],
      }),
    ).toBe(
      'Bearer resource_metadata="https://db.example.test/.well-known/oauth-protected-resource/mcp", scope="targets.read schema.read diagnostics.read"',
    )
    expect(
      oauth.bearerChallenge('https://db.example.test', 'mcp', {
        code: 'insufficient_scope',
        scope: ['migrations.apply:nonprod', 'targets.read'],
      }),
    ).toBe(
      'Bearer error="insufficient_scope", resource_metadata="https://db.example.test/.well-known/oauth-protected-resource/mcp", scope="migrations.apply:nonprod targets.read"',
    )
  })
})

describe('discovery documents (oauth.md §2)', () => {
  const issuer = 'https://db.example.test'

  it('advertises S256 only, the iss parameter, CIMD and no session-only scope', () => {
    const metadata = oauth.authorizationServerMetadata(issuer)
    expect(metadata.issuer).toBe(issuer)
    expect(metadata.code_challenge_methods_supported).toEqual(['S256'])
    expect(metadata.authorization_response_iss_parameter_supported).toBe(true)
    expect(metadata.client_id_metadata_document_supported).toBe(true)
    expect(metadata.token_endpoint_auth_methods_supported).toEqual(['none', 'private_key_jwt'])
    expect(metadata.scopes_supported).not.toContain('api')
    expect(metadata.scopes_supported).not.toContain('plans.approve')
    expect(JSON.stringify(metadata)).not.toMatch(/offline_access|openid|client_secret|jwks_uri/)
  })

  it('publishes one protected resource document per resource, with the minimal baseline', () => {
    for (const resource of ['api', 'mcp'] as const) {
      const prm = oauth.protectedResourceMetadata(issuer, resource)
      expect(prm.resource).toBe(`${issuer}/${resource}`)
      expect(prm.authorization_servers).toEqual([issuer])
      expect(prm.scopes_supported).toEqual(['targets.read', 'schema.read', 'diagnostics.read'])
      expect(oauth.protectedResourceMetadataPath(resource)).toBe(
        `/.well-known/oauth-protected-resource/${resource}`,
      )
    }
    expect(oauth.resourceOf(issuer, `${issuer}/api`)).toBe('api')
    expect(oauth.resourceOf(issuer, `${issuer}/api/`)).toBeUndefined()
    expect(oauth.resourceOf(issuer, 'https://evil.example.test/api')).toBeUndefined()
  })
})

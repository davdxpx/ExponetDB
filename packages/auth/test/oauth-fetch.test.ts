import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { oauth } from '../src/index.ts'
import { PUBLIC_ADDRESS, type TlsWorld, tlsWorld } from './support/tls.ts'

/**
 * The SSRF-hardened metadata fetcher (oauth.md §7, G3B CIMD items): the
 * address policy, the URL rules, DNS pinning, TLS verification for the
 * host name, no redirects, the size, time, type and encoding limits.
 */
const HOST = 'client.example.test'
const URL_OK = `https://${HOST}/oauth/client.json`

function document(clientId = URL_OK) {
  return JSON.stringify({
    client_id: clientId,
    client_name: 'Example Agent',
    redirect_uris: ['https://client.example.test/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  })
}

let world: TlsWorld

beforeAll(async () => {
  world = await tlsWorld([HOST, 'other.example.test'])
})

afterAll(async () => {
  await world?.close()
})

beforeEach(() => {
  world.connections.length = 0
  world.setHandler((_req, res) => {
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'public, max-age=60')
    res.end(document())
  })
})

async function refusal(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    return error instanceof oauth.MetadataFetchError ? error.reason : String(error)
  }
}

describe('address policy', () => {
  it('refuses every non-public address family and range', () => {
    for (const address of [
      '0.0.0.0',
      '10.1.2.3',
      '100.64.0.1',
      '100.100.100.200',
      '127.0.0.1',
      '127.255.255.254',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.0.0.170',
      '192.0.2.1',
      '192.168.1.1',
      '198.18.0.1',
      '198.51.100.7',
      '203.0.113.9',
      '224.0.0.1',
      '240.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '::ffff:7f00:1',
      '64:ff9b::a00:1',
      '100::1',
      '2001::1',
      '2001:db8::1',
      '2002:a00:1::1',
      'fc00::1',
      'fd00:ec2::254',
      'fe80::1',
      'fec0::1',
      'ff02::1',
      '2::1',
      'not-an-address',
    ]) {
      expect(oauth.isPublicAddress(address), address).toBe(false)
    }
  })

  it('accepts public unicast addresses', () => {
    for (const address of [PUBLIC_ADDRESS, '2620:4f:8000::1', '::ffff:192.175.48.1']) {
      expect(oauth.isPublicAddress(address), address).toBe(true)
    }
  })
})

describe('metadata URL', () => {
  it('accepts only an exact https URL of a DNS name with a path', () => {
    expect(oauth.parseMetadataUrl(URL_OK)?.hostname).toBe(HOST)
    for (const bad of [
      `http://${HOST}/oauth/client.json`,
      `https://${HOST}/`,
      `https://${HOST}`,
      `https://user@${HOST}/c.json`,
      `https://${HOST}:8443/c.json`,
      `https://${HOST}/c.json?x=1`,
      `https://${HOST}/c.json#f`,
      `https://${HOST}/a/../c.json`,
      `https://${HOST}/./c.json`,
      'https://127.0.0.1/c.json',
      'https://[::1]/c.json',
      'https://localhost/c.json',
      'https://intranet/c.json',
      'https://metadata.google.internal/c.json',
      'https://printer.local/c.json',
      `https://${HOST.toUpperCase()}/c.json`,
      `https://${HOST}/c json`,
      `https://${HOST}/${'a'.repeat(600)}`,
    ]) {
      expect(oauth.parseMetadataUrl(bad), bad).toBeUndefined()
    }
  })
})

describe('fetch', () => {
  it('fetches over a pinned, verified TLS connection and reads max-age', async () => {
    const fetched = await oauth.fetchMetadataDocument(URL_OK, world.network())
    expect(JSON.parse(fetched.text).client_id).toBe(URL_OK)
    expect(fetched.maxAgeSeconds).toBe(60)
    expect(fetched.address).toBe(PUBLIC_ADDRESS)
    expect(world.connections).toEqual([PUBLIC_ADDRESS])
  })

  it('sends one plain GET without a credential, a cookie or forwarded data', async () => {
    let seen: {
      method: string | undefined
      url: string | undefined
      headers: Record<string, unknown>
    } = { method: undefined, url: undefined, headers: {} }
    world.setHandler((req, res) => {
      seen = { method: req.method, url: req.url, headers: { ...req.headers } }
      res.setHeader('content-type', 'application/json')
      res.end(document())
    })
    await oauth.fetchMetadataDocument(URL_OK, world.network())
    expect(seen.method).toBe('GET')
    expect(seen.url).toBe(new URL(URL_OK).pathname)
    expect(Object.keys(seen.headers).sort()).toEqual([
      'accept',
      'accept-encoding',
      'connection',
      'host',
      'user-agent',
    ])
    expect(seen.headers['host']).toBe(HOST)
  })

  it('never connects when any resolved address is not public (DNS rebinding, round robin)', async () => {
    for (const answers of [
      ['127.0.0.1'],
      ['169.254.169.254'],
      ['10.0.0.5'],
      ['::1'],
      ['fd00:ec2::254'],
      [PUBLIC_ADDRESS, '10.0.0.5'],
      ['::ffff:127.0.0.1'],
    ]) {
      expect(
        await refusal(oauth.fetchMetadataDocument(URL_OK, world.network({ [HOST]: answers }))),
        answers.join(),
      ).toBe('address_refused')
    }
    expect(await refusal(oauth.fetchMetadataDocument(URL_OK, world.network({ [HOST]: [] })))).toBe(
      'dns_failed',
    )
    expect(world.connections).toEqual([])
  })

  it('refuses the production resolver answer for localhost', async () => {
    const network = oauth.systemNetwork()
    const answers = await network.resolve('localhost')
    expect(answers.length).toBeGreaterThan(0)
    expect(answers.every((a) => !oauth.isPublicAddress(a.address))).toBe(true)
  })

  it('verifies the certificate for the host name (no other CA, no other name)', async () => {
    expect(
      await refusal(oauth.fetchMetadataDocument(URL_OK, world.network({}, { untrusted: true }))),
    ).toBe('tls_failed')
    const wrongName = 'https://wrong.example.test/oauth/client.json'
    expect(await refusal(oauth.fetchMetadataDocument(wrongName, world.network()))).toBe(
      'tls_failed',
    )
  })

  it('follows no redirect and accepts only status 200', async () => {
    for (const status of [301, 302, 307, 308]) {
      world.setHandler((_req, res) => {
        res.statusCode = status
        res.setHeader('location', 'https://169.254.169.254/latest/meta-data/')
        res.end()
      })
      expect(
        await refusal(oauth.fetchMetadataDocument(URL_OK, world.network())),
        String(status),
      ).toBe('redirect_refused')
    }
    world.setHandler((_req, res) => {
      res.statusCode = 404
      res.end()
    })
    expect(await refusal(oauth.fetchMetadataDocument(URL_OK, world.network()))).toBe(
      'status_refused',
    )
  })

  it('accepts only uncompressed JSON of at most 64 KiB', async () => {
    world.setHandler((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end('<html></html>')
    })
    expect(await refusal(oauth.fetchMetadataDocument(URL_OK, world.network()))).toBe(
      'content_type_refused',
    )
    world.setHandler((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.setHeader('content-encoding', 'gzip')
      res.end(gzipSync(document()))
    })
    expect(await refusal(oauth.fetchMetadataDocument(URL_OK, world.network()))).toBe(
      'encoding_refused',
    )
    world.setHandler((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(`"${'x'.repeat(70 * 1024)}"`)
    })
    expect(await refusal(oauth.fetchMetadataDocument(URL_OK, world.network()))).toBe('too_large')
    // A chunked body without a length is counted as it arrives.
    world.setHandler((_req, res) => {
      res.setHeader('content-type', 'application/json')
      for (let i = 0; i < 80; i++) {
        res.write('x'.repeat(1024))
      }
      res.end()
    })
    expect(await refusal(oauth.fetchMetadataDocument(URL_OK, world.network()))).toBe('too_large')
  })

  it('gives up after the time limit', async () => {
    world.setHandler(() => {
      // Never answers.
    })
    const started = Date.now()
    expect(
      await refusal(oauth.fetchMetadataDocument(URL_OK, world.network(), { timeoutMs: 300 })),
    ).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('refuses an invalid URL before resolving anything', async () => {
    expect(
      await refusal(oauth.fetchMetadataDocument('https://127.0.0.1/c.json', world.network())),
    ).toBe('url_invalid')
    expect(world.connections).toEqual([])
  })
})

describe('client metadata', () => {
  const valid = JSON.parse(document()) as Record<string, unknown>

  it('accepts a public client and keeps only bounded display data', () => {
    const result = oauth.validateClientMetadata(
      { ...valid, contacts: ['person@example.test'], logo_uri: 'https://x.example.test/l.png' },
      URL_OK,
      HOST,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.metadata.clientName).toBe('Example Agent')
    expect(result.metadata.display).toEqual({ client_name: 'Example Agent' })
    expect(JSON.stringify(result.metadata)).not.toMatch(/person@|logo/)
  })

  it('refuses secrets, keys, other methods, bad redirects and a foreign client_id', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...valid, client_id: 'https://evil.example.test/c.json' }, 'client_id_mismatch'],
      [{ ...valid, client_secret: 'x' }, 'secret_not_allowed'],
      [{ ...valid, jwks_uri: 'https://client.example.test/jwks' }, 'keys_not_allowed'],
      [{ ...valid, jwks: { keys: [] } }, 'keys_not_allowed'],
      [{ ...valid, token_endpoint_auth_method: 'client_secret_basic' }, 'auth_method_unsupported'],
      [{ ...valid, token_endpoint_auth_method: 'private_key_jwt' }, 'auth_method_unsupported'],
      [{ ...valid, redirect_uris: [] }, 'redirect_uris_invalid'],
      [{ ...valid, redirect_uris: ['http://client.example.test/cb'] }, 'redirect_uris_invalid'],
      [{ ...valid, redirect_uris: ['https://client.example.test/cb#x'] }, 'redirect_uris_invalid'],
      [{ ...valid, redirect_uris: ['https://*.example.test/cb'] }, 'redirect_uris_invalid'],
      [{ ...valid, grant_types: ['client_credentials'] }, 'grant_types_invalid'],
      [{ ...valid, grant_types: ['implicit'] }, 'grant_types_invalid'],
      [{ ...valid, grant_types: ['refresh_token'] }, 'grant_types_invalid'],
      [{ ...valid, response_types: ['token'] }, 'response_types_invalid'],
      [{ ...valid, application_type: 'service' }, 'application_type_invalid'],
      [{ ...valid, client_name: 'a\u0007b' }, 'client_name_invalid'],
      [{ ...valid, client_name: 'x'.repeat(101) }, 'client_name_invalid'],
    ]
    for (const [doc, reason] of cases) {
      const result = oauth.validateClientMetadata(JSON.parse(JSON.stringify(doc)), URL_OK, HOST)
      expect(result, reason).toEqual({ ok: false, reason })
    }
    expect(oauth.validateClientMetadata([], URL_OK, HOST)).toEqual({
      ok: false,
      reason: 'not_an_object',
    })
    // A registration (DCR) never names its own client_id.
    expect(oauth.validateClientMetadata(JSON.parse(document()), undefined, 'x')).toEqual({
      ok: false,
      reason: 'client_id_mismatch',
    })
  })
})

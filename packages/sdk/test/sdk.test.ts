import type { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { decodeProtectedHeader, jwtVerify } from 'jose'
import { describe, expect, it } from 'vitest'
import { algorithmOf, clientAssertion, ExponetDB, OPERATIONS } from '../src/index.ts'
import { request, type TransportOptions } from '../src/transport.ts'

type CryptoKey = webcrypto.CryptoKey

const BASE = 'https://db.example.test'
const KEY = `exak_${'a'.repeat(32)}`

interface Call {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: string | undefined
}

type Reply = Response | Error | ((call: Call) => Response | Error)

/** A scripted `fetch`: answers in order and records every call. */
function fakeFetch(...replies: Reply[]) {
  const calls: Call[] = []
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? init.body : undefined,
    }
    calls.push(call)
    const next = replies.shift()
    if (next === undefined) throw new Error(`unexpected request ${call.method} ${call.url}`)
    const reply = typeof next === 'function' ? next(call) : next
    if (reply instanceof Error) throw reply
    return reply
  }
  return { fetch: impl as typeof fetch, calls }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

const problem = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      type: `https://db.exponet.cloud/errors/${code.toLowerCase()}`,
      title: 'Title',
      status,
      code,
      message: 'Message.',
      retryable: false,
      requestId: 'req_01J000000000000000000000AA',
      ...extra,
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  )

const page = (items: unknown[], nextCursor: string | null) => json(200, { items, nextCursor })

function client(fetchImpl: typeof fetch, auth: ConstructorParameters<typeof ExponetDB>[0]['auth']) {
  return new ExponetDB({ baseUrl: BASE, auth, fetch: fetchImpl })
}

/** The transport with a recorded, instant sleep. */
function transport(fetchImpl: typeof fetch, sleeps: number[] = []): TransportOptions {
  return {
    baseUrl: BASE,
    auth: {
      header: async () => ({ ok: true, value: `Bearer ${KEY}` }),
      invalidate: () => {},
      renewable: false,
    },
    fetch: fetchImpl,
    timeoutMs: 1000,
    userAgent: 'test',
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  }
}

describe('construction', () => {
  it('requires https except for localhost and refuses credentials in the URL', () => {
    const { fetch } = fakeFetch()
    expect(
      () =>
        new ExponetDB({
          baseUrl: 'http://db.example.test',
          auth: { kind: 'apiKey', key: KEY },
          fetch,
        }),
    ).toThrow(/https/)
    expect(
      () =>
        new ExponetDB({
          baseUrl: 'https://u:p@db.example.test',
          auth: { kind: 'apiKey', key: KEY },
          fetch,
        }),
    ).toThrow(/credentials/)
    expect(
      () =>
        new ExponetDB({
          baseUrl: 'http://localhost:3000',
          auth: { kind: 'apiKey', key: KEY },
          fetch,
        }),
    ).not.toThrow()
  })

  it('accepts only exak_ API keys and never a connection string', () => {
    const { fetch } = fakeFetch()
    expect(() => client(fetch, { kind: 'apiKey', key: 'postgres://u:p@h/db' })).toThrow(/exak_/)
    expect(() => client(fetch, { kind: 'apiKey', key: 'exak_short' })).toThrow(/exak_/)
  })
})

describe('requests', () => {
  it('sends the API key as a bearer token, never in the URL', async () => {
    const { fetch, calls } = fakeFetch(json(200, { items: [], nextCursor: null }))
    const sdk = client(fetch, { kind: 'apiKey', key: KEY })
    const result = await sdk.targets.list({ limit: 5 })
    expect(result).toEqual({ ok: true, value: { items: [], nextCursor: null } })
    expect(calls[0]?.headers['authorization']).toBe(`Bearer ${KEY}`)
    expect(calls[0]?.url).toBe(`${BASE}/api/v1/targets?limit=5`)
    expect(calls[0]?.url).not.toContain('exak_')
    expect(calls[0]?.headers['user-agent']).toMatch(/^exponetdb-sdk\//)
  })

  it('encodes a target path as one segment and leaves resolution to the server', async () => {
    const { fetch, calls } = fakeFetch(json(200, { id: 'tgt_x' }), json(200, { id: 'tgt_x' }))
    const sdk = client(fetch, { kind: 'apiKey', key: KEY })
    await sdk.targets.resolve('shop/platform/staging')
    await sdk.health.get('shop/platform/staging')
    expect(calls[0]?.url).toBe(`${BASE}/api/v1/targets/shop%2Fplatform%2Fstaging`)
    expect(calls[1]?.url).toBe(`${BASE}/api/v1/targets/shop%2Fplatform%2Fstaging/health`)
  })

  it('encodes a schema object name and explodes array query parameters', async () => {
    const { fetch, calls } = fakeFetch(json(200, {}), json(200, {}))
    const sdk = client(fetch, { kind: 'apiKey', key: KEY })
    await sdk.schema.object('tgt_x', 'function', 'public.f(integer, text)')
    await sdk.schema.search('tgt_x', { q: 'acc', kinds: ['table', 'view'] })
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v1/targets/tgt_x/schema/objects/function/public.f(integer%2C%20text)`,
    )
    expect(calls[1]?.url).toBe(
      `${BASE}/api/v1/targets/tgt_x/schema/search?q=acc&kinds=table&kinds=view`,
    )
  })

  it('refuses a missing path parameter before sending anything', async () => {
    const { fetch, calls } = fakeFetch()
    const sdk = client(fetch, { kind: 'apiKey', key: KEY })
    await expect(sdk.targets.get('')).rejects.toThrow(/missing path parameter/)
    expect(calls).toHaveLength(0)
  })
})

describe('errors', () => {
  it('maps a problem document to an ApiError and keeps only catalog fields', async () => {
    const { fetch } = fakeFetch(
      problem(404, 'TARGET_NOT_FOUND', {
        details: { target: 'a/b/c' },
        remediation: 'Check the path.',
        stack: 'Error: at secret.ts:1',
        password: 'p',
      }),
    )
    const result = await client(fetch, { kind: 'apiKey', key: KEY }).targets.get('a/b/c')
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'TARGET_NOT_FOUND',
        status: 404,
        requestId: 'req_01J000000000000000000000AA',
        retryable: false,
        title: 'Title',
        message: 'Message.',
        details: { target: 'a/b/c' },
        remediation: 'Check the path.',
      },
    })
  })

  it('reports an unreadable answer as RESPONSE_INVALID, never as an empty value', async () => {
    const { fetch } = fakeFetch(
      new Response('<html>bad gateway</html>', { status: 400 }),
      new Response('not json', { status: 200 }),
    )
    const sdk = client(fetch, { kind: 'apiKey', key: KEY })
    const a = await sdk.targets.list()
    const b = await sdk.targets.list()
    expect(a.ok ? undefined : a.error).toMatchObject({
      code: 'RESPONSE_INVALID',
      status: 400,
      retryable: false,
    })
    expect(b.ok ? undefined : b.error).toMatchObject({ code: 'RESPONSE_INVALID', status: 200 })
  })

  it('keeps the catalog retryable flag and Retry-After', async () => {
    const { fetch } = fakeFetch(
      problem(503, 'CONTROL_PLANE_DEGRADED', { retryable: true }),
      problem(503, 'CONTROL_PLANE_DEGRADED', { retryable: true }),
      new Response(
        JSON.stringify({ code: 'CONTROL_PLANE_DEGRADED', retryable: true, requestId: 'req_1' }),
        {
          status: 503,
          headers: { 'retry-after': '2' },
        },
      ),
    )
    const sleeps: number[] = []
    const result = await request(transport(fetch, sleeps), 'listTargets')
    expect(result.ok ? undefined : result.error).toMatchObject({
      code: 'CONTROL_PLANE_DEGRADED',
      retryable: true,
      retryAfterSeconds: 2,
    })
  })
})

describe('retries', () => {
  it('retries a GET on 502/503/504/429 and on no answer, with bounded backoff, at most 3 attempts', async () => {
    const { fetch, calls } = fakeFetch(
      new TypeError('fetch failed'),
      new Response('', { status: 503, headers: { 'retry-after': '60' } }),
      json(200, { items: [], nextCursor: null }),
    )
    const sleeps: number[] = []
    const result = await request(transport(fetch, sleeps), 'listTargets')
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(3)
    // 200 ms after the network error; Retry-After is capped at 5 s.
    expect(sleeps).toEqual([200, 5000])
  })

  it('gives up after 3 attempts of a GET', async () => {
    const { fetch, calls } = fakeFetch(
      new Response('', { status: 502 }),
      new Response('', { status: 504 }),
      new Response('', { status: 429 }),
    )
    const sleeps: number[] = []
    const result = await request(transport(fetch, sleeps), 'listTargets')
    expect(calls).toHaveLength(3)
    expect(sleeps).toEqual([200, 400])
    expect(result.ok ? undefined : result.error).toMatchObject({
      code: 'RESPONSE_INVALID',
      status: 429,
    })
  })

  it('never retries a mutation: no answer is TRANSPORT_FAILED and not retryable', async () => {
    const { fetch, calls } = fakeFetch(new TypeError('socket hang up'))
    const sleeps: number[] = []
    const result = await request(transport(fetch, sleeps), 'runDriftCheck', {
      params: { target: 'tgt_x' },
      body: {},
    })
    expect(calls).toHaveLength(1)
    expect(sleeps).toEqual([])
    expect(result).toEqual({
      ok: false,
      error: { code: 'TRANSPORT_FAILED', status: null, requestId: null, retryable: false },
    })
  })

  it('never retries a mutation on 503 either', async () => {
    const { fetch, calls } = fakeFetch(problem(503, 'CONTROL_PLANE_DEGRADED', { retryable: true }))
    const result = await request(transport(fetch), 'runDriftCheck', {
      params: { target: 'tgt_x' },
      body: {},
    })
    expect(calls).toHaveLength(1)
    expect(result.ok).toBe(false)
  })

  it('sends a caller-supplied Idempotency-Key and JSON body on a mutation', async () => {
    const { fetch, calls } = fakeFetch(json(200, { status: 'drifted' }))
    await request(transport(fetch), 'runDriftCheck', {
      params: { target: 'tgt_x' },
      body: {},
      idempotencyKey: 'idem-1',
    })
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.headers['idempotency-key']).toBe('idem-1')
    expect(calls[0]?.headers['content-type']).toBe('application/json')
    expect(calls[0]?.body).toBe('{}')
  })
})

describe('pagination', () => {
  it('follows the server cursor page by page and stops at the end', async () => {
    const { fetch, calls } = fakeFetch(page([{ id: 'a' }], 'c1'), page([{ id: 'b' }], null))
    const sdk = client(fetch, { kind: 'apiKey', key: KEY })
    const seen: unknown[] = []
    for await (const p of sdk.targets.pages({ limit: 1 })) {
      expect(p.ok).toBe(true)
      if (p.ok) seen.push(...p.value.items)
    }
    expect(seen).toEqual([{ id: 'a' }, { id: 'b' }])
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/api/v1/targets?limit=1`,
      `${BASE}/api/v1/targets?limit=1&cursor=c1`,
    ])
  })

  it('collects at most maxItems and stops asking', async () => {
    const { fetch, calls } = fakeFetch(
      page([{ id: 'a' }, { id: 'b' }], 'c1'),
      page([{ id: 'c' }], 'c2'),
    )
    const sdk = client(fetch, { kind: 'apiKey', key: KEY })
    const all = await sdk.targets.all({}, 3)
    expect(all).toEqual({ ok: true, value: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] })
    expect(calls).toHaveLength(2)
  })

  it('returns the error of a failed page instead of a partial list', async () => {
    const { fetch } = fakeFetch(page([{ id: 'a' }], 'c1'), problem(403, 'PERMISSION_DENIED'))
    const all = await client(fetch, { kind: 'apiKey', key: KEY }).targets.all()
    expect(all.ok ? undefined : all.error.code).toBe('PERMISSION_DENIED')
  })
})

describe('installation', () => {
  it('reports whether the server speaks this REST API version', async () => {
    const body = (restApi: string) => ({ contracts: { restApi } })
    const { fetch } = fakeFetch(json(200, body('v1')), json(200, body('v2')))
    const sdk = client(fetch, { kind: 'apiKey', key: KEY })
    expect(await sdk.installation.compatible()).toEqual({ ok: true, value: true })
    expect(await sdk.installation.compatible()).toEqual({ ok: true, value: false })
  })
})

async function keyPair(kind: 'ES256' | 'ES384' | 'EdDSA' | 'RS256' | 'PS256') {
  const algorithm:
    | webcrypto.RsaHashedKeyGenParams
    | webcrypto.EcKeyGenParams
    | webcrypto.KeyAlgorithm = {
    ES256: { name: 'ECDSA', namedCurve: 'P-256' },
    ES384: { name: 'ECDSA', namedCurve: 'P-384' },
    EdDSA: { name: 'Ed25519' },
    RS256: {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    PS256: {
      name: 'RSA-PSS',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
  }[kind]
  const pair = (await crypto.subtle.generateKey(algorithm, false, [
    'sign',
    'verify',
  ])) as webcrypto.CryptoKeyPair
  return pair
}

describe('private_key_jwt', () => {
  it.each(['ES256', 'ES384', 'EdDSA', 'RS256', 'PS256'] as const)(
    'signs a %s assertion the issuer can verify, with a fresh jti each time',
    async (alg) => {
      const pair = await keyPair(alg)
      expect(algorithmOf(pair.privateKey)).toBe(alg)
      const input = {
        clientId: 'cli_service',
        issuer: BASE,
        privateKey: pair.privateKey,
        keyId: 'k1',
        algorithm: alg,
        nowSeconds: Math.floor(Date.now() / 1000),
      }
      const a = await clientAssertion(input)
      const b = await clientAssertion(input)
      expect(decodeProtectedHeader(a)).toEqual({ alg, kid: 'k1', typ: 'JWT' })
      const { payload } = await jwtVerify(a, pair.publicKey, {
        issuer: 'cli_service',
        audience: BASE,
      })
      expect(payload.sub).toBe('cli_service')
      expect(payload.aud).toBe(BASE)
      expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(60)
      const other = await jwtVerify(b, pair.publicKey)
      expect(typeof payload.jti).toBe('string')
      expect(other.payload.jti).not.toBe(payload.jti)
    },
  )

  it('refuses a key of another algorithm (no fallback)', async () => {
    const hmac = (await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ])) as CryptoKey
    const { fetch } = fakeFetch()
    expect(algorithmOf(hmac)).toBeUndefined()
    expect(() =>
      client(fetch, {
        kind: 'serviceAccount',
        clientId: 'cli_x',
        privateKey: hmac,
        keyId: 'k1',
        scopes: ['targets.read'],
      }),
    ).toThrow(/ES256/)
  })
})

describe('service account tokens', () => {
  const token = (n: number, expiresIn = 300) =>
    json(200, { access_token: `tok_${n}`, token_type: 'Bearer', expires_in: expiresIn })

  async function serviceClient(...replies: Reply[]) {
    const pair = await keyPair('ES256')
    const { fetch, calls } = fakeFetch(...replies)
    const sdk = new ExponetDB({
      baseUrl: `${BASE}/`,
      auth: {
        kind: 'serviceAccount',
        clientId: 'cli_service',
        privateKey: pair.privateKey,
        keyId: 'k1',
        scopes: ['targets.read', 'schema.read'],
      },
      fetch,
    })
    return { sdk, calls, pair }
  }

  it('asks the token endpoint for an /api token with a client assertion, then uses it', async () => {
    const { sdk, calls, pair } = await serviceClient(
      token(1),
      json(200, { items: [], nextCursor: null }),
    )
    expect((await sdk.targets.list()).ok).toBe(true)
    expect(calls[0]?.url).toBe(`${BASE}/oauth/token`)
    expect(calls[0]?.method).toBe('POST')
    const form = new URLSearchParams(calls[0]?.body)
    expect(form.get('grant_type')).toBe('client_credentials')
    expect(form.get('client_id')).toBe('cli_service')
    expect(form.get('client_assertion_type')).toBe(
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    )
    expect(form.get('scope')).toBe('targets.read schema.read')
    expect(form.get('resource')).toBe(`${BASE}/api`)
    expect(calls[0]?.body).not.toContain('/mcp')
    expect(form.has('refresh_token')).toBe(false)
    const { payload } = await jwtVerify(form.get('client_assertion') ?? '', pair.publicKey, {
      issuer: 'cli_service',
      audience: BASE,
    })
    expect(payload.sub).toBe('cli_service')
    expect(calls[1]?.headers['authorization']).toBe('Bearer tok_1')
  })

  it('keeps the token in memory and shares one token request between concurrent calls', async () => {
    const { sdk, calls } = await serviceClient(
      token(1),
      json(200, { items: [], nextCursor: null }),
      json(200, { items: [], nextCursor: null }),
      json(200, { items: [], nextCursor: null }),
    )
    await Promise.all([sdk.targets.list(), sdk.targets.list()])
    await sdk.targets.list()
    expect(calls.filter((c) => c.url.endsWith('/oauth/token'))).toHaveLength(1)
    expect(calls.slice(1).every((c) => c.headers['authorization'] === 'Bearer tok_1')).toBe(true)
  })

  it('renews a token shortly before it expires', async () => {
    // A 20-second token is inside the 30-second renewal window at once.
    const { sdk, calls } = await serviceClient(
      token(1, 20),
      json(200, { items: [], nextCursor: null }),
      token(2),
      json(200, { items: [], nextCursor: null }),
    )
    await sdk.targets.list()
    await sdk.targets.list()
    expect(calls.filter((c) => c.url.endsWith('/oauth/token'))).toHaveLength(2)
    expect(calls[3]?.headers['authorization']).toBe('Bearer tok_2')
  })

  it('renews once after a 401 and then reports the refusal', async () => {
    const { sdk, calls } = await serviceClient(
      token(1),
      problem(401, 'AUTHENTICATION_REQUIRED'),
      token(2),
      problem(401, 'AUTHENTICATION_REQUIRED'),
    )
    const result = await sdk.targets.list()
    expect(result.ok ? undefined : result.error.code).toBe('AUTHENTICATION_REQUIRED')
    expect(calls).toHaveLength(4)
    expect(calls[3]?.headers['authorization']).toBe('Bearer tok_2')
  })

  it('reports a refused assertion as CLIENT_AUTHENTICATION_FAILED and sends no API request', async () => {
    const { sdk, calls } = await serviceClient(
      json(401, { error: 'invalid_client' }, { 'x-request-id': 'req_t' }),
    )
    const result = await sdk.targets.list()
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'CLIENT_AUTHENTICATION_FAILED',
        status: 401,
        requestId: 'req_t',
        retryable: false,
        details: { error: 'invalid_client' },
      },
    })
    expect(calls).toHaveLength(1)
  })

  it('does not echo the token endpoint body beyond the OAuth error code', async () => {
    const { sdk } = await serviceClient(
      json(400, { error: 'invalid_scope', error_description: 'scope admin.write' }),
    )
    const result = await sdk.targets.list()
    expect(JSON.stringify(result)).not.toContain('error_description')
  })
})

describe('leak check (order §205)', () => {
  const openapi = JSON.parse(
    readFileSync(new URL('../../contracts/generated/openapi.json', import.meta.url), 'utf8'),
  ) as {
    paths: Record<
      string,
      Record<
        string,
        { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> }
      >
    >
    components: { schemas: Record<string, unknown> }
  }
  const FORBIDDEN = ['password', 'connectionString', 'dsn', 'credentialSecret']

  /** Every property name reachable from a schema, following `$ref`s. */
  function propertyNames(
    schema: unknown,
    seen = new Set<string>(),
    names = new Set<string>(),
  ): Set<string> {
    if (typeof schema !== 'object' || schema === null) return names
    if (Array.isArray(schema)) {
      for (const s of schema) propertyNames(s, seen, names)
      return names
    }
    const record = schema as Record<string, unknown>
    const ref = record['$ref']
    if (typeof ref === 'string') {
      const name = ref.replace('#/components/schemas/', '')
      if (!seen.has(name)) {
        seen.add(name)
        propertyNames(openapi.components.schemas[name], seen, names)
      }
      return names
    }
    const props = record['properties']
    if (typeof props === 'object' && props !== null) {
      for (const key of Object.keys(props)) names.add(key)
    }
    for (const value of Object.values(record)) propertyNames(value, seen, names)
    return names
  }

  const registryReads = Object.entries(OPERATIONS).filter(([, op]) => op.wave === '4')

  it('covers the Wave 4 operations', () => {
    expect(registryReads.length).toBeGreaterThan(20)
  })

  it.each(registryReads)('%s responds without credential fields', (_id, op) => {
    const operation = openapi.paths[op.path]?.[op.method.toLowerCase()]
    expect(operation).toBeDefined()
    const responses = Object.values(operation?.responses ?? {})
    const names = propertyNames(
      responses.map((r) => Object.values(r.content ?? {}).map((c) => c.schema)),
    )
    for (const field of FORBIDDEN) expect(names.has(field)).toBe(false)
  })

  it('the credential submission is a write-only input type', () => {
    const submit = openapi.paths[OPERATIONS.submitClusterCredential.path]?.['post']
    const responseNames = propertyNames(
      Object.values(submit?.responses ?? {}).map((r) =>
        Object.values(r.content ?? {}).map((c) => c.schema),
      ),
    )
    expect(responseNames.has('password')).toBe(false)
    // No response anywhere reaches the submission schema.
    for (const path of Object.values(openapi.paths)) {
      for (const operation of Object.values(path)) {
        const seen = new Set<string>()
        propertyNames(
          Object.values(operation.responses ?? {}).map((r) =>
            Object.values(r.content ?? {}).map((c) => c.schema),
          ),
          seen,
        )
        expect(seen.has('CredentialSubmission')).toBe(false)
      }
    }
  })
})

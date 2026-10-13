import { describe, expect, it, vi } from 'vitest'
import { ApiClient, fillPath, queryString } from '../../src/lib/api/client.ts'
import { CSRF_HEADER, readCsrf } from '../../src/lib/api/csrf.ts'
import { ApiError, problemOf } from '../../src/lib/api/errors.ts'

interface Sent {
  readonly url: string
  readonly init: RequestInit
}

function harness(answers: (sent: Sent, n: number) => Response) {
  const sent: Sent[] = []
  let cookies = '__Host-exdb_csrf=first_token'
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const record = { url: String(url), init: init ?? {} }
    sent.push(record)
    return answers(record, sent.length)
  })
  const gone = vi.fn()
  const client = new ApiClient({
    fetch: fetchFn as unknown as typeof fetch,
    cookies: () => cookies,
    onSessionGone: gone,
  })
  return {
    client,
    sent,
    gone,
    setCookies: (value: string) => {
      cookies = value
    },
  }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

const header = (init: RequestInit, name: string): string | undefined =>
  (init.headers as Record<string, string> | undefined)?.[name]

describe('the CSRF cookie', () => {
  it('is read by exact name and shape only', () => {
    expect(readCsrf('a=b; __Host-exdb_csrf=abc_DEF-123; c=d')).toBe('abc_DEF-123')
    expect(readCsrf('__Host-exdb_csrf=bad value')).toBeUndefined()
    expect(readCsrf('x__Host-exdb_csrf=abc')).toBeUndefined()
    expect(readCsrf('__Host-exdb_csrf=')).toBeUndefined()
    expect(readCsrf(`__Host-exdb_csrf=${'a'.repeat(129)}`)).toBeUndefined()
    expect(readCsrf('')).toBeUndefined()
  })
})

describe('paths and queries', () => {
  it('encodes each parameter as one segment and refuses a missing one', () => {
    expect(fillPath('/targets/{target}/schema', { target: 'reosa/platform/production' })).toBe(
      '/targets/reosa%2Fplatform%2Fproduction/schema',
    )
    expect(fillPath('/plans/{planId}', { planId: '../x?y#z' })).toBe('/plans/..%2Fx%3Fy%23z')
    expect(() => fillPath('/plans/{planId}', {})).toThrow(/planId/)
  })

  it('drops undefined values and repeats arrays', () => {
    expect(queryString({ a: 1, b: undefined, c: ['x', 'y'], d: null })).toBe('?a=1&c=x&c=y')
    expect(queryString({})).toBe('')
  })
})

describe('the API client', () => {
  it('sends same-origin, no-store, the CSRF header and never an Authorization header', async () => {
    const { client, sent } = harness(() => json(200, { items: [], nextCursor: null }))
    await client.operation('listTargets', { query: { tier: 'prod' } })
    const [request] = sent
    expect(request?.url).toBe('/api/v1/targets?tier=prod')
    expect(request?.init.method).toBe('GET')
    expect(request?.init.credentials).toBe('same-origin')
    expect(request?.init.cache).toBe('no-store')
    expect(header(request?.init ?? {}, CSRF_HEADER)).toBe('first_token')
    expect(header(request?.init ?? {}, 'authorization')).toBeUndefined()
    expect(request?.init.body).toBeUndefined()
  })

  it('reads the CSRF cookie fresh for every request', async () => {
    const h = harness(() => json(200, {}))
    await h.client.ceremony('/auth/logout')
    h.setCookies('__Host-exdb_csrf=rotated')
    await h.client.ceremony('/auth/logout')
    expect(h.sent.map((s) => header(s.init, CSRF_HEADER))).toEqual(['first_token', 'rotated'])
  })

  it('sends JSON bodies for mutations', async () => {
    const { client, sent } = harness(() => json(202, { id: 'op_1' }))
    await client.operation('applyPlan', { params: { planId: 'pln_1' }, body: {} })
    expect(sent[0]?.url).toBe('/api/v1/plans/pln_1/apply')
    expect(sent[0]?.init.method).toBe('POST')
    expect(header(sent[0]?.init ?? {}, 'content-type')).toBe('application/json')
    expect(sent[0]?.init.body).toBe('{}')
  })

  it('turns a problem into an ApiError with the catalog message, code and Retry-After', async () => {
    const { client } = harness(() =>
      json(429, { code: 'RATE_LIMITED', message: 'Too many requests.' }, { 'retry-after': '7' }),
    )
    const error = await client.ceremony('/auth/login/password', {}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ code: 'RATE_LIMITED', status: 429, retryAfterSeconds: 7 })
    expect((error as ApiError).message).toBe('Too many requests.')
  })

  it('never shows text from a body that is not a problem of the catalog', () => {
    expect(problemOf(500, '<html>stack trace</html>', null)).toMatchObject({
      code: 'UNKNOWN',
      message: 'The request failed.',
    })
    expect(problemOf(500, { code: 'lower case', message: 'leak' }, null).message).toBe(
      'The request failed.',
    )
  })

  it('reports an unreachable server with fixed text', async () => {
    const client = new ApiClient({
      fetch: (async () => {
        throw new TypeError('connect ECONNREFUSED 10.0.0.1:5432')
      }) as unknown as typeof fetch,
      cookies: () => '',
      onSessionGone: () => {},
    })
    const error = await client.ceremony('/auth/logout').catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'NETWORK', message: 'The server could not be reached.' })
  })

  it('ends the session in the page when the server says it expired', async () => {
    const h = harness(() => json(401, { code: 'SESSION_EXPIRED', message: 'Sign in again.' }))
    await expect(h.client.operation('getMe')).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
    expect(h.gone).toHaveBeenCalledTimes(1)
    expect(h.sent).toHaveLength(1)
  })

  it('sends once more a request whose CSRF token was rotated under it, and only once', async () => {
    const h = harness((_, n) => {
      if (n === 1) {
        h.setCookies('__Host-exdb_csrf=rotated')
        return json(401, { code: 'SESSION_EXPIRED', message: 'Sign in again.' })
      }
      return json(200, { ok: true })
    })
    expect(await h.client.operation('getMe')).toEqual({ ok: true })
    expect(h.sent.map((s) => header(s.init, CSRF_HEADER))).toEqual(['first_token', 'rotated'])
    expect(h.gone).not.toHaveBeenCalled()
  })

  it('does not loop when the retried request expires as well', async () => {
    let n = 0
    const h = harness(() => {
      n++
      h.setCookies(`__Host-exdb_csrf=rotated${n}`)
      return json(401, { code: 'SESSION_EXPIRED', message: 'Sign in again.' })
    })
    await expect(h.client.operation('getMe')).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
    expect(h.sent).toHaveLength(2)
    expect(h.gone).toHaveBeenCalledTimes(1)
  })
})

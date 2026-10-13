import { describe, expect, it, vi } from 'vitest'
import { ApiClient } from '../../src/lib/api/client.ts'
import { CSRF_HEADER } from '../../src/lib/api/csrf.ts'
import { RequestGate } from '../../src/lib/api/gate.ts'
import { withReauth } from '../../src/lib/api/reauth.ts'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** A fake server: a session whose CSRF token rotates when the re-authentication succeeds. */
function world() {
  let csrf = 'before'
  let fresh = false
  const log: string[] = []
  const pending: { path: string; release: () => void }[] = []
  const fetchFn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = String(url)
    const sentCsrf = ((init?.headers ?? {}) as Record<string, string>)[CSRF_HEADER]
    log.push(`${path} ${sentCsrf}`)
    if (path === '/slow') {
      const gate = deferred<void>()
      pending.push({ path, release: () => gate.resolve() })
      await gate.promise
    }
    if (sentCsrf !== csrf) {
      return json(401, { code: 'SESSION_EXPIRED', message: 'Sign in again.' })
    }
    if (path === '/auth/reauth/totp') {
      csrf = 'after'
      fresh = true
      return json(200, { reauthenticatedAt: 'now' })
    }
    if (path === '/needs-proof') {
      return fresh
        ? json(200, { done: true })
        : json(403, { code: 'REAUTH_REQUIRED', message: 'Confirm it is you.' })
    }
    return json(200, { path })
  }
  const gone = vi.fn()
  const client = new ApiClient({
    fetch: fetchFn as unknown as typeof fetch,
    cookies: () => `__Host-exdb_csrf=${csrf}`,
    onSessionGone: gone,
    gate: new RequestGate(1_000),
  })
  return { client, log, pending, gone }
}

describe('re-authentication', () => {
  it('confirms once and runs the action exactly once more', async () => {
    const w = world()
    const ask = vi.fn(async (c: ApiClient) => {
      await c.ceremonyBypassingGate('/auth/reauth/totp', { code: '123456' })
      return true
    })
    const result = await withReauth(w.client, ask, () => w.client.send('POST', '/needs-proof'))
    expect(result).toEqual({ done: true })
    expect(ask).toHaveBeenCalledTimes(1)
    expect(w.log).toEqual(['/needs-proof before', '/auth/reauth/totp before', '/needs-proof after'])
  })

  it('reports a canceled confirmation as "nothing was changed" and does not retry', async () => {
    const w = world()
    const error = await withReauth(
      w.client,
      async () => false,
      () => w.client.send('POST', '/needs-proof'),
    ).catch((e: unknown) => e)
    expect(error).toMatchObject({
      code: 'REAUTH_CANCELED',
      message: 'Canceled. Nothing was changed.',
    })
    expect(w.log).toEqual(['/needs-proof before'])
  })

  it('never bounces a parallel request to the sign-in page around the rotation', async () => {
    const w = world()
    // A request is in flight when the re-authentication starts; another starts during it.
    const inFlight = w.client.send('GET', '/slow')
    const ask = async (c: ApiClient) => {
      const during = w.client.send('GET', '/during')
      await c.ceremonyBypassingGate('/auth/reauth/totp', { code: '123456' })
      await Promise.resolve()
      expect(w.log).not.toContain('/during before')
      void during
      return true
    }
    const reauth = withReauth(w.client, ask, () => w.client.send('POST', '/needs-proof'))
    // The ceremony waits until the request in flight has settled.
    await new Promise((r) => setTimeout(r, 20))
    expect(w.log.some((l) => l.startsWith('/auth/reauth/totp'))).toBe(false)
    w.pending[0]?.release()
    await expect(inFlight).resolves.toEqual({ path: '/slow' })
    await expect(reauth).resolves.toEqual({ done: true })
    expect(w.log).toContain('/during after')
    expect(w.gone).not.toHaveBeenCalled()
  })

  it('shares one confirmation between two actions that need it at the same time', async () => {
    const w = world()
    const ask = vi.fn(async (c: ApiClient) => {
      await c.ceremonyBypassingGate('/auth/reauth/totp', { code: '123456' })
      return true
    })
    const both = await Promise.all([
      withReauth(w.client, ask, () => w.client.send('POST', '/needs-proof')),
      withReauth(w.client, ask, () => w.client.send('POST', '/needs-proof')),
    ])
    expect(both).toEqual([{ done: true }, { done: true }])
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('does not wait forever for a request that hangs', async () => {
    const w = world()
    void w.client.send('GET', '/slow')
    const ask = async (c: ApiClient) => {
      await c.ceremonyBypassingGate('/auth/reauth/totp', { code: '123456' })
      return true
    }
    await expect(
      withReauth(w.client, ask, () => w.client.send('POST', '/needs-proof')),
    ).resolves.toEqual({ done: true })
    w.pending[0]?.release()
  })
})

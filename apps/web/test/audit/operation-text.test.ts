import { describe, expect, it, vi } from 'vitest'
import { ApiClient } from '../../src/lib/api/client.ts'
import { CSRF_HEADER } from '../../src/lib/api/csrf.ts'
import { ApiError } from '../../src/lib/api/errors.ts'

/**
 * `operationText`: the raw body of an operation whose answer is not JSON (the
 * NDJSON audit export), sent like every other request: the session cookie,
 * the CSRF header, `no-store`, never an `Authorization` header; a failure is
 * read as a problem.
 */
function harness(answer: () => Response) {
  const sent: { url: string; init: RequestInit }[] = []
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} })
    return answer()
  })
  const client = new ApiClient({
    fetch: fetchFn as unknown as typeof fetch,
    cookies: () => '__Host-exdb_csrf=tok',
    onSessionGone: vi.fn(),
  })
  return { client, sent }
}

describe('operationText', () => {
  it('returns the body as text and sends no Authorization header', async () => {
    const body = '{"type":"header"}\n{"type":"event"}\n'
    const { client, sent } = harness(
      () =>
        new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } }),
    )
    const text = await client.operationText('exportAuditEvents', {
      query: { from: '1', cursor: 'c' },
    })
    expect(text).toBe(body)
    expect(sent[0]?.url).toBe('/api/v1/audit-events/export?from=1&cursor=c')
    const headers = sent[0]?.init.headers as Record<string, string>
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain('authorization')
    expect(headers[CSRF_HEADER]).toBe('tok')
    expect(sent[0]?.init.credentials).toBe('same-origin')
    expect(sent[0]?.init.cache).toBe('no-store')
    expect(sent[0]?.init.method).toBe('GET')
  })

  it('reads a refusal as a problem with its code', async () => {
    const { client } = harness(
      () =>
        new Response(JSON.stringify({ code: 'REAUTH_REQUIRED', message: 'Confirm it is you.' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    )
    await expect(client.operationText('exportAuditEvents')).rejects.toBeInstanceOf(ApiError)
    await expect(client.operationText('exportAuditEvents')).rejects.toMatchObject({
      code: 'REAUTH_REQUIRED',
    })
  })
})

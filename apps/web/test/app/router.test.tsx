import '@testing-library/jest-dom/vitest'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppProviders } from '../../src/app/providers.tsx'
import { type AppRouter, createAppRouter, keepRawFragment } from '../../src/app/router.ts'
import { holdOneTimeLink } from '../../src/features/enrollment/link.ts'
import { createReauthBridge } from '../../src/features/reauth/reauth.tsx'
import { ApiClient } from '../../src/lib/api/client.ts'
import { parseSearch, stringifySearch } from '../../src/lib/navigation/search.ts'
import { createQueryClient } from '../../src/lib/query/client.ts'

/**
 * The router's handling of untrusted deep links (threat-model.md, "Untrusted
 * deep links"; order Appendix C): query values stay strings, a fragment is
 * never rewritten into the address bar, and a one-time token never reaches
 * the router, the address bar or the history.
 */
afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', '/')
  vi.unstubAllGlobals()
})

function mount(router: AppRouter) {
  const fetchFn = vi.fn(
    async () =>
      new Response(JSON.stringify({ code: 'UNAUTHENTICATED', message: 'Sign in to continue.' }), {
        status: 401,
      }),
  )
  vi.stubGlobal('fetch', fetchFn)
  const client = new ApiClient({
    fetch: fetchFn as unknown as typeof fetch,
    cookies: () => '',
    onSessionGone: () => undefined,
  })
  render(
    <AppProviders
      services={{
        queryClient: createQueryClient(),
        client,
        reauth: createReauthBridge(),
        navigate: (to) => void router.navigate({ href: to }),
      }}
    >
      <RouterProvider router={router} />
    </AppProviders>,
  )
  return fetchFn
}

describe('query strings', () => {
  it('reads every value as the string it is, never as JSON', () => {
    expect(parseSearch('?returnTo=%22%2Fapprovals%22')).toEqual({ returnTo: '"/approvals"' })
    expect(parseSearch('?a=123&b=true&c=%5B1%5D&d=%7B%22x%22%3A1%7D&e=null')).toEqual({
      a: '123',
      b: 'true',
      c: '[1]',
      d: '{"x":1}',
      e: 'null',
    })
    expect(parseSearch('')).toEqual({})
  })

  it('keeps the first of a repeated key, like URLSearchParams.get', () => {
    expect(parseSearch('?returnTo=%2Faccount&returnTo=%2Fapprovals')).toEqual({
      returnTo: '/account',
    })
  })

  it('takes a key named __proto__ as a plain key, never as the prototype', () => {
    const parsed = parseSearch('?__proto__=x&constructor=y')
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype)
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true)
    expect(Object.getOwnPropertyDescriptor(parsed, '__proto__')?.value).toBe('x')
    expect(parsed['constructor']).toBe('y')
  })

  it('writes strings, numbers and booleans, and leaves out the rest', () => {
    expect(stringifySearch({ returnTo: '"/approvals"' })).toBe('?returnTo=%22%2Fapprovals%22')
    expect(stringifySearch({ a: 1, b: false, c: undefined, d: null, e: { x: 1 } })).toBe(
      '?a=1&b=false',
    )
    expect(stringifySearch({})).toBe('')
  })

  it('keeps a JSON-looking returnTo a string in the router state and the address', async () => {
    const router = createAppRouter(
      createMemoryHistory({ initialEntries: ['/oauth/error?returnTo=%22%2Fapprovals%22'] }),
    )
    mount(router)
    await waitFor(() => expect(router.state.status).toBe('idle'))
    expect(router.state.location.search).toEqual({ returnTo: '"/approvals"' })
    expect(router.history.location.search).toBe('?returnTo=%22%2Fapprovals%22')
  })
})

describe('fragments', () => {
  it('never writes a decoded fragment back into the address bar or the history', async () => {
    // A percent-encoded handle does not match the exact grammar; the router's canonical rewrite
    // on load must not decode it into one that does.
    const encoded = `#request=exar_%41${'A'.repeat(42)}`
    window.history.replaceState(null, '', `/oauth/error?reason=client_not_approved${encoded}`)
    const length = window.history.length
    const router = createAppRouter()
    mount(router)
    await screen.findByRole('main')
    await waitFor(() => expect(router.state.status).toBe('idle'))
    expect(window.location.hash).toBe(encoded)
    expect(router.history.location.hash).toBe(encoded)
    expect(window.history.length).toBe(length)
  })

  it('writes any other fragment the app navigates to as given', () => {
    const history = keepRawFragment(createMemoryHistory({ initialEntries: ['/a#x=%41'] }))
    history.push('/b#y=1')
    expect(history.location.hash).toBe('#y=1')
    history.replace('/b#x=A')
    expect(history.location.hash).toBe('#x=A')
  })

  it('keeps the raw fragment only for the same fragment in decoded form', () => {
    const history = keepRawFragment(createMemoryHistory({ initialEntries: ['/a#x=%41'] }))
    history.replace('/a#x=A')
    expect(history.location.hash).toBe('#x=%41')
  })

  it('a one-time token leaves the address bar and the history before the router exists', async () => {
    const token = `exsu_${'B'.repeat(43)}`
    window.history.replaceState(null, '', `/setup#token=${token}`)
    const length = window.history.length
    expect(holdOneTimeLink(window.location, window.history)).toBe(true)
    expect(window.location.href).not.toContain(token)
    const router = createAppRouter()
    const fetchFn = mount(router)
    await waitFor(() => expect(router.state.status).toBe('idle'))
    expect(window.location.href).not.toContain(token)
    expect(window.location.hash).toBe('')
    expect(router.state.location.hash).toBe('')
    expect(JSON.stringify(router.state.location)).not.toContain(token)
    expect(JSON.stringify(window.history.state)).not.toContain(token)
    // No entry was added (the token's entry was replaced, never pushed).
    expect(window.history.length).toBe(length)
    // The token travels in a request body only (the redemption), never in a URL.
    for (const [input] of fetchFn.mock.calls as unknown as [unknown][]) {
      expect(String(input)).not.toContain(token)
    }
  })
})

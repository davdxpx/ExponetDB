import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { configure, render, screen, within } from '@testing-library/react'
import type userEvent from '@testing-library/user-event'
import { expect, vi } from 'vitest'
import { AppProviders } from '../../src/app/providers.tsx'
import { createReauthBridge } from '../../src/features/reauth/reauth.tsx'
import { ApiClient, type ResponseOf } from '../../src/lib/api/client.ts'
import { createQueryClient } from '../../src/lib/query/client.ts'
import { routeTree } from '../../src/routeTree.gen.ts'

/**
 * A fake server for the access, audit and settings pages and a way to mount
 * the real route tree on it. Each test registers the answers it needs by
 * method and exact path (`world.on`); the session read is built in. Changes
 * (anything but GET) answer `REAUTH_REQUIRED` while `needsProof` holds and
 * the authenticator code 123456 has not been sent, and so does a GET listed
 * in `proofFor` (the audit export). Every request is recorded with its
 * method, path, query, body and headers; a request nobody registered is a
 * 404, so a request a page should not make is visible.
 */
configure({ asyncUtilTimeout: 5_000 })
vi.setConfig({ testTimeout: 30_000 })

export const T0 = '2026-10-13T09:00:00Z'
export const ME = 'idn_01JZ0000000000000000000001'
export const OTHER = 'idn_01JZ0000000000000000000002'
export const PLAN = 'pln_01JZ0000000000000000000001'
export const OP = 'op_01JZ0000000000000000000001'
export const TARGET = 'tgt_01JZ0000000000000000000001'
export const CLIENT = 'cli_01JZ0000000000000000000001'
export const GRANT = 'grt_01JZ0000000000000000000001'
export const BGL = 'bgl_01JZ0000000000000000000001'
export const BGL2 = 'bgl_01JZ0000000000000000000002'

export const HOSTILE = '<script>document.title="x"</script><img src=x onerror=alert(1)>'
export const BIDI = `admin${String.fromCodePoint(0x202e)}gpj.exe`
export const ZWSP = `zero${String.fromCodePoint(0x200b)}width`
export const TAG = `tag${String.fromCodePoint(0xe0041, 0xe0042)}`

export type Permission = ResponseOf<'getMe'>['effectivePermissions'][number]['permission']
export type Me = ResponseOf<'getMe'>

export function meWith(permissions: readonly Permission[]): Me {
  return {
    identity: {
      activatedAt: T0,
      createdAt: T0,
      displayName: 'Ada',
      email: 'owner@example.test',
      factors: { passkeys: 1, password: true, recoveryCodesRemaining: 10, totp: true },
      id: ME,
      kind: 'human',
      label: 'owner',
      recoveryRequired: false,
      state: 'active',
    },
    session: {
      assurance: 'full',
      clientKind: 'web',
      createdAt: T0,
      current: true,
      device: 'Test',
      expiresAt: '2026-10-14T09:00:00Z',
      id: 'wss_01JZ0000000000000000000001',
      idleExpiresAt: '2026-10-13T21:00:00Z',
      lastSeenAt: T0,
      reauthAt: null,
    },
    bindings: [],
    effectivePermissions: permissions.map((permission) => ({
      permission,
      scopes: [{ kind: 'global' as const }],
    })),
  }
}

export interface Recorded {
  readonly method: string
  readonly path: string
  readonly search: URLSearchParams
  readonly body: unknown
  readonly headers: Readonly<Record<string, string>>
}

export type Answer = Response | { readonly status?: number; readonly json: unknown }
export type Handler = (request: Recorded) => Answer | Promise<Answer>

/** `{ status, json }` (and nothing else) is an answer with that status; any other value is a 200 body. */
function isAnswer(value: unknown): value is Answer {
  if (value instanceof Response) return true
  if (typeof value !== 'object' || value === null) return false
  const keys = Object.keys(value)
  return keys.includes('json') && keys.every((key) => key === 'json' || key === 'status')
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export const problem = (status: number, code: string, message = `${code} happened.`) =>
  json(status, { code, message })

export class World {
  permissions: Permission[] = [
    'access.read',
    'access.manage',
    'audit.read',
    'policy.manage',
    'registry.manage',
    'targets.read',
    'nodes.read',
  ]
  needsProof = false
  proven = false
  /** GET paths that need a fresh proof as well (the audit export). */
  readonly proofFor = new Set<string>()
  readonly requests: Recorded[] = []
  readonly #handlers = new Map<string, Handler>()

  /** Registers the answer for `METHOD /api/v1/path` (exact path, any query). */
  on(method: string, path: string, handler: Handler): this
  on(method: string, path: string, body: object): this
  on(method: string, path: string, handler: unknown): this {
    const fixed = (): Answer => (isAnswer(handler) ? handler : json(200, handler))
    this.#handlers.set(
      `${method} ${path}`,
      typeof handler === 'function' ? (handler as Handler) : fixed,
    )
    return this
  }

  /** The changes the page sent (everything but reads and the proof). */
  get changes(): Recorded[] {
    return this.requests.filter((r) => r.method !== 'GET' && !r.path.startsWith('/auth/'))
  }

  reads(path: string): Recorded[] {
    return this.requests.filter((r) => r.method === 'GET' && r.path === path)
  }

  async answer(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input), 'http://localhost')
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const headers = { ...((init?.headers as Record<string, string> | undefined) ?? {}) }
    const recorded: Recorded = {
      method,
      path: url.pathname,
      search: url.searchParams,
      body,
      headers,
    }
    this.requests.push(recorded)
    if (url.pathname === '/api/v1/me') return json(200, meWith(this.permissions))
    if (url.pathname === '/auth/reauth/totp') {
      if ((body as { code?: string } | undefined)?.code !== '123456') {
        return problem(400, 'REAUTH_FAILED', 'The proof was not accepted.')
      }
      this.proven = true
      return json(200, { reauthenticatedAt: new Date().toISOString() })
    }
    const needs = method !== 'GET' ? this.needsProof : this.proofFor.has(url.pathname)
    if (needs && !this.proven) return problem(403, 'REAUTH_REQUIRED', 'Confirm it is you.')
    const handler = this.#handlers.get(`${method} ${url.pathname}`)
    if (handler === undefined) return problem(404, 'NOT_FOUND', 'Not found.')
    const result = await handler(recorded)
    return result instanceof Response ? result : json(result.status ?? 200, result.json)
  }
}

export function mountApp(initialPath: string, world: World) {
  const fetchFn = vi.fn((input: string | URL | Request, init?: RequestInit) =>
    world.answer(input, init),
  )
  const client = new ApiClient({
    fetch: fetchFn as unknown as typeof fetch,
    cookies: () => '__Host-exdb_csrf=t',
    onSessionGone: vi.fn(),
  })
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  })
  const queryClient = createQueryClient()
  const view = render(
    <AppProviders
      services={{
        queryClient,
        client,
        reauth: createReauthBridge(),
        navigate: (to) => void router.navigate({ href: to }),
      }}
    >
      <RouterProvider router={router} />
    </AppProviders>,
  )
  return { router, fetchFn, queryClient, container: view.container }
}

/** Everything the query and mutation caches hold, as JSON text. */
export function cacheText(queryClient: ReturnType<typeof createQueryClient>): string {
  return JSON.stringify({
    queries: queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.state),
    mutations: queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state),
  })
}

export async function confirmWithCode(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const reauth = await screen.findByRole('dialog', { name: 'Confirm it is you' })
  await user.type(
    within(reauth).getByLabelText('Or enter the code from your authenticator app'),
    '123456',
  )
  await user.click(within(reauth).getByRole('button', { name: 'Confirm with code' }))
}

/** A promise the test resolves later, for holding a read in its loading state. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Untrusted text is shown as text, with invisible and direction characters named by code point. */
export function expectInert(container: HTMLElement): void {
  expect(container.querySelector('script')).toBeNull()
  expect(container.querySelector('img')).toBeNull()
  expect(document.title).not.toBe('x')
}

export function plan(over: Record<string, unknown> = {}) {
  return { id: PLAN, ...over }
}

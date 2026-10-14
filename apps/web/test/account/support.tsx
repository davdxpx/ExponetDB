import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render } from '@testing-library/react'
import { StrictMode } from 'react'
import { type Mock, vi } from 'vitest'
import { AppProviders } from '../../src/app/providers.tsx'
import { createAppRouter } from '../../src/app/router.ts'
import { createReauthBridge } from '../../src/features/reauth/reauth.tsx'
import { pageLoad } from '../../src/features/sign-in/page-load.ts'
import { ApiClient } from '../../src/lib/api/client.ts'
import { createQueryClient } from '../../src/lib/query/client.ts'

/**
 * A fake server for the sign-in, link and account pages and a way to mount
 * the real route tree on it. Each request is recorded with its method, path,
 * parsed body, headers and the address bar's fragment at the moment it was
 * sent (so a test can prove a token left the address before it was used).
 * A route answers from a handler the test sets; anything else is a 404
 * problem, so a request a page should not make is visible.
 */
export interface Recorded {
  readonly method: string
  readonly path: string
  readonly body: unknown
  readonly headers: Readonly<Record<string, string>>
  /** The request body when it is not a string (raw bytes), else undefined. */
  readonly raw?: unknown
  /** `window.location.hash` when the request was sent. */
  readonly hash: string
}

export type Handler = (request: Recorded) => Response | Promise<Response>

export function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

export function problem(
  status: number,
  code: string,
  message = `${code} happened.`,
  headers: Record<string, string> = {},
) {
  return json(status, { code, message }, headers)
}

export const TOKEN_TAIL = 'Q'.repeat(43)
export const NOW = '2026-10-13T12:00:00.000Z'
export const LATER = '2026-10-13T12:30:00.000Z'

const ID = (prefix: string, n: number) => `${prefix}_01JZ${String(n).padStart(22, '0')}`

export const ids = {
  identity: ID('idn', 1),
  session: (n: number) => ID('ses', n),
  factor: (n: number) => ID('fac', n),
  grant: (n: number) => ID('grt', n),
  client: (n: number) => ID('ocl', n),
}

export function meOf(
  over: {
    readonly recovery?: boolean
    readonly email?: string | null
    readonly displayName?: string | null
    readonly roles?: readonly string[]
  } = {},
) {
  const recovery = over.recovery === true
  return {
    identity: {
      id: ids.identity,
      kind: 'human',
      state: 'active',
      label: 'owner',
      displayName: over.displayName === undefined ? 'Ada' : over.displayName,
      email: over.email === undefined ? 'owner@example.test' : over.email,
      createdAt: NOW,
      activatedAt: NOW,
      recoveryRequired: recovery,
      factors: { passkeys: 1, password: true, totp: true, recoveryCodesRemaining: 10 },
    },
    session: {
      id: ids.session(1),
      assurance: recovery ? 'recovery' : 'full',
      clientKind: 'web',
      createdAt: NOW,
      current: true,
      device: 'Chrome on Linux',
      expiresAt: LATER,
      idleExpiresAt: LATER,
      lastSeenAt: NOW,
      reauthAt: null,
    },
    bindings: (over.roles ?? ['owner']).map((roleId, n) => ({
      id: ID('rlb', n + 1),
      identityId: ids.identity,
      roleId,
      scope: { kind: 'global' },
      state: 'active',
      createdAt: NOW,
      createdByOperationId: null,
      revokedAt: null,
    })),
    effectivePermissions: [],
  }
}

export function passkey(n: number, label = `Passkey ${n}`) {
  return {
    id: ids.factor(n),
    kind: 'passkey',
    label,
    createdAt: NOW,
    lastUsedAt: null,
    backedUp: true,
    deviceType: 'multiDevice',
  }
}

export function webSession(n: number, over: Record<string, unknown> = {}) {
  return {
    id: ids.session(n),
    assurance: 'full',
    clientKind: 'web',
    createdAt: NOW,
    current: n === 1,
    device: `Browser ${n}`,
    expiresAt: LATER,
    idleExpiresAt: LATER,
    lastSeenAt: NOW,
    reauthAt: null,
    ...over,
  }
}

export function grant(
  n: number,
  over: {
    readonly name?: string
    readonly firstParty?: boolean
    readonly resource?: 'api' | 'mcp'
    readonly scopes?: readonly string[]
    readonly tiers?: readonly string[]
    readonly state?: string
    readonly lastUsedAt?: string | null
    readonly lastUseClass?: string | null
  } = {},
) {
  return {
    id: ids.grant(n),
    identityId: ids.identity,
    kind: 'delegated',
    client: {
      id: ids.client(n),
      clientId: `client-${n}`,
      firstParty: over.firstParty ?? false,
      kind: 'mcp',
      name: over.name ?? `Client ${n}`,
      registration: over.firstParty === true ? 'first_party' : 'dcr',
      state: 'active',
    },
    consentAt: NOW,
    createdAt: NOW,
    expiresAt: LATER,
    lastTokenAt: NOW,
    lastUsedAt: over.lastUsedAt === undefined ? null : over.lastUsedAt,
    lastUseClass: over.lastUseClass === undefined ? null : over.lastUseClass,
    resource: over.resource ?? 'mcp',
    resourceUri: 'https://db.exponet.cloud/mcp',
    restrictions: { targets: { kind: 'all' }, tiers: over.tiers ?? ['nonprod'] },
    revokeReason: null,
    revokedAt: null,
    scopes: over.scopes ?? ['targets.read'],
    state: over.state ?? 'active',
  }
}

export class FakeServer {
  readonly requests: Recorded[] = []
  readonly #routes = new Map<string, Handler>()
  /** The app client's `onSessionGone` (leaving for the sign-in page). */
  readonly sessionGone: Mock<() => void> = vi.fn()
  readonly fetch: Mock<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>

  constructor() {
    this.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const text = typeof init?.body === 'string' ? init.body : ''
      const recorded: Recorded = {
        method: init?.method ?? 'GET',
        path: `${url.pathname}${url.search}`,
        body: text === '' ? undefined : JSON.parse(text),
        headers: { ...(init?.headers as Record<string, string> | undefined) },
        raw: typeof init?.body === 'string' ? undefined : init?.body,
        hash: window.location.hash,
      }
      this.requests.push(recorded)
      const handler = this.#routes.get(`${recorded.method} ${url.pathname}`)
      return handler === undefined ? problem(404, 'NOT_FOUND', 'Not found.') : handler(recorded)
    })
  }

  /** Answers `method path` with the handler (the last one set wins). */
  on(method: string, path: string, handler: Handler): this {
    this.#routes.set(`${method} ${path}`, handler)
    return this
  }

  /** Answers `method path` with a JSON body. */
  answer(method: string, path: string, status: number, body: unknown): this {
    return this.on(method, path, () => json(status, body))
  }

  /** The requests to one path, in order. */
  to(method: string, path: string): Recorded[] {
    return this.requests.filter((r) => r.method === method && r.path === path)
  }

  /** Signed out: `GET /api/v1/me` answers `UNAUTHENTICATED`. */
  signedOut(): this {
    return this.on('GET', '/api/v1/me', () =>
      problem(401, 'UNAUTHENTICATED', 'Sign in to continue.'),
    )
  }

  /** Signed in as `me`. */
  signedIn(me: unknown): this {
    return this.answer('GET', '/api/v1/me', 200, me)
  }
}

/** The app's own router (plain query strings, raw fragments) over an in-memory history. */
function testRouter(path: string) {
  return createAppRouter(createMemoryHistory({ initialEntries: [path] }))
}

export interface Mounted {
  readonly router: ReturnType<typeof testRouter>
  readonly queryClient: ReturnType<typeof createQueryClient>
  readonly assign: Mock<(path: string) => void>
}

/**
 * Mounts the app's real route tree at `path` against the fake server. The
 * app client and the sign-in page's session probe (which uses the global
 * `fetch`) both reach the fake. Full page loads are recorded, not done.
 */
export function mountApp(
  path: string,
  server: FakeServer,
  options: { readonly strict?: boolean } = {},
): Mounted {
  vi.stubGlobal('fetch', server.fetch)
  const assign = vi.fn<(path: string) => void>()
  vi.spyOn(pageLoad, 'assign').mockImplementation(assign)
  const client = new ApiClient({
    fetch: server.fetch as unknown as typeof fetch,
    cookies: () => '__Host-exdb_csrf=csrf-token',
    onSessionGone: server.sessionGone,
  })
  const router = testRouter(path)
  const queryClient = createQueryClient()
  const tree = (
    <AppProviders
      services={{
        queryClient,
        client,
        reauth: createReauthBridge(),
        navigate: (to) => void router.navigate({ href: to }),
      }}
    >
      <RouterProvider router={router} />
    </AppProviders>
  )
  render(options.strict === true ? <StrictMode>{tree}</StrictMode> : tree)
  return { router, queryClient, assign }
}

/** Everything the query cache holds, as text (to prove a secret never went there). */
export function cacheText(queryClient: ReturnType<typeof createQueryClient>): string {
  return JSON.stringify([
    queryClient
      .getQueryCache()
      .getAll()
      .map((query) => [query.queryKey, query.state.data]),
    queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => [mutation.state.variables, mutation.state.data]),
  ])
}

/** Everything in both browser storages, as text. */
export function storageText(): string {
  const all: string[] = []
  for (const storage of [window.localStorage, window.sessionStorage]) {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key !== null) all.push(`${key}=${storage.getItem(key) ?? ''}`)
    }
  }
  return all.join('\n')
}

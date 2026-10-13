import type { ConsentView } from '@exponetdb/contracts'
import type { QueryClient } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { render } from '@testing-library/react'
import { vi } from 'vitest'
import { AppProviders } from '../../src/app/providers.tsx'
import { createReauthBridge } from '../../src/features/reauth/reauth.tsx'
import { ApiClient } from '../../src/lib/api/client.ts'
import { createQueryClient } from '../../src/lib/query/client.ts'
import { routeTree } from '../../src/routeTree.gen.ts'

/**
 * A fake server for the OAuth pages and a way to mount the real route tree
 * on it: the session read, the consent and device ceremonies and the
 * authenticator-code re-authentication (code 123456). A test changes the
 * `OAuthWorld` between steps; every request is recorded with its body, and
 * anything unknown answers 404, so a request a page should not make shows.
 */
export const HANDLE = `exar_${'A'.repeat(43)}`
export const T_STAGING = 'tgt_01M4S9000000000000000000AG'
export const T_PRODUCTION = 'tgt_01M4S9000000000000000000AC'

type Offer = ConsentView['scopes'][number]

export function offer(scope: string, over: Partial<Offer> = {}): Offer {
  return {
    scope,
    available: true,
    reason: null,
    write: false,
    effect: 'read',
    tier: null,
    explicitConsent: false,
    humanOnly: false,
    ...over,
  } as Offer
}

export function consentView(over: Partial<ConsentView> = {}): ConsentView {
  return {
    kind: 'authorization_code',
    client: {
      id: 'cli_01M4S9000000000000000000AE',
      clientId: 'https://agent.example.test/client.json',
      kind: 'mcp',
      registration: 'cimd',
      state: 'active',
      firstParty: false,
      name: 'Agent',
      redirectHost: 'agent.example.test',
      loopbackRedirect: false,
      lookalike: false,
    },
    resource: 'mcp',
    resourceUri: 'https://db.example.test/mcp',
    scopes: [
      offer('targets.read'),
      offer('schema.read', { write: true, effect: 'control_record' }),
      offer('migrations.apply:nonprod', { write: true, effect: 'consequential', tier: 'nonprod' }),
      offer('data.read:prod', { tier: 'prod', explicitConsent: true }),
      offer('registry.manage', {
        available: false,
        reason: 'not_grantable',
        write: true,
        effect: 'consequential',
        explicitConsent: true,
        humanOnly: true,
      }),
    ],
    defaults: { tiers: ['nonprod'], targets: { kind: 'all' } },
    targets: [
      { id: T_PRODUCTION, path: 'shop/platform/production', tier: 'prod' },
      { id: T_STAGING, path: 'shop/platform/staging', tier: 'nonprod' },
    ],
    lifetimeDays: { default: 30, max: 90 },
    reauth: { fresh: true, withinSeconds: 300 },
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    ...over,
  } as ConsentView
}

export interface Failure {
  readonly status: number
  readonly code: string
  readonly message?: string
}

export interface Sent {
  readonly path: string
  readonly body: unknown
}

export class OAuthWorld {
  view: ConsentView = consentView()
  /** The answer of `/auth/oauth/consent`. */
  redirectTo = 'https://agent.example.test/callback?code=x&state=y'
  deviceStatus: 'approved' | 'denied' = 'approved'
  /** Failures by exact path, each used once unless `sticky`. */
  readonly failures = new Map<string, Failure & { readonly sticky?: boolean }>()
  /** When set, the view's `expiresAt` is this many milliseconds after the moment it is served. */
  expiresInMs: number | undefined = undefined
  /** Answers held back until the promise settles, by exact path. */
  readonly holds = new Map<string, Promise<unknown>>()
  /** The decision needs a fresh proof until the authenticator code was given. */
  needsProof = false
  readonly sent: Sent[] = []
  me: Record<string, unknown> = {
    identity: {
      id: 'idn_01JZ0000000000000000000000',
      kind: 'human',
      state: 'active',
      label: 'owner',
      displayName: 'Ada',
      email: 'owner@example.test',
    },
    session: {},
    bindings: [],
    effectivePermissions: [],
  }

  paths(): string[] {
    return this.sent.map((s) => s.path)
  }

  bodiesOf(path: string): unknown[] {
    return this.sent.filter((s) => s.path === path).map((s) => s.body)
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function answer(world: OAuthWorld, path: string, body: unknown): Response {
  const failure = world.failures.get(path)
  if (failure !== undefined) {
    if (failure.sticky !== true) world.failures.delete(path)
    return json(failure.status, {
      code: failure.code,
      message: failure.message ?? `${failure.code} happened.`,
    })
  }
  switch (path) {
    case '/api/v1/me':
      return json(200, world.me)
    case '/auth/oauth/consent/view':
    case '/auth/oauth/device/view':
      return json(
        200,
        world.expiresInMs === undefined
          ? world.view
          : { ...world.view, expiresAt: new Date(Date.now() + world.expiresInMs).toISOString() },
      )
    case '/auth/oauth/consent':
      if (world.needsProof) {
        return json(403, { code: 'REAUTH_REQUIRED', message: 'Confirm it is you.' })
      }
      return json(200, { redirectTo: world.redirectTo })
    case '/auth/oauth/device':
      if (world.needsProof) {
        return json(403, { code: 'REAUTH_REQUIRED', message: 'Confirm it is you.' })
      }
      return json(200, { status: world.deviceStatus })
    case '/auth/reauth/totp': {
      const code = (body as { code?: string } | undefined)?.code
      if (code !== '123456') {
        return json(400, { code: 'REAUTH_FAILED', message: 'The proof was not accepted.' })
      }
      world.needsProof = false
      return json(200, { reauthenticatedAt: new Date().toISOString() })
    }
    default:
      return json(404, { code: 'NOT_FOUND', message: 'Not found.' })
  }
}

export interface Mounted {
  readonly router: ReturnType<typeof createRouter<typeof routeTree>>
  readonly history: ReturnType<typeof createMemoryHistory>
  readonly queryClient: QueryClient
  /** Called when the API client finds the session gone. */
  readonly onSessionGone: () => void
}

export function mountApp(initialPath: string, world: OAuthWorld): Mounted {
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
    world.sent.push({ path: `${url.pathname}${url.search}`, body })
    await world.holds.get(url.pathname)
    return answer(world, url.pathname, body)
  })
  const onSessionGone = vi.fn()
  const client = new ApiClient({
    fetch: fetchFn as unknown as typeof fetch,
    cookies: () => '__Host-exdb_csrf=t',
    onSessionGone,
  })
  const history = createMemoryHistory({ initialEntries: [initialPath] })
  const router = createRouter({ routeTree, history })
  const queryClient = createQueryClient()
  render(
    <AppProviders
      services={{
        queryClient,
        client,
        reauth: createReauthBridge(),
        navigate: (to, options) =>
          void router.navigate({ href: to, replace: options?.replace === true }),
      }}
    >
      <RouterProvider router={router} />
    </AppProviders>,
  )
  return { router, history, queryClient, onSessionGone }
}

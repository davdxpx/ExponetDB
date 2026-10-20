import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { configure, render } from '@testing-library/react'
import { vi } from 'vitest'
import { AppProviders } from '../../src/app/providers.tsx'
import { createReauthBridge } from '../../src/features/reauth/reauth.tsx'
import type { ResponseOf } from '../../src/lib/api/client.ts'
import { ApiClient } from '../../src/lib/api/client.ts'
import { createQueryClient } from '../../src/lib/query/client.ts'
import { routeTree } from '../../src/routeTree.gen.ts'
import { answer, type FailureSpec, NOW_ISO, project, World } from '../target/support.tsx'

export { NOW_ISO, project, World }

/**
 * A fake server for the Connections and Locks pages on top of the target
 * `World`: sessions, the lock graph, cluster endpoints and the raw statement
 * view (with `REAUTH_REQUIRED` until the authenticator proof `123456` is
 * given). Everything it does not know is answered by the target fake (a 404),
 * so a request a page should not make is visible in `requests`.
 */
configure({ asyncUtilTimeout: 5_000 })
vi.setConfig({ testTimeout: 30_000 })

export type SessionList = ResponseOf<'listSessions'>
export type Session = SessionList['sessions'][number]
export type LockGraph = ResponseOf<'getLockGraph'>
export type RawStatement = ResponseOf<'getRawStatement'>

export const BIDI = String.fromCodePoint(0x202e)
export const ZWSP = String.fromCodePoint(0x200b)
export const TAG = String.fromCodePoint(0xe0041, 0xe0042)
export const DIGEST = `sha256:${'ab'.repeat(32)}`
export const SECRET_TEXT = 'select secret_marker_9 from vault'
export const CLUSTER = 'cls_01M4S9000000000000000000AF'

export function session(over: Partial<Session> = {}): Session {
  return {
    pid: 101,
    role: 'app_rw',
    applicationName: 'shop-api',
    backendStart: '2026-10-13T08:00:00.000Z',
    state: 'idle',
    stateAgeMs: 2_000,
    transactionAgeMs: null,
    queryAgeMs: null,
    queryStart: null,
    waitEvent: null,
    statement: null,
    exponetdbOperationId: null,
    ...over,
  }
}

export function sessionList(
  sessions: readonly Session[],
  over: Partial<SessionList> = {},
): SessionList {
  return {
    targetId: 'tgt_00000000000000000000000001',
    source: 'live',
    observedAt: NOW_ISO(),
    cap: 500,
    truncated: false,
    sessions: [...sessions],
    ...over,
  }
}

export function lockGraph(waits: LockGraph['waits'], over: Partial<LockGraph> = {}): LockGraph {
  return {
    targetId: 'tgt_00000000000000000000000001',
    source: 'live',
    observedAt: NOW_ISO(),
    truncated: false,
    waits,
    ...over,
  }
}

export function wait(over: Partial<LockGraph['waits'][number]> = {}): LockGraph['waits'][number] {
  return {
    waitingPid: 202,
    blockingPids: [101],
    lockMode: 'RowExclusiveLock',
    relation: 'public.orders',
    waitingSince: new Date(Date.now() - 12_000).toISOString(),
    exponetdbOperationId: null,
    ...over,
  }
}

export class DiagnosticsWorld extends World {
  sessions: SessionList | undefined
  /**
   * What the target answers when the sessions are asked for with a filter (`state`, `application`
   * or `minAgeSeconds`): the unfiltered list is `sessions`, a filtered one comes from here. Without
   * it every request gets `sessions`.
   */
  sessionsFor: ((query: URLSearchParams) => SessionList) | undefined
  locks: LockGraph | undefined
  endpoints: ResponseOf<'listClusterEndpoints'> | undefined
  raw: RawStatement | undefined
  /** The refusal the raw view answers with (after the re-authentication check). */
  rawError: { status: number; code: string; message?: string; details?: unknown } | undefined
  reauthNeeded = false
  fresh = false
  readonly rawRequests: string[] = []
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function respond(world: DiagnosticsWorld, input: string, body: unknown): Response {
  const url = new URL(input, 'http://localhost')
  const request = `${url.pathname}${url.search}`
  const failure: FailureSpec | undefined = [...world.failures].find(([part]) =>
    request.includes(part),
  )?.[1]
  const isDiagnostic =
    /\/sessions$|\/locks$|\/endpoints$|\/statements\//.test(url.pathname) ||
    url.pathname === '/auth/reauth/totp'
  if (!isDiagnostic) return answer(world, input)
  world.requests.push(request)
  if (failure !== undefined) {
    return json(failure.status, {
      code: failure.code,
      message: failure.message ?? `${failure.code} happened.`,
    })
  }
  if (url.pathname === '/auth/reauth/totp') {
    if ((body as { code?: string } | undefined)?.code === '123456') {
      world.fresh = true
      return json(200, { reauthenticatedAt: new Date().toISOString() })
    }
    return json(400, { code: 'REAUTH_FAILED', message: 'The proof was not accepted.' })
  }
  if (url.pathname.endsWith('/sessions')) {
    const filtered =
      url.searchParams.has('state') ||
      url.searchParams.has('application') ||
      url.searchParams.has('minAgeSeconds')
    if (filtered && world.sessionsFor !== undefined) {
      return json(200, world.sessionsFor(url.searchParams))
    }
    return world.sessions === undefined
      ? json(404, { code: 'NOT_FOUND', message: 'Not found.' })
      : json(200, world.sessions)
  }
  if (url.pathname.endsWith('/locks')) {
    return world.locks === undefined
      ? json(404, { code: 'NOT_FOUND', message: 'Not found.' })
      : json(200, world.locks)
  }
  if (url.pathname.endsWith('/endpoints')) {
    return world.endpoints === undefined
      ? json(404, { code: 'NOT_FOUND', message: 'Not found.' })
      : json(200, world.endpoints)
  }
  world.rawRequests.push(request)
  if (world.reauthNeeded && !world.fresh) {
    return json(403, { code: 'REAUTH_REQUIRED', message: 'Confirm it is you.' })
  }
  if (world.rawError !== undefined) {
    return json(world.rawError.status, {
      code: world.rawError.code,
      message: world.rawError.message ?? `${world.rawError.code} happened.`,
      details: world.rawError.details,
    })
  }
  return world.raw === undefined
    ? json(404, { code: 'NOT_FOUND', message: 'Not found.' })
    : json(200, world.raw)
}

export function mountDiagnostics(initialPath: string, world: DiagnosticsWorld) {
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const text = String(input)
    for (const [part, held] of world.delays) {
      if (text.includes(part)) await held
    }
    let body: unknown
    if (typeof init?.body === 'string') body = JSON.parse(init.body)
    return respond(world, text, body)
  })
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
  render(
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
  return { router, queryClient, fetchFn }
}

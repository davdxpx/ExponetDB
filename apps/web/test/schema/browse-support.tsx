import type { QueryResult, SchemaObject } from '@exponetdb/sdk/operations'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { configure, render } from '@testing-library/react'
import { vi } from 'vitest'
import { AppProviders } from '../../src/app/providers.tsx'
import { createReauthBridge } from '../../src/features/reauth/reauth.tsx'
import { ApiClient, type ResponseOf } from '../../src/lib/api/client.ts'
import { createQueryClient } from '../../src/lib/query/client.ts'
import { routeTree } from '../../src/routeTree.gen.ts'
import {
  answerMore,
  World as OverviewWorld,
  objectFixture,
  ref,
} from '../target-overview/support.tsx'

export {
  BIDI,
  fingerprintFixture,
  objectFixture,
  overviewFixture,
  project,
  ref,
  ZWSP,
} from '../target-overview/support.tsx'

/**
 * The fake server of the row browser: the schema reads of the overview
 * support, the data-read endpoint with the method and body of every request
 * recorded, the policy settings, and the grants of the person with their
 * scopes. A path nobody set up answers 404, so a request that should not be
 * made shows.
 */
configure({ asyncUtilTimeout: 5_000 })
vi.setConfig({ testTimeout: 30_000 })

type Grant = ResponseOf<'getMe'>['effectivePermissions'][number]

export interface Sent {
  readonly method: string
  readonly path: string
  readonly body: unknown
}

export interface Answer {
  readonly status: number
  readonly body: unknown
}

export interface RunBody {
  readonly sql: string
  readonly params?: readonly unknown[]
  readonly queryId: string
}

export class BrowseWorld extends OverviewWorld {
  readonly sent: Sent[] = []
  /** The data-read answer for a request; the default is one page of the orders. */
  run: (body: RunBody, call: number) => Answer = (body) => ({
    status: 200,
    body: resultFixture({ queryId: body.queryId }),
  })
  /** The body of `GET /policy-settings`; absent answers 404. */
  policy: unknown
  /** The grants of the person with their scopes; absent keeps the world's permissions with no scope. */
  grants: Grant[] | undefined

  runs(): Sent[] {
    return this.sent.filter((s) => s.method === 'POST' && s.path.endsWith('/queries'))
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export function mountBrowse(initialPath: string, world: BrowseWorld) {
  let calls = 0
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    world.sent.push({ method, path: `${url.pathname}${url.search}`, body })
    for (const [part, held] of world.delays) {
      if (`${url.pathname}${url.search}`.includes(part)) await held
    }
    if (method === 'POST' && /^\/api\/v1\/targets\/[^/]+\/queries$/.test(url.pathname)) {
      world.requests.push(url.pathname)
      calls += 1
      const answer = world.run(body as RunBody, calls)
      return json(answer.status, answer.body)
    }
    if (method === 'GET' && url.pathname === '/api/v1/policy-settings') {
      world.requests.push(url.pathname)
      return world.policy === undefined
        ? json(404, { code: 'NOT_FOUND', message: 'Not found.' })
        : json(200, world.policy)
    }
    if (url.pathname === '/api/v1/me' && world.grants !== undefined) {
      const base = (await answerMore(world, input).json()) as Record<string, unknown>
      return json(200, { ...base, effectivePermissions: world.grants })
    }
    return answerMore(world, input)
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
  return { router, fetchFn, queryClient }
}

// ----- fixtures -----

export const GLOBAL_GRANT: Grant = { permission: 'data.read', scopes: [{ kind: 'global' }] }

const COLUMNS: QueryResult['columns'] = [
  { name: 'id', type: 'uuid', masked: false },
  { name: 'status', type: 'text', masked: false },
  { name: 'total', type: 'numeric', masked: false },
]

/** `n` rows of the orders with ids `u-<from>` and up, zero-padded so that they sort as text. */
export function orderRows(n: number, from = 1): string[][] {
  return Array.from({ length: n }, (_, i) => [
    `u-${String(from + i).padStart(5, '0')}`,
    i % 2 === 0 ? 'paid' : 'open',
    String(10 + i),
  ])
}

export function resultFixture(over: Partial<QueryResult> = {}): QueryResult {
  const rows = over.rows ?? orderRows(3)
  return {
    queryId: 'qry_01M4V3RV9F5XM2TB8KC6QZJ0NS',
    columns: COLUMNS,
    rows,
    rowCount: rows.length,
    truncated: false,
    truncation: null,
    rlsRelations: [],
    durationMs: 7,
    statementDigest: `sha256:${'ab'.repeat(32)}`,
    ...over,
  } as QueryResult
}

function column(name: string, type: string) {
  return { name, type, nullable: false, default: null, generated: null, identity: null }
}

/** The orders table: uuid key `id`, `status` text, `total` numeric, a foreign key to `users`. */
export function ordersObject(over: Partial<SchemaObject> = {}): SchemaObject {
  return objectFixture(ref({ name: 'orders' }), {
    columns: [
      column('id', 'uuid'),
      column('status', 'text'),
      column('total', 'numeric'),
      column('user_id', 'uuid'),
    ],
    constraints: [
      { name: 'orders_pk', type: 'primary_key', definition: 'PRIMARY KEY (id)', validated: true },
      {
        name: 'orders_user_fk',
        type: 'foreign_key',
        definition: 'FOREIGN KEY (user_id) REFERENCES public.users(id)',
        validated: true,
      },
      { name: 'orders_sku', type: 'unique', definition: 'UNIQUE (status)', validated: true },
    ],
    indexes: [],
    policies: [],
    grants: [],
    ...over,
  })
}

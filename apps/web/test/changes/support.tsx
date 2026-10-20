import type { MigrationStream, OperationRead, Project } from '@exponetdb/sdk/operations'
import type { QueryClient } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { render } from '@testing-library/react'
import { vi } from 'vitest'
import { AppProviders } from '../../src/app/providers.tsx'
import { createReauthBridge } from '../../src/features/reauth/reauth.tsx'
import { ApiClient } from '../../src/lib/api/client.ts'
import { createQueryClient } from '../../src/lib/query/client.ts'
import { routeTree } from '../../src/routeTree.gen.ts'
import { answer, operationFor, type Sent, World } from '../plans/support.tsx'

export {
  BIDI,
  HASH,
  hostileItem,
  hostilePlan,
  IDENTITY,
  OP,
  operationFor,
  PLAN,
  SHY,
  TAG,
  TARGET,
  World,
  ZWSP,
} from '../plans/support.tsx'

/**
 * A fake server for the Changes screens: the plan review fake of
 * `test/plans/support.tsx` plus the operations list (with cursor pages), the
 * cancel of an operation, the projects and the migration stream of a project.
 * Requests whose `METHOD path` contains a part of `held` are never answered,
 * so a test can see a page while a read is in flight.
 */
export const OP2 = 'op_01M4S9000000000000000000AB'
export const OP3 = 'op_01M4S9000000000000000000AC'
export const PROJECT = 'prj_01M4S9000000000000000000AF'
export const PROJECT2 = 'prj_01M4S9000000000000000000AG'

export class ChangesWorld extends World {
  /** Pages of `GET /operations`, by cursor (`''` is the first page). */
  readonly operationPages = new Map<string, { items: OperationRead[]; nextCursor: string | null }>()
  projects: Project[] = []
  readonly streams = new Map<string, MigrationStream>()
  /** Parts of `METHOD path` that are never answered. */
  readonly held = new Set<string>()
  cancelAnswer: (operationId: string) => OperationRead = (operationId) =>
    operationFor(operationId, { state: 'canceled' })
  /** The plan `POST /targets/{t}/migrations/plans` answers with (the plan page opens). */
  migrationPlanAnswer: (target: string) => unknown = () => ({ id: PLAN_ID })
}

const PLAN_ID = 'pln_01M4S9000000000000000000AA'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function changesAnswer(world: ChangesWorld, sent: Sent): Response | Promise<Response> {
  const { method, path } = sent
  for (const part of world.held) {
    if (`${method} ${path}`.includes(part)) return new Promise<Response>(() => {})
  }
  for (const [part, failure] of world.failures) {
    if (`${method} ${path}`.includes(part)) {
      return json(failure.status, {
        code: failure.code,
        message: failure.message ?? `${failure.code} happened.`,
      })
    }
  }
  const url = new URL(path, 'http://localhost')
  const p = url.pathname
  if (p === '/api/v1/operations' && method === 'GET') {
    const page = world.operationPages.get(url.searchParams.get('cursor') ?? '')
    return json(200, page ?? { items: [], nextCursor: null })
  }
  let m = /^\/api\/v1\/operations\/([^/]+)\/cancel$/.exec(p)
  if (m !== null && method === 'POST' && !world.needsProof()) {
    return json(200, world.cancelAnswer(decodeURIComponent(m[1] ?? '')))
  }
  if (p === '/api/v1/projects' && method === 'GET') {
    return json(200, { items: world.projects, nextCursor: null })
  }
  m = /^\/api\/v1\/projects\/([^/]+)\/migrations$/.exec(p)
  if (m !== null && method === 'GET') {
    const stream = world.streams.get(decodeURIComponent(m[1] ?? ''))
    return stream === undefined
      ? json(404, { code: 'PROJECT_NOT_FOUND', message: 'No such project.' })
      : json(200, stream)
  }
  m = /^\/api\/v1\/targets\/([^/]+)\/migrations\/plans$/.exec(p)
  if (m !== null && method === 'POST' && !world.needsProof()) {
    return json(201, world.migrationPlanAnswer(decodeURIComponent(m[1] ?? '')))
  }
  return answer(world, sent)
}

export interface Mounted {
  readonly router: ReturnType<typeof createRouter>
  readonly queryClient: QueryClient
}

export function mountChanges(initialPath: string, world: ChangesWorld): Mounted {
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const sent: Sent = {
      method: init?.method ?? 'GET',
      path: String(input),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      csrf: headers['x-csrf-token'],
    }
    world.sent.push(sent)
    world.onRequest(sent)
    return changesAnswer(world, sent)
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
        navigate: (to, options) =>
          void router.navigate({ href: to, replace: options?.replace === true }),
      }}
    >
      <RouterProvider router={router} />
    </AppProviders>,
  )
  return { router: router as unknown as Mounted['router'], queryClient }
}

export function project(id: string, path: string): Project {
  return {
    id,
    path,
    slug: path.split('/').at(-1) ?? 'platform',
    displayName: path,
    productId: 'prd_01M4S9000000000000000000AH',
    revision: 1,
    evidenceOverride: {},
    managedScope: { schemas: ['public'] },
  } as unknown as Project
}

export const M1 = '01M4S9000000000000000000M1'
export const M2 = '01M4S9000000000000000000M2'

export function stream(over: Partial<MigrationStream> = {}): MigrationStream {
  const target = (slug: string, tier: 'prod' | 'nonprod') => ({
    id: `tgt_01M4S9000000000000000000${slug === 'staging' ? 'S1' : 'P1'}`,
    path: `shop/platform/${slug}`,
    generation: 1,
    lifecycle: 'active',
    tier,
  })
  return {
    projectId: PROJECT,
    source: 'cached',
    observedAt: new Date().toISOString(),
    truncated: false,
    bundleCount: 2,
    baselines: [],
    heads: [M2],
    graph: { valid: true, errors: [] },
    environments: [
      {
        slug: 'production',
        displayName: 'Production',
        tier: 'prod',
        rank: 2,
        evidenceFrom: 'staging',
        target: target('production', 'prod'),
        mirror: null,
      },
      {
        slug: 'staging',
        displayName: 'Staging',
        tier: 'nonprod',
        rank: 1,
        evidenceFrom: null,
        target: target('staging', 'nonprod'),
        mirror: null,
      },
    ],
    bundles: [
      {
        migrationId: M2,
        name: 'add_notes',
        revision: 1,
        checksum: `sha256:c1:${'ab'.repeat(32)}`,
        dependsOn: [M1],
        // Production holds nothing for this bundle: the cell is absent.
        states: [
          {
            environment: 'staging',
            state: 'applied',
            appliedAt: '2026-10-13T08:00:00.000Z',
            checksum: null,
            checksumMatches: true,
            observedAt: '2026-10-13T08:01:00.000Z',
            verification: null,
          },
        ],
      },
      {
        migrationId: M1,
        name: 'create_accounts',
        revision: 1,
        checksum: `sha256:c1:${'cd'.repeat(32)}`,
        dependsOn: [],
        states: [
          {
            environment: 'staging',
            state: 'verified',
            appliedAt: '2026-10-12T08:00:00.000Z',
            checksum: null,
            checksumMatches: true,
            observedAt: '2026-10-13T08:01:00.000Z',
            verification: { status: 'passed', verifiedAt: '2026-10-12T08:02:00.000Z' },
          },
          {
            environment: 'production',
            state: 'divergent',
            appliedAt: '2026-10-12T09:00:00.000Z',
            checksum: null,
            checksumMatches: true,
            observedAt: '2026-10-13T08:01:00.000Z',
            verification: null,
          },
        ],
      },
    ],
    ...over,
  } as unknown as MigrationStream
}

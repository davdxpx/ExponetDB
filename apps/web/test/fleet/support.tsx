import type {
  Cluster,
  DatabaseView,
  Environment,
  Fleet,
  FleetFinding,
  InstallationHealth,
  Product,
  Project,
  TargetSummary,
} from '@exponetdb/sdk/operations'
import type { QueryClient } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { configure, render } from '@testing-library/react'
import { vi } from 'vitest'
import { AppProviders } from '../../src/app/providers.tsx'
import { createReauthBridge } from '../../src/features/reauth/reauth.tsx'
import { ApiClient } from '../../src/lib/api/client.ts'
import { createQueryClient } from '../../src/lib/query/client.ts'
import { routeTree } from '../../src/routeTree.gen.ts'

/**
 * A fake server for the fleet overview, the targets list and the
 * registration page, and a way to mount the real route tree on it. It
 * answers from a `World` the test changes between steps, records every
 * request, and answers anything it does not know with a 404, so a request a
 * page should not make (a health read per row, say) is visible.
 */
configure({ asyncUtilTimeout: 5_000 })
vi.setConfig({ testTimeout: 30_000 })

export const BIDI = String.fromCodePoint(0x202e)
export const ZWSP = String.fromCodePoint(0x200b)
export const TAG = String.fromCodePoint(0xe0041, 0xe0042)

export const iso = (msAgo = 0): string => new Date(Date.now() - msAgo).toISOString()

export interface FailureSpec {
  readonly status: number
  readonly code: string
  readonly message?: string
}

export interface Sent {
  readonly method: string
  readonly path: string
  readonly body: unknown
}

export const IDENTITY = 'idn_01M4S9000000000000000000AD'
export const CLUSTER = 'cls_01M4S9000000000000000000AF'
export const PLAN = 'pln_01M4S9000000000000000000AA'

export function fleetFixture(over: Partial<Fleet> = {}): Fleet {
  return {
    asOf: iso(),
    targets: {
      total: 7,
      decommissioned: 2,
      byTier: { prod: 3, nonprod: 4 },
      byHealth: { healthy: 3, degraded: 1, unhealthy: 1, unreachable: 0, unknown: 2, suspended: 0 },
      bySource: { sampled: 4, cached: 1, inferred: 2 },
      lowerBound: false,
      lowerBoundReason: null,
      observedAt: iso(),
      oldestSampleAt: iso(5 * 60_000),
      source: 'sampled',
    },
    findings: {
      available: true,
      open: 9,
      bySeverity: { critical: 2, warning: 3, info: 4 },
      lowerBound: false,
      lowerBoundReason: null,
      observedAt: iso(),
      source: 'live',
    },
    operations: {
      available: true,
      awaiting_approval: 1,
      running: 2,
      needs_attention: 3,
      lowerBound: false,
      lowerBoundReason: null,
      observedAt: iso(),
      source: 'live',
    },
    ...over,
  } as Fleet
}

export function targetFixture(path: string, over: Partial<TargetSummary> = {}): TargetSummary {
  return {
    id: `tgt_${path
      .replace(/[^a-z0-9]/gi, '')
      .padEnd(26, '0')
      .slice(0, 26)
      .toUpperCase()}`,
    path,
    productId: 'prd_00000000000000000000000001',
    projectId: 'prj_00000000000000000000000001',
    environmentId: 'env_00000000000000000000000001',
    tier: 'nonprod',
    state: 'active',
    generation: 1,
    health: { state: 'healthy', source: 'sampled', observedAt: iso(5 * 60_000) },
    ...over,
  }
}

export function findingFixture(path: string, over: Partial<FleetFinding> = {}): FleetFinding {
  return {
    id: 'fnd_01M4S9000000000000000000A1',
    code: 'DRIFT_DETECTED',
    kind: 'drift',
    severity: 'critical',
    state: 'open',
    summary: 'The schema differs from the baseline.',
    object: null,
    occurrences: 1,
    firstSeenAt: iso(3_600_000),
    lastSeenAt: iso(60_000),
    resolution: null,
    resolvedAt: null,
    securityRelevant: false,
    subject: { targetId: 'tgt_01M4S9000000000000000000AC', clusterId: null, nodeId: null },
    targetId: 'tgt_01M4S9000000000000000000AC',
    targetPath: path,
    ...over,
  }
}

export function healthFixture(over: Partial<InstallationHealth> = {}): InstallationHealth {
  return {
    state: 'operational',
    observedAt: iso(),
    components: [
      {
        component: 'control-store',
        state: 'operational',
        source: 'live',
        observedAt: iso(),
      },
    ],
    ...over,
  }
}

export class World {
  fleet: Fleet = fleetFixture()
  findings: FleetFinding[] = []
  findingsNextCursor: string | null = null
  controlPlane: InstallationHealth = healthFixture()
  /** Pages of the target list; the cursor of page n is `c<n+1>`. */
  targetPages: TargetSummary[][] = [[]]
  products: Product[] = [
    { id: 'prd_01M4S9000000000000000000P1', slug: 'shop', displayName: 'Shop' },
  ]
  projects: Project[] = [
    {
      id: 'prj_01M4S9000000000000000000J1',
      productId: 'prd_01M4S9000000000000000000P1',
      slug: 'platform',
      displayName: 'Platform',
      path: 'shop/platform',
      revision: 1,
      evidenceOverride: {},
      managedScope: { kind: 'all' } as unknown as Project['managedScope'],
    },
  ]
  environments: Environment[] = [
    {
      id: 'env_01M4S9000000000000000000E1',
      productId: 'prd_01M4S9000000000000000000P1',
      slug: 'staging',
      displayName: 'Staging',
      tier: 'nonprod',
      rank: 1,
      revision: 1,
      evidenceFrom: null,
    },
    {
      id: 'env_01M4S9000000000000000000E2',
      productId: 'prd_01M4S9000000000000000000P1',
      slug: 'production',
      displayName: 'Production',
      tier: 'prod',
      rank: 2,
      revision: 1,
      evidenceFrom: 'staging',
    },
  ]
  clusters: Cluster[] = [
    {
      id: CLUSTER,
      displayName: 'Main cluster',
      state: 'active',
      managementMode: 'agent',
      derivedTier: 'nonprod',
      declaredTier: 'nonprod',
      confirmedAt: iso(),
      health: null,
      postgresVersion: '17.2',
      serverId: null,
      systemIdentifier: null,
    },
  ]
  databases: DatabaseView[] = [
    {
      id: 'dbs_01M4S9000000000000000000D1',
      clusterId: CLUSTER,
      name: 'orders',
      state: 'registered',
      createdAt: iso(),
      observed: null,
      placement: null,
    },
    {
      id: 'dbs_01M4S9000000000000000000D2',
      clusterId: CLUSTER,
      name: 'taken',
      state: 'registered',
      createdAt: iso(),
      observed: null,
      placement: { generation: 1, targetId: 'tgt_01M4S9000000000000000000AC' },
    },
  ]
  /** Reads that fail, by a substring of `METHOD path` (first match wins). */
  readonly failures = new Map<string, FailureSpec>()
  /** Reads held back until the promise settles, by a substring of the path. */
  readonly delays = new Map<string, Promise<unknown>>()
  readonly sent: Sent[] = []

  firstCluster(): Cluster {
    const cluster = this.clusters[0]
    if (cluster === undefined) throw new Error('no cluster in the world')
    return cluster
  }

  /** The requests that were not the session read. */
  get apiRequests(): Sent[] {
    return this.sent.filter((s) => s.path !== '/api/v1/me')
  }

  gets(part: string): Sent[] {
    return this.sent.filter((s) => s.method === 'GET' && s.path.includes(part))
  }

  posts(part: string): Sent[] {
    return this.sent.filter((s) => s.method === 'POST' && s.path.includes(part))
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const NOT_FOUND = () => json(404, { code: 'NOT_FOUND', message: 'Not found.' })

function me() {
  return {
    identity: {
      id: IDENTITY,
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
}

export function planBody(id = PLAN) {
  return {
    id,
    kind: 'target.register',
    class: 'standard',
    state: 'open',
    subject: {
      targetId: null,
      targetPath: null,
      clusterId: CLUSTER,
      nodeId: null,
      tier: 'nonprod',
    },
  }
}

export function answer(world: World, sent: Sent): Response {
  const { method, path } = sent
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
  if (p === '/api/v1/me') return json(200, me())
  if (method === 'GET' && p === '/api/v1/fleet') return json(200, world.fleet)
  if (method === 'GET' && p === '/api/v1/findings') {
    return json(200, { items: world.findings, nextCursor: world.findingsNextCursor })
  }
  if (method === 'GET' && p === '/api/v1/installation/health') return json(200, world.controlPlane)
  if (method === 'GET' && p === '/api/v1/targets') {
    const cursor = url.searchParams.get('cursor')
    const index = cursor === null ? 0 : Number(cursor.slice(1))
    const items = world.targetPages[index] ?? []
    const more = index + 1 < world.targetPages.length
    return json(200, { items, nextCursor: more ? `c${index + 1}` : null })
  }
  if (method === 'POST' && p === '/api/v1/targets') return json(201, planBody())
  if (method === 'GET' && p === '/api/v1/products') {
    return json(200, { items: world.products, nextCursor: null })
  }
  if (method === 'GET' && p === '/api/v1/projects') {
    return json(200, { items: world.projects, nextCursor: null })
  }
  let m = /^\/api\/v1\/products\/([^/]+)\/environments$/.exec(p)
  if (m !== null && method === 'GET') {
    return json(200, {
      items: world.environments.filter((e) => e.productId === decodeURIComponent(m?.[1] ?? '')),
      nextCursor: null,
    })
  }
  if (method === 'GET' && p === '/api/v1/clusters') {
    return json(200, { items: world.clusters, nextCursor: null })
  }
  m = /^\/api\/v1\/clusters\/([^/]+)\/databases$/.exec(p)
  if (m !== null && method === 'GET') {
    return json(200, {
      items: world.databases.filter((d) => d.clusterId === decodeURIComponent(m?.[1] ?? '')),
      truncated: false,
    })
  }
  m = /^\/api\/v1\/plans\/([^/]+)$/.exec(p)
  if (m !== null && method === 'GET') return NOT_FOUND()
  return NOT_FOUND()
}

export interface Mounted {
  readonly router: ReturnType<typeof createRouter>
  readonly queryClient: QueryClient
}

export function mountApp(initialPath: string, world: World): Mounted {
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const sent: Sent = {
      method: init?.method ?? 'GET',
      path: String(input),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    world.sent.push(sent)
    const held = [...world.delays].find(([part]) => sent.path.includes(part))
    if (held !== undefined) await held[1]
    return answer(world, sent)
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

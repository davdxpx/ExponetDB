import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { render } from '@testing-library/react'
import { vi } from 'vitest'
import { AppProviders } from '../../src/app/providers.tsx'
import { createReauthBridge } from '../../src/features/reauth/reauth.tsx'
import type { Target, TargetHealth } from '../../src/features/target/queries.ts'
import { ApiClient, type ResponseOf } from '../../src/lib/api/client.ts'
import { createQueryClient } from '../../src/lib/query/client.ts'
import { routeTree } from '../../src/routeTree.gen.ts'

/**
 * A fake server for the target pages and a way to mount the real route tree
 * on it. The fake answers the four reads the target pages make (`getMe`,
 * `getTarget`, `listTargets`, `getTargetHealth`) from a `World` the test
 * changes between steps, records every request it receives, and answers
 * anything else with a 404, so a request a page should not make is visible.
 */
export const NOW_ISO = (): string => new Date().toISOString()

export type Permission = ResponseOf<'getMe'>['effectivePermissions'][number]['permission']

export interface FailureSpec {
  readonly status: number
  readonly code: string
  readonly message?: string
}

export class World {
  readonly targets = new Map<string, Target>()
  readonly health = new Map<string, TargetHealth>()
  permissions: Permission[] = []
  /** Reads that fail, by a substring of the request path (first match wins). */
  readonly failures = new Map<string, FailureSpec>()
  /** Reads held back until the promise settles, by a substring of the request path. */
  readonly delays = new Map<string, Promise<unknown>>()
  /** The cursor `listTargets` answers with (a longer list than one read returns). */
  nextCursor: string | null = null
  /** The body `listTargets` answers with, instead of the targets of the world. */
  listOverride: unknown
  /** The requests received, as `path?query`. */
  readonly requests: string[] = []
  private nextId = 1

  /** Adds a target and returns it. `tier` is the field the page must trust, not the slug. */
  add(path: string, over: Partial<Target> = {}): Target {
    const [, , environment = ''] = path.split('/')
    const tier = over.tier ?? 'nonprod'
    const n = String(this.nextId++).padStart(26, '0')
    const target: Target = {
      id: `tgt_${n}`,
      path,
      productId: 'prd_00000000000000000000000001',
      projectId: 'prj_00000000000000000000000001',
      environmentId: `env_${n}`,
      tier,
      state: 'active',
      generation: 1,
      health: null,
      environment: { slug: environment, tier },
      placement: null,
      ledger: null,
      openFindingCount: 0,
      ...over,
    }
    this.targets.set(path, target)
    return target
  }

  /** Changes fields of a target that is already there. */
  update(path: string, over: Partial<Target>): Target {
    const current = this.targets.get(path)
    if (current === undefined) throw new Error(`no target ${path} in the world`)
    const next: Target = { ...current, ...over }
    this.targets.set(path, next)
    return next
  }

  /** Adds the health sample of a target. */
  sample(path: string, over: Partial<TargetHealth> = {}): TargetHealth {
    const target = this.targets.get(path)
    const sample: TargetHealth = {
      targetId: target?.id ?? 'tgt_00000000000000000000000000',
      lifecycle: 'active',
      state: 'healthy',
      source: 'sampled',
      observedAt: NOW_ISO(),
      conditions: [],
      unknownBecause: null,
      probes: [],
      node: null,
      backups: null,
      ...over,
    }
    this.health.set(path, sample)
    return sample
  }

  /** The requests that were not the session read. */
  get apiRequests(): string[] {
    return this.requests.filter((request) => request !== '/api/v1/me')
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function me(world: World) {
  return {
    identity: {
      id: 'idn_00000000000000000000000001',
      kind: 'human',
      state: 'active',
      label: 'owner',
      displayName: 'Ada',
      email: 'owner@example.test',
    },
    session: {},
    bindings: [],
    effectivePermissions: world.permissions.map((permission) => ({ permission, scopes: [] })),
  }
}

function summaryOf(target: Target) {
  return {
    id: target.id,
    path: target.path,
    productId: target.productId,
    projectId: target.projectId,
    environmentId: target.environmentId,
    tier: target.tier,
    state: target.state,
    generation: target.generation,
    health: target.health,
  }
}

export function answer(world: World, input: string | URL | Request): Response {
  const url = new URL(String(input), 'http://localhost')
  const request = `${url.pathname}${url.search}`
  world.requests.push(request)
  for (const [part, failure] of world.failures) {
    if (request.includes(part)) {
      return json(failure.status, {
        code: failure.code,
        message: failure.message ?? `${failure.code} happened.`,
      })
    }
  }
  if (url.pathname === '/api/v1/me') return json(200, me(world))
  if (url.pathname === '/api/v1/targets') {
    const product = url.searchParams.get('product')
    const project = url.searchParams.get('project')
    const items = [...world.targets.values()]
      .filter((target) => {
        const [p, q] = target.path.split('/')
        return (product === null || p === product) && (project === null || q === project)
      })
      .map(summaryOf)
    return json(200, world.listOverride ?? { items, nextCursor: world.nextCursor })
  }
  const detail = /^\/api\/v1\/targets\/([^/]+)$/.exec(url.pathname)
  if (detail?.[1] !== undefined) {
    const target = world.targets.get(decodeURIComponent(detail[1]))
    return target === undefined
      ? json(404, { code: 'TARGET_NOT_FOUND', message: 'No such target is visible to the caller.' })
      : json(200, target)
  }
  const healthOf = /^\/api\/v1\/targets\/([^/]+)\/health$/.exec(url.pathname)
  if (healthOf?.[1] !== undefined) {
    const sample = world.health.get(decodeURIComponent(healthOf[1]))
    return sample === undefined
      ? json(404, { code: 'TARGET_NOT_FOUND', message: 'No such target is visible to the caller.' })
      : json(200, sample)
  }
  return json(404, { code: 'NOT_FOUND', message: 'Not found.' })
}

export function mountApp(initialPath: string, world: World) {
  const fetchFn = vi.fn(async (input: string | URL | Request) => {
    const request = String(input)
    for (const [part, held] of world.delays) {
      if (request.includes(part)) await held
    }
    return answer(world, input)
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

/** A `Readable`-friendly way to build the targets of one project. */
export function project(world: World, product = 'shop', projectSlug = 'platform') {
  return {
    development: world.add(`${product}/${projectSlug}/development`),
    staging: world.add(`${product}/${projectSlug}/staging`),
    production: world.add(`${product}/${projectSlug}/production`, { tier: 'prod' }),
  }
}

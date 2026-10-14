import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { render } from '@testing-library/react'
import { vi } from 'vitest'
import { AppProviders } from '../../src/app/providers.tsx'
import { createReauthBridge } from '../../src/features/reauth/reauth.tsx'
import { ApiClient } from '../../src/lib/api/client.ts'
import { createQueryClient } from '../../src/lib/query/client.ts'
import { routeTree } from '../../src/routeTree.gen.ts'
import { answer, type FailureSpec, World } from '../target/support.tsx'

export { project, World } from '../target/support.tsx'

/**
 * The fake server of the target pages: the target world of `test/target`
 * plus routes a test registers for the reads and writes of the migrations,
 * findings, drift, activity and configuration pages. A request nobody
 * answers is a 404, so a request a page should not make is visible; every
 * request is recorded with its method and body.
 */
export const PROD_TARGET = 'shop/platform/production'
export const TARGET = 'shop/platform/staging'

export const BIDI = '‮'
export const ZERO_WIDTH = '​'
export const TAG_CHAR = '\u{e0041}'
export const HOSTILE = `<script>alert(1)</script>${BIDI}evil${ZERO_WIDTH}${TAG_CHAR}`

/** A 26-character ULID body that passes the id grammar. */
export const ulid = (n: number): string => `01M4S9${String(n).padStart(20, '0')}`

export interface Recorded {
  readonly method: string
  readonly url: string
  readonly body: unknown
}

type Handler = (request: Recorded) => FailureSpec | { readonly status: 200 | 201; body: unknown }

export class OpsWorld extends World {
  readonly routes: { method: string; pattern: RegExp; handler: Handler }[] = []
  readonly calls: Recorded[] = []

  /** Answers `method` requests whose `path?query` matches `pattern` with `body` (status 200). */
  on(method: string, pattern: RegExp, handler: Handler | object, status: 200 | 201 = 200): this {
    const fn: Handler =
      typeof handler === 'function' ? (handler as Handler) : () => ({ status, body: handler })
    this.routes.unshift({ method, pattern, handler: fn })
    return this
  }

  /** Answers with an error in the server's problem shape. */
  fail(method: string, pattern: RegExp, status: number, code: string, details?: unknown): this {
    return this.on(
      method,
      pattern,
      () =>
        ({
          status,
          code,
          message: `${code} happened.`,
          ...(details === undefined ? {} : { details }),
        }) as FailureSpec,
    )
  }

  callsTo(method: string, pattern: RegExp): Recorded[] {
    return this.calls.filter((call) => call.method === method && pattern.test(call.url))
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export function mountOps(initialPath: string, world: OpsWorld) {
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const request = `${url.pathname}${url.search}`
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const recorded: Recorded = { method, url: request, body }
    world.calls.push(recorded)
    for (const [part, held] of world.delays) {
      if (request.includes(part)) await held
    }
    for (const route of world.routes) {
      if (route.method === method && route.pattern.test(request)) {
        const result = route.handler(recorded)
        if ('code' in result) {
          const problem = result as FailureSpec & { details?: unknown; message?: string }
          return json(problem.status, {
            code: problem.code,
            message: problem.message ?? `${problem.code} happened.`,
            ...(problem.details === undefined ? {} : { details: problem.details }),
          })
        }
        return json(result.status, result.body)
      }
    }
    if (method !== 'GET') return json(404, { code: 'NOT_FOUND', message: 'Not found.' })
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

// ---------------------------------------------------------------------------
// Fixtures (neutral names, valid ids)
// ---------------------------------------------------------------------------

export const NOW = (): string => new Date().toISOString()
export const AGO = (ms: number): string => new Date(Date.now() - ms).toISOString()

export function ledgerEntry(n: number, over: Record<string, unknown> = {}) {
  return {
    appliedAt: AGO(60_000 * n),
    checksum: `sha256:c1:${String(n).padStart(64, 'a')}`,
    migrationId: ulid(n),
    name: `add_orders_${n}`,
    operationId: `op_${ulid(n)}`,
    origin: 'exponetdb',
    reverted: false,
    verification: { status: 'passed', verifiedAt: AGO(30_000 * n), verifyDigest: null },
    ...over,
  }
}

export function ledgerStatus(over: Record<string, unknown> = {}) {
  return {
    applied: [
      ledgerEntry(1),
      ledgerEntry(2, { verification: { status: 'pending', verifiedAt: null, verifyDigest: null } }),
    ],
    baselineId: null,
    ledgerStateHash: `sha256:${'b'.repeat(64)}`,
    mirror: { inSync: true, checkedAt: NOW() },
    observedAt: NOW(),
    pending: [
      { checksum: `sha256:c1:${'c'.repeat(64)}`, migrationId: ulid(9), name: 'add_invoices' },
    ],
    source: 'live',
    targetId: 'tgt_00000000000000000000000002',
    ...over,
  }
}

export function stream(over: Record<string, unknown> = {}) {
  return {
    projectId: 'prj_00000000000000000000000001',
    graph: { valid: true, errors: [] },
    heads: [ulid(2)],
    baselines: [],
    bundles: [
      {
        migrationId: ulid(1),
        name: 'add_orders_1',
        revision: 1,
        checksum: `sha256:c1:${'a'.repeat(64)}`,
        dependsOn: [],
        states: [
          cell('development', 'verified'),
          cell('staging', 'applied'),
          cell('production', 'not_applied'),
        ],
      },
      {
        migrationId: ulid(2),
        name: 'add_orders_2',
        revision: 1,
        checksum: `sha256:c1:${'d'.repeat(64)}`,
        dependsOn: [ulid(1)],
        // Production has no cell at all: the timeline must read it as unknown.
        states: [cell('development', 'verified'), cell('staging', 'failed')],
      },
    ],
    bundleCount: 2,
    truncated: false,
    environments: [
      environment('development', 'nonprod', null, 0),
      environment('staging', 'nonprod', 'development', 1),
      environment('production', 'prod', 'staging', 2),
    ],
    source: 'cached',
    observedAt: NOW(),
    ...over,
  }
}

function cell(slug: string, state: string) {
  return {
    environment: slug,
    state,
    checksum: null,
    checksumMatches: null,
    appliedAt: state === 'not_applied' ? null : AGO(120_000),
    verification: null,
    observedAt: AGO(60_000),
  }
}

function environment(slug: string, tier: string, evidenceFrom: string | null, rank: number) {
  return {
    slug,
    displayName: slug,
    tier,
    evidenceFrom,
    rank,
    target: {
      id: `tgt_${ulid(rank + 50)}`,
      path: `shop/platform/${slug}`,
      lifecycle: 'active',
      generation: 1,
    },
    mirror: {
      observedAt: AGO(60_000),
      ledgerStateHash: `sha256:${'e'.repeat(64)}`,
      baselineId: null,
      divergent: false,
      divergence: null as null | {
        missing: string[]
        checksumDiffers: string[]
        unrecorded: string[]
      },
      entriesOutsideStream: 0,
    },
  }
}

export function finding(n: number, over: Record<string, unknown> = {}) {
  return {
    id: `fnd_${ulid(n)}`,
    code: 'schema_drift',
    kind: 'drift',
    severity: 'warning',
    state: 'open',
    object: `public.orders_${n}`,
    summary: `Table orders_${n} differs from the expected schema`,
    firstSeenAt: AGO(86_400_000),
    lastSeenAt: AGO(60_000),
    occurrences: 3,
    resolution: null,
    resolvedAt: null,
    securityRelevant: false,
    subject: { clusterId: null, nodeId: null, targetId: 'tgt_00000000000000000000000002' },
    targetId: 'tgt_00000000000000000000000002',
    targetPath: TARGET,
    ...over,
  }
}

export function plan(n: number, over: Record<string, unknown> = {}) {
  return {
    id: `pln_${ulid(n)}`,
    kind: 'migration.plan',
    class: 'standard',
    state: 'active',
    createdAt: AGO(60_000),
    subject: { clusterId: null, nodeId: null, targetId: null, targetPath: TARGET, tier: 'nonprod' },
    ...over,
  }
}

export function driftCheck(over: Record<string, unknown> = {}) {
  return {
    id: `chk_${ulid(1)}`,
    targetId: 'tgt_00000000000000000000000002',
    status: 'completed',
    errorCode: null,
    checkedAt: NOW(),
    baselineFingerprint: 'fp1:aaaa',
    currentFingerprint: 'fp1:bbbb',
    truncated: false,
    counts: { drifted: 1, matched: 1, unmanaged: 1, opened: 1, resolved: 0, updated: 0 },
    findings: [
      {
        id: `fnd_${ulid(1)}`,
        code: 'object_changed',
        bucket: 'drifted',
        driftKind: 'C',
        severity: 'critical',
        object: `public.${HOSTILE}`,
        expected: 'create policy a using (true)',
        actual: `create policy a using (false) -- ${HOSTILE}`,
        explainedByOperationId: null,
      },
      {
        id: `fnd_${ulid(2)}`,
        code: 'object_same',
        bucket: 'matched',
        driftKind: 'C',
        severity: 'info',
        object: 'public.users',
        expected: 'table users',
        actual: 'table users',
        explainedByOperationId: null,
      },
      {
        id: `fnd_${ulid(3)}`,
        code: 'object_extra',
        bucket: 'unmanaged',
        driftKind: 'C',
        severity: 'info',
        object: 'public.scratch',
        expected: null,
        actual: 'table scratch',
        explainedByOperationId: `op_${ulid(7)}`,
      },
    ],
    ...over,
  }
}

export function report(over: Record<string, unknown> = {}) {
  return {
    id: `imr_${ulid(1)}`,
    targetId: 'tgt_00000000000000000000000002',
    projectId: 'prj_00000000000000000000000001',
    baselineId: 'baseline:legacy',
    state: 'open',
    createdAt: AGO(3_600_000),
    fingerprint: 'fp1:aaaa',
    unresolved: 1,
    items: [
      {
        itemId: '1',
        legacyId: '0001_init',
        name: '0001_init',
        state: 'recorded_present',
        contentDigest: null,
        evidence: ['legacy_tool_hash'],
        decision: null,
      },
      {
        itemId: '2',
        legacyId: `0014_policy${BIDI}`,
        name: `0014_policy ${HOSTILE}`,
        state: 'recorded_missing',
        contentDigest: null,
        evidence: ['expectations failed'],
        decision: null,
      },
    ],
    ...over,
  }
}

export function auditEvent(n: number, over: Record<string, unknown> = {}) {
  return {
    id: `aud_${ulid(n)}`,
    action: 'migration.apply',
    phase: 'completed',
    actor: { identityId: null, kind: 'human', label: `human #${n}` },
    client: { clientId: `cli_${ulid(n)}`, grantId: null, kind: 'mcp', sessionId: null },
    denial: null,
    occurredAt: AGO(60_000 * n),
    reason: null,
    refs: { jobId: null, operationId: `op_${ulid(n)}`, planHash: null, planId: `pln_${ulid(n)}` },
    result: { status: 'succeeded', errorCode: null },
    subject: { clusterId: null, nodeId: null, targetId: null, targetPath: TARGET, tier: 'nonprod' },
    ...over,
  }
}

export function operation(n: number, over: Record<string, unknown> = {}) {
  return {
    id: `op_${ulid(n)}`,
    planId: `pln_${ulid(n)}`,
    kind: 'migration.apply',
    state: 'verification_failed',
    applyOutcome: 'applied',
    verificationOutcome: 'failed',
    errorCode: null,
    actor: { identityId: `idn_${ulid(n)}`, kind: 'human', via: 'web' },
    createdAt: AGO(60_000 * n),
    updatedAt: AGO(30_000 * n),
    approvalUrl: null,
    steps: [],
    subject: { clusterId: null, nodeId: null, targetId: null, targetPath: TARGET, tier: 'nonprod' },
    waitingFor: null,
    ...over,
  }
}

/** Registers the reads of the staging target with sensible answers; tests override single routes. */
export function withDefaults(world: OpsWorld, path = TARGET): OpsWorld {
  const encoded = encodeURIComponent(path)
  world.on('GET', new RegExp(`/api/v1/targets/${encoded}/migrations$`), ledgerStatus())
  world.on('GET', /\/api\/v1\/projects\/[^/]+\/migrations$/, stream())
  world.on('GET', /\/api\/v1\/plans\?/, { items: [plan(1)], nextCursor: null })
  world.on('GET', new RegExp(`/api/v1/targets/${encoded}/findings`), {
    items: [],
    nextCursor: null,
  })
  world.on('GET', /\/api\/v1\/findings\?/, { items: [], nextCursor: null })
  world.on('GET', /\/api\/v1\/operations\?/, { items: [operation(1)], nextCursor: null })
  world.on('GET', /\/api\/v1\/audit-events\?/, { items: [auditEvent(1)], nextCursor: null })
  return world
}

/** The item at `index`, or a failure the test shows (no non-null assertion). */
export function nth<T>(list: readonly T[], index: number): T {
  const value = list[index]
  if (value === undefined) throw new Error(`no item at ${index}`)
  return value
}

export function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing value')
  return value
}

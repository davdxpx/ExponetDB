import {
  buildProblem,
  type ErrorCode,
  MIGRATION_MANIFEST_SCHEMA_URL,
  migrationManifestJsonSchema,
  PROJECT_CONFIG_SCHEMA_URL,
  projectConfigJsonSchema,
} from '@exponetdb/contracts'
import type { Clock } from '@exponetdb/kernel'
import {
  type Counter,
  describeError,
  type Histogram,
  type Logger,
  type MetricsRegistry,
  newRequestId,
  publicReadiness,
  type ReadinessReport,
  readinessHttpStatus,
  statusClass,
  type Tracing,
  withCorrelation,
} from '@exponetdb/observability'
import { type Context, Hono } from 'hono'
import { MCP_PATH, type McpDeps, mountMcp } from '../mcp/edge.ts'
import { type ApiDeps, mountApi } from './api.ts'
import type { HttpEnv } from './env.ts'
import { mountOAuth } from './oauth.ts'
import { mountWeb, type WebAssets } from './web.ts'

/**
 * HTTP interfaces. They depend only on what the composition root hands them
 * (a readiness view, metrics, a logger): never on the Control Store, SQL or
 * domain packages.
 *
 * - The **public** app (serve, `EXPONETDB_LISTEN`) answers `/healthz/live`
 *   and `/healthz/ready` with the status and the request id only: no check
 *   names, reasons or build version (health.md §8); every other path is a
 *   `NOT_FOUND` problem. Wave 2 exposes no management API.
 * - The **internal** app (every role, loopback by default) adds the build
 *   version, the per-check readiness detail and the Prometheus metrics.
 */
export interface HttpMetrics {
  readonly requests: Counter<'route' | 'method' | 'status_class'>
  readonly duration: Histogram<'route' | 'method'>
}

export function httpMetrics(registry: MetricsRegistry): HttpMetrics {
  return {
    requests: registry.counter('exdb_http_requests_total', 'HTTP requests by route template.', {
      route: { pattern: /^\/[a-z0-9_./{}-]{0,80}$/, maxDistinct: 100 },
      method: { values: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'OTHER'] },
      status_class: { values: ['1xx', '2xx', '3xx', '4xx', '5xx'] },
    }),
    duration: registry.histogram(
      'exdb_http_request_duration_seconds',
      'HTTP request duration by route template.',
      {
        route: { pattern: /^\/[a-z0-9_./{}-]{0,80}$/, maxDistinct: 100 },
        method: { values: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'OTHER'] },
      },
    ),
  }
}

export interface HttpDeps {
  readonly readiness: () => ReadinessReport
  readonly version: string
  readonly logger: Logger
  readonly metrics: HttpMetrics
  readonly clock: Clock
  readonly tracing?: Tracing
}

type Env = HttpEnv

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

function problem(c: Context<Env>, code: ErrorCode): Response {
  const built = buildProblem(code, { requestId: c.get('requestId') })
  const body = built.ok ? built.value : { code: 'INTERNAL', requestId: c.get('requestId') }
  return new Response(JSON.stringify(body), {
    status: built.ok ? built.value.status : 500,
    headers: { 'content-type': 'application/problem+json' },
  })
}

function base(
  deps: HttpDeps,
  routes: readonly string[],
  exposure: 'public' | 'internal',
): Hono<Env> {
  const build = exposure === 'internal' ? { version: deps.version } : {}
  const app = new Hono<Env>()
  app.use('*', async (c, next) => {
    const requestId = newRequestId(deps.clock)
    c.set('requestId', requestId)
    const started = performance.now()
    const run = () => withCorrelation({ requestId }, next)
    const headers: Record<string, string> = {}
    c.req.raw.headers.forEach((value, key) => {
      headers[key] = value
    })
    await (deps.tracing === undefined ? run() : deps.tracing.withIncoming(headers, run))
    const route = routes.includes(c.req.path) ? c.req.path : '/unmatched'
    const method = METHODS.has(c.req.method) ? c.req.method : 'OTHER'
    deps.metrics.requests.inc({ route, method, status_class: statusClass(c.res.status) })
    deps.metrics.duration.observe({ route, method }, (performance.now() - started) / 1000)
    c.header('x-request-id', requestId)
    c.header('cache-control', 'no-store')
    c.header('x-content-type-options', 'nosniff')
    c.header('referrer-policy', 'no-referrer')
    // The Web App pages set their own (still strict) policy; everything else gets none at all.
    if (!c.res.headers.has('content-security-policy')) {
      c.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'")
    }
  })
  app.get('/healthz/live', (c) => c.json({ status: 'up', ...build, requestId: c.get('requestId') }))
  app.get('/healthz/ready', (c) => {
    const report = deps.readiness()
    return c.json(
      { ...publicReadiness(report), ...build, requestId: c.get('requestId') },
      readinessHttpStatus(report.status),
    )
  })
  app.notFound((c) => problem(c, 'NOT_FOUND'))
  app.onError((error, c) => {
    deps.logger.error('http.request_failed', { ...describeError(error), route: '/unmatched' })
    return problem(c, 'INTERNAL')
  })
  return app
}

/**
 * The JSON Schemas whose `$id` names a public URL of this installation
 * (`migration.yaml`, `exponetdb.project.yaml`): static documents of the
 * contracts, served without authentication so editors and agents can
 * resolve them.
 */
const PUBLIC_SCHEMAS: Readonly<Record<string, () => Record<string, unknown>>> = {
  [new URL(MIGRATION_MANIFEST_SCHEMA_URL).pathname]: migrationManifestJsonSchema,
  [new URL(PROJECT_CONFIG_SCHEMA_URL).pathname]: projectConfigJsonSchema,
}

/**
 * The public listener of `serve`: probes, and with Wave 3A the Web App,
 * its `/auth` ceremonies and the `/api/v1` access resources; with Wave 3B
 * the OAuth authorization server (`/oauth/*`, `/.well-known/*`); with
 * Wave 7 the MCP endpoint (`POST /mcp`).
 */
export function createPublicApp(
  deps: HttpDeps,
  surface: { readonly api?: ApiDeps; readonly web?: WebAssets; readonly mcp?: McpDeps } = {},
): Hono<Env> {
  const routes = [
    '/healthz/live',
    '/healthz/ready',
    ...(surface.mcp === undefined ? [] : [MCP_PATH]),
    ...(surface.api === undefined && surface.mcp === undefined ? [] : Object.keys(PUBLIC_SCHEMAS)),
  ]
  const app = base(deps, routes, 'public')
  if (surface.mcp !== undefined) {
    mountMcp(app, surface.mcp)
  }
  if (surface.api !== undefined) {
    mountApi(app, surface.api)
    mountOAuth(app, surface.api)
  }
  if (surface.api !== undefined || surface.mcp !== undefined) {
    for (const [path, document] of Object.entries(PUBLIC_SCHEMAS)) {
      const body = JSON.stringify(document())
      app.get(
        path,
        () => new Response(body, { headers: { 'content-type': 'application/schema+json' } }),
      )
    }
  }
  if (surface.web !== undefined) {
    mountWeb(app, surface.web)
  }
  return app
}

/** The internal listener of every role: probes, per-check readiness detail and metrics. */
export function createInternalApp(
  deps: HttpDeps & { readonly registry: MetricsRegistry },
): Hono<Env> {
  const app = base(
    deps,
    ['/healthz/live', '/healthz/ready', '/healthz/detail', '/metrics'],
    'internal',
  )
  app.get('/healthz/detail', (c) => {
    const report = deps.readiness()
    return c.json(
      { ...report, version: deps.version, requestId: c.get('requestId') },
      readinessHttpStatus(report.status),
    )
  })
  app.get('/metrics', (c) =>
    c.body(deps.registry.render(), 200, {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
    }),
  )
  return app
}

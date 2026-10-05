import { buildProblem, type ErrorCode } from '@exponetdb/contracts'
import type { Clock, RequestId } from '@exponetdb/kernel'
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

/**
 * HTTP interfaces. They depend only on what the composition root hands them
 * (a readiness view, metrics, a logger): never on the Control Store, SQL or
 * domain packages.
 *
 * - The **public** app (serve, `EXPONETDB_LISTEN`) answers `/healthz/live`
 *   and `/healthz/ready` with status, version and request id only; every
 *   other path is a `NOT_FOUND` problem. Wave 2 exposes no management API.
 * - The **internal** app (every role, loopback by default) adds the per-check
 *   readiness detail and the Prometheus metrics.
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

type Env = { Variables: { requestId: RequestId } }

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

function problem(c: Context<Env>, code: ErrorCode): Response {
  const built = buildProblem(code, { requestId: c.get('requestId') })
  const body = built.ok ? built.value : { code: 'INTERNAL', requestId: c.get('requestId') }
  return new Response(JSON.stringify(body), {
    status: built.ok ? built.value.status : 500,
    headers: { 'content-type': 'application/problem+json' },
  })
}

function base(deps: HttpDeps, routes: readonly string[]): Hono<Env> {
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
    c.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'")
  })
  app.get('/healthz/live', (c) =>
    c.json({ status: 'up', version: deps.version, requestId: c.get('requestId') }),
  )
  app.get('/healthz/ready', (c) => {
    const report = deps.readiness()
    return c.json(
      { ...publicReadiness(report), version: deps.version, requestId: c.get('requestId') },
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

/** The public listener of `serve`: probes only. */
export function createPublicApp(deps: HttpDeps): Hono<Env> {
  return base(deps, ['/healthz/live', '/healthz/ready'])
}

/** The internal listener of every role: probes, per-check readiness detail and metrics. */
export function createInternalApp(
  deps: HttpDeps & { readonly registry: MetricsRegistry },
): Hono<Env> {
  const app = base(deps, ['/healthz/live', '/healthz/ready', '/healthz/detail', '/metrics'])
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

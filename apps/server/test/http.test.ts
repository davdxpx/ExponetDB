import { fixedClock } from '@exponetdb/kernel'
import { MetricsRegistry, type ReadinessReport, silentLogger } from '@exponetdb/observability'
import { describe, expect, it } from 'vitest'
import { servedRoutes } from '../src/interfaces/http/api.ts'
import {
  createInternalApp,
  createPublicApp,
  httpMetrics,
  ROUTE_LABEL,
} from '../src/interfaces/http/app.ts'

const report = (status: ReadinessReport['status']): ReadinessReport => ({
  status,
  evaluatedAt: '2026-10-05T12:00:00.000Z',
  checks: [
    {
      name: 'schema',
      severity: 'critical',
      status: status === 'not_ready' ? 'fail' : 'pass',
      reason: 'schema_pending',
      durationMs: 1,
    },
  ],
})

function apps(status: ReadinessReport['status']) {
  const registry = new MetricsRegistry()
  const deps = {
    readiness: () => report(status),
    version: '0.2.0',
    logger: silentLogger,
    metrics: httpMetrics(registry),
    clock: fixedClock(Date.parse('2026-10-05T12:00:00Z')),
  }
  return {
    registry,
    pub: createPublicApp(deps),
    internal: createInternalApp({ ...deps, registry }),
  }
}

describe('public HTTP interface (serve)', () => {
  it('answers liveness and readiness with the status and request id only', async () => {
    const { pub } = apps('not_ready')
    const live = await pub.request('/healthz/live')
    expect(live.status).toBe(200)
    expect(await live.json()).toEqual({
      status: 'up',
      requestId: expect.stringMatching(/^req_/),
    })
    const ready = await pub.request('/healthz/ready')
    expect(ready.status).toBe(503)
    const text = await ready.text()
    const body = JSON.parse(text)
    expect(Object.keys(body).sort()).toEqual(['requestId', 'status'])
    expect(text).not.toContain('schema')
    expect(text).not.toContain('0.2.0')
    expect(text).toContain(`"requestId":"${ready.headers.get('x-request-id')}"`)
    expect(ready.headers.get('cache-control')).toBe('no-store')
    expect(ready.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('degraded is still ready for traffic (200)', async () => {
    expect((await apps('degraded').pub.request('/healthz/ready')).status).toBe(200)
  })

  it('exposes no management API: everything else is a NOT_FOUND problem', async () => {
    const { pub } = apps('ready')
    for (const [method, path] of [
      ['GET', '/api/v1/targets'],
      ['POST', '/api/v1/plans'],
      ['GET', '/mcp'],
      ['GET', '/metrics'],
      ['GET', '/healthz/detail'],
      ['DELETE', '/healthz/live'],
    ] as const) {
      const res = await pub.request(path, { method })
      expect(res.status, `${method} ${path}`).toBe(404)
      expect(res.headers.get('content-type')).toBe('application/problem+json')
      const body = await res.json()
      expect(body).toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
        requestId: expect.stringMatching(/^req_/),
      })
    }
  })

  it('counts requests by route template, never by raw path', async () => {
    const { pub, registry } = apps('ready')
    await pub.request('/healthz/live')
    await pub.request('/api/v1/targets/tgt_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z')
    const text = registry.render()
    expect(text).toContain(
      'exdb_http_requests_total{method="GET",route="/healthz/live",status_class="2xx"} 1',
    )
    expect(text).toContain('route="/unmatched"')
    expect(text).not.toContain('tgt_01JB')
  })

  it('records the matched route template of a parameterized route, one series for all ids (VC-037)', async () => {
    const { pub, registry } = apps('ready')
    // The routes of the API are mounted with templates; every call used to be "/unmatched".
    pub.get('/api/v1/targets/:target', (c) => c.json({ ok: true }))
    await pub.request('/api/v1/targets/tgt_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z')
    await pub.request('/api/v1/targets/tgt_01JB2Z6G8M4Q7R9T1V3W5X7Y9A')
    await pub.request('/somewhere/else')
    const text = registry.render()
    expect(text).toContain(
      'exdb_http_requests_total{method="GET",route="/api/v1/targets/:target",status_class="2xx"} 2',
    )
    expect(text).toContain('route="/unmatched"')
    expect(text).not.toContain('tgt_01JB')
  })

  it('has room in the route label for every template the API serves (VC-037)', () => {
    const templates = new Set(
      servedRoutes().map(({ base, route }) => `${base}${route.path.replace(/\{(\w+)\}/g, ':$1')}`),
    )
    expect(templates.size).toBeLessThanOrEqual(ROUTE_LABEL.maxDistinct)
    for (const template of templates) expect(template, template).toMatch(ROUTE_LABEL.pattern)
  })
})

describe('internal HTTP interface', () => {
  it('serves the per-check detail and the metrics', async () => {
    const { internal } = apps('not_ready')
    const detail = await internal.request('/healthz/detail')
    expect(detail.status).toBe(503)
    expect(await detail.json()).toMatchObject({
      status: 'not_ready',
      version: '0.2.0',
      checks: [{ name: 'schema', reason: 'schema_pending' }],
    })
    expect(await (await internal.request('/healthz/live')).json()).toMatchObject({
      status: 'up',
      version: '0.2.0',
    })
    const metrics = await internal.request('/metrics')
    expect(metrics.status).toBe(200)
    expect(await metrics.text()).toContain('exdb_http_requests_total')
  })
})

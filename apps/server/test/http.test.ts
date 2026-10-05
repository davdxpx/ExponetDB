import { fixedClock } from '@exponetdb/kernel'
import { MetricsRegistry, type ReadinessReport, silentLogger } from '@exponetdb/observability'
import { describe, expect, it } from 'vitest'
import { createInternalApp, createPublicApp, httpMetrics } from '../src/interfaces/http/app.ts'

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
  it('answers liveness and readiness with status, version and request id only', async () => {
    const { pub } = apps('not_ready')
    const live = await pub.request('/healthz/live')
    expect(live.status).toBe(200)
    expect(await live.json()).toMatchObject({
      status: 'up',
      version: '0.2.0',
      requestId: expect.stringMatching(/^req_/),
    })
    const ready = await pub.request('/healthz/ready')
    expect(ready.status).toBe(503)
    const text = await ready.text()
    const body = JSON.parse(text)
    expect(Object.keys(body).sort()).toEqual(['requestId', 'status', 'version'])
    expect(text).not.toContain('schema')
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
})

describe('internal HTTP interface', () => {
  it('serves the per-check detail and the metrics', async () => {
    const { internal } = apps('not_ready')
    const detail = await internal.request('/healthz/detail')
    expect(detail.status).toBe(503)
    expect(await detail.json()).toMatchObject({
      status: 'not_ready',
      checks: [{ name: 'schema', reason: 'schema_pending' }],
    })
    const metrics = await internal.request('/metrics')
    expect(metrics.status).toBe(200)
    expect(await metrics.text()).toContain('exdb_http_requests_total')
  })
})

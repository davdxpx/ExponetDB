import { manualClock } from '@exponetdb/kernel'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace'
import { describe, expect, it } from 'vitest'
import {
  fail,
  LABELS,
  MetricsRegistry,
  pass,
  publicReadiness,
  Readiness,
  readinessHttpStatus,
  SafeError,
  setupTracing,
  statusClass,
  warn,
} from '../src/index.ts'

describe('metrics registry', () => {
  it('renders Prometheus text with sorted labels and series', () => {
    const r = new MetricsRegistry()
    const c = r.counter('exdb_http_requests_total', 'HTTP requests.', {
      route: LABELS.route,
      method: LABELS.method,
      status_class: LABELS.statusClass,
    })
    c.inc({ route: '/healthz/ready', method: 'GET', status_class: statusClass(503) })
    c.inc({ route: '/healthz/live', method: 'GET', status_class: statusClass(200) }, 2)
    const h = r.histogram(
      'exdb_control_store_query_duration_seconds',
      'Query duration.',
      { query_class: LABELS.queryClass },
      [0.1, 1],
    )
    h.observe({ query_class: 'audit.append' }, 0.05)
    h.observe({ query_class: 'audit.append' }, 0.5)
    expect(r.render()).toBe(
      [
        '# HELP exdb_control_store_query_duration_seconds Query duration.',
        '# TYPE exdb_control_store_query_duration_seconds histogram',
        'exdb_control_store_query_duration_seconds_bucket{query_class="audit.append",le="0.1"} 1',
        'exdb_control_store_query_duration_seconds_bucket{query_class="audit.append",le="1"} 2',
        'exdb_control_store_query_duration_seconds_bucket{query_class="audit.append",le="+Inf"} 2',
        'exdb_control_store_query_duration_seconds_sum{query_class="audit.append"} 0.55',
        'exdb_control_store_query_duration_seconds_count{query_class="audit.append"} 2',
        '# HELP exdb_http_requests_total HTTP requests.',
        '# TYPE exdb_http_requests_total counter',
        'exdb_http_requests_total{method="GET",route="/healthz/live",status_class="2xx"} 2',
        'exdb_http_requests_total{method="GET",route="/healthz/ready",status_class="5xx"} 1',
        '',
      ].join('\n'),
    )
  })

  it('never turns ids or unexpected values into label values', () => {
    const r = new MetricsRegistry()
    const g = r.gauge('exdb_test_gauge', 'Test.', {
      kind: { pattern: /^[a-z0-9_.]+$/, maxDistinct: 2 },
    })
    g.set({ kind: 'tgt_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z' }, 1)
    g.set({ kind: '01JB2Z6G8M4Q7R9T1V3W5X7Y9Z' }, 1)
    g.set({ kind: '123e4567-e89b-12d3-a456-426614174000' }, 1)
    g.set({ kind: 'Has Spaces' }, 1)
    g.set({ kind: 'a' }, 1)
    g.set({ kind: 'b' }, 1)
    g.set({ kind: 'c' }, 1) // over the distinct-value cap
    const text = r.render()
    expect(text).not.toContain('01JB2Z6G8M4Q7R9T1V3W5X7Y9Z')
    expect(text).not.toContain('123e4567')
    expect(text).toContain('kind="other"')
    expect(text).toContain('kind="a"')
    expect(text).toContain('kind="b"')
    expect(text).not.toContain('kind="c"')
    const closed = r.counter('exdb_test_total', 'Test.', { role: LABELS.role })
    closed.inc({ role: 'superuser' })
    expect(r.render()).toContain('exdb_test_total{role="other"} 1')
  })

  it('refuses metric names outside the exdb_ namespace and duplicates', () => {
    const r = new MetricsRegistry()
    expect(() => r.counter('http_requests_total', 'x', {})).toThrow()
    r.counter('exdb_a_total', 'x', {})
    expect(() => r.counter('exdb_a_total', 'x', {})).toThrow()
  })
})

describe('readiness model', () => {
  it('starts not ready until evaluated', () => {
    const r = new Readiness()
    expect(r.latest().status).toBe('not_ready')
  })

  it('combines critical and degrading checks', async () => {
    const r = new Readiness()
    r.register({ name: 'control_store', severity: 'critical', run: async () => pass() })
    r.register({
      name: 'audit_export',
      severity: 'degrading',
      run: async () => fail('export_failing'),
    })
    expect((await r.evaluate()).status).toBe('degraded')
    const r2 = new Readiness()
    r2.register({
      name: 'schema',
      severity: 'critical',
      run: async () => fail('schema_unverified'),
    })
    r2.register({
      name: 'keyring',
      severity: 'critical',
      run: async () => warn('key_rotation_pending'),
    })
    const report = await r2.evaluate()
    expect(report.status).toBe('not_ready')
    expect(readinessHttpStatus(report.status)).toBe(503)
    expect(publicReadiness(report)).toEqual({ status: 'not_ready' })
  })

  it('treats a throwing or hanging check as failed, never as passed', async () => {
    const r = new Readiness()
    r.register({
      name: 'throws',
      severity: 'critical',
      run: async () => {
        throw new SafeError('x', 'boom')
      },
    })
    r.register({
      name: 'hangs',
      severity: 'degrading',
      timeoutMs: 20,
      run: () => new Promise(() => undefined),
    })
    const report = await r.evaluate()
    expect(report.status).toBe('not_ready')
    expect(report.checks.map((c) => [c.name, c.status, c.reason])).toEqual([
      ['throws', 'fail', 'check_error'],
      ['hangs', 'fail', 'check_timeout'],
    ])
  })

  it('is not ready with no checks and stays not ready once stopping', async () => {
    const empty = new Readiness()
    expect((await empty.evaluate()).status).toBe('not_ready')
    const r = new Readiness(manualClock(0))
    r.register({ name: 'ok', severity: 'critical', run: async () => pass() })
    expect((await r.evaluate()).status).toBe('ready')
    r.markStopping()
    expect((await r.evaluate()).status).toBe('not_ready')
    expect(r.latest().checks[0]?.reason).toBe('stopping')
  })

  it('replaces reasons that are not machine codes', async () => {
    const r = new Readiness()
    r.register({
      name: 'x',
      severity: 'critical',
      run: async () => fail('connection to postgres://h failed'),
    })
    expect((await r.evaluate()).checks[0]?.reason).toBe('unspecified')
  })
})

describe('tracing', () => {
  it('without an exporter: disabled, but incoming W3C context still correlates', async () => {
    const tracing = setupTracing({ serviceName: 'exponetdb', role: 'serve', version: '0.0.0' })
    expect(tracing.enabled).toBe(false)
    const ids = tracing.withIncoming(
      { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
      () => tracing.currentIds(),
    )
    expect(ids.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
    expect(tracing.withIncoming({ traceparent: 'garbage' }, () => tracing.currentIds())).toEqual({})
    await expect(tracing.withSpan('noop', {}, async () => 42)).resolves.toBe(42)
  })

  it('with an exporter: allowlisted attributes only, errors carry the code, not the message', async () => {
    const exporter = new InMemorySpanExporter()
    const tracing = setupTracing({
      serviceName: 'exponetdb',
      role: 'worker',
      version: '0.0.0',
      spanExporter: exporter,
    })
    expect(tracing.enabled).toBe(true)
    await tracing.withSpan(
      'control_store.query',
      { 'exdb.query_class': 'audit.append', 'exdb.role': 'worker' },
      async () => 1,
    )
    const unsafe: Record<string, string> = { 'db.statement': 'SELECT secret FROM t' }
    await expect(
      tracing.withSpan('worker.step', unsafe, async () => {
        throw new SafeError('lease_lost', 'Lease lost.')
      }),
    ).rejects.toThrow('Lease lost.')
    await tracing.flush(2000)
    const spans = exporter.getFinishedSpans()
    await tracing.shutdown(2000)
    expect(spans.map((s) => s.name)).toEqual(['control_store.query', 'worker.step'])
    expect(spans[0]?.attributes).toEqual({
      'exdb.query_class': 'audit.append',
      'exdb.role': 'worker',
    })
    expect(spans[1]?.attributes).toEqual({})
    expect(spans[1]?.status.message).toBe('lease_lost')
    expect(spans[1]?.events).toEqual([])
  })
})

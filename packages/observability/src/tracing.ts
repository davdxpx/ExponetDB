import {
  type Attributes,
  type Context,
  context,
  propagation,
  type Span,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  type SpanExporter,
  TraceIdRatioBasedSampler,
  TracerProvider,
} from '@opentelemetry/sdk-trace'
import { describeError } from './errors.ts'
import { redactText } from './redact.ts'

/**
 * OpenTelemetry tracing ([self-observability.md §4](../../../exponetdb-docs/10-observability/self-observability.md#4-tracing)).
 *
 * W3C trace context is always extracted and propagated, so log lines carry
 * the caller's trace id even when no tracing backend exists. Spans are
 * exported only when an OTLP endpoint is configured; without one, tracing is
 * cleanly disabled (no-op spans) and nothing fails at startup. Exporting is
 * best effort: a down collector never affects a request.
 *
 * Span attributes pass an allowlist (query class, route template, method,
 * status, operation kind, task, role, outcome); SQL text, statement
 * parameters, ids of people and exception messages never become attributes.
 * Errors set the span status to the error code only.
 */
export const SPAN_ATTRIBUTES = [
  'exdb.role',
  'exdb.query_class',
  'exdb.operation.kind',
  'exdb.task',
  'exdb.outcome',
  'http.route',
  'http.request.method',
  'http.response.status_code',
] as const
export type SpanAttributeName = (typeof SPAN_ATTRIBUTES)[number]
export type SpanAttributes = Partial<Record<SpanAttributeName, string | number | boolean>>

export interface TracingOptions {
  readonly serviceName: string
  readonly role: string
  readonly version: string
  /** OTLP/HTTP traces endpoint, e.g. `http://otel-collector:4318/v1/traces`. Absent: disabled. */
  readonly otlpEndpoint?: string
  /** Head sampling ratio for root spans, 0 to 1 (default 1). */
  readonly sampleRatio?: number
  /** Replaces the OTLP exporter (tests, other transports). Enables tracing like an endpoint does. */
  readonly spanExporter?: SpanExporter
}

export interface Tracing {
  readonly enabled: boolean
  /** Runs `fn` in a child span of the active context. */
  withSpan<T>(name: string, attributes: SpanAttributes, fn: () => Promise<T>): Promise<T>
  /** Runs `fn` in the trace context carried by incoming W3C headers (if valid). */
  withIncoming<T>(headers: Readonly<Record<string, string | undefined>>, fn: () => T): T
  /** Trace and span id of the active context, if any. */
  currentIds(): { readonly traceId?: string; readonly spanId?: string }
  /** Exports pending spans, bounded by `timeoutMs`. Never throws. */
  flush(timeoutMs: number): Promise<void>
  /** Flushes and stops exporting, bounded by `timeoutMs`. Never throws. */
  shutdown(timeoutMs: number): Promise<void>
}

function bounded(work: Promise<unknown>, timeoutMs: number): Promise<unknown> {
  return Promise.race([
    work.catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
  ])
}

function safeAttributes(attributes: SpanAttributes): Attributes {
  const out: Attributes = {}
  for (const name of SPAN_ATTRIBUTES) {
    const value = attributes[name]
    if (typeof value === 'string') {
      out[name] = redactText(value).slice(0, 128)
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out[name] = value
    }
  }
  return out
}

let contextManagerInstalled = false

/** Sets up tracing once per process. */
export function setupTracing(options: TracingOptions): Tracing {
  if (!contextManagerInstalled) {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
    propagation.setGlobalPropagator(new W3CTraceContextPropagator())
    contextManagerInstalled = true
  }
  let provider: TracerProvider | undefined
  const exporter =
    options.spanExporter ??
    (options.otlpEndpoint === undefined
      ? undefined
      : new OTLPTraceExporter({ url: options.otlpEndpoint, timeoutMillis: 5000 }))
  if (exporter !== undefined) {
    const ratio = Math.min(1, Math.max(0, options.sampleRatio ?? 1))
    provider = new TracerProvider({
      resource: resourceFromAttributes({
        'service.name': options.serviceName,
        'service.version': options.version,
        'exdb.role': options.role,
      }),
      sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) }),
      spanProcessors: [new BatchSpanProcessor({ exporter, scheduledDelayMillis: 1000 })],
    })
    trace.setGlobalTracerProvider(provider)
  }
  const tracer = trace.getTracer(options.serviceName, options.version)

  return {
    enabled: provider !== undefined,
    async withSpan<T>(name: string, attributes: SpanAttributes, fn: () => Promise<T>): Promise<T> {
      return tracer.startActiveSpan(
        name,
        { attributes: safeAttributes(attributes) },
        async (span: Span) => {
          try {
            const result = await fn()
            span.setStatus({ code: SpanStatusCode.OK })
            return result
          } catch (error) {
            const described = describeError(error)
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: described.errorCode ?? described.errorName,
            })
            throw error
          } finally {
            span.end()
          }
        },
      )
    },
    withIncoming<T>(headers: Readonly<Record<string, string | undefined>>, fn: () => T): T {
      const carrier: Record<string, string> = {}
      const traceparent = headers['traceparent']
      const tracestate = headers['tracestate']
      if (traceparent !== undefined) {
        carrier['traceparent'] = traceparent
      }
      if (tracestate !== undefined) {
        carrier['tracestate'] = tracestate
      }
      const extracted: Context = propagation.extract(context.active(), carrier)
      return context.with(extracted, fn)
    },
    currentIds() {
      const spanContext = trace.getSpanContext(context.active())
      if (spanContext === undefined || !trace.isSpanContextValid(spanContext)) {
        return {}
      }
      return { traceId: spanContext.traceId, spanId: spanContext.spanId }
    },
    async flush(timeoutMs: number): Promise<void> {
      if (provider !== undefined) {
        await bounded(provider.forceFlush(), timeoutMs)
      }
    },
    async shutdown(timeoutMs: number): Promise<void> {
      if (provider === undefined) {
        return
      }
      await bounded(provider.shutdown(), timeoutMs)
      trace.disable()
    },
  }
}

import type { Application, Caller } from '@exponetdb/application'
import { oauth } from '@exponetdb/auth'
import {
  MCP_ADVERTISED_SCOPES,
  MCP_ERROR_CODES,
  MCP_HEADERS,
  MCP_META_KEYS,
  MCP_RATE_LIMITS,
  MCP_REQUEST_LIMITS,
  type McpEra,
  type Scope,
  type ToolRateClass,
} from '@exponetdb/contracts'
import type { RequestId } from '@exponetdb/kernel'
import {
  type Counter,
  describeError,
  type Histogram,
  type Logger,
  type MetricsRegistry,
  statusClass,
} from '@exponetdb/observability'
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server'
import type { Context, Hono } from 'hono'
import { authenticateBearer, authorizationHeaders } from '../http/bearer.ts'
import type { HttpEnv } from '../http/env.ts'
import { checkShape, classify, type RpcMessage } from './classify.ts'
import { readJson } from './json.ts'
import { checkHost, checkOrigin, type OriginPolicy, originPolicy } from './origin.ts'
import { ConcurrencyGate, RateLimiter } from './rate-limit.ts'
import type { McpCallContext, ToolHost } from './registry.ts'
import type { ResourceHost } from './resources.ts'
import { toolError } from './results.ts'
import { authInfoOf, mcpServerFactory } from './server.ts'

/**
 * The HTTP edge of `/mcp` (ADR-0027 §3, protocol-baseline.md §4 and §5).
 * Every POST passes these checks in this order before the SDK sees it;
 * each refusal is the cheapest one that applies:
 *
 * 1. method (`405`, `Allow: POST`), `Origin` (`403`), `Host` (`421`),
 *    availability (`503`), `Content-Type` (`415`), `Accept` (`406`), the
 *    declared length (`413`): all before authentication;
 * 2. the bearer token for the audience `mcp` (`401` with the challenge):
 *    the shared helper of `/api/v1`, a live lookup on every request;
 * 3. the body, read with a size bound and a deadline (`413`, `408`), then
 *    a strict JSON reading (`-32700`, `-32600`), the message shape and the
 *    era classification (§4);
 * 4. the rate limits of the grant and the identity (`429`, `Retry-After`);
 * 5. dispatch to a fresh SDK server with a reduced request: no
 *    `Authorization`, cookies, `Origin`, forwarding or session headers ever
 *    reach it, and its `authInfo` carries no token.
 *
 * A missing scope found by the engine becomes `403 insufficient_scope`; any
 * other refusal of the engine or the policy is a tool error inside a `200`.
 * Answers carry no session id, no cookie and `Cache-Control: no-store`.
 */
export const MCP_PATH = '/mcp'

export interface McpLimits {
  readonly bodyBytes: number
  readonly bundleBodyBytes: number
  readonly largeBodiesPerGrant: number
  readonly jsonDepth: number
  readonly jsonElements: number
  readonly bodyTimeoutMs: number
  readonly requestTimeoutMs: number
}

const DEFAULT_LIMITS: McpLimits = {
  bodyBytes: MCP_REQUEST_LIMITS.bodyBytes,
  bundleBodyBytes: MCP_REQUEST_LIMITS.bundleBodyBytes,
  largeBodiesPerGrant: MCP_REQUEST_LIMITS.largeBodiesPerGrant,
  jsonDepth: MCP_REQUEST_LIMITS.jsonDepth,
  jsonElements: MCP_REQUEST_LIMITS.jsonElements,
  bodyTimeoutMs: MCP_REQUEST_LIMITS.bodyTimeoutMs,
  requestTimeoutMs: MCP_REQUEST_LIMITS.requestTimeoutMs,
}

/** Why the edge refused a request (a closed set: the `reason` label and log field). */
export const MCP_DENIALS = [
  'method',
  'origin',
  'host',
  'degraded',
  'content_type',
  'accept',
  'too_large',
  'unauthenticated',
  'invalid_token',
  'body_timeout',
  'parse',
  'invalid_request',
  'version',
  'rate_limited',
  'large_bodies',
  'insufficient_scope',
  'timeout',
] as const
export type McpDenial = (typeof MCP_DENIALS)[number]

export interface McpMetrics {
  readonly requests: Counter<'era' | 'status_class'>
  readonly toolCalls: Counter<'tool' | 'outcome' | 'era'>
  readonly toolDuration: Histogram<'tool'>
  readonly denied: Counter<'reason'>
}

export function mcpMetrics(registry: MetricsRegistry): McpMetrics {
  const tool = { pattern: /^[a-z][a-z0-9_]{0,47}$/, maxDistinct: 64 }
  return {
    requests: registry.counter('exdb_mcp_requests_total', 'MCP requests by era and status class.', {
      era: { values: ['modern', 'legacy', 'none'] },
      status_class: { values: ['1xx', '2xx', '3xx', '4xx', '5xx'] },
    }),
    toolCalls: registry.counter(
      'exdb_mcp_tool_calls_total',
      'MCP tool calls by tool and outcome code.',
      {
        tool,
        // `input_required` is the approval round of plan_apply (registry.ts), not an error code.
        outcome: { pattern: /^(?:ok|input_required|[A-Z][A-Z0-9_]{0,63})$/, maxDistinct: 96 },
        era: { values: ['modern', 'legacy'] },
      },
    ),
    toolDuration: registry.histogram(
      'exdb_mcp_tool_call_duration_seconds',
      'MCP tool call duration by tool.',
      { tool },
    ),
    denied: registry.counter(
      'exdb_mcp_denied_total',
      'MCP requests refused at the edge, by reason.',
      {
        reason: { values: MCP_DENIALS },
      },
    ),
  }
}

export interface McpDeps {
  readonly application: Pick<Application, 'authenticateBearer' | 'noteGrantUse'>
  readonly tools: ToolHost
  readonly resources: ResourceHost
  /** `EXPONETDB_PUBLIC_URL`: the issuer, the resource and the allowed origin. */
  readonly publicOrigin: string
  /** `EXPONETDB_MCP_ALLOWED_ORIGINS`: further browser origins allowed to call `/mcp`. */
  readonly extraOrigins: readonly string[]
  readonly version: string
  readonly logger: Logger
  readonly metrics: McpMetrics
  /** False until the stored role matrix is verified: nothing is served before (fail closed). */
  readonly available: () => boolean
  readonly limiter?: RateLimiter
  readonly gate?: ConcurrencyGate
  readonly limits?: Partial<McpLimits>
}

type Env = HttpEnv

/** What the request log and the metrics record about one request. */
interface Record {
  era?: McpEra
  protocolVersion?: string
  rpcMethod?: string
  rpcCode?: number
  denial?: McpDenial
  ctx?: McpCallContext
}

function rpcError(
  status: number,
  code: number,
  message: string,
  options: {
    readonly id?: string | number | undefined
    readonly data?: unknown
    readonly headers?: Readonly<globalThis.Record<string, string>>
  } = {},
): Response {
  const body = {
    jsonrpc: '2.0',
    ...(options.id === undefined ? {} : { id: options.id }),
    error: { code, message, ...(options.data === undefined ? {} : { data: options.data }) },
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...options.headers },
  })
}

/** The media type of a `Content-Type` value, lowercased, without parameters. */
function mediaType(value: string | undefined): string | undefined {
  return value?.split(';')[0]?.trim().toLowerCase()
}

/** Which answer forms an `Accept` header allows (a missing header allows both). */
export function acceptance(value: string | undefined): { json: boolean; sse: boolean } {
  if (value === undefined || value.trim() === '') {
    return { json: true, sse: true }
  }
  let json = false
  let sse = false
  for (const range of value.split(',')) {
    const [type, ...params] = range.split(';').map((p) => p.trim().toLowerCase())
    const q = params.find((p) => p.startsWith('q='))
    if (q !== undefined && Number(q.slice(2)) === 0) continue
    if (type === 'application/json' || type === 'application/*' || type === '*/*') json = true
    if (type === 'text/event-stream' || type === 'text/*' || type === '*/*') sse = true
  }
  return { json, sse }
}

type BodyRead =
  | { readonly kind: 'ok'; readonly bytes: Uint8Array }
  | { readonly kind: 'too_large' }
  | { readonly kind: 'timeout' }

/** Reads a body stream up to `limit` bytes before `deadlineMs`; never buffers more than the bound. */
export async function readBounded(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
  deadlineMs: number,
): Promise<BodyRead> {
  if (stream === null) {
    return { kind: 'ok', bytes: new Uint8Array() }
  }
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), deadlineMs)
  })
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline])
      if (next === 'timeout') {
        await reader.cancel().catch(() => undefined)
        return { kind: 'timeout' }
      }
      if (next.done) break
      total += next.value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => undefined)
        return { kind: 'too_large' }
      }
      chunks.push(next.value)
    }
  } finally {
    clearTimeout(timer)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { kind: 'ok', bytes }
}

/** The JSON-RPC response to request `id` inside an SSE body (the SDK frames legacy answers as SSE). */
export function responseFromSse(text: string, id: string | number): string | undefined {
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n')
    if (data === '') continue
    try {
      const message = JSON.parse(data) as unknown
      if (
        typeof message === 'object' &&
        message !== null &&
        (message as globalThis.Record<string, unknown>)['id'] === id &&
        ('result' in message || 'error' in message)
      ) {
        return data
      }
    } catch {
      // Not a JSON-RPC message: skipped.
    }
  }
  return undefined
}

/** A legacy `resources/read` miss as the legacy revisions name it: `-32002` (the SDK sends `-32602`). */
export function legacyResourceNotFound(data: string): string {
  try {
    const message = JSON.parse(data) as { error?: { code?: unknown; message?: unknown } }
    if (
      message.error?.code === MCP_ERROR_CODES.invalidParams &&
      message.error.message === 'Resource not found'
    ) {
      message.error.code = MCP_ERROR_CODES.legacyResourceNotFound
      return JSON.stringify(message)
    }
  } catch {
    // Not JSON: left as it is.
  }
  return data
}

/** The grant (or API key) a principal's limits are counted on. */
function grantKey(principal: McpCallContext['principal']): string {
  const credential = principal.delegation.credential
  return credential.type === 'access_token' ? credential.grantId : credential.keyId
}

export function mountMcp(app: Hono<Env>, deps: McpDeps): McpHttpHandler {
  const limits: McpLimits = { ...DEFAULT_LIMITS, ...deps.limits }
  const policy: OriginPolicy = originPolicy(deps.publicOrigin, deps.extraOrigins)
  const limiter = deps.limiter ?? new RateLimiter()
  const gate = deps.gate ?? new ConcurrencyGate()
  const resource = oauth.resourceUri(deps.publicOrigin, 'mcp')
  const handler = createMcpHandler(mcpServerFactory(deps), {
    legacy: 'stateless',
    // 'auto' is a single JSON body unless a related message precedes the result; ExponetDB
    // sends none ('json' would print a console warning outside the logger). The edge
    // shapes any SSE answer into the form the client accepts.
    responseMode: 'auto',
    // The edge already bounds and parses the body; this only guards the SDK's own reads.
    maxRequestBodySize: limits.bundleBodyBytes + 1,
    onerror: (error) => deps.logger.warn('mcp.sdk_error', { ...describeError(error) }),
  })

  const challenge = (
    code: 'invalid_token' | 'insufficient_scope' | undefined,
    scope: readonly Scope[] | undefined,
  ): string =>
    oauth.bearerChallenge(deps.publicOrigin, 'mcp', {
      ...(code === undefined ? {} : { code }),
      ...(scope === undefined ? {} : { scope }),
    })

  async function serve(c: Context<Env>, record: Record): Promise<Response> {
    const requestId: RequestId = c.get('requestId')
    const deny = (reason: McpDenial, response: Response): Response => {
      record.denial = reason
      return response
    }
    // 1. Before authentication.
    if (c.req.method !== 'POST') {
      return deny(
        'method',
        rpcError(
          405,
          MCP_ERROR_CODES.invalidRequest,
          'Method not allowed: /mcp accepts POST only.',
          {
            headers: { allow: 'POST' },
          },
        ),
      )
    }
    if (checkOrigin(policy, c.req.header('origin')) !== undefined) {
      return deny(
        'origin',
        rpcError(403, MCP_ERROR_CODES.invalidRequest, 'Forbidden: this origin may not call /mcp.'),
      )
    }
    if (checkHost(policy, c.req.header('host') ?? new URL(c.req.url).host) !== undefined) {
      return deny(
        'host',
        rpcError(421, MCP_ERROR_CODES.invalidRequest, 'Misdirected request: unknown host name.'),
      )
    }
    if (!deps.available()) {
      return deny(
        'degraded',
        rpcError(503, MCP_ERROR_CODES.internalError, 'ExponetDB is not ready; retry later.', {
          data: { code: 'CONTROL_PLANE_DEGRADED' },
          headers: { 'retry-after': '5' },
        }),
      )
    }
    if (mediaType(c.req.header('content-type')) !== 'application/json') {
      return deny(
        'content_type',
        rpcError(
          415,
          MCP_ERROR_CODES.invalidRequest,
          'Unsupported media type: send application/json.',
        ),
      )
    }
    const accept = acceptance(c.req.header('accept'))
    if (!accept.json && !accept.sse) {
      return deny(
        'accept',
        rpcError(
          406,
          MCP_ERROR_CODES.invalidRequest,
          'Not acceptable: accept application/json or text/event-stream.',
        ),
      )
    }
    const mcpMethod = c.req.header(MCP_HEADERS.method)
    const mcpName = c.req.header(MCP_HEADERS.name)
    const bundleClaim =
      mcpMethod === 'tools/call' && mcpName !== undefined && deps.tools.bundleBody(mcpName)
    const declared = c.req.header('content-length')
    const declaredBytes = declared === undefined ? undefined : Number(declared)
    const tooLarge = () =>
      deny(
        'too_large',
        rpcError(413, MCP_ERROR_CODES.invalidRequest, 'Request too large.', {
          data: { maxBytes: limits.bodyBytes },
        }),
      )
    if (declaredBytes !== undefined) {
      if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
        return deny(
          'invalid_request',
          rpcError(400, MCP_ERROR_CODES.invalidRequest, 'Invalid Content-Length.'),
        )
      }
      if (declaredBytes > limits.bundleBodyBytes) return tooLarge()
      // A modern request names its tool in a header: only a bundle tool may send a large body.
      if (mcpMethod !== undefined && !bundleClaim && declaredBytes > limits.bodyBytes)
        return tooLarge()
    }

    // 2. Authentication (the same helper as /api/v1, audience mcp).
    const bearer = await authenticateBearer(deps.application, authorizationHeaders(c), 'mcp')
    if (bearer.kind !== 'ok') {
      const none = bearer.kind === 'none'
      const response = rpcError(401, MCP_ERROR_CODES.invalidRequest, 'Unauthorized.', {
        data: { code: 'UNAUTHENTICATED' },
      })
      response.headers.set(
        'www-authenticate',
        challenge(none ? undefined : 'invalid_token', none ? MCP_ADVERTISED_SCOPES : undefined),
      )
      return deny(none ? 'unauthenticated' : 'invalid_token', response)
    }
    const principal = bearer.principal
    const caller: Caller = { kind: 'bearer', principal, resource: 'mcp' }

    // 3. The body: bounded, strict, one message, one era.
    let releaseLarge: (() => void) | undefined
    try {
      let limit = limits.bodyBytes
      // A body that may be large holds one of few slots per grant: a legacy request names no
      // tool in a header, and a modern request claiming a bundle tool may send the large tier too.
      if (
        (bundleClaim || mcpMethod === undefined) &&
        (declaredBytes === undefined || declaredBytes > limits.bodyBytes)
      ) {
        releaseLarge = gate.acquire([
          { key: `large:${grantKey(principal)}`, max: limits.largeBodiesPerGrant },
        ])
        if (releaseLarge === undefined) {
          return deny(
            'large_bodies',
            rpcError(429, MCP_ERROR_CODES.invalidRequest, 'Too many large requests at once.', {
              data: { code: 'RATE_LIMITED', retryAfterSeconds: 1 },
              headers: { 'retry-after': '1' },
            }),
          )
        }
        limit = limits.bundleBodyBytes
      }
      const read = await readBounded(c.req.raw.body, limit, limits.bodyTimeoutMs)
      if (read.kind === 'too_large') return tooLarge()
      if (read.kind === 'timeout') {
        return deny(
          'body_timeout',
          rpcError(408, MCP_ERROR_CODES.invalidRequest, 'The request body arrived too slowly.'),
        )
      }
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(read.bytes)
      } catch {
        return deny(
          'parse',
          rpcError(400, MCP_ERROR_CODES.parseError, 'Parse error: the body is not UTF-8.'),
        )
      }
      const json = readJson(text, { depth: limits.jsonDepth, elements: limits.jsonElements })
      if (!json.ok) {
        return json.reason === 'syntax'
          ? deny('parse', rpcError(400, MCP_ERROR_CODES.parseError, 'Parse error.'))
          : deny(
              'invalid_request',
              rpcError(
                400,
                MCP_ERROR_CODES.invalidRequest,
                json.reason === 'duplicate_key'
                  ? 'Invalid Request: an object has a duplicate key.'
                  : 'Invalid Request: the body is nested too deeply or has too many values.',
              ),
            )
      }
      const shaped = checkShape(json.value)
      if ('kind' in shaped) {
        return deny('invalid_request', rpcError(shaped.status, shaped.code, shaped.message))
      }
      const message: RpcMessage = shaped
      record.rpcMethod = message.method
      const toolName =
        typeof message.params?.['name'] === 'string' ? message.params['name'] : undefined
      if (
        read.bytes.byteLength > limits.bodyBytes &&
        !(
          message.method === 'tools/call' &&
          toolName !== undefined &&
          deps.tools.bundleBody(toolName)
        )
      ) {
        return tooLarge()
      }
      const versionHeader = c.req.header(MCP_HEADERS.protocolVersion)
      const classified = classify(message, {
        ...(versionHeader === undefined ? {} : { protocolVersion: versionHeader }),
      })
      if (classified.kind === 'refuse') {
        record.rpcCode = classified.code
        return deny(
          'version',
          rpcError(classified.status, classified.code, classified.message, {
            id: message.id,
            ...(classified.data === undefined ? {} : { data: classified.data }),
          }),
        )
      }
      record.era = classified.kind
      if (classified.version !== undefined) record.protocolVersion = classified.version

      // 4. Rate limits: the grant's bucket of the tool class, and the identity's at twice the rate.
      const rateClass: ToolRateClass =
        message.method === 'tools/call' && toolName !== undefined
          ? (deps.tools.rateClass(toolName) ?? 'read')
          : 'read'
      const bucket = MCP_RATE_LIMITS[rateClass]
      const factor = MCP_RATE_LIMITS.identityFactor
      const grant = grantKey(principal)
      const taken = limiter.take([
        { key: `g:${grant}:${rateClass}`, limit: bucket },
        {
          key: `i:${principal.identityId}:${rateClass}`,
          limit: { perSecond: bucket.perSecond * factor, burst: bucket.burst * factor },
        },
      ])
      if (!taken.ok) {
        return deny(
          'rate_limited',
          rpcError(
            429,
            MCP_ERROR_CODES.invalidRequest,
            'Rate limited: retry after the time in Retry-After.',
            {
              data: { code: 'RATE_LIMITED', retryAfterSeconds: taken.retryAfterSeconds },
              headers: { 'retry-after': String(taken.retryAfterSeconds) },
            },
          ),
        )
      }

      // The grant's last use, by tool class (data basis only, decision 10): in the background.
      deps.application.noteGrantUse(caller, rateClass)

      // A notification is acknowledged here: stateless serving has nothing it could act on
      // (a cancellation reaches a fresh instance; closing the connection is what cancels).
      if (message.id === undefined) {
        return new Response(null, { status: 202 })
      }

      // 5. Dispatch to a fresh SDK server with a reduced request.
      const controller = new AbortController()
      const follow = (signal: AbortSignal) => {
        if (signal.aborted) controller.abort()
        else signal.addEventListener('abort', () => controller.abort(), { once: true })
      }
      follow(c.req.raw.signal)
      const envelope = message.params?.['_meta']
      const capabilities =
        classified.kind === 'modern' && typeof envelope === 'object' && envelope !== null
          ? ((envelope as globalThis.Record<string, unknown>)[MCP_META_KEYS.clientCapabilities] as
              | Readonly<globalThis.Record<string, unknown>>
              | undefined)
          : undefined
      const ctx: McpCallContext = {
        requestId,
        era: classified.kind,
        principal,
        caller,
        clientCapabilities: capabilities,
        signal: controller.signal,
        follow,
      }
      record.ctx = ctx
      const headers = new Headers({
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      })
      for (const name of [MCP_HEADERS.protocolVersion, MCP_HEADERS.method, MCP_HEADERS.name]) {
        const value = c.req.header(name)
        if (value !== undefined) headers.set(name, value)
      }
      const request = new Request(resource, {
        method: 'POST',
        headers,
        body: text,
        signal: controller.signal,
      })
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), limits.requestTimeoutMs)
      })
      let answered: Response | 'timeout'
      try {
        answered = await Promise.race([
          handler.fetch(request, { authInfo: authInfoOf(ctx, resource), parsedBody: json.value }),
          timeout,
        ])
      } finally {
        clearTimeout(timer)
      }
      if (answered === 'timeout') {
        controller.abort()
        return deny(
          'timeout',
          rpcError(
            504,
            MCP_ERROR_CODES.internalError,
            'The request took too long and was canceled. A read ends with it; an operation that was already accepted continues: observe it with operation_get.',
            { id: message.id },
          ),
        )
      }
      if (ctx.challenge !== undefined) {
        const refused = toolError({
          code: 'INSUFFICIENT_SCOPE',
          requestId,
          details: { requiredScope: ctx.challenge.required },
        })
        const response = rpcError(403, MCP_ERROR_CODES.invalidRequest, 'Insufficient scope.', {
          data: refused,
        })
        response.headers.set(
          'www-authenticate',
          challenge('insufficient_scope', ctx.challenge.scopes),
        )
        return deny('insufficient_scope', response)
      }
      return await shape(answered, accept, message, classified.kind)
    } finally {
      releaseLarge?.()
    }
  }

  /** The SDK's answer in the form the client accepts, with ExponetDB's headers only. */
  async function shape(
    response: Response,
    accept: { readonly json: boolean; readonly sse: boolean },
    message: RpcMessage,
    era: McpEra,
  ): Promise<Response> {
    const type = mediaType(response.headers.get('content-type') ?? undefined)
    if (response.status === 202 || response.body === null) {
      await response.body?.cancel().catch(() => undefined)
      return new Response(null, { status: response.status })
    }
    // The SDK answers a missing resource with -32602 on every revision; the
    // legacy revisions say -32002 (protocol-baseline.md L-18).
    const legacyRead = era === 'legacy' && message.method === 'resources/read'
    if (type === 'text/event-stream' && !legacyRead) {
      // A modern stream (`subscriptions/listen`: the acknowledgment, then the
      // completion) stays a stream for a client that takes one; a legacy answer
      // is one message the SDK frames as SSE, and becomes JSON when JSON is accepted.
      if (accept.sse && (!accept.json || era === 'modern')) {
        return new Response(response.body, {
          status: response.status,
          headers: { 'content-type': 'text/event-stream', 'x-accel-buffering': 'no' },
        })
      }
    }
    if (type !== 'text/event-stream' && accept.json && !legacyRead) {
      return new Response(response.body, {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      })
    }
    // One message, reshaped.
    const read = await readBounded(response.body, 64 * 1024 * 1024, limits.requestTimeoutMs)
    const text = read.kind === 'ok' ? new TextDecoder().decode(read.bytes) : undefined
    let data =
      text === undefined || message.id === undefined
        ? undefined
        : type === 'text/event-stream'
          ? responseFromSse(text, message.id)
          : text
    if (data === undefined) {
      deps.logger.error('mcp.response_shape_failed', { status: response.status })
      return rpcError(500, MCP_ERROR_CODES.internalError, 'Internal error.', { id: message.id })
    }
    if (legacyRead) {
      data = legacyResourceNotFound(data)
    }
    if (accept.json) {
      return new Response(data, {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      })
    }
    // The client takes SSE only: one event with the JSON answer.
    return new Response(`event: message\ndata: ${data.replace(/\r?\n/g, '')}\n\n`, {
      status: response.status,
      headers: { 'content-type': 'text/event-stream', 'x-accel-buffering': 'no' },
    })
  }

  app.all(MCP_PATH, async (c) => {
    const started = performance.now()
    const record: Record = {}
    let response: Response
    try {
      response = await serve(c, record)
    } catch (error) {
      deps.logger.error('mcp.request_failed', { ...describeError(error) })
      response = rpcError(500, MCP_ERROR_CODES.internalError, 'Internal error.')
    }
    const durationMs = Math.round(performance.now() - started)
    const ctx = record.ctx
    const credential = ctx?.principal.delegation.credential
    deps.metrics.requests.inc({
      era: record.era ?? 'none',
      status_class: statusClass(response.status),
    })
    if (record.denial !== undefined) {
      deps.metrics.denied.inc({ reason: record.denial })
    }
    if (ctx?.tool !== undefined) {
      deps.metrics.toolCalls.inc({
        tool: ctx.tool,
        outcome: ctx.outcome ?? 'INTERNAL',
        era: ctx.era,
      })
      deps.metrics.toolDuration.observe({ tool: ctx.tool }, durationMs / 1000)
    }
    deps.logger.info('mcp.request', {
      route: MCP_PATH,
      method: c.req.method,
      status: response.status,
      durationMs,
      era: record.era,
      protocolVersion: record.protocolVersion,
      rpcMethod: record.rpcMethod,
      rpcCode: record.rpcCode,
      tool: ctx?.tool,
      toolVersion: ctx?.toolVersion,
      catalogDigest: ctx?.catalogDigest,
      outcome: ctx?.outcome,
      reason: record.denial,
      grantId: credential?.type === 'access_token' ? credential.grantId : undefined,
      clientId: credential?.type === 'access_token' ? credential.clientId : undefined,
    })
    return response
  })
  return handler
}

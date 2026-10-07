import {
  createSecureServer,
  type Http2SecureServer,
  constants as http2Constants,
  type IncomingHttpHeaders,
  type ServerHttp2Session,
  type ServerHttp2Stream,
} from 'node:http2'
import type { AddressInfo } from 'node:net'
import type { TLSSocket } from 'node:tls'
import type { AgentApi, Presented } from '@exponetdb/application'
import {
  ClaimRequestSchema,
  ClaimResponseSchema,
  EnrollRequestSchema,
  EnrollResponseSchema,
  errorDefinition,
  HeartbeatRequestSchema,
  HeartbeatResponseSchema,
  HelloRequestSchema,
  HelloResponseSchema,
  isErrorCode,
  JobCompleteRequestSchema,
  JobCompleteResponseSchema,
  JobProgressRequestSchema,
  JobProgressResponseSchema,
  JobStartRequestSchema,
  JobStartResponseSchema,
  NODE_PROTOCOL_ID,
  NODE_PROTOCOL_LIMITS,
  type NodeProtocolError,
  RenewRequestSchema,
  RenewResponseSchema,
} from '@exponetdb/contracts'
import { type JsonValue, parseJson } from '@exponetdb/kernel'
import type { Logger } from '@exponetdb/observability'

/**
 * The gateway's agent listener ([control-plane.md §5](../../../../../exponetdb-docs/07-node-agent/control-plane.md#5-gateway),
 * [protocol.md §1](../../../../../exponetdb-docs/07-node-agent/protocol.md#1-transport)):
 * HTTP/2 over TLS 1.3 only (ALPN `h2`, no HTTP/1.1), the gateway's chain up to
 * and including the root, client certificates requested and verified by TLS
 * against the agent root (the issuing CA allows `clientAuth` only, so OpenSSL's
 * client purpose check refuses anything else). `enroll` takes no client
 * certificate; every other endpoint requires a verified one, and the
 * application checks that it is the node's current certificate.
 *
 * Per request: POST only, the protocol and agent-version headers, JSON
 * within the route's size limit and the body deadline, strict JSON without
 * U+0000 (which jsonb cannot store), the message schema; the response is
 * checked against its schema before it is sent. Errors are the catalog's
 * codes, never internal text.
 *
 * Bounds (Phase 3 review): at most `MAX_CONNECTIONS` connections and
 * `BUFFERED_BYTES_MAX` of request bodies in flight across all of them (a
 * body over the budget or the deadline has its stream reset, which the
 * agent retries); a session without a verified client certificate gets one
 * stream and is closed after its request, and each address gets
 * `ANONYMOUS_PER_MINUTE` such requests.
 */

const MAX_CONNECTIONS = 1024
const BUFFERED_BYTES_MAX = 64 * 1024 * 1024
const ANONYMOUS_PER_MINUTE = 20
const AGENT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
/** Refusals worth an operator's attention, logged at info with the ids. */
const NOTABLE = new Set([
  'NODE_ENROLLMENT_REFUSED',
  'NODE_PROOF_INVALID',
  'NODE_CERTIFICATE_REFUSED',
  'NODE_ALREADY_ENROLLED',
  'RATE_LIMITED',
])

export interface AgentIdentity {
  /** The gateway certificate, the server CA and the root, PEM. */
  readonly certificateChainPem: string
  readonly privateKeyPem: string
}

export interface AgentListenerOptions {
  readonly host: string
  readonly port: number
  readonly identity: AgentIdentity
  /** The agent root, PEM: the trust anchor for client certificates. */
  readonly clientRootPem: string
  readonly api: AgentApi
  readonly logger: Logger
  /** The body deadline (tests); NODE_PROTOCOL_LIMITS.bodySecondsMax otherwise. */
  readonly bodyDeadlineMs?: number
}

export interface AgentListener {
  readonly port: number
  /** Swaps the gateway's TLS identity for new connections. */
  setIdentity(identity: AgentIdentity): void
  close(timeoutMs: number): Promise<void>
}

class Refusal extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.code = code
  }
}

type Handler = (
  body: unknown,
  presented: Presented | undefined,
  jobId: string | undefined,
  signal: AbortSignal,
) => Promise<unknown>

/** A stream that ends without an answer (reset): the agent retries. */
class Reset extends Error {}

/** What a contract schema offers here: a checked parse. */
interface Schema {
  safeParse(value: unknown): { readonly success: boolean; readonly data?: unknown }
}

interface Route {
  readonly request: Schema
  readonly response: Schema
  readonly limit: number
  /** Enrollment is the only request without a client certificate. */
  readonly anonymous: boolean
  readonly handle: Handler
}

const JOB_PATH = /^\/agent\/v1\/jobs\/(job_[0-7][0-9A-HJKMNP-TV-Z]{25})\/(start|progress|complete)$/

function routes(api: AgentApi): {
  readonly fixed: Readonly<Record<string, Route>>
  readonly job: Readonly<Record<string, Route>>
} {
  const limit = NODE_PROTOCOL_LIMITS.requestBytes
  const node = (p: Presented | undefined): Presented => {
    if (p === undefined) {
      throw new Refusal('NODE_CERTIFICATE_REFUSED')
    }
    return p
  }
  const job = (id: string | undefined): string => {
    if (id === undefined) {
      throw new Refusal('NOT_FOUND')
    }
    return id
  }
  return {
    fixed: {
      '/agent/v1/enroll': {
        request: EnrollRequestSchema,
        response: EnrollResponseSchema,
        limit: NODE_PROTOCOL_LIMITS.enrollBytes,
        anonymous: true,
        handle: (b) => api.enroll(EnrollRequestSchema.parse(b)),
      },
      '/agent/v1/hello': {
        request: HelloRequestSchema,
        response: HelloResponseSchema,
        limit,
        anonymous: false,
        handle: (b, p) => api.hello(node(p), HelloRequestSchema.parse(b)),
      },
      '/agent/v1/heartbeat': {
        request: HeartbeatRequestSchema,
        response: HeartbeatResponseSchema,
        limit: NODE_PROTOCOL_LIMITS.heartbeatBytes,
        anonymous: false,
        handle: (b, p) => api.heartbeat(node(p), HeartbeatRequestSchema.parse(b)),
      },
      '/agent/v1/jobs/claim': {
        request: ClaimRequestSchema,
        response: ClaimResponseSchema,
        limit,
        anonymous: false,
        handle: (b, p, _j, signal) => api.claim(node(p), ClaimRequestSchema.parse(b), signal),
      },
      '/agent/v1/renew': {
        request: RenewRequestSchema,
        response: RenewResponseSchema,
        limit,
        anonymous: false,
        handle: (b, p) => api.renew(node(p), RenewRequestSchema.parse(b)),
      },
    },
    job: {
      start: {
        request: JobStartRequestSchema,
        response: JobStartResponseSchema,
        limit,
        anonymous: false,
        handle: (b, p, j) => api.start(node(p), job(j), JobStartRequestSchema.parse(b)),
      },
      progress: {
        request: JobProgressRequestSchema,
        response: JobProgressResponseSchema,
        limit,
        anonymous: false,
        handle: (b, p, j) => api.progress(node(p), job(j), JobProgressRequestSchema.parse(b)),
      },
      complete: {
        request: JobCompleteRequestSchema,
        response: JobCompleteResponseSchema,
        limit,
        anonymous: false,
        // The completion is stored as received: its nr1 signature covers
        // the members as sent, not a schema's output.
        handle: (b, p, j) =>
          api.complete(node(p), job(j), JobCompleteRequestSchema.parse(b), b as JsonValue),
      },
    },
  }
}

function problem(code: string): { status: number; body: NodeProtocolError } {
  const known = isErrorCode(code) ? code : 'INTERNAL'
  const definition = errorDefinition(known)
  return {
    status: definition.status,
    body: { code: known, message: definition.message, retryable: definition.retryable },
  }
}

function codeOf(error: unknown): string {
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    isErrorCode(error.code)
  ) {
    return error.code
  }
  return 'INTERNAL'
}

/** The verified client certificate, if any: its node id (CN) and DER. */
function presentedOf(stream: ServerHttp2Stream): Presented | undefined {
  const socket = stream.session?.socket as TLSSocket | undefined
  if (socket === undefined || !socket.authorized) {
    return undefined
  }
  const peer = socket.getPeerCertificate(false)
  const cn = peer?.subject?.CN
  if (peer === undefined || typeof cn !== 'string' || !(peer.raw instanceof Buffer)) {
    return undefined
  }
  return { nodeId: cn, certificate: new Uint8Array(peer.raw) }
}

/** Bytes of request bodies buffered across all streams. */
interface Budget {
  used: number
}

function readBody(
  stream: ServerHttp2Stream,
  limit: number,
  budget: Budget,
  deadlineMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (error?: Error) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      budget.used -= size
      if (error === undefined) {
        resolve(Buffer.concat(chunks).toString('utf8'))
        return
      }
      chunks.length = 0
      reject(error)
    }
    const reset = () => {
      finish(new Reset())
      stream.close(http2Constants.NGHTTP2_CANCEL)
    }
    const timer = setTimeout(reset, deadlineMs)
    stream.on('data', (chunk: Buffer) => {
      if (settled) {
        return
      }
      if (size + chunk.length > limit) {
        // Answered by the caller; send() then stops the rest of the body.
        stream.pause()
        finish(new Refusal('VALIDATION_FAILED'))
        return
      }
      if (budget.used + chunk.length > BUFFERED_BYTES_MAX) {
        reset()
        return
      }
      size += chunk.length
      budget.used += chunk.length
      chunks.push(chunk)
    })
    stream.on('end', () => finish())
    stream.on('error', (error) => finish(error))
    stream.on('close', () => finish(new Reset()))
  })
}

/** jsonb cannot store U+0000; a message carrying it is refused, not retried. */
function containsNul(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.includes('\u0000')
  }
  if (Array.isArray(value)) {
    return value.some(containsNul)
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(([k, v]) => k.includes('\u0000') || containsNul(v))
  }
  return false
}

/** Requests without a client certificate per address and minute. */
class AnonymousLimit {
  readonly #seen = new Map<string, { minute: number; count: number }>()

  allow(address: string, nowMs: number): boolean {
    const minute = Math.floor(nowMs / 60_000)
    if (this.#seen.size > 10_000) {
      for (const [k, v] of this.#seen) {
        if (v.minute !== minute) {
          this.#seen.delete(k)
        }
      }
    }
    const entry = this.#seen.get(address)
    if (entry === undefined || entry.minute !== minute) {
      this.#seen.set(address, { minute, count: 1 })
      return true
    }
    entry.count += 1
    return entry.count <= ANONYMOUS_PER_MINUTE
  }
}

function isJsonContentType(value: unknown): boolean {
  const type = String(value ?? '')
    .split(';')[0]
    ?.trim()
    .toLowerCase()
  return type === 'application/json'
}

/** The ids a notable refusal is logged with; never a secret. */
function idsOf(body: unknown, presented: Presented | undefined): Record<string, string> {
  const ids: Record<string, string> = {}
  if (presented !== undefined) {
    ids['nodeId'] = presented.nodeId
  }
  if (body !== null && typeof body === 'object' && 'tokenId' in body) {
    const tokenId = (body as { tokenId: unknown }).tokenId
    if (typeof tokenId === 'string' && /^ent_[0-9A-HJKMNP-TV-Z]{26}$/.test(tokenId)) {
      ids['tokenId'] = tokenId
    }
  }
  return ids
}

function send(stream: ServerHttp2Stream, status: number, body: unknown): void {
  if (stream.destroyed || stream.closed) {
    return
  }
  const data = JSON.stringify(body)
  stream.respond({
    ':status': status,
    'content-type': 'application/json',
    'cache-control': 'no-store',
  })
  // A response before the whole request body (a refusal): once it is sent,
  // RST_STREAM(NO_ERROR) tells the client to stop sending (RFC 9113 §8.1).
  stream.once('finish', () => {
    if (!stream.readableEnded && !stream.closed) {
      stream.close(http2Constants.NGHTTP2_NO_ERROR)
    }
  })
  stream.end(data)
}

interface StreamContext {
  readonly table: ReturnType<typeof routes>
  readonly logger: Logger
  readonly budget: Budget
  readonly anonymous: AnonymousLimit
  readonly bodyDeadlineMs: number
}

async function serveStream(
  ctx: StreamContext,
  stream: ServerHttp2Stream,
  headers: IncomingHttpHeaders,
): Promise<void> {
  const started = Date.now()
  const path = String(headers[':path'] ?? '')
  const jobMatch = JOB_PATH.exec(path)
  const route = jobMatch === null ? ctx.table.fixed[path] : ctx.table.job[jobMatch[2] ?? '']
  const routeName = jobMatch === null ? path : `/agent/v1/jobs/{jobId}/${jobMatch[2]}`
  const controller = new AbortController()
  stream.on('close', () => controller.abort())
  const presented = presentedOf(stream)
  let status = 200
  let code: string | undefined
  let body: unknown
  try {
    if (route === undefined) {
      throw new Refusal('NOT_FOUND')
    }
    if (headers[':method'] !== 'POST') {
      throw new Refusal('NOT_FOUND')
    }
    if (
      headers['x-exponetdb-protocol'] !== NODE_PROTOCOL_ID ||
      !AGENT_VERSION.test(String(headers['x-exponetdb-agent-version'] ?? ''))
    ) {
      throw new Refusal('NODE_PROTOCOL_UNSUPPORTED')
    }
    if (!isJsonContentType(headers['content-type'])) {
      throw new Refusal('VALIDATION_FAILED')
    }
    if (presented === undefined) {
      if (!route.anonymous) {
        throw new Refusal('NODE_CERTIFICATE_REFUSED')
      }
      const address = stream.session?.socket?.remoteAddress ?? 'unknown'
      if (!ctx.anonymous.allow(address, Date.now())) {
        throw new Refusal('RATE_LIMITED')
      }
    }
    const text = await readBody(stream, route.limit, ctx.budget, ctx.bodyDeadlineMs)
    const parsed = parseJson(text)
    if (!parsed.ok || containsNul(parsed.value) || !route.request.safeParse(parsed.value).success) {
      throw new Refusal('VALIDATION_FAILED')
    }
    body = parsed.value
    const result = await route.handle(parsed.value, presented, jobMatch?.[1], controller.signal)
    const checked = route.response.safeParse(result)
    if (!checked.success) {
      throw new Refusal('INTERNAL')
    }
    send(stream, 200, checked.data)
  } catch (error) {
    if (error instanceof Reset) {
      status = 0
      code = 'RESET'
    } else {
      code = codeOf(error)
      const p = problem(code)
      status = p.status
      send(stream, p.status, p.body)
    }
  } finally {
    // A session without a client certificate serves one request.
    if (presented === undefined) {
      stream.session?.close()
    }
    const fields = { route: routeName, method: 'POST', status, durationMs: Date.now() - started }
    if (status >= 500) {
      ctx.logger.warn('agent.request', { ...fields, code })
    } else if (code !== undefined && NOTABLE.has(code)) {
      ctx.logger.info('agent.refused', { ...fields, code, ...idsOf(body, presented) })
    } else {
      ctx.logger.debug('agent.request', code === undefined ? fields : { ...fields, code })
    }
  }
}

export function listenAgentApi(options: AgentListenerOptions): Promise<AgentListener> {
  const table = routes(options.api)
  // The versions belong to every secure context: setSecureContext resets
  // what its options omit, so a swapped identity would otherwise accept
  // TLS 1.2 (Phase 3 review).
  const context = (identity: AgentIdentity) => ({
    key: identity.privateKeyPem,
    cert: identity.certificateChainPem,
    ca: [options.clientRootPem],
    minVersion: 'TLSv1.3' as const,
    maxVersion: 'TLSv1.3' as const,
  })
  const server: Http2SecureServer = createSecureServer({
    ...context(options.identity),
    requestCert: true,
    // Enrollment has no client certificate; every other endpoint checks
    // that TLS verified one (socket.authorized).
    rejectUnauthorized: false,
    allowHTTP1: false,
    ALPNProtocols: ['h2'],
    settings: { maxConcurrentStreams: 16 },
  })
  server.setTimeout(120_000)
  server.maxConnections = MAX_CONNECTIONS
  const ctx: StreamContext = {
    table,
    logger: options.logger,
    budget: { used: 0 },
    anonymous: new AnonymousLimit(),
    bodyDeadlineMs: options.bodyDeadlineMs ?? NODE_PROTOCOL_LIMITS.bodySecondsMax * 1000,
  }
  const sessions = new Set<ServerHttp2Session>()
  server.on('session', (session) => {
    sessions.add(session)
    session.once('close', () => sessions.delete(session))
    if (!(session.socket as TLSSocket).authorized) {
      session.settings({ maxConcurrentStreams: 1 })
    }
  })
  server.on('stream', (stream, headers) => {
    void serveStream(ctx, stream, headers)
  })
  server.on('tlsClientError', () => {
    options.logger.debug('agent.tls_refused', { reason: 'handshake_failed' })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => {
      const address = server.address() as AddressInfo
      resolve({
        port: address.port,
        setIdentity: (identity) => server.setSecureContext(context(identity)),
        close: (timeoutMs) =>
          new Promise<void>((done) => {
            const timer = setTimeout(done, timeoutMs)
            timer.unref()
            server.close(() => {
              clearTimeout(timer)
              done()
            })
            // Agents hold long polls open; ending their sessions lets them
            // reconnect to another gateway.
            for (const session of sessions) {
              session.close()
            }
            setTimeout(() => {
              for (const session of sessions) {
                session.destroy()
              }
            }, timeoutMs / 2).unref()
          }),
      })
    })
  })
}

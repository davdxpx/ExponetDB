import {
  createSecureServer,
  type Http2SecureServer,
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
import { parseJson } from '@exponetdb/kernel'
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
 * Per request: POST only, the protocol header, JSON within the size limit,
 * strict JSON, the message schema; the response is checked against its
 * schema before it is sent. Errors are the catalog's codes, never internal
 * text.
 */

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
        limit,
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
        handle: (b, p, j) => api.complete(node(p), job(j), JobCompleteRequestSchema.parse(b)),
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

function readBody(stream: ServerHttp2Stream, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Refusal('VALIDATION_FAILED'))
        stream.close()
        return
      }
      chunks.push(chunk)
    })
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    stream.on('error', reject)
  })
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
  stream.end(data)
}

async function serveStream(
  table: ReturnType<typeof routes>,
  stream: ServerHttp2Stream,
  headers: IncomingHttpHeaders,
  logger: Logger,
): Promise<void> {
  const started = Date.now()
  const path = String(headers[':path'] ?? '')
  const jobMatch = JOB_PATH.exec(path)
  const route = jobMatch === null ? table.fixed[path] : table.job[jobMatch[2] ?? '']
  const routeName = jobMatch === null ? path : `/agent/v1/jobs/{jobId}/${jobMatch[2]}`
  const controller = new AbortController()
  stream.on('close', () => controller.abort())
  let status = 200
  let code: string | undefined
  try {
    if (route === undefined) {
      throw new Refusal('NOT_FOUND')
    }
    if (headers[':method'] !== 'POST') {
      throw new Refusal('NOT_FOUND')
    }
    if (headers['x-exponetdb-protocol'] !== NODE_PROTOCOL_ID) {
      throw new Refusal('NODE_PROTOCOL_UNSUPPORTED')
    }
    if (!String(headers['content-type'] ?? '').startsWith('application/json')) {
      throw new Refusal('VALIDATION_FAILED')
    }
    const presented = presentedOf(stream)
    if (!route.anonymous && presented === undefined) {
      throw new Refusal('NODE_CERTIFICATE_REFUSED')
    }
    const text = await readBody(stream, route.limit)
    const parsed = parseJson(text)
    if (!parsed.ok || !route.request.safeParse(parsed.value).success) {
      throw new Refusal('VALIDATION_FAILED')
    }
    const result = await route.handle(parsed.value, presented, jobMatch?.[1], controller.signal)
    const checked = route.response.safeParse(result)
    if (!checked.success) {
      throw new Refusal('INTERNAL')
    }
    send(stream, 200, checked.data)
  } catch (error) {
    code = codeOf(error)
    const p = problem(code)
    status = p.status
    send(stream, p.status, p.body)
  } finally {
    const fields = { route: routeName, method: 'POST', status, durationMs: Date.now() - started }
    if (status >= 500) {
      logger.warn('agent.request', { ...fields, code })
    } else {
      logger.debug('agent.request', code === undefined ? fields : { ...fields, code })
    }
  }
}

export function listenAgentApi(options: AgentListenerOptions): Promise<AgentListener> {
  const table = routes(options.api)
  const context = (identity: AgentIdentity) => ({
    key: identity.privateKeyPem,
    cert: identity.certificateChainPem,
    ca: [options.clientRootPem],
  })
  const server: Http2SecureServer = createSecureServer({
    ...context(options.identity),
    requestCert: true,
    // Enrollment has no client certificate; every other endpoint checks
    // that TLS verified one (socket.authorized).
    rejectUnauthorized: false,
    minVersion: 'TLSv1.3',
    maxVersion: 'TLSv1.3',
    allowHTTP1: false,
    ALPNProtocols: ['h2'],
    settings: { maxConcurrentStreams: 16 },
  })
  server.setTimeout(120_000)
  const sessions = new Set<ServerHttp2Session>()
  server.on('session', (session) => {
    sessions.add(session)
    session.once('close', () => sessions.delete(session))
  })
  server.on('stream', (stream, headers) => {
    void serveStream(table, stream, headers, options.logger)
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

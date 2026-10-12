import type { Authenticator } from './auth.ts'
import { OPERATIONS, type OperationId, type Operations } from './generated/api.ts'
import { type ApiError, err, ok, type Result } from './result.ts'

/**
 * The transport (sdk.md §1, order §126): one request per call against the
 * generated operation table, path parameters percent-encoded (a target path
 * is one segment), arrays in the query exploded, JSON in and out, a
 * per-request deadline.
 *
 * - `GET` is retried on no answer, 429, 502, 503 and 504 with bounded
 *   exponential backoff (3 attempts, `Retry-After` honored up to 5 s).
 * - A mutation is sent once. It is never retried by the SDK: a mutation
 *   that did not answer is reported as `TRANSPORT_FAILED`, and the caller
 *   decides (with an `Idempotency-Key` where the route supports one).
 * - A 401 with a renewable credential (a service account token) obtains a
 *   fresh token and sends the same request once more: the server
 *   authenticates before anything runs, so nothing was executed.
 */
export interface TransportOptions {
  readonly baseUrl: string
  readonly auth: Authenticator
  readonly fetch: typeof fetch
  readonly timeoutMs: number
  readonly userAgent: string
  /** Sleeping between retries (tests replace it). */
  readonly sleep: (ms: number) => Promise<void>
  /** The largest answer body read; longer is `RESPONSE_INVALID` (default 8 MiB). */
  readonly maxResponseBytes?: number
  /** Validates a success body against the operation's schema. */
  readonly validate?: (operationId: OperationId, body: unknown) => boolean
}

/** Reads a body up to `limit` bytes; undefined when it is longer or unreadable. */
async function boundedText(response: Response, limit: number): Promise<string | undefined> {
  const declared = response.headers.get('content-length')
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) {
    await response.body?.cancel()
    return undefined
  }
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    bytes.set(c, at)
    at += c.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

type Input<Id extends OperationId> = {
  readonly params?: Operations[Id]['params']
  readonly query?: Operations[Id]['query']
  readonly body?: Operations[Id]['body']
  readonly idempotencyKey?: string
}

const RETRYABLE = new Set([429, 502, 503, 504])
const MAX_ATTEMPTS = 3

function url<Id extends OperationId>(base: string, id: Id, input: Input<Id>): string {
  const op = OPERATIONS[id]
  const params = (input.params ?? {}) as Readonly<Record<string, string>>
  const path = op.path.replace(/\{([A-Za-z]+)\}/g, (_m, name: string) => {
    const value = params[name]
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`missing path parameter ${name}`)
    }
    // A URL parser removes `.` and `..` segments (encoded or not): they would reach another route.
    if (value === '.' || value === '..') {
      throw new TypeError(`path parameter ${name} cannot be ${value}`)
    }
    return encodeURIComponent(value)
  })
  const search = new URLSearchParams()
  for (const [name, value] of Object.entries((input.query ?? {}) as Record<string, unknown>)) {
    if (value === undefined) continue
    for (const v of Array.isArray(value) ? value : [value]) {
      search.append(name, String(v))
    }
  }
  const query = search.toString()
  return `${base.replace(/\/+$/, '')}/api/v1${path}${query.length > 0 ? `?${query}` : ''}`
}

/** Whether a success body has the shape its operation promises (a list is a page). */
function wellFormed(shape: string, body: unknown): boolean {
  if (shape === 'none') return true
  if (shape === 'array') return Array.isArray(body)
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false
  if (shape !== 'paged') return true
  const page = body as { readonly items?: unknown; readonly nextCursor?: unknown }
  return (
    Array.isArray(page.items) &&
    (page.nextCursor === null ||
      (typeof page.nextCursor === 'string' && page.nextCursor.length > 0))
  )
}

function retryAfter(response: Response): number | undefined {
  const raw = response.headers.get('retry-after')
  if (raw === null || !/^\d{1,5}$/.test(raw)) return undefined
  return Number(raw)
}

const text = (record: Record<string, unknown>, name: string): string | undefined =>
  typeof record[name] === 'string' ? record[name] : undefined

/**
 * The problem document (RFC 9457 with the catalog's fields) as an `ApiError`.
 * Only the catalog's fields are kept; anything else in the body is dropped.
 */
async function problem(response: Response, limit: number): Promise<ApiError> {
  let body: unknown
  try {
    const text = await boundedText(response, limit)
    body = text === undefined ? undefined : JSON.parse(text)
  } catch {
    body = undefined
  }
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const code = text(record, 'code')
  const after = retryAfter(response)
  const title = text(record, 'title')
  const message = text(record, 'message')
  const remediation = text(record, 'remediation')
  const operationId = text(record, 'operationId')
  const planId = text(record, 'planId')
  return {
    code: code ?? 'RESPONSE_INVALID',
    status: response.status,
    requestId: text(record, 'requestId') ?? null,
    retryable: code !== undefined && record['retryable'] === true,
    ...(title === undefined ? {} : { title }),
    ...(message === undefined ? {} : { message }),
    ...(record['details'] === undefined ? {} : { details: record['details'] }),
    ...(remediation === undefined ? {} : { remediation }),
    ...(operationId === undefined ? {} : { operationId }),
    ...(planId === undefined ? {} : { planId }),
    ...(after === undefined ? {} : { retryAfterSeconds: after }),
  }
}

export async function request<Id extends OperationId>(
  t: TransportOptions,
  id: Id,
  input: Input<Id> = {},
): Promise<Result<Operations[Id]['response']>> {
  const op: { readonly method: string; readonly status: number; readonly shape: string } =
    OPERATIONS[id]
  const target = url(t.baseUrl, id, input)
  const idempotent = op.method === 'GET'
  let renewed = false
  for (let attempt = 1; ; attempt++) {
    const authorization = await t.auth.header()
    if (!authorization.ok) return err(authorization.error)
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: authorization.value,
      'user-agent': t.userAgent,
    }
    if (input.body !== undefined) headers['content-type'] = 'application/json'
    if (input.idempotencyKey !== undefined) headers['idempotency-key'] = input.idempotencyKey
    let response: Response
    try {
      response = await t.fetch(target, {
        method: op.method,
        headers,
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        signal: AbortSignal.timeout(t.timeoutMs),
        // The API never redirects: a redirect would carry the credential elsewhere.
        redirect: 'error',
      })
    } catch {
      if (idempotent && attempt < MAX_ATTEMPTS) {
        await t.sleep(Math.min(200 * 2 ** (attempt - 1), 2000))
        continue
      }
      return err({ code: 'TRANSPORT_FAILED', status: null, requestId: null, retryable: idempotent })
    }
    const limit = t.maxResponseBytes ?? 8 * 1024 * 1024
    if (response.status === op.status) {
      if (op.status === 204) return ok(undefined as unknown as Operations[Id]['response'])
      try {
        const text = await boundedText(response, limit)
        const body: unknown = text === undefined ? undefined : JSON.parse(text)
        if (
          text !== undefined &&
          wellFormed(op.shape, body) &&
          (t.validate === undefined || t.validate(id, body))
        ) {
          return ok(body as Operations[Id]['response'])
        }
      } catch {
        // Not JSON: not the contract's answer either.
      }
      return err({
        code: 'RESPONSE_INVALID',
        status: response.status,
        requestId: response.headers.get('x-request-id'),
        retryable: false,
      })
    }
    if (response.status === 401 && t.auth.renewable && !renewed) {
      // Authentication happens before anything runs: the same request may be sent again.
      await response.body?.cancel()
      t.auth.invalidate()
      renewed = true
      attempt--
      continue
    }
    if (idempotent && RETRYABLE.has(response.status) && attempt < MAX_ATTEMPTS) {
      const after = retryAfter(response)
      await response.body?.cancel()
      await t.sleep(Math.min((after ?? 0) * 1000 || 200 * 2 ** (attempt - 1), 5000))
      continue
    }
    return err(await problem(response, limit))
  }
}

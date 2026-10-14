import { OPERATIONS, type OperationId, type Operations } from '@exponetdb/sdk/operations'
import { CSRF_HEADER, readCsrf } from './csrf.ts'
import { ApiError, CLIENT_CODES, isSessionGone, networkError, problemOf } from './errors.ts'
import { RequestGate } from './gate.ts'

/**
 * The only way the Web App talks to the server (ADR-0019, order §7): same-
 * origin `fetch` with the session cookie, JSON in and out, the CSRF token
 * read fresh from its cookie for every request, never an `Authorization`
 * header (a cookie plus a bearer is `AMBIGUOUS_CREDENTIALS`), `no-store`.
 * REST calls are typed by the generated operations table of the SDK's
 * browser subpath; `/auth` ceremonies are called by path.
 *
 * A request that answers `SESSION_EXPIRED` while its CSRF token was rotated
 * under it (a re-authentication finished while it was in flight) is sent
 * once more: the server refused it before doing anything. Any other
 * `SESSION_EXPIRED` ends the session in the page (`onSessionGone`).
 */
export const API_BASE = '/api/v1'

export interface ClientDeps {
  readonly fetch: typeof fetch
  /** The current `document.cookie` (read for every request). */
  readonly cookies: () => string
  /** The session is gone: the page leaves for the sign-in page. */
  readonly onSessionGone: () => void
  readonly gate?: RequestGate
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type Params<Id extends OperationId> = Operations[Id]['params']
export type Query<Id extends OperationId> = Operations[Id]['query']
export type Body<Id extends OperationId> = Operations[Id]['body']
export type ResponseOf<Id extends OperationId> = Operations[Id]['response']

export interface OperationInput<Id extends OperationId> {
  readonly params?: Params<Id>
  readonly query?: Query<Id>
  readonly body?: Body<Id>
  readonly signal?: AbortSignal
}

/** `/targets/{target}` with each parameter percent-encoded as one path segment. */
export function fillPath(template: string, params: Readonly<Record<string, string>> = {}): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (_, name: string) => {
    const value = params[name]
    if (value === undefined || value.length === 0) {
      throw new TypeError(`missing path parameter ${name}`)
    }
    return encodeURIComponent(value)
  })
}

/** A query string from defined values only; arrays repeat the key. */
export function queryString(query: Readonly<Record<string, unknown>> = {}): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    for (const item of Array.isArray(value) ? value : [value]) {
      search.append(key, String(item))
    }
  }
  const text = search.toString()
  return text.length === 0 ? '' : `?${text}`
}

/**
 * A body that is not JSON: raw bytes with their exact content type (a profile
 * picture). Sent with the same cookie, CSRF header and error handling as a
 * JSON call, never with an `Authorization` header.
 */
export class RawBody {
  readonly bytes: Blob | ArrayBuffer | Uint8Array
  readonly contentType: string
  constructor(bytes: Blob | ArrayBuffer | Uint8Array, contentType: string) {
    this.bytes = bytes
    this.contentType = contentType
  }
}

export class ApiClient {
  readonly gate: RequestGate
  readonly #deps: ClientDeps

  constructor(deps: ClientDeps) {
    this.#deps = deps
    this.gate = deps.gate ?? new RequestGate()
  }

  /** A REST operation of `/api/v1`, typed by the generated operations table. */
  operation<Id extends OperationId>(
    id: Id,
    input: OperationInput<Id> = {},
  ): Promise<ResponseOf<Id>> {
    const op = OPERATIONS[id]
    const path = `${API_BASE}${fillPath(op.path, input.params as Readonly<Record<string, string>>)}${queryString(input.query as Readonly<Record<string, unknown>>)}`
    return this.send<ResponseOf<Id>>(op.method, path, input.body, input.signal)
  }

  /**
   * A REST operation whose success answer is not JSON (`shape: none`, such as
   * the NDJSON audit export): the body as text. Failures are read as problems
   * like every other answer; the same headers, never an `Authorization`.
   */
  operationText<Id extends OperationId>(id: Id, input: OperationInput<Id> = {}): Promise<string> {
    const op = OPERATIONS[id]
    const path = `${API_BASE}${fillPath(op.path, input.params as Readonly<Record<string, string>>)}${queryString(input.query as Readonly<Record<string, unknown>>)}`
    return this.gate.run(() =>
      this.#attempt<string>(op.method, path, input.body, input.signal, true, 'text'),
    )
  }

  /** A `/auth` ceremony (outside OpenAPI): always `POST`. */
  ceremony<T>(path: `/auth/${string}`, body?: unknown, signal?: AbortSignal): Promise<T> {
    return this.send<T>('POST', path, body ?? {}, signal)
  }

  /**
   * A `/auth` ceremony sent while a re-authentication holds the gate (the
   * re-authentication dialog's own requests). Only the gate's holder uses it.
   */
  ceremonyBypassingGate<T>(path: `/auth/${string}`, body?: unknown): Promise<T> {
    return this.#attempt<T>('POST', path, body ?? {}, undefined, true)
  }

  /** A call whose body is raw bytes with a content type of its own (`PUT /me/avatar`). */
  sendRaw<T>(
    method: 'PUT' | 'POST',
    path: string,
    body: RawBody,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.send<T>(method, path, body, signal)
  }

  send<T>(method: Method, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return this.gate.run(() => this.#attempt<T>(method, path, body, signal, true))
  }

  async #attempt<T>(
    method: Method,
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    mayRetry: boolean,
    expect: 'json' | 'text' = 'json',
  ): Promise<T> {
    const csrf = readCsrf(this.#deps.cookies())
    const headers: Record<string, string> = {
      accept: expect === 'text' ? 'application/x-ndjson, application/json' : 'application/json',
    }
    if (csrf !== undefined) {
      headers[CSRF_HEADER] = csrf
    }
    const init: RequestInit = { method, headers, credentials: 'same-origin', cache: 'no-store' }
    if (signal !== undefined) init.signal = signal
    if (method !== 'GET' && method !== 'DELETE') {
      if (body instanceof RawBody) {
        headers['content-type'] = body.contentType
        init.body = body.bytes as BodyInit
      } else {
        headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body ?? {})
      }
    }
    let response: Response
    try {
      response = await this.#deps.fetch(path, init)
    } catch (error) {
      if (signal?.aborted === true) throw error
      throw networkError()
    }
    const text = await response.text().catch(() => '')
    let parsed: unknown
    try {
      parsed = text.length === 0 ? undefined : JSON.parse(text)
    } catch {
      parsed = undefined
    }
    if (!response.ok) {
      const error = problemOf(response.status, parsed, response.headers.get('retry-after'))
      if (isSessionGone(error)) {
        const now = readCsrf(this.#deps.cookies())
        if (mayRetry && now !== undefined && now !== csrf) {
          return this.#attempt<T>(method, path, body, signal, false, expect)
        }
        this.#deps.onSessionGone()
      }
      throw error
    }
    if (expect === 'text') {
      return text as T
    }
    if (text.length > 0 && parsed === undefined) {
      throw new ApiError(
        CLIENT_CODES.RESPONSE_INVALID,
        response.status,
        'The server sent an answer the page cannot read.',
      )
    }
    // The server validates every response against the contract before it sends it.
    return parsed as T
  }
}

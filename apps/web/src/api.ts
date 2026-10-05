import { CSRF_HEADER, csrfToken } from './safe.ts'

/**
 * The only way the page talks to the server: same-origin `fetch` with the
 * session cookie, JSON bodies, and the CSRF header on every request (the
 * server requires it for session-bound changes). Errors arrive as RFC 9457
 * problems whose title and message come from the server's error catalog,
 * never from exception text, so they can be shown as they are.
 */
export class ApiError extends Error {
  override readonly name = 'ApiError'
  readonly code: string
  readonly status: number
  readonly retryAfterSeconds: number | undefined
  readonly details: unknown

  constructor(
    code: string,
    status: number,
    message: string,
    retryAfterSeconds: number | undefined,
    details: unknown,
  ) {
    super(message)
    this.code = code
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
    this.details = details
  }
}

type Method = 'GET' | 'POST' | 'DELETE'

function problemOf(status: number, body: unknown, retryAfter: string | null): ApiError {
  const record = typeof body === 'object' && body !== null ? body : {}
  const code = 'code' in record && typeof record.code === 'string' ? record.code : 'INTERNAL'
  const message =
    'message' in record && typeof record.message === 'string'
      ? record.message
      : 'The request failed.'
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter)
  return new ApiError(
    code,
    status,
    message,
    Number.isFinite(seconds) ? seconds : undefined,
    'details' in record ? record.details : undefined,
  )
}

export async function call<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' }
  const csrf = csrfToken(document.cookie)
  if (csrf !== undefined) {
    headers[CSRF_HEADER] = csrf
  }
  const init: RequestInit = { method, headers, credentials: 'same-origin', cache: 'no-store' }
  if (method !== 'GET') {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body ?? {})
  }
  let response: Response
  try {
    response = await fetch(path, init)
  } catch {
    throw new ApiError('NETWORK', 0, 'The server could not be reached.', undefined, undefined)
  }
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    parsed = undefined
  }
  if (!response.ok) {
    throw problemOf(response.status, parsed, response.headers.get('retry-after'))
  }
  // The server validates every response against the contract before it sends it.
  return parsed as T
}

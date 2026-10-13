import { BlockList, isIP } from 'node:net'
import { buildProblem, type ErrorCode, isErrorCode } from '@exponetdb/contracts'
import type { RequestId } from '@exponetdb/kernel'

/**
 * Request-level helpers of the authenticated interfaces: cookies, the client
 * address behind trusted proxies, and problem responses. Nothing here
 * decides authorization.
 */

// ----- cookies (rest architecture §6, identity.md §3) -----

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (header === undefined || header.length > 8192) {
    return out
  }
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) {
      continue
    }
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    // A duplicate name is ambiguous: the first one wins, as browsers order most specific first.
    if (!out.has(name) && /^[A-Za-z0-9_-]{1,96}$/.test(value)) {
      out.set(name, value)
    }
  }
  return out
}

/**
 * `__Host-` cookies: `Secure`, `Path=/`, no `Domain`, `SameSite=Strict`.
 * The CSRF cookie is the only one the page can read (double submit).
 */
export function setCookie(
  name: string,
  value: string,
  options: { readonly maxAgeSeconds: number; readonly httpOnly: boolean },
): string {
  return [
    `${name}=${value}`,
    'Path=/',
    'Secure',
    ...(options.httpOnly ? ['HttpOnly'] : []),
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
  ].join('; ')
}

export function clearCookie(name: string, httpOnly: boolean): string {
  return setCookie(name, '', { maxAgeSeconds: 0, httpOnly })
}

// ----- client address -----

function normalize(ip: string): string {
  return ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip
}

/**
 * Parses a trusted-proxy entry: an IPv4 or IPv6 address, or a CIDR range of
 * either family. Undefined for anything else (the configuration refuses it).
 */
export function parseProxyEntry(
  entry: string,
):
  | { readonly address: string; readonly prefix: number; readonly family: 'ipv4' | 'ipv6' }
  | undefined {
  const [base = '', bitsText, extra] = entry.split('/')
  const version = isIP(base)
  if (extra !== undefined || version === 0) {
    return undefined
  }
  const family = version === 4 ? 'ipv4' : 'ipv6'
  const max = version === 4 ? 32 : 128
  if (bitsText === undefined) {
    return { address: base, prefix: max, family }
  }
  if (!/^\d{1,3}$/.test(bitsText) || Number(bitsText) > max) {
    return undefined
  }
  return { address: base, prefix: Number(bitsText), family }
}

/** Whether `ip` is one of the configured proxies (exact address or CIDR range, IPv4 or IPv6). */
export function isTrustedProxy(ip: string, proxies: readonly string[]): boolean {
  const address = normalize(ip)
  const version = isIP(address)
  if (version === 0) {
    return false
  }
  const list = new BlockList()
  for (const entry of proxies) {
    const parsed = parseProxyEntry(entry)
    if (parsed !== undefined) {
      list.addSubnet(parsed.address, parsed.prefix, parsed.family)
    }
  }
  return list.check(address, version === 4 ? 'ipv4' : 'ipv6')
}

/**
 * The client address: the TCP peer, unless the peer is a configured
 * trusted proxy; then the right-most `X-Forwarded-For` entry that is not a
 * trusted proxy. A header from an untrusted peer is ignored entirely.
 */
export function clientAddress(
  peer: string | undefined,
  forwardedFor: string | undefined,
  proxies: readonly string[],
): string | undefined {
  if (peer === undefined) {
    return undefined
  }
  if (!isTrustedProxy(peer, proxies) || forwardedFor === undefined) {
    return normalize(peer)
  }
  const hops = forwardedFor
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0)
    .slice(-16)
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i] ?? ''
    if (isIP(hop) === 0) {
      return normalize(peer)
    }
    if (!isTrustedProxy(hop, proxies)) {
      return normalize(hop)
    }
  }
  return normalize(peer)
}

// ----- problems -----

/** A refusal raised by the interface itself (credential mode, Origin, CSRF, validation). */
export class HttpRefusal extends Error {
  override readonly name = 'HttpRefusal'
  readonly code: ErrorCode
  readonly details: unknown
  constructor(code: ErrorCode, details?: unknown) {
    super(code)
    this.code = code
    this.details = details
  }
}

/** The catalog code of an error from the application, auth or operations layers; anything else is internal. */
export function errorCodeOf(error: unknown): ErrorCode {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    isErrorCode(error.code)
  ) {
    return error.code
  }
  return 'INTERNAL'
}

export function detailsOf(
  error: unknown,
  code: ErrorCode,
  context: { readonly planId?: string; readonly retryAfterSeconds?: number },
): unknown {
  if (!(error instanceof Error)) {
    return undefined
  }
  if (code === 'RATE_LIMITED') {
    // The wait of the Retry-After header, also in the body (MCP has no header).
    const after =
      context.retryAfterSeconds ??
      ('retryAfterSeconds' in error && typeof error.retryAfterSeconds === 'number'
        ? error.retryAfterSeconds
        : undefined)
    if (after !== undefined) {
      return { retryAfterSeconds: Math.max(1, Math.ceil(after)) }
    }
  }
  if (code === 'PLAN_STALE' && 'changedBindings' in error && Array.isArray(error.changedBindings)) {
    return context.planId === undefined
      ? undefined
      : { planId: context.planId, changedBindings: error.changedBindings.slice(0, 32) }
  }
  return 'details' in error ? error.details : undefined
}

export function problemResponse(
  requestId: RequestId,
  error: unknown,
  context: { readonly planId?: string; readonly retryAfterSeconds?: number } = {},
): Response {
  let code = errorCodeOf(error)
  let details = detailsOf(error, code, context)
  if (code === 'VALIDATION_FAILED' && details === undefined) {
    details = { errors: [{ path: '', code: 'invalid', message: 'The request is not valid.' }] }
  }
  let built = buildProblem(code, { requestId, ...(details === undefined ? {} : { details }) })
  if (!built.ok) {
    // Details that do not match the catalog are never sent; the code is kept only if it needs none.
    built = buildProblem(code, { requestId })
    if (!built.ok) {
      code = 'INTERNAL'
      built = buildProblem('INTERNAL', { requestId })
    }
  }
  const body = built.ok ? built.value : { code: 'INTERNAL', requestId }
  const headers: Record<string, string> = { 'content-type': 'application/problem+json' }
  if (code === 'RATE_LIMITED' && context.retryAfterSeconds !== undefined) {
    headers['retry-after'] = String(Math.max(1, Math.ceil(context.retryAfterSeconds)))
  }
  return new Response(JSON.stringify(body), {
    status: built.ok ? built.value.status : 500,
    headers,
  })
}

/**
 * Reads a request body as UTF-8 text, never holding more than `limit` bytes:
 * the stream is counted as it arrives and cancelled once it exceeds the
 * limit, whatever `Content-Length` claims (or whether it is sent at all, as
 * with chunked transfer). Undefined when too large or not valid UTF-8.
 */
export async function readLimitedText(
  request: Request,
  limit: number,
): Promise<string | undefined> {
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d{1,12}$/.test(declared) || Number(declared) > limit)) {
    return undefined
  }
  if (request.body === null) {
    return ''
  }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => undefined)
      return undefined
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

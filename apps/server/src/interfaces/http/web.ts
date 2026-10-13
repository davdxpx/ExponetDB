import type { Context, Hono } from 'hono'
import type { HttpEnv } from './env.ts'

/**
 * The Web App: static files built from `apps/web`, served by `serve` on the
 * public origin ([ADR-0031](../../../../../exponetdb-docs/01-architecture/adr/0031-web-app-serving.md)).
 *
 * - The page (`index.html`) answers every client route: a `GET` or `HEAD`
 *   for a path outside the API, protocol and probe namespaces whose last
 *   segment has no dot (the SPA fallback). Unknown paths inside those
 *   namespaces, and file-like paths, stay `NOT_FOUND` problems.
 * - Assets live under `/assets/`. The entry files (`app.js`, `app.css`)
 *   and everything outside `chunks/` and `files/` are `no-store`; the
 *   content-hashed files under `/assets/chunks/` and `/assets/files/` are
 *   immutable.
 * - Precompressed variants (`.br`, `.gz`) built next to a file are served
 *   when the request accepts them.
 *
 * The page loads only its own scripts, styles, fonts and workers: no
 * third-party script, font, analytics or QR service. The CSP allows only
 * same-origin scripts, styles, fonts, workers and requests, no inline script
 * or style, no framing, no form posts elsewhere.
 */
export interface WebAsset {
  readonly body: Uint8Array<ArrayBuffer>
  readonly type: string
  /** Precompressed variants built next to the file. */
  readonly encodings?: {
    readonly br?: Uint8Array<ArrayBuffer>
    readonly gzip?: Uint8Array<ArrayBuffer>
  }
}

/** `index.html` plus the assets keyed by their path below `/assets/` (`app.js`, `chunks/route-AbC1.js`). */
export type WebAssets = ReadonlyMap<string, WebAsset>

export const WEB_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "worker-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ')

/**
 * Namespaces the SPA fallback never answers: the API, the `/auth`
 * ceremonies, the OAuth protocol endpoints (apart from the three ceremony
 * pages in `WEB_OAUTH_PAGES`), MCP, well-known metadata, probes, metrics,
 * the public schemas and the assets themselves. An unknown path inside them
 * is a `NOT_FOUND` problem, never the page.
 */
export const WEB_FALLBACK_EXCLUDED = [
  '/api',
  '/auth',
  '/oauth',
  '/mcp',
  '/.well-known',
  '/healthz',
  '/metrics',
  '/schemas',
  '/assets',
] as const

/** The pages of the OAuth ceremonies: the only page paths inside an excluded namespace. */
export const WEB_OAUTH_PAGES = ['/oauth/consent', '/oauth/device', '/oauth/error'] as const

const IMMUTABLE_PREFIXES = ['chunks/', 'files/'] as const

const SECURITY_HEADERS = {
  'content-security-policy': WEB_CSP,
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy':
    'publickey-credentials-get=(self), publickey-credentials-create=(self), camera=(), microphone=(), geolocation=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
} as const

const NO_STORE = 'no-store'
const IMMUTABLE = 'public, max-age=31536000, immutable'

/** Whether the SPA fallback answers `path` with the page. */
export function isPagePath(path: string): boolean {
  // Repeated slashes and letter case never move a path out of a namespace.
  const normalized = path.replace(/\/{2,}/g, '/').toLowerCase()
  if ((WEB_OAUTH_PAGES as readonly string[]).includes(normalized)) {
    return true
  }
  if (
    WEB_FALLBACK_EXCLUDED.some(
      (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
    )
  ) {
    return false
  }
  const last = normalized.slice(normalized.lastIndexOf('/') + 1)
  return !last.includes('.')
}

/** The encoding to send for an `Accept-Encoding` value: `br` before `gzip`, never one with `q=0`. */
export function chooseEncoding(
  acceptEncoding: string | undefined,
  available: WebAsset['encodings'],
): 'br' | 'gzip' | undefined {
  if (acceptEncoding === undefined || available === undefined) {
    return undefined
  }
  const accepted = new Set<string>()
  for (const part of acceptEncoding.split(',')) {
    const [token = '', ...params] = part.trim().toLowerCase().split(';')
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='))
    if (q !== undefined && !(Number(q.slice(2)) > 0)) {
      continue
    }
    accepted.add(token.trim())
  }
  if (available.br !== undefined && accepted.has('br')) {
    return 'br'
  }
  if (available.gzip !== undefined && accepted.has('gzip')) {
    return 'gzip'
  }
  return undefined
}

function respond(c: Context<HttpEnv>, asset: WebAsset, cacheControl: string): Response {
  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    'cache-control': cacheControl,
    'content-type': asset.type,
  }
  let body = asset.body
  if (asset.encodings !== undefined) {
    headers['vary'] = 'accept-encoding'
    const encoding = chooseEncoding(c.req.header('accept-encoding'), asset.encodings)
    const encoded = encoding === undefined ? undefined : asset.encodings[encoding]
    if (encoding !== undefined && encoded !== undefined) {
      headers['content-encoding'] = encoding
      body = encoded
    }
  }
  // A Response takes a copy of a byte source (Fetch "extract a body"), so the stored bytes are
  // never handed out and need no copy here.
  return new Response(body, { headers })
}

export function mountWeb(app: Hono<HttpEnv>, assets: WebAssets): void {
  const page = assets.get('index.html')
  if (page === undefined) {
    return
  }
  app.get('/assets/*', (c, next) => {
    const key = c.req.path.slice('/assets/'.length)
    const asset = key === 'index.html' ? undefined : assets.get(key)
    if (asset === undefined) {
      return next()
    }
    const immutable = IMMUTABLE_PREFIXES.some((prefix) => key.startsWith(prefix))
    return respond(c, asset, immutable ? IMMUTABLE : NO_STORE)
  })
  // Registered last: every route of the API, the protocols and the probes matches first.
  app.get('*', (c, next) => (isPagePath(c.req.path) ? respond(c, page, NO_STORE) : next()))
}

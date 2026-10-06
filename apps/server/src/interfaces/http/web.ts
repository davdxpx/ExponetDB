import type { Hono } from 'hono'
import type { HttpEnv } from './env.ts'

/**
 * The minimal Web App of Wave 3A (sign-in, enrollment, own account): static
 * files built from `apps/web`, served by `serve` on the public origin. The
 * page loads only its own script and stylesheet: no third-party script,
 * font, analytics or QR service. Every response is `no-store`; the CSP
 * allows only same-origin scripts, styles and requests, no inline script,
 * no framing, no form posts elsewhere.
 */
export interface WebAsset {
  readonly body: Uint8Array
  readonly type: string
}

export type WebAssets = ReadonlyMap<string, WebAsset>

/** Client routes of the single page (the server answers them with the page itself). */
export const WEB_PAGES = [
  '/',
  '/login',
  '/setup',
  '/invite',
  '/recover',
  '/account',
  '/approvals',
  '/oauth/consent',
  '/oauth/device',
  '/oauth/error',
  '/admin/clients',
  '/admin/service-accounts',
] as const

export const WEB_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ')

const PAGE_HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy': WEB_CSP,
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy':
    'publickey-credentials-get=(self), publickey-credentials-create=(self), camera=(), microphone=(), geolocation=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
} as const

export function mountWeb(app: Hono<HttpEnv>, assets: WebAssets): void {
  const page = assets.get('index.html')
  if (page === undefined) {
    return
  }
  for (const path of WEB_PAGES) {
    app.get(
      path,
      () =>
        new Response(Uint8Array.from(page.body), {
          headers: { ...PAGE_HEADERS, 'content-type': page.type },
        }),
    )
  }
  for (const [name, asset] of assets) {
    if (name === 'index.html') {
      continue
    }
    app.get(
      `/assets/${name}`,
      () =>
        new Response(Uint8Array.from(asset.body), {
          headers: { ...PAGE_HEADERS, 'content-type': asset.type },
        }),
    )
  }
}

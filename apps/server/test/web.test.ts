import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync, brotliDecompressSync, gzipSync } from 'node:zlib'
import { fixedClock } from '@exponetdb/kernel'
import { MetricsRegistry, silentLogger } from '@exponetdb/observability'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadWebAssets } from '../src/composition/access.ts'
import { createPublicApp, httpMetrics } from '../src/interfaces/http/app.ts'
import {
  chooseEncoding,
  isPagePath,
  WEB_CSP,
  WEB_FALLBACK_EXCLUDED,
  type WebAssets,
} from '../src/interfaces/http/web.ts'

const PAGE =
  '<!doctype html><title>ExponetDB</title><script type="module" src="/assets/app.js"></script>'
const CHUNK = 'export const route = 1;'.repeat(64)

let dir: string
let assets: WebAssets

function app(web: WebAssets | undefined) {
  return createPublicApp(
    {
      readiness: () => ({ status: 'ready', evaluatedAt: '2026-10-13T12:00:00.000Z', checks: [] }),
      version: '0.0.0-test',
      logger: silentLogger,
      metrics: httpMetrics(new MetricsRegistry()),
      clock: fixedClock(Date.parse('2026-10-13T12:00:00Z')),
    },
    web === undefined ? {} : { web },
  )
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'exdb-web-'))
  await writeFile(join(dir, 'index.html'), PAGE)
  await mkdir(join(dir, 'assets', 'chunks'), { recursive: true })
  await mkdir(join(dir, 'assets', 'files', 'deep', 'deeper', 'deepest'), { recursive: true })
  await writeFile(join(dir, 'assets', 'app.js'), 'import "./chunks/route-AbC_9-x.js"')
  await writeFile(join(dir, 'assets', 'app.css'), 'body{margin:0}')
  await writeFile(join(dir, 'assets', 'chunks', 'route-AbC_9-x.js'), CHUNK)
  await writeFile(join(dir, 'assets', 'chunks', 'route-AbC_9-x.js.br'), brotliCompressSync(CHUNK))
  await writeFile(join(dir, 'assets', 'chunks', 'route-AbC_9-x.js.gz'), gzipSync(CHUNK))
  await writeFile(join(dir, 'assets', 'files', 'inter-latin-400-Zz9.woff2'), 'wOF2')
  await writeFile(join(dir, 'assets', 'files', 'logo-Q1.svg'), '<svg/>')
  await writeFile(join(dir, 'assets', 'files', 'source-Map1.js.map'), '{}')
  await writeFile(join(dir, 'assets', 'files', 'data-1.json'), '{}')
  await writeFile(join(dir, 'assets', 'files', '.hidden.js'), 'x')
  await writeFile(join(dir, 'assets', 'files', 'other.html'), '<p>')
  await writeFile(join(dir, 'assets', 'files', 'deep', 'deeper', 'too-deep.js'), 'x')
  await writeFile(join(dir, 'secret.txt'), 'not served')
  await symlink(join(dir, 'secret.txt'), join(dir, 'assets', 'files', 'link.js'))
  const loaded = await loadWebAssets([dir])
  if (loaded === undefined) {
    throw new Error('the test Web App did not load')
  }
  assets = loaded
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('the built Web App is loaded from an allowlist', () => {
  it('keys assets by their path below /assets/ and skips everything else', () => {
    expect([...assets.keys()].sort()).toEqual([
      'app.css',
      'app.js',
      'chunks/route-AbC_9-x.js',
      'files/inter-latin-400-Zz9.woff2',
      'files/logo-Q1.svg',
      'index.html',
    ])
    expect(assets.get('files/inter-latin-400-Zz9.woff2')?.type).toBe('font/woff2')
    expect(assets.get('chunks/route-AbC_9-x.js')?.encodings?.br).toBeDefined()
    expect(assets.get('chunks/route-AbC_9-x.js')?.encodings?.gzip).toBeDefined()
  })

  it('still loads the flat layout of the Wave 3A build', async () => {
    const flat = await mkdtemp(join(tmpdir(), 'exdb-web-flat-'))
    try {
      await writeFile(join(flat, 'index.html'), PAGE)
      await writeFile(join(flat, 'app.js'), 'void 0')
      await writeFile(join(flat, 'app.css'), '')
      const loaded = await loadWebAssets([flat])
      expect([...(loaded?.keys() ?? [])].sort()).toEqual(['app.css', 'app.js', 'index.html'])
    } finally {
      await rm(flat, { recursive: true, force: true })
    }
  })

  it('refuses a build that holds the same asset twice', async () => {
    const both = await mkdtemp(join(tmpdir(), 'exdb-web-both-'))
    try {
      await writeFile(join(both, 'index.html'), PAGE)
      await writeFile(join(both, 'app.js'), 'void 0')
      await mkdir(join(both, 'assets'))
      await writeFile(join(both, 'assets', 'app.js'), 'void 0')
      await expect(loadWebAssets([both])).rejects.toThrow(/app\.js twice/)
    } finally {
      await rm(both, { recursive: true, force: true })
    }
  })

  it('finds nothing without an index.html', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'exdb-web-empty-'))
    try {
      expect(await loadWebAssets([empty, join(empty, 'missing')])).toBeUndefined()
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})

describe('the SPA fallback', () => {
  it('answers client routes with the page and its strict headers', async () => {
    const pub = app(assets)
    for (const path of [
      '/',
      '/login',
      '/approvals',
      '/changes/plans/pln_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z',
      '/t/reosa/platform/production/schema/indexes',
      '/access/oauth-clients',
      '/oauth/consent',
      '/oauth/device',
      '/oauth/error',
      '/admin/clients',
      '/no/such/page',
    ]) {
      const res = await pub.request(path)
      expect(res.status, path).toBe(200)
      expect(await res.text(), path).toBe(PAGE)
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(res.headers.get('content-security-policy')).toBe(WEB_CSP)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('x-frame-options')).toBe('DENY')
      expect(res.headers.get('referrer-policy')).toBe('no-referrer')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    }
  })

  it('never answers inside the API, protocol and probe namespaces, nor file-like paths', async () => {
    const pub = app(assets)
    for (const path of [
      '/api',
      '/api/v1/no-such-resource',
      '/API/v1/targets',
      '//api/v1/targets',
      '/auth/no-such-ceremony',
      '/oauth/token',
      '/oauth/authorize/extra',
      '/oauth/device_authorization',
      '/oauth/register-something',
      '/oauth/consent/extra',
      '/oauth',
      '/mcp',
      '/mcp/extra',
      '/.well-known/no-such-document',
      '/healthz/detail',
      '/metrics',
      '/schemas/none',
      '/assets/missing.js',
      '/assets/index.html',
      '/assets/../index.html',
      '/assets/files/source-Map1.js.map',
      '/favicon.ico',
      '/robots.txt',
      '/login.html',
    ]) {
      const res = await pub.request(path)
      expect(res.status, path).toBe(404)
      expect(res.headers.get('content-type'), path).toBe('application/problem+json')
      expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' })
    }
  })

  it('answers a write to a page path with a NOT_FOUND problem, not the page', async () => {
    const res = await app(assets).request('/login', { method: 'POST' })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
  })

  it('serves nothing without a built Web App', async () => {
    const res = await app(undefined).request('/login')
    expect(res.status).toBe(404)
  })

  it('classifies paths by namespace, case and repeated slashes', () => {
    for (const prefix of WEB_FALLBACK_EXCLUDED) {
      expect(isPagePath(prefix), prefix).toBe(false)
      expect(isPagePath(`${prefix}/x`), prefix).toBe(false)
      expect(isPagePath(`/${prefix.toUpperCase()}/x`), prefix).toBe(false)
    }
    expect(isPagePath('/apis')).toBe(true)
    expect(isPagePath('/oauth/consent')).toBe(true)
    expect(isPagePath('/oauth/Device')).toBe(true)
    expect(isPagePath('/oauth/elsewhere')).toBe(false)
    expect(isPagePath('/t/a/b/c')).toBe(true)
    expect(isPagePath('/t/a/b/c.d')).toBe(false)
  })
})

describe('assets', () => {
  it('serves the entry files no-store and the hashed files immutable', async () => {
    const pub = app(assets)
    for (const [path, cache] of [
      ['/assets/app.js', 'no-store'],
      ['/assets/app.css', 'no-store'],
      ['/assets/chunks/route-AbC_9-x.js', 'public, max-age=31536000, immutable'],
      ['/assets/files/inter-latin-400-Zz9.woff2', 'public, max-age=31536000, immutable'],
      ['/assets/files/logo-Q1.svg', 'public, max-age=31536000, immutable'],
    ] as const) {
      const res = await pub.request(path)
      expect(res.status, path).toBe(200)
      expect(res.headers.get('cache-control'), path).toBe(cache)
      expect(res.headers.get('content-security-policy'), path).toBe(WEB_CSP)
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff')
      expect(res.headers.get('cross-origin-resource-policy'), path).toBe('same-origin')
    }
    expect((await pub.request('/assets/app.js')).headers.get('content-type')).toBe(
      'text/javascript; charset=utf-8',
    )
  })

  it('never serves a symbolic link, a hidden file, another page or a file nested too deep', async () => {
    const pub = app(assets)
    for (const path of [
      '/assets/files/link.js',
      '/assets/files/.hidden.js',
      '/assets/files/other.html',
      '/assets/files/deep/deeper/too-deep.js',
      '/assets/secret.txt',
    ]) {
      expect((await pub.request(path)).status, path).toBe(404)
    }
  })

  it('sends a precompressed variant only when the request accepts it', async () => {
    const pub = app(assets)
    const path = '/assets/chunks/route-AbC_9-x.js'
    const br = await pub.request(path, { headers: { 'accept-encoding': 'gzip, br' } })
    expect(br.headers.get('content-encoding')).toBe('br')
    expect(br.headers.get('vary')).toBe('accept-encoding')
    expect(brotliDecompressSync(Buffer.from(await br.arrayBuffer())).toString()).toBe(CHUNK)
    const gzip = await pub.request(path, { headers: { 'accept-encoding': 'gzip, br;q=0' } })
    expect(gzip.headers.get('content-encoding')).toBe('gzip')
    const plain = await pub.request(path)
    expect(plain.headers.get('content-encoding')).toBeNull()
    expect(await plain.text()).toBe(CHUNK)
  })

  it('hands out the same bytes on every request', async () => {
    const pub = app(assets)
    const first = await (await pub.request('/assets/app.js')).text()
    const second = await (await pub.request('/assets/app.js')).text()
    expect(second).toBe(first)
    expect(await (await pub.request('/login')).text()).toBe(PAGE)
    expect(await (await pub.request('/account')).text()).toBe(PAGE)
  })
})

describe('Accept-Encoding', () => {
  const both = { br: new Uint8Array(1), gzip: new Uint8Array(1) }
  it('prefers br, honors q=0 and ignores unknown codings', () => {
    expect(chooseEncoding('gzip, deflate, br', both)).toBe('br')
    expect(chooseEncoding('br;q=0, gzip;q=0.5', both)).toBe('gzip')
    expect(chooseEncoding('BR', both)).toBe('br')
    expect(chooseEncoding('identity', both)).toBeUndefined()
    expect(chooseEncoding('gzip;q=0', both)).toBeUndefined()
    expect(chooseEncoding(undefined, both)).toBeUndefined()
    expect(chooseEncoding('br', { gzip: new Uint8Array(1) })).toBeUndefined()
  })
})

describe('the CSP', () => {
  it('allows only the origin and no inline or evaluated code', () => {
    expect(WEB_CSP).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; worker-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    )
    expect(WEB_CSP).not.toMatch(/unsafe-|nonce-|sha256-|\*|https?:|blob:/)
  })
})

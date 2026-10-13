import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { MCP_META_KEYS } from '@exponetdb/contracts'
import { createProtocolClient } from '@exponetdb/testkit/mcp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type McpFixture, startMcpFixture } from './support/mcp-fixture-server.ts'
import { TOKEN } from './support/mcp-world.ts'

/**
 * `/mcp` behind a real Traefik (Wave 7 order §30, spike item 6): a
 * disposable container of a pinned Traefik in front of the test composition
 * on a real port, once plain and once with a compress middleware (as a
 * Coolify application router carries one). What the server decides must
 * arrive unchanged: streams stay streams and are not compressed or
 * buffered, the refusals keep their status and headers, the proxy adds no
 * session, and a client's own `Host` or `X-Forwarded-*` changes nothing.
 * Needs Docker; never skipped.
 */
const run = promisify(execFile)
const TRAEFIK =
  'mirror.gcr.io/library/traefik@sha256:2cd5cc75530c8d07ae0587c743d23eb30cae2436d07017a5ff78498b1a43d09f'
/** The version the digest above names (`traefik version`). */
const TRAEFIK_VERSION = '3.3.7'

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const address = s.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      s.close(() => resolve(port))
    })
  })
}

interface Proxy {
  readonly origin: string
  readonly fixture: McpFixture
  stop(): Promise<void>
}

/** An upstream stream of three events 300 ms apart: whether the proxy holds events back. */
async function slowStream(): Promise<{ server: Server; url: string }> {
  const server = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    let n = 0
    const tick = () => {
      res.write(`data: {"n":${n}}\n\n`)
      n += 1
      if (n < 3) setTimeout(tick, 300)
      else res.end()
    }
    tick()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { server, url: `http://127.0.0.1:${port}` }
}

/** A request with the client's own Host header (fetch does not send one). */
function withHost(url: string, host: string, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = httpRequest(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: { ...base, host, 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

async function startBehindTraefik(name: string, compress: boolean): Promise<Proxy> {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const fixture = await startMcpFixture({ unlimited: true, publicOrigin: origin })
  const upstream = new URL(fixture.url).origin
  const probe = await slowStream()
  const dir = await mkdtemp(join(tmpdir(), 'exdb-traefik-'))
  await writeFile(
    join(dir, 'dynamic.yml'),
    [
      'http:',
      '  routers:',
      '    exdb:',
      '      rule: "PathPrefix(`/`)"',
      '      entryPoints: [web]',
      '      service: exdb',
      ...(compress ? ['      middlewares: [gzip]'] : []),
      '    probe:',
      '      rule: "PathPrefix(`/probe-stream`)"',
      '      entryPoints: [web]',
      '      service: probe',
      ...(compress ? ['      middlewares: [gzip]'] : []),
      ...(compress ? ['  middlewares:', '    gzip:', '      compress: {}'] : []),
      '  services:',
      '    exdb:',
      '      loadBalancer:',
      '        servers:',
      `          - url: "${upstream}"`,
      '    probe:',
      '      loadBalancer:',
      '        servers:',
      `          - url: "${probe.url}"`,
      '',
    ].join('\n'),
  )
  await run('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '--network',
    'host',
    '-v',
    `${dir}:/etc/exdb-traefik:ro`,
    TRAEFIK,
    `--entryPoints.web.address=127.0.0.1:${port}`,
    '--providers.file.filename=/etc/exdb-traefik/dynamic.yml',
    '--log.level=ERROR',
  ])
  // Ready once the route answers with the server's own refusal of GET.
  const deadline = Date.now() + 30_000
  for (;;) {
    const status = await fetch(`${origin}/mcp`).then(
      (r) => r.status,
      () => 0,
    )
    if (status === 405) break
    if (Date.now() > deadline) throw new Error(`Traefik did not route (last status ${status})`)
    await new Promise((r) => setTimeout(r, 250))
  }
  return {
    origin,
    fixture,
    stop: async () => {
      await run('docker', ['rm', '-f', name]).catch(() => undefined)
      await fixture.stop()
      await new Promise((resolve) => probe.server.close(resolve))
      await rm(dir, { recursive: true, force: true })
    },
  }
}

const MODERN = '2026-07-28'
const base = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  authorization: `Bearer ${TOKEN}`,
}
const legacyList = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })

function frames(text: string): Record<string, unknown>[] {
  return text
    .split(/\n\n/)
    .map((e) =>
      e
        .split('\n')
        .find((l) => l.startsWith('data:'))
        ?.slice(5)
        .trim(),
    )
    .filter((d): d is string => d !== undefined && d !== '')
    .map((d) => JSON.parse(d) as Record<string, unknown>)
}

let versionSeen = ''

beforeAll(async () => {
  const { stdout } = await run('docker', ['run', '--rm', TRAEFIK, 'version'])
  versionSeen = /Version:\s+(\S+)/.exec(stdout)?.[1] ?? ''
}, 300_000)

describe.each([
  { compress: false, name: 'plain' },
  { compress: true, name: 'with a compress middleware' },
])('/mcp behind Traefik ($name)', ({ compress }) => {
  let p: Proxy

  beforeAll(async () => {
    p = await startBehindTraefik(
      `exdb-traefik-${compress ? 'gz' : 'plain'}-${process.pid}`,
      compress,
    )
  }, 120_000)

  afterAll(async () => {
    await p?.stop()
  })

  it('runs the pinned version', () => {
    expect(versionSeen).toBe(TRAEFIK_VERSION)
  })

  it('answers as the server does: the full list, its headers, no session, no cookie', async () => {
    const send = () =>
      fetch(`${p.origin}/mcp`, {
        method: 'POST',
        headers: { ...base, 'accept-encoding': 'gzip' },
        body: legacyList,
      })
    const proxied = await send()
    expect(proxied.status).toBe(200)
    const body = (await proxied.json()) as { result: { tools: unknown[]; _meta: object } }
    expect(body.result.tools.length).toBeGreaterThan(0)
    expect(body.result._meta).toHaveProperty('cloud.exponet.db/catalogDigest')
    // Deterministic through the proxy too.
    expect(await (await send()).json()).toEqual(body)
    expect(proxied.headers.get('cache-control')).toBe('no-store')
    expect(proxied.headers.get('x-request-id')).toMatch(/^req_/)
    expect(proxied.headers.get('mcp-session-id')).toBeNull()
    expect(proxied.headers.get('set-cookie')).toBeNull()
  })

  it('keeps a modern stream a stream: event-stream, frames intact and in order', async () => {
    const res = await fetch(`${p.origin}/mcp`, {
      method: 'POST',
      headers: {
        ...base,
        accept: 'application/json, text/event-stream',
        'accept-encoding': 'gzip',
        'mcp-protocol-version': MODERN,
        'mcp-method': 'subscriptions/listen',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'subscriptions/listen',
        params: {
          notifications: { toolsListChanged: true },
          _meta: {
            [MCP_META_KEYS.protocolVersion]: MODERN,
            [MCP_META_KEYS.clientCapabilities]: {},
          },
        },
      }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    // [OBSERVED] Traefik 3.3.7's compress middleware gzips an event stream (it ignores
    // `no-transform`); the frames stay intact and are not held back (next test).
    expect(res.headers.get('content-encoding')).toBe(compress ? 'gzip' : null)
    expect(res.headers.get('x-accel-buffering')).toBe('no')
    const got = frames(await res.text())
    expect(got[0]).toMatchObject({ method: 'notifications/subscriptions/acknowledged' })
    expect(got.at(-1)).toMatchObject({ id: 1, result: { resultType: 'complete' } })
  })

  it('does not hold events back: each arrives about when it is sent', async () => {
    const started = Date.now()
    const res = await fetch(`${p.origin}/probe-stream`, { headers: { 'accept-encoding': 'gzip' } })
    const reader = res.body?.getReader()
    if (reader === undefined) throw new Error('no body')
    const decoder = new TextDecoder()
    const arrivals: number[] = []
    let text = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      while (arrivals.length < (text.match(/\n\n/g) ?? []).length) {
        arrivals.push(Date.now() - started)
      }
    }
    expect(arrivals).toHaveLength(3)
    // Sent at 0, 300 and 600 ms; a buffering proxy would deliver all three at the end.
    expect(arrivals[0]).toBeLessThan(250)
    expect((arrivals[2] ?? 0) - (arrivals[0] ?? 0)).toBeGreaterThan(400)
  })

  it('works for the official client in both eras', async () => {
    for (const era of ['modern', 'legacy'] as const) {
      const { client, close } = await createProtocolClient({
        era,
        token: TOKEN,
        url: `${p.origin}/mcp`,
      })
      try {
        const tools = await client.listTools()
        expect(tools.tools.length, era).toBeGreaterThan(0)
        const called = (await client.callTool({ name: 'targets_list', arguments: {} })) as {
          structuredContent?: unknown
        }
        expect(called.structuredContent, era).toEqual({ items: [], nextCursor: null })
      } finally {
        await close()
      }
    }
  })

  it('passes the refusals through with their status and headers', async () => {
    const post = (headers: Record<string, string>, body = legacyList) =>
      fetch(`${p.origin}/mcp`, { method: 'POST', headers: { ...base, ...headers }, body })
    // No token: the challenge names the public origin's metadata, whatever the client claims.
    const anonymous = await fetch(`${p.origin}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https',
      },
      body: legacyList,
    })
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get('www-authenticate')).toContain(
      `resource_metadata="${p.origin}/.well-known/oauth-protected-resource/mcp"`,
    )
    expect(await anonymous.text()).not.toContain('evil.example')
    // A foreign Origin and a client's own Host are refused by the server, not lost in the proxy.
    expect((await post({ origin: 'https://evil.example' })).status).toBe(403)
    expect(await withHost(`${p.origin}/mcp`, 'evil.example', legacyList)).toBe(421)
    expect(await withHost(`${p.origin}/mcp`, new URL(p.origin).host, legacyList)).toBe(200)
    // The declared size is checked behind the proxy too (a modern call over 256 KiB).
    const large = await post(
      { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list' },
      JSON.stringify({ pad: 'x'.repeat(1024 * 1024) }),
    )
    expect(large.status).toBe(413)
    // GET: 405 with Allow: POST; a notification: 202 without a body.
    const get = await fetch(`${p.origin}/mcp`)
    expect([get.status, get.headers.get('allow')]).toEqual([405, 'POST'])
    const note = await post(
      {},
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    )
    expect(note.status).toBe(202)
    expect(await note.text()).toBe('')
  })
})

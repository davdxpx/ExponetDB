import { mkdir, writeFile } from 'node:fs/promises'
import { MCP_META_KEYS, type Scope } from '@exponetdb/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EXISTENCE_FLOOR_MS } from '../src/interfaces/existence.ts'
import { type McpWorld, MODERN, mcpWorld } from './support/mcp-int-world.ts'
import { ORIGIN } from './support/node-world.ts'

/**
 * Performance smoke (Wave 7 order §39): measured values, not targets without
 * a basis. The latencies of the read tools and of the same reads over REST
 * against PostgreSQL 17 (in process, no socket) go to
 * `apps/server/test-results/smoke/mcp.md`; the bound only catches a
 * pathological slowdown. The heap over 40 000 requests is
 * `mcp-stability.lab.test.ts`.
 */
const OUT = new URL('../test-results/smoke/', import.meta.url)
const report: string[] = []

function quantiles(samples: number[]): { p50: number; p95: number; max: number } {
  const s = [...samples].sort((a, b) => a - b)
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0
  return { p50: at(0.5), p95: at(0.95), max: s.at(-1) ?? 0 }
}

const ms = (n: number) => `${n.toFixed(1)} ms`

let w: McpWorld
let token = ''
let restToken = ''

beforeAll(async () => {
  w = await mcpWorld('exdb_it_mcp_smoke')
  const scopes: Scope[] = ['targets.read', 'schema.read', 'diagnostics.read', 'migrations.read']
  token = (await w.mcpToken(await w.mcpClient('Smoke'), scopes, ['nonprod'])).access_token
  restToken = await w.apiToken(scopes, ['nonprod'])
}, 300_000)

afterAll(async () => {
  await mkdir(OUT, { recursive: true })
  await writeFile(
    new URL('mcp.md', OUT),
    [`MCP smoke, ${new Date().toISOString()}, Node ${process.version}.`, '', ...report, ''].join(
      '\n',
    ),
  )
  await w?.stop()
})

describe('read latency against PostgreSQL 17 (in process)', () => {
  it('measures p50 and p95 of the read tools and of the same reads over REST', async () => {
    const call = async (name: string, args: Record<string, unknown>) => {
      const started = performance.now()
      const res = await w.app.request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': MODERN,
          'mcp-method': 'tools/call',
          'mcp-name': name,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name,
            arguments: args,
            _meta: {
              [MCP_META_KEYS.protocolVersion]: MODERN,
              [MCP_META_KEYS.clientCapabilities]: {},
            },
          },
        }),
      })
      const body = (await res.json()) as { result?: { isError?: boolean } }
      expect([res.status, body.result?.isError], name).toEqual([200, undefined])
      return performance.now() - started
    }
    const rest = async (path: string) => {
      const started = performance.now()
      const res = await w.app.request(`${ORIGIN}${path}`, {
        headers: { authorization: `Bearer ${restToken}` },
      })
      await res.arrayBuffer()
      expect(res.status, path).toBe(200)
      return performance.now() - started
    }
    const target = w.ids.stagingTarget
    const tools: [string, Record<string, unknown>, string][] = [
      ['targets_list', {}, '/api/v1/targets'],
      ['target_get', { target }, `/api/v1/targets/${target}`],
      [
        'schema_search',
        { target, q: 'accounts' },
        `/api/v1/targets/${target}/schema/search?q=accounts`,
      ],
      ['migration_status', { target }, `/api/v1/targets/${target}/migrations`],
    ]
    report.push('| read | MCP p50 | MCP p95 | REST p50 | REST p95 |', '|---|---|---|---|---|')
    for (const [name, args, path] of tools) {
      for (let i = 0; i < 5; i += 1) await call(name, args) // warm-up
      const viaMcp: number[] = []
      const viaRest: number[] = []
      for (let i = 0; i < 40; i += 1) {
        viaMcp.push(await call(name, args))
        viaRest.push(await rest(path))
      }
      const m = quantiles(viaMcp)
      const r = quantiles(viaRest)
      report.push(`| ${name} | ${ms(m.p50)} | ${ms(m.p95)} | ${ms(r.p50)} | ${ms(r.p95)} |`)
      // Not a target: a bound that only catches a pathological slowdown.
      expect(m.p95, name).toBeLessThan(2_000)
    }
  }, 300_000)
})

describe('response time of existence decisions (order §30: no enumeration through timing)', () => {
  it('answers a target outside the grant and an unknown one in the same time class', async () => {
    const scopes: Scope[] = ['targets.read', 'schema.read']
    const restricted = (
      await w.mcpToken(await w.mcpClient('Smoke Restricted'), scopes, ['nonprod', 'prod'], {
        targets: [w.ids.stagingTarget],
      })
    ).access_token
    const get = async (target: string): Promise<number> => {
      for (;;) {
        const started = performance.now()
        const res = await w.app.request(`${ORIGIN}/mcp`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${restricted}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'target_get', arguments: { target } },
          }),
        })
        const text = await res.text()
        const elapsed = performance.now() - started
        if (res.status === 429) {
          // The grant's read bucket: wait as told, and time only an admitted call.
          await new Promise((r) =>
            setTimeout(r, 1_000 * Number(res.headers.get('retry-after') ?? 1)),
          )
          continue
        }
        expect(text).toContain('TARGET_NOT_FOUND')
        return elapsed
      }
    }
    const unknown = `tgt_01M4ZZZZZZZZZZZZZZZZZZZZZZ`
    for (let i = 0; i < 5; i += 1) {
      await get(unknown)
      await get(w.ids.productionTarget)
    }
    const a: number[] = []
    const b: number[] = []
    for (let i = 0; i < 60; i += 1) {
      a.push(await get(unknown))
      b.push(await get(w.ids.productionTarget))
    }
    const qa = quantiles(a)
    const qb = quantiles(b)
    report.push(
      '',
      `target_get, refused as unknown: an unknown id p50 ${ms(qa.p50)}, p95 ${ms(qa.p95)}; a target outside the grant (concealed) p50 ${ms(qb.p50)}, p95 ${ms(qb.p95)}.`,
    )
    // Both leave at the floor (existence.ts): one class, whatever the database did.
    expect(Math.min(...a, ...b)).toBeGreaterThanOrEqual(EXISTENCE_FLOOR_MS)
    expect(Math.abs(qa.p50 - qb.p50)).toBeLessThan(5)
    // The same over REST: an unknown path and a target outside the key's grant are 404 at the floor.
    const rest = async (target: string) => {
      const started = performance.now()
      const res = await w.app.request(`${ORIGIN}/api/v1/targets/${target}`, {
        headers: { authorization: `Bearer ${restToken}` },
      })
      await res.arrayBuffer()
      expect(res.status).toBe(404)
      return performance.now() - started
    }
    const r: number[] = []
    for (let i = 0; i < 10; i += 1) r.push(await rest(unknown), await rest(w.ids.productionTarget))
    report.push(`REST 404 of the same two: p50 ${ms(quantiles(r).p50)}, min ${ms(Math.min(...r))}.`)
    expect(Math.min(...r)).toBeGreaterThanOrEqual(EXISTENCE_FLOOR_MS)
  }, 300_000)
})

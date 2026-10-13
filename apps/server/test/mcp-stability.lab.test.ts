import { mkdir, writeFile } from 'node:fs/promises'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { MCP_META_KEYS } from '@exponetdb/contracts'
import { describe, expect, it } from 'vitest'
import { startMcpFixture } from './support/mcp-fixture-server.ts'
import { MODERN } from './support/mcp-int-world.ts'
import { TOKEN } from './support/mcp-world.ts'

/**
 * Stability smoke (Wave 7 order §39) of the stateless endpoint on the test
 * composition (no database) over a real socket: the heap after 40 000
 * `/mcp` requests in four epochs (the SDK server is built per request; a
 * growth case of the SDK is reported upstream), and 200 requests of one
 * grant in flight at once (the edge serves what its per-grant bound admits
 * and answers the rest `429` at once; nothing piles up). The numbers go to
 * `apps/server/test-results/smoke/mcp-stability.md`.
 *
 * Over a socket, not in process: undici's `Request` follows a signal
 * through a `WeakRef`, and V8 keeps a `WeakRef`'s target until the current
 * job ends; an in-process loop that never yields keeps every request's
 * server alive (measured: 12 KiB per request, none once a macrotask
 * separates the requests, as every socket event does).
 */
const OUT = new URL('../test-results/smoke/', import.meta.url)

setFlagsFromString('--expose-gc')
const gc = runInNewContext('gc') as () => void

describe('stability of the stateless endpoint (test composition, no database)', () => {
  it('keeps the heap flat over 40 000 requests in four epochs, and after 200 in flight', async () => {
    const fixture = await startMcpFixture({ unlimited: true, discard: true })
    const headers = {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    }
    const modern = (method: string, params: Record<string, unknown>) => ({
      headers: {
        ...headers,
        'mcp-protocol-version': MODERN,
        'mcp-method': method,
        ...(typeof params['name'] === 'string' ? { 'mcp-name': params['name'] } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            [MCP_META_KEYS.protocolVersion]: MODERN,
            [MCP_META_KEYS.clientCapabilities]: {},
          },
        },
      }),
    })
    const requests: { headers: Record<string, string>; body: string }[] = [
      modern('tools/list', {}),
      modern('tools/call', { name: 'targets_list', arguments: {} }),
      {
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      },
    ]
    const send = async (i: number): Promise<number> => {
      const r = requests[i % requests.length] ?? requests[0]
      if (r === undefined) throw new Error('no request')
      const res = await fetch(fixture.url, { method: 'POST', headers: r.headers, body: r.body })
      await res.arrayBuffer()
      return res.status
    }
    const sendOk = async (i: number) => {
      const status = await send(i)
      if (status !== 200) throw new Error(`status ${status}`)
    }
    const heap = () => {
      gc()
      gc()
      return process.memoryUsage().heapUsed / 1024 / 1024
    }
    for (let i = 0; i < 2_000; i += 1) await sendOk(i) // warm-up: JIT, caches, the schema registry
    const baseline = heap()
    const epochs: number[] = []
    for (let epoch = 0; epoch < 4; epoch += 1) {
      for (let i = 0; i < 10_000; i += 1) await sendOk(i)
      epochs.push(heap())
    }
    const started = performance.now()
    const burst = await Promise.all(Array.from({ length: 200 }, (_, i) => send(i)))
    const burstMs = performance.now() - started
    const afterBurst = heap()
    const served = burst.filter((s) => s === 200).length
    const limited = burst.filter((s) => s === 429).length
    await mkdir(OUT, { recursive: true })
    await writeFile(
      new URL('mcp-stability.md', OUT),
      [
        `MCP stability smoke, ${new Date().toISOString()}, Node ${process.version}.`,
        '',
        `Heap after GC (MiB): baseline ${baseline.toFixed(1)}; after each 10 000 requests ${epochs
          .map((h) => h.toFixed(1))
          .join(', ')}; after 200 in flight ${afterBurst.toFixed(1)}.`,
        `200 requests of one grant at once: ${served} served, ${limited} refused with 429, in ${burstMs.toFixed(0)} ms.`,
        '',
      ].join('\n'),
    )
    await fixture.stop()
    expect(served + limited).toBe(200)
    expect(served).toBeGreaterThan(0)
    // A leak of even 1 KiB per request would add about 10 MiB per epoch.
    expect(Math.max(...epochs, afterBurst) - baseline).toBeLessThan(16)
    expect((epochs[3] ?? 0) - (epochs[0] ?? 0)).toBeLessThan(8)
  }, 600_000)
})

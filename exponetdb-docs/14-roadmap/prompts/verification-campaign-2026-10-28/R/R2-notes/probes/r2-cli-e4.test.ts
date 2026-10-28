// R2 probe (E4/TC-040): an older CLI against a newer server. Copy to apps/cli/test/.
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { run } from '../src/main.ts'
import { testIo } from './support.ts'

const SERVER = 'https://db.example.test'
const id = (p: string, n: number) => `${p}_01J${String(n).padStart(23, '0')}`
let dir = ''
const installation = (over: Record<string, unknown>) => ({
  version: '0.9.0',
  contracts: { restApi: 'v1', mcpCatalog: 'exponetdb.mcp/v1', nodeProtocol: 'exponetdb.node/v1', migrationManifest: 'exponetdb.migration/v1', projectConfig: 'exponetdb.project/v1' },
  features: [],
  ...over,
})
const node = (over: Record<string, unknown> = {}) => ({ id: id('nod', 1), serverId: id('srv', 2), state: 'active', agentVersion: '1.0.0', protocolMajor: 1, lastHeartbeatAt: '2026-10-26T10:00:00.000Z', clockSkewMs: 0, capabilities: [], ...over })

function server(inst: Record<string, unknown>, nodes: unknown): typeof fetch {
  return async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
    const path = url.pathname.replace(/^\/api\/v1/, '')
    if (path === '/installation') return Response.json(inst)
    if (path === '/nodes') return Response.json(nodes)
    return Response.json({ code: 'NOT_FOUND', title: 'x', message: 'x', retryable: false }, { status: 404 })
  }
}
async function cli(argv: string[], f: typeof fetch) {
  const stdout: string[] = []
  const stderr: string[] = []
  const code = await run(argv, testIo({ configDir: join(dir, 'config'), cwd: dir, fetch: f, stdout, stderr }))
  return { code, stdout: stdout.join(''), stderr: stderr.join('') }
}
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'exdb-r2-e4-'))
  const key = join(dir, 'k.txt')
  await writeFile(key, `exak_${'k'.repeat(32)}\n`)
  await chmod(key, 0o600)
  await cli(['profile', 'add', 'lab', '--server', SERVER, '--auth', 'api-key', '--key-file', key], server(installation({}), { items: [], nextCursor: null }))
  await cli(['profile', 'use', 'lab'], server(installation({}), { items: [], nextCursor: null }))
})
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

describe('R2 E4 probe', () => {
  const cases: [string, Record<string, unknown>, unknown][] = [
    ['A restApi v2', { contracts: { ...installation({}).contracts, restApi: 'v2' } }, { items: [node()], nextCursor: null }],
    ['B newer server version, extra field on a node', { version: '9.0.0' }, { items: [node({ newField: 1 })], nextCursor: null }],
    ['C newer server version, unknown node state', { version: '9.0.0' }, { items: [node({ state: 'quarantined' })], nextCursor: null }],
    ['D minCliVersion field on the installation', { version: '9.0.0', minCliVersion: '9.0.0' }, { items: [node()], nextCursor: null }],
  ]
  it.each(cases)('%s', async (name, inst, nodes) => {
    const r = await cli(['node', 'list'], server(installation(inst), nodes))
    console.log(`R2-E4 ${name}: exit ${r.code}\n  stdout: ${JSON.stringify(r.stdout.slice(0, 160))}\n  stderr: ${JSON.stringify(r.stderr.slice(0, 260))}`)
    expect(true).toBe(true)
  })
})

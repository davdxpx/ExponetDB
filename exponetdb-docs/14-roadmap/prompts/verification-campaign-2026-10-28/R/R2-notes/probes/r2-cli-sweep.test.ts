// R2 probe (TC-030/TC-031/TC-032 neighbours): every remote read command of the CLI answered 403 / 404 by a fake
// server must print nothing on stdout, and its JSON error envelope must carry no `data`. Copy to apps/cli/test/.
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { COMMANDS } from '../src/commands/index.ts'
import { run } from '../src/main.ts'
import { testIo } from './support.ts'

const SERVER = 'https://db.example.test'
const ULID = '01J00000000000000000000001'
let dir = ''

const mk = (mode: 403 | 404): typeof fetch => async (input) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
  if (url.pathname.replace(/^\/api\/v1/, '') === '/installation') {
    return Response.json({
      version: '0.9.0',
      contracts: { restApi: 'v1', mcpCatalog: 'exponetdb.mcp/v1', nodeProtocol: 'exponetdb.node/v1', migrationManifest: 'exponetdb.migration/v1', projectConfig: 'exponetdb.project/v1' },
      features: [],
    })
  }
  const body = mode === 403
    ? { code: 'INSUFFICIENT_SCOPE', title: 'x', message: 'Refused.', retryable: false, details: { requiredScope: 'backups.read' } }
    : { code: 'NOT_FOUND', title: 'x', message: 'Not found.', retryable: false }
  return Response.json(body, { status: mode })
}

async function cli(argv: string[], f: typeof fetch) {
  const stdout: string[] = []
  const stderr: string[] = []
  const code = await run(argv, testIo({ configDir: join(dir, 'config'), cwd: dir, fetch: f, stdout, stderr, now: () => Date.parse('2026-10-26T12:00:00.000Z') }))
  return { code, stdout: stdout.join(''), stderr: stderr.join('') }
}

function placeholder(name: string): string {
  if (/target|scratch/.test(name)) return 'reosa/platform/staging'
  if (/^cluster$/.test(name)) return `cls_${ULID}`
  if (/node/.test(name)) return `nod_${ULID}`
  if (/server/.test(name)) return `srv_${ULID}`
  if (/plan/.test(name)) return `pln_${ULID}`
  if (/operation/.test(name)) return `op_${ULID}`
  if (/project/.test(name)) return 'reosa/platform'
  if (/environment/.test(name)) return `env_${ULID}`
  if (/product/.test(name)) return `prd_${ULID}`
  if (/backup/.test(name)) return `bkp_${ULID}`
  if (/restore/.test(name)) return `rst_${ULID}`
  if (/identity/.test(name)) return `idn_${ULID}`
  return `x_${ULID}`
}

const reads = COMMANDS.filter((c) => c.locality === 'remote' && c.effect === 'read')

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'exdb-r2-sweep-'))
  const key = join(dir, 'k.txt')
  await writeFile(key, `exak_${'k'.repeat(32)}\n`)
  await chmod(key, 0o600)
  await cli(['profile', 'add', 'lab', '--server', SERVER, '--auth', 'api-key', '--key-file', key], mk(403))
  await cli(['profile', 'use', 'lab'], mk(403))
})
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

const report: string[] = []
describe('R2 sweep of remote read commands against 403 and 404', () => {
  for (const mode of [403, 404] as const) {
    it.each(reads.map((c) => [c.path.join(' '), c] as const))(`${mode} %s`, async (name, c) => {
      const argv = [...c.path]
      for (const a of c.args ?? []) if (a.required && a.body !== true) argv.push(placeholder(a.name))
      for (const f of c.flags ?? []) {
        if (f.required) argv.push(`--${f.name}`, ...(f.type === 'boolean' ? [] : [f.type === 'enum' ? (f.values?.[0] ?? 'x') : f.type === 'number' ? '1' : placeholder(f.name)]))
      }
      const h = await cli(argv, mk(mode))
      if (h.code === 2) { report.push(`SKIP-USAGE ${mode} ${name}: ${h.stderr.split('\n')[0]?.slice(0, 120)}`); return }
      const j = await cli([...argv, '--output', 'json'], mk(mode))
      const doc = (() => { try { return JSON.parse(j.stdout) } catch { return undefined } })()
      const bad: string[] = []
      if (h.stdout.trim() !== '') bad.push(`stdout="${h.stdout.trim().slice(0, 100).replace(/\n/g, '|')}"`)
      if (h.code === 0) bad.push('exit 0')
      if (doc !== undefined && Object.hasOwn(doc, 'data')) bad.push(`json data=${JSON.stringify(doc.data).slice(0, 80)}`)
      if (bad.length > 0) report.push(`VIOLATION ${mode} ${name} (exit ${h.code}): ${bad.join('; ')}`)
      else report.push(`ok ${mode} ${name}`)
    })
  }
  it('prints the report', () => {
    console.log('R2-SWEEP-BEGIN\n' + report.join('\n') + '\nR2-SWEEP-END')
    expect(true).toBe(true)
  })
})

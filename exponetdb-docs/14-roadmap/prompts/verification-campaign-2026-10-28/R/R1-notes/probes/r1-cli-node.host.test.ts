// R1: TC-001 (plan views of the seven postgres.* node plans) and TC-002 (node config / roles planned from the CLI)
// against the real planners, a real node agent and a real PostgreSQL 17 cluster. The CLI is a real process
// (bun, source conditions) talking HTTP to serve's public app (the world's in-process app behind @hono/node-server)
// with an API key of a service account; no inspection is made by hand before a plan.
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { describe, expect, it } from 'vitest'
import { hostScenario } from '../support/host-world.ts'

const w = hostScenario({ scenario: 'r1-cli-node' })
const TAG = process.env['R1_TAG'] ?? 'new'
const EV = `/srv/work/r1/logs/cli-${TAG}.log`
mkdirSync('/srv/work/r1/logs', { recursive: true })
const ev = (name: string, v: unknown) => appendFileSync(EV, `[${new Date().toISOString()}] ${name}: ${JSON.stringify(v)}\n`)
const CLI_MAIN = fileURLToPath(new URL('../../../cli/src/main.ts', import.meta.url))
let home = ''
let base = ''

function cli(args: readonly string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('bun', ['--conditions=@exponetdb/source', CLI_MAIN, ...args], {
      cwd,
      env: { PATH: process.env['PATH'] ?? '', HOME: home, EXPONETDB_CONFIG_DIR: join(home, 'config'), NO_COLOR: '1', EXPONETDB_PROFILE: 'r1' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b) => (stdout += b))
    child.stderr.on('data', (b) => (stderr += b))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}
const json = (r: { stdout: string }) => { try { return JSON.parse(r.stdout) } catch { return undefined } }

describe(`R1 node plans from the CLI (${TAG})`, () => {
  let node = ''
  let cluster = ''
  let work = ''
  const plans: Record<string, string> = {}

  it('sets up the CLI against the world over HTTP', async () => {
    node = w.requireNode().nodeId
    cluster = w.clusterId
    home = await mkdtemp(join(tmpdir(), 'r1-cli-'))
    work = join(home, 'work')
    await mkdir(work, { recursive: true })
    const acct = await w.serviceAccount('r1 cli', 'operator')
    const scopes = ['targets.read', 'schema.read', 'migrations.read', 'diagnostics.read', 'backups.read', 'nodes.read', 'audit.read', 'migrations.plan', 'migrations.apply:nonprod', 'data.read:nonprod', 'connections.operate:nonprod', 'backups.run', 'restore.plan', 'nodes.plan', 'nodes.operate:nonprod']
    const key = await w.apiKey(acct, scopes, ['nonprod'])
    await writeFile(join(home, 'key'), key, { mode: 0o600 })
    const listener = serve({ fetch: w.app.fetch, hostname: '127.0.0.1', port: 0 })
    await new Promise((r) => listener.once('listening', r))
    const addr = listener.address() as { port: number }
    base = `http://127.0.0.1:${addr.port}`
    const add = await cli(['profile', 'add', 'r1', '--server', base, '--auth', 'api-key', '--key-file', join(home, 'key'), '--use', '--output', 'json'], work)
    ev('profile add', { code: add.code, err: add.stderr.slice(0, 300) })
    const who = await cli(['whoami', '--output', 'json'], work)
    ev('whoami', { code: who.code, out: who.stdout.slice(0, 200), err: who.stderr.slice(0, 300) })
    expect(add.code, add.stderr).toBe(0)
  }, 300_000)

  it('TC-002: node postgres config --set work_mem=8MB plans with no inspection made by hand', async () => {
    const r = await cli(['node', 'postgres', 'config', node, '--cluster', cluster, '--set', 'work_mem=8MB', '--no-wait', '--output', 'json'], work)
    ev('config plan', { code: r.code, out: r.stdout.slice(0, 400), err: r.stderr.slice(0, 500) })
    expect(r.code, `${r.stdout}${r.stderr}`).toBe(0)
    plans['postgres.config.apply'] = json(r)?.data?.id ?? json(r)?.planId
  }, 300_000)

  it('TC-002: node postgres roles plans from a file with no inspection made by hand', async () => {
    const role = `r1_${Math.random().toString(16).slice(2, 8)}`
    const step = (f: Record<string, unknown>) => ({ attributes: null, verifier: null, member: null, admin: null, inherit: null, set: null, database: null, setting: null, value: null, ...f })
    await writeFile(join(work, 'roles.json'), JSON.stringify({ steps: [step({ op: 'create_role', role, attributes: { login: true, inherit: true, createdb: false, createrole: false, replication: false, bypassrls: false, connectionLimit: 3 } }), step({ op: 'set_role_setting', role, setting: 'work_mem', value: '16MB' })] }))
    const r = await cli(['node', 'postgres', 'roles', node, '--cluster', cluster, '--file', 'roles.json', '--no-wait', '--output', 'json'], work)
    ev('roles plan', { code: r.code, out: r.stdout.slice(0, 400), err: r.stderr.slice(0, 500) })
    expect(r.code, `${r.stdout}${r.stderr}`).toBe(0)
    plans['postgres.roles.apply'] = json(r)?.data?.id ?? json(r)?.planId
  }, 300_000)

  it('TC-002: node inspect with --arg-json returns succeeded for roles.inspect and config.plan', async () => {
    const a = await cli(['node', 'inspect', node, '--capability', 'postgres.roles.inspect@2', '--cluster', cluster, '--arg-json', 'expectSettings=[]', '--output', 'json'], work)
    const b = await cli(['node', 'inspect', node, '--capability', 'postgres.config.plan@2', '--cluster', cluster, '--arg-json', 'changes=[{"name":"work_mem","value":"8MB"}]', '--output', 'json'], work)
    ev('inspect arg-json', { rolesCode: a.code, rolesOut: a.stdout.slice(0, 300), planCode: b.code, planOut: b.stdout.slice(0, 300), err: (a.stderr + b.stderr).slice(0, 300) })
    expect(a.code, `${a.stdout}${a.stderr}`).toBe(0)
    expect(b.code, `${b.stdout}${b.stderr}`).toBe(0)
  }, 300_000)

  it('TC-001/TC-002: the other node plan kinds from the CLI, then plan show carries the change', async () => {
    await writeFile(join(work, 'hba.json'), JSON.stringify({ managedRules: [{ type: 'hostssl', database: ['app'], user: ['app_user'], address: '10.1.0.0/16', method: 'scram-sha-256', map: null }], protectedAccess: [] }))
    await writeFile(join(work, 'tls.json'), JSON.stringify({ dnsNames: ['pg17.exdb.test'], ipAddresses: ['127.0.0.1'], validityDays: 30 }))
    await w.psql('CREATE DATABASE r1_ext')
    const extVersion = await w.psql("SELECT default_version FROM pg_available_extensions WHERE name = 'pg_trgm'")
    await writeFile(join(work, 'ext.json'), JSON.stringify({ database: 'r1_ext', steps: [{ op: 'create', name: 'pg_trgm', schema: 'public', version: extVersion }] }))
    if (TAG === 'old') {
      // The old CLI cannot make the basis observations itself: make them by hand so the plan views can be compared (TC-001).
      await w.inspect('postgres.status@1')
      await w.inspect('postgres.restart.plan@2')
      await w.inspect('postgres.hba.inspect@2')
      await w.inspect('postgres.extensions.inspect@1', { database: 'r1_ext' })
      await w.inspect('postgres.tls.inspect@1')
      await w.inspect('postgres.config.plan@2', { changes: [{ name: 'work_mem', value: '8MB' }] })
      await w.inspect('postgres.roles.inspect@2', { expectSettings: [] })
      for (const [k, a, b] of [['postgres.config.apply', 'config', ['--set', 'work_mem=8MB']], ['postgres.roles.apply', 'roles', ['--file', 'roles.json']]] as const) {
        const r = await cli(['node', 'postgres', a, node, '--cluster', cluster, ...b, '--no-wait', '--output', 'json'], work)
        plans[k] = json(r)?.data?.id ?? json(r)?.planId
        ev(`old plan ${k} after a manual inspection`, { code: r.code, id: plans[k] })
      }
    }
    const jobs: [string, string[]][] = [
      ['postgres.reload', ['node', 'postgres', 'reload']],
      ['postgres.restart', ['node', 'postgres', 'restart']],
      ['postgres.hba.apply', ['node', 'postgres', 'hba', '--file', 'hba.json']],
      ['postgres.extensions.apply', ['node', 'postgres', 'extensions', '--file', 'ext.json']],
      ['postgres.tls.rotate', ['node', 'postgres', 'tls', '--file', 'tls.json']],
    ]
    for (const [kind, parts] of jobs) {
      const [a, b, c, ...rest] = parts
      const r = await cli([a!, b!, c!, node, '--cluster', cluster, ...rest, '--no-wait', '--output', 'json'], work)
      ev(`plan ${kind}`, { code: r.code, out: r.stdout.slice(0, 200), err: r.stderr.slice(0, 400) })
      plans[kind] = json(r)?.data?.id ?? json(r)?.planId
    }
    const report: Record<string, unknown> = {}
    for (const [kind, id] of Object.entries(plans)) {
      if (id === undefined) { report[kind] = 'NO PLAN'; continue }
      const j = await cli(['plan', 'show', id, '--output', 'json'], work)
      const t = await cli(['plan', 'show', id], work)
      const view = json(j)?.data ?? json(j)
      report[kind] = {
        hasChange: view?.change !== undefined,
        contentKeys: view?.change?.content ? Object.keys(view.change.content) : null,
        hostValuesLeaked: /dataDirectory|hbaFile|sourcefile|certFile|keyFile|\/var\/lib\/postgresql|\/etc\/postgresql/.test(j.stdout),
        tableMentionsChange: /change|managed|work_mem|restart|connections|extension|certificate|role/i.test(t.stdout),
        tableHead: t.stdout.split('\n').slice(0, 14).join(' | ').slice(0, 600),
      }
    }
    ev('plan show per kind', report)
    for (const [kind, r] of Object.entries(report)) expect((r as any).hasChange, `${kind}: ${JSON.stringify(r)}`).toBe(true)
  }, 600_000)
})

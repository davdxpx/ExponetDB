// S2: the offline runbook (C-35) end to end at 7 GB: adopt, download via REST and via the CLI as a real process, run it with the Control Plane
// roles stopped (same host), record the offline drill (REST and CLI), wrong digest. Second host: s2-d-host2.sh uses the same script file.
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { describe, expect, it } from 'vitest'
import { hostScenario, run } from '../support/host-world.ts'

const w = hostScenario({ scenario: 's2-cp-offline', freshCluster: false })
const LOGDIR = '/srv/work/s2/logs'
const EV = `${LOGDIR}/cp-offline.log`
const REPOS = '/etc/exponetdb-node/repositories'
mkdirSync(LOGDIR, { recursive: true })
const ev = (name: string, v: unknown) => appendFileSync(EV, `[${new Date().toISOString()}] ${name}: ${JSON.stringify(v)}\n`)
const sh = async (cmd: string) => (await run('bash', ['-c', cmd], { maxBuffer: 64 * 1024 * 1024 }).catch((e: any) => ({ stdout: `FAILED(${e.code}) ${e.stdout ?? ''} ${e.stderr ?? ''}` }))).stdout.trim()
const CLI_MAIN = fileURLToPath(new URL('../../../cli/src/main.ts', import.meta.url))
const cid = () => w.clusterId
const secs = (t0: number) => (Date.now() - t0) / 1000
let home = ''
function cli(args: readonly string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string; seconds: number }> {
  const t0 = Date.now()
  return new Promise((resolve) => {
    const child = spawn('bun', ['--conditions=@exponetdb/source', CLI_MAIN, ...args], { cwd, env: { PATH: process.env['PATH'] ?? '', HOME: home, EXPONETDB_CONFIG_DIR: join(home, 'config'), NO_COLOR: '1', EXPONETDB_PROFILE: 's2' } })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', (b) => (stdout += b)); child.stderr.on('data', (b) => (stderr += b))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr, seconds: secs(t0) }))
  })
}
async function planApply(path: string, body: unknown, ms = 600_000) {
  const planned = await w.call('POST', path, body)
  if (planned.status !== 201 || planned.body?.decision === 'deny') return { planned, head: { status: planned.status, code: planned.body?.code } } as any
  await w.reauth()
  const applied = await w.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
  const done = await w.finished(applied.body.id, ms)
  return { planned, applied, done, head: { status: 201 } } as any
}

describe('S2 offline runbook', () => {
  it('adopts the repository, downloads the runbook (REST and CLI), runs it, records the offline drill', async () => {
    await w.inspect('postgres.status@1')
    const a = await planApply(`/api/v1/clusters/${cid()}/backup-repositories`, { layer: 'l1_physical', engine: 'pgbackrest', provider: 'posix', location: { endpointHost: null, region: null, bucket: null, prefix: 'var/lib/pgbackrest/', stanza: 'exdbnode', repoIndex: 1 } })
    expect(a.done?.state, JSON.stringify(a.head)).toBe('succeeded')
    const repositoryId = (await w.call('GET', `/api/v1/clusters/${cid()}/backup-repositories`)).body.repositories[0].id
    await sh(`mkdir -p ${REPOS}/${repositoryId} && echo adopted_runs > ${REPOS}/${repositoryId}/mode && printf 'stanza=exdbnode\\nrepo=1\\n' > ${REPOS}/${repositoryId}/pgbackrest && chmod 644 ${REPOS}/${repositoryId}/*`)
    const r = await w.call('POST', `/api/v1/clusters/${cid()}/backups/refresh`, {}); await w.finished(r.body.id)

    // CLI as a real process with an API key of a service account (role operator, tier-scoped scopes)
    home = await mkdtemp(join(tmpdir(), 's2-cli-')); const work = join(home, 'work'); await mkdir(work, { recursive: true })
    const acct = await w.serviceAccount('s2 cli', 'operator')
    const key = await w.apiKey(acct, ['targets.read', 'backups.read', 'backups.run', 'restore.plan'], ['nonprod'])
    await writeFile(join(home, 'key'), key, { mode: 0o600 })
    const listener = serve({ fetch: w.app.fetch, hostname: '127.0.0.1', port: 0 }); await new Promise((res) => listener.once('listening', res))
    const base = `http://127.0.0.1:${(listener.address() as { port: number }).port}`
    expect((await cli(['profile', 'add', 's2', '--server', base, '--auth', 'api-key', '--key-file', join(home, 'key'), '--use', '--output', 'json'], work)).code).toBe(0)

    const rb = await w.call('GET', `/api/v1/clusters/${cid()}/restore-runbook?repository=${repositoryId}`)
    expect(rb.status, JSON.stringify(rb.body).slice(0, 300)).toBe(200)
    const out = '/srv/work/s2/xfer/runbook-main.sh'
    await sh(`rm -f ${out}`)
    const dl = await cli(['restore', 'runbook', cid(), '--repository', repositoryId, '--out', out], work)
    ev('CLI restore runbook (service account, operator role, :nonprod scopes)', { code: dl.code, seconds: dl.seconds, err: dl.stderr.slice(0, 500), out: dl.stdout.slice(0, 400), restDigest: rb.body.digest, restBytes: rb.body.script.length })
    if (dl.code !== 0) writeFileSync(out, rb.body.script, { mode: 0o755 })
    const shaFile = await sh(`sha256sum ${out} | cut -d' ' -f1`)
    ev('runbook file', { sha256: shaFile, digestOfRest: rb.body.digest, placeholders: rb.body.placeholders?.map((p: any) => p.name), mode: await sh(`stat -c %a ${out}`) })
    await sh(`chmod 0755 ${out}; chown postgres ${out}; rm -rf /var/lib/postgresql/s2-offline /var/lib/postgresql/s2-offline.exponetdb; install -m600 -o postgres /root/lab/cipher.pass /var/lib/s2-cipher.pass`)

    // run it with the Control Plane roles stopped: this process stops nothing, but the world's gateway/worker need not be reachable for the script; it touches no ExponetDB endpoint
    const t0 = Date.now()
    const tail = await sh(`runuser -u postgres -- env TARGET_DIR=/var/lib/postgresql/s2-offline PG_BIN=/usr/lib/postgresql/17/bin PORT=55441 CIPHER_PASS_FILE=/var/lib/s2-cipher.pass sh ${out} > ${LOGDIR}/offline-run.out 2>&1; echo rc=$?; tail -4 ${LOGDIR}/offline-run.out | cut -c1-200`)
    const sec = secs(t0)
    const q = (sql: string) => sh(`runuser -u postgres -- /usr/lib/postgresql/17/bin/psql -X -q -A -t -h /var/lib/postgresql/s2-offline.exponetdb/socket -p 55441 -d app -c "${sql}" 2>&1 | head -2`)
    ev('OFFLINE runbook run on the same host (default type: end of archive)', { seconds: sec, tail, marker: await q('select count(*) from marker'), accounts: await q('select count(*) from pgbench_accounts') })
    await sh(`runuser -u postgres -- /usr/lib/postgresql/17/bin/pg_ctl -D /var/lib/postgresql/s2-offline stop -m fast >/dev/null 2>&1; rm -rf /var/lib/postgresql/s2-offline /var/lib/postgresql/s2-offline.exponetdb /var/lib/s2-cipher.pass`)

    await w.reauth()
    const rec = await w.call('POST', `/api/v1/clusters/${cid()}/drills/offline`, { repositoryId, runbookDigest: rb.body.digest, restoredAt: new Date().toISOString(), durationSeconds: Math.round(sec), outcome: 'passed', notes: 'S2: offline runbook run on the same host at 7 GB' })
    ev('record-offline (REST)', { status: rec.status, body: rec.body })
    await w.reauth()
    const wrong = await w.call('POST', `/api/v1/clusters/${cid()}/drills/offline`, { repositoryId, runbookDigest: `sha256:${'0'.repeat(64)}`, restoredAt: new Date().toISOString(), durationSeconds: 5, outcome: 'passed', notes: 'wrong digest' })
    ev('record-offline wrong digest', { status: wrong.status, code: wrong.body?.code, message: wrong.body?.message })
    const rec2 = await cli(['drill', 'record-offline', cid(), '--file', '/dev/null'], work)
    ev('CLI drill record-offline without a usable file (error text)', { code: rec2.code, err: rec2.stderr.slice(0, 400) })
    const cat = (await w.call('GET', `/api/v1/clusters/${cid()}/backups`)).body
    ev('protection after the offline drill', cat.protection)
    ev('drills', (await w.call('GET', `/api/v1/clusters/${cid()}/drills`)).body.drills)
    const dlist = await cli(['drill', 'list', cid()], work); ev('CLI drill list', { code: dlist.code, text: dlist.stdout.slice(0, 1500) })
    expect(rec.status, JSON.stringify(rec.body)).toBe(201)
  }, 3_600_000)
})

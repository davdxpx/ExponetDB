// S2: the Control Plane at 7 GB. Adopts the pgBackRest repository, verifies the backups, runs every drill kind through
// REST (the Web/REST drill records) and the CLI as a real process, downloads the offline runbook, runs it, records the
// offline drill. Stopwatch values are taken outside the product (this process' clock and /srv/work/s2/logs/watch.log).
// Needs host-world.ts patched like R1's (backupExecution + helper ReadWritePaths). Env: S2_TAG (log suffix).
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { describe, expect, it } from 'vitest'
import { hostScenario, run } from '../support/host-world.ts'

const w = hostScenario({ scenario: 's2-cp-drills', freshCluster: false })
const TAG = process.env['S2_TAG'] ?? 'main'
const LOGDIR = '/srv/work/s2/logs'
const EV = `${LOGDIR}/cp-${TAG}.log`
const REPOS = '/etc/exponetdb-node/repositories'
mkdirSync(LOGDIR, { recursive: true })
const now = () => new Date().toISOString()
const ev = (name: string, v: unknown) => appendFileSync(EV, `[${now()}] ${name}: ${JSON.stringify(v)}\n`)
const sh = async (cmd: string) => (await run('bash', ['-c', cmd]).catch((e: any) => ({ stdout: `FAILED ${e.stdout ?? ''} ${e.stderr ?? ''}` }))).stdout.trim()
const CLI_MAIN = fileURLToPath(new URL('../../../cli/src/main.ts', import.meta.url))
let repositoryId = ''
let home = ''
const cid = () => w.clusterId
const secs = (t0: number) => (Date.now() - t0) / 1000

async function planApply(path: string, body: unknown, ms = 3_600_000) {
  const tPlan = Date.now()
  const planned = await w.call('POST', path, body)
  if (planned.status !== 201 || planned.body?.decision === 'deny') {
    return { planned, head: { status: planned.status, decision: planned.body?.decision, code: planned.body?.code, details: planned.body?.details ?? planned.body?.reasons } } as any
  }
  await w.reauth()
  const tApply = Date.now()
  const applied = await w.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
  if (applied.status !== 202) return { planned, applied, head: { status: applied.status, body: applied.body } } as any
  const done = await w.finished(applied.body.id, ms)
  const tDone = Date.now()
  return { planned, applied, done, head: { status: 201 }, planSeconds: (tApply - tPlan) / 1000, applyToDoneSeconds: (tDone - tApply) / 1000, tApplyIso: new Date(tApply).toISOString(), tDoneIso: new Date(tDone).toISOString() } as any
}
async function refresh() {
  const r = await w.call('POST', `/api/v1/clusters/${cid()}/backups/refresh`, {})
  expect(r.status, JSON.stringify(r.body)).toBe(202)
  return w.finished(r.body.id)
}
const catalog = async () => (await w.call('GET', `/api/v1/clusters/${cid()}/backups`)).body
function cli(args: readonly string[], cwd: string, input?: string): Promise<{ code: number; stdout: string; stderr: string; seconds: number }> {
  const t0 = Date.now()
  return new Promise((resolve) => {
    const child = spawn('bun', ['--conditions=@exponetdb/source', CLI_MAIN, ...args], { cwd, env: { PATH: process.env['PATH'] ?? '', HOME: home, EXPONETDB_CONFIG_DIR: join(home, 'config'), NO_COLOR: '1', EXPONETDB_PROFILE: 's2' } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b) => (stdout += b))
    child.stderr.on('data', (b) => (stderr += b))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr, seconds: secs(t0) }))
    if (input !== undefined) child.stdin.end(input)
  })
}
const targets = (): Record<string, { id: number; at: string }> => {
  const out: Record<string, { id: number; at: string }> = {}
  for (const line of readFileSync(`${LOGDIR}/targets.tsv`, 'utf8').trim().split('\n')) {
    const [name, id, at] = line.split('\t')
    out[name!] = { id: Number(id), at: at! }
  }
  return out
}
async function drill(label: string, selection: unknown) {
  const t0 = Date.now()
  const r = await planApply(`/api/v1/clusters/${cid()}/drills`, { repositoryId, selection })
  const d = await w.call('GET', `/api/v1/clusters/${cid()}/drills`)
  const rs = await w.call('GET', `/api/v1/clusters/${cid()}/restores`)
  const drillRec = d.body.drills?.[0]
  const restore = rs.body.restores?.[0]
  ev(`DRILL ${label}`, {
    wallSecondsPlanToDone: secs(t0), head: r.head, op: r.done, planSeconds: r.planSeconds, applyToDoneSeconds: r.applyToDoneSeconds, tApply: r.tApplyIso, tDone: r.tDoneIso,
    drill: drillRec, restore,
  })
  return { r, drillRec, restore }
}

describe(`S2 Control Plane at 7 GB (${TAG})`, () => {
  it('adopts the repository, sets adopted_runs, refreshes the catalog', async () => {
    await w.inspect('postgres.status@1')
    const t0 = Date.now()
    const a = await planApply(`/api/v1/clusters/${cid()}/backup-repositories`, { layer: 'l1_physical', engine: 'pgbackrest', provider: 'posix', location: { endpointHost: null, region: null, bucket: null, prefix: 'var/lib/pgbackrest/', stanza: 'exdbnode', repoIndex: 1 } })
    expect(a.done?.state, JSON.stringify(a.head)).toBe('succeeded')
    repositoryId = (await w.call('GET', `/api/v1/clusters/${cid()}/backup-repositories`)).body.repositories[0].id
    await sh(`mkdir -p ${REPOS}/${repositoryId} && echo adopted_runs > ${REPOS}/${repositoryId}/mode && printf 'stanza=exdbnode\\nrepo=1\\n' > ${REPOS}/${repositoryId}/pgbackrest && chmod 644 ${REPOS}/${repositoryId}/*`)
    const o = await planApply(`/api/v1/backup-repositories/${repositoryId}/ownership`, { to: 'adopted_runs', acknowledge: { hostConfigurationUnchanged: true } })
    expect(o.done?.state, JSON.stringify(o.head)).toBe('succeeded')
    await sh('runuser -u postgres -- psql -X -q -p 55417 -d app -c "SELECT pg_switch_wal()"; sleep 2; runuser -u postgres -- pgbackrest --stanza=exdbnode check')
    ev('wal.archive_status', await w.inspect('wal.archive_status@1'))
    const t1 = Date.now()
    const r = await refresh()
    ev('refresh', { op: r, seconds: secs(t1), setupSeconds: (t1 - t0) / 1000 })
    const cat = await catalog()
    ev('catalog', { n: cat.backups.length, backups: cat.backups.map((b: any) => ({ id: b.id, label: b.engineLabel, kind: b.kind, size: b.sizeBytes, verification: b.verification, walFrom: b.walFrom, walTo: b.walTo })), protection: cat.protection, walCoverage: cat.walCoverage })
    expect(cat.backups.length).toBeGreaterThanOrEqual(3)
  })

  it('verifies every backup through the product (stopwatch per backup)', async () => {
    const cat = await catalog()
    const rows: unknown[] = []
    for (const b of cat.backups) {
      const t0 = Date.now()
      const v = await w.call('POST', `/api/v1/clusters/${cid()}/backups/${b.id}/verify`, {})
      expect(v.status, JSON.stringify(v.body)).toBe(202)
      const d = await w.finished(v.body.id, 3_600_000)
      rows.push({ label: b.engineLabel, kind: b.kind, state: d.state, verification: d.verificationOutcome, errorCode: d.errorCode, seconds: secs(t0) })
    }
    ev('product verify of every backup', rows)
    await refresh()
    ev('protection after verify', (await catalog()).protection)
    expect(rows.every((s: any) => s.state === 'succeeded')).toBe(true)
  })

  it('CLI as a real process: overview, list, runs (text and json)', async () => {
    home = await mkdtemp(join(tmpdir(), 's2-cli-'))
    const work = join(home, 'work')
    await mkdir(work, { recursive: true })
    const acct = await w.serviceAccount('s2 cli', 'operator')
    const scopes = ['targets.read', 'backups.read', 'backups.run', 'restore.plan', 'nodes.read', 'audit.read']
    const key = await w.apiKey(acct, scopes, ['nonprod'])
    await writeFile(join(home, 'key'), key, { mode: 0o600 })
    const listener = serve({ fetch: w.app.fetch, hostname: '127.0.0.1', port: 0 })
    await new Promise((r) => listener.once('listening', r))
    const addr = listener.address() as { port: number }
    const base = `http://127.0.0.1:${addr.port}`
    const add = await cli(['profile', 'add', 's2', '--server', base, '--auth', 'api-key', '--key-file', join(home, 'key'), '--use', '--output', 'json'], work)
    expect(add.code, add.stderr).toBe(0)
    for (const args of [['backup', 'overview'], ['backup', 'list', cid()], ['backup', 'repositories', cid()], ['backup', 'runs', cid()], ['drill', 'list', cid()]]) {
      const t = await cli(args, work)
      const j = await cli([...args, '--output', 'json'], work)
      ev(`CLI ${args.slice(0, 2).join(' ')}`, { codeText: t.code, codeJson: j.code, seconds: t.seconds, text: t.stdout.slice(0, 1500), err: t.stderr.slice(0, 300), jsonBytes: j.stdout.length })
    }
    // a drill plan from the CLI (plan only; the apply is human only with re-authentication in the browser)
    const p = await cli(['drill', 'plan', cid(), '--repository', repositoryId, '--selection', 'latest', '--no-wait', '--output', 'json'], work)
    ev('CLI drill plan latest', { code: p.code, out: p.stdout.slice(0, 1200), err: p.stderr.slice(0, 400) })
    const apply = await cli(['drill', 'plan', cid(), '--repository', repositoryId, '--selection', 'latest', '--apply', '--timeout-wait', '120s'], work)
    ev('CLI drill plan --apply (no browser step-up possible)', { code: apply.code, out: apply.stdout.slice(0, 800), err: apply.stderr.slice(0, 800) })
    ;(globalThis as any).S2_BASE = base
    ;(globalThis as any).S2_WORK = work
  }, 900_000)

  it('drills through REST: latest, older, pitr_random (RTO reported vs stopwatch)', async () => {
    const results: Record<string, any> = {}
    await sh('runuser -u postgres -- psql -X -q -p 55417 -d app -c "SELECT pg_switch_wal()"; sleep 2; runuser -u postgres -- pgbackrest --stanza=exdbnode check')
    await refresh()
    for (const kind of ['latest', 'older', 'pitr_random']) {
      const x = await drill(kind, { kind })
      results[kind] = x
    }
    for (const kind of ['latest', 'older', 'pitr_random']) expect(results[kind].drillRec?.outcome, `${kind}: ${JSON.stringify(results[kind].r.head)}`).toBe('passed')
  })

  it('drills through REST: explicit backup and explicit PITR targets taken under load', async () => {
    const t = targets()
    const cat = await catalog()
    const full = [...cat.backups].filter((b: any) => b.kind === 'full').sort((a: any, b: any) => String(a.finishedAt).localeCompare(String(b.finishedAt)))
    ev('explicit selection sources', { fulls: full.map((b: any) => b.engineLabel), targets: t })
    const x1 = await drill('backup:oldest-full', { kind: 'backup', backupId: full[0].id })
    for (const name of ['T1-after-incr', 'T3-after-full2']) {
      const at = new Date(t[name]!.at.replace(' ', 'T').replace('+00', 'Z')).toISOString()
      const x = await drill(`pitr:${name} (${at}) expect marker ${t[name]!.id}`, { kind: 'pitr', at })
      ev(`PITR ${name}`, { expectedMarker: t[name]!.id, outcome: x.drillRec?.outcome })
    }
    expect(x1.drillRec?.outcome).toBe('passed')
  })

  it('offline runbook: download (CLI + REST), run it with the Control Plane roles stopped, record the drill', async () => {
    const rb = await w.call('GET', `/api/v1/clusters/${cid()}/restore-runbook?repository=${repositoryId}`)
    expect(rb.status, JSON.stringify(rb.body).slice(0, 300)).toBe(200)
    const out = '/srv/work/s2/xfer/runbook-main.sh'
    await sh(`rm -f ${out}`)
    const dl = await cli(['restore', 'runbook', cid(), '--repository', repositoryId, '--out', out], (globalThis as any).S2_WORK)
    ev('CLI restore runbook', { code: dl.code, err: dl.stderr.slice(0, 600), out: dl.stdout.slice(0, 600), restDigest: rb.body.digest, placeholders: rb.body.placeholders?.map((p: any) => p.name) })
    expect(dl.code, dl.stderr).toBe(0)
    await sh(`chmod 0755 ${out}; chown postgres ${out} 2>/dev/null; rm -rf /var/lib/s2-offline /var/lib/s2-offline.exponetdb; echo -n "$(cat /root/lab/cipher.pass)" > /var/lib/s2-cipher.pass; chown postgres /var/lib/s2-cipher.pass; chmod 600 /var/lib/s2-cipher.pass`)
    const t0 = Date.now()
    const r = await sh(`runuser -u postgres -- env TARGET_DIR=/var/lib/s2-offline PG_BIN=/usr/lib/postgresql/17/bin PORT=55441 CIPHER_PASS_FILE=/var/lib/s2-cipher.pass sh ${out} 2>&1 | tail -12`)
    const sec = secs(t0)
    ev('OFFLINE runbook run (same host, default type)', { seconds: sec, tail: r.slice(-1500) })
    const rows = await sh(`runuser -u postgres -- psql -X -A -t -h /var/lib/s2-offline.exponetdb/socket -p 55441 -d app -c "SELECT count(*) FROM marker" 2>&1`)
    ev('offline restored marker rows', rows)
    await sh(`runuser -u postgres -- /usr/lib/postgresql/17/bin/pg_ctl -D /var/lib/s2-offline stop -m fast >/dev/null 2>&1; rm -rf /var/lib/s2-offline /var/lib/s2-offline.exponetdb`)
    await w.reauth()
    const rec = await w.call('POST', `/api/v1/clusters/${cid()}/drills/offline`, { repositoryId, runbookDigest: rb.body.digest, restoredAt: new Date().toISOString(), durationSeconds: Math.round(sec), outcome: 'passed', notes: 'S2: offline runbook run on the same host, 7 GB, see S2 notes' })
    ev('record-offline', { status: rec.status, body: rec.body })
    await w.reauth()
    const wrong = await w.call('POST', `/api/v1/clusters/${cid()}/drills/offline`, { repositoryId, runbookDigest: `sha256:${'0'.repeat(64)}`, restoredAt: new Date().toISOString(), durationSeconds: 5, outcome: 'passed', notes: 'wrong digest' })
    ev('record-offline wrong digest', { status: wrong.status, code: wrong.body?.code })
    const dl2 = await w.call('GET', `/api/v1/clusters/${cid()}/drills`)
    ev('drills at the end', dl2.body.drills?.map((d: any) => ({ id: d.id, selection: d.selection, mode: d.mode, outcome: d.outcome, rto: d.measuredRtoSeconds, startedAt: d.startedAt, finishedAt: d.finishedAt })))
    ev('protection at the end', (await catalog()).protection)
    expect(rec.status, JSON.stringify(rec.body)).toBe(201)
    const cli2 = await cli(['drill', 'list', cid()], (globalThis as any).S2_WORK)
    ev('CLI drill list at the end', { code: cli2.code, text: cli2.stdout.slice(0, 2500) })
  }, 3_600_000)
})

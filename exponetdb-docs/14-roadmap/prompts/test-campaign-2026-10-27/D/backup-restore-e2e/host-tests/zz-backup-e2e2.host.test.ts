import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { hostScenario, run } from '../support/host-world.ts'

/** Test-campaign scenario 2 (tc-node-2): pitr_random / pitr drills, wal.archive_status, C-35 with the roles stopped, record-offline. */
const w = hostScenario({ scenario: 'backup-e2e2', freshCluster: false })
const EV = '/root/lab/logs/b2-evidence.log'
const REPOS = '/etc/exponetdb-node/repositories'
mkdirSync('/root/lab/logs', { recursive: true })
const ev = (name: string, v: unknown) => appendFileSync(EV, `[${new Date().toISOString()}] ${name}: ${JSON.stringify(v)}\n`)
const sh = async (cmd: string) => (await run('bash', ['-c', cmd]).catch((e: any) => ({ stdout: `FAILED ${e.stdout ?? ''} ${e.stderr ?? ''}` }))).stdout.trim()
let repositoryId = ''
const cid = () => w.clusterId

async function planApply(path: string, body: unknown, ms = 900_000) {
  const t0 = Date.now()
  const planned = await w.call('POST', path, body)
  if (planned.status !== 201 || planned.body?.decision === 'deny') return { planned, head: { status: planned.status, decision: planned.body?.decision, details: planned.body?.details } }
  await w.reauth()
  const applied = await w.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
  if (applied.status !== 202) return { planned, applied, head: { status: applied.status, body: applied.body } }
  const done = await w.finished(applied.body.id, ms)
  return { planned, applied, done, head: { status: 201 }, seconds: (Date.now() - t0) / 1000 }
}
async function refresh() {
  const r = await w.call('POST', `/api/v1/clusters/${cid()}/backups/refresh`, {})
  expect(r.status, JSON.stringify(r.body)).toBe(202)
  return w.finished(r.body.id)
}
async function lastDrill() {
  const d = await w.call('GET', `/api/v1/clusters/${cid()}/drills`)
  const rs = await w.call('GET', `/api/v1/clusters/${cid()}/restores`)
  return { drill: d.body.drills[0], restore: rs.body.restores?.[0] }
}

describe('drills, C-35 and the offline record (tc-node-2)', () => {
  it('C1 adopt, adopted_runs, wal.archive_status, refresh, verify three backups', async () => {
    await w.inspect('postgres.status@1')
    const a = await planApply(`/api/v1/clusters/${cid()}/backup-repositories`, { layer: 'l1_physical', engine: 'pgbackrest', provider: 'posix', location: { endpointHost: null, region: null, bucket: null, prefix: 'var/lib/pgbackrest/', stanza: 'exdbnode', repoIndex: 1 } })
    expect(a.done?.state).toBe('succeeded')
    repositoryId = (await w.call('GET', `/api/v1/clusters/${cid()}/backup-repositories`)).body.repositories[0].id
    await sh(`mkdir -p ${REPOS}/${repositoryId} && echo adopted_runs > ${REPOS}/${repositoryId}/mode && printf 'stanza=exdbnode\\nrepo=1\\n' > ${REPOS}/${repositoryId}/pgbackrest && chmod 644 ${REPOS}/${repositoryId}/*`)
    await planApply(`/api/v1/backup-repositories/${repositoryId}/ownership`, { to: 'adopted_runs', acknowledge: { hostConfigurationUnchanged: true } })
    await sh('runuser -u postgres -- psql -X -q -p 55417 -d app -c "SELECT pg_switch_wal()"; sleep 2; runuser -u postgres -- pgbackrest --stanza=exdbnode check')
    const arch = await w.inspect('wal.archive_status@1')
    ev('wal.archive_status', arch)
    ev('refresh', await refresh())
    const cat = (await w.call('GET', `/api/v1/clusters/${cid()}/backups`)).body
    ev('protection', cat.protection)
    const sorted = [...cat.backups].sort((x: any, y: any) => String(y.finishedAt).localeCompare(String(x.finishedAt)))
    for (const t of [sorted[0], sorted[2], sorted[3]]) {
      const v = await w.call('POST', `/api/v1/clusters/${cid()}/backups/${t.id}/verify`, {})
      const vd = await w.finished(v.body.id)
      ev('verify', { label: t.engineLabel, state: vd.state })
    }
    await refresh()
  })

  it('C2 M-6: pitr_random and an explicit pitr drill', async () => {
    await sh('sleep 2; runuser -u postgres -- psql -X -q -p 55417 -d app -c "SELECT pg_switch_wal()"; sleep 2; runuser -u postgres -- pgbackrest --stanza=exdbnode check')
    await w.inspect('wal.archive_status@1')
    await refresh()
    for (const selection of [{ kind: 'pitr_random' }, { kind: 'pitr_random' }, { kind: 'pitr', at: new Date(Date.now() - 20 * 60_000).toISOString() }]) {
      const t1 = Date.now()
      const r = await planApply(`/api/v1/clusters/${cid()}/drills`, { repositoryId, selection })
      const { drill, restore } = await lastDrill()
      ev(`DRILL ${JSON.stringify(selection)}`, { head: r.head, done: r.done, seconds: (Date.now() - t1) / 1000, drill, restoreState: restore?.state, checks: restore?.checks, plan: r.planned?.body?.change?.source ?? r.planned?.body?.change?.analysis })
      const jobs = await w.sql("SELECT j.capability, left((j.completion - 'nodeSignature')::text, 1200) AS c FROM nodes.jobs j WHERE j.capability = 'run.status@1' ORDER BY j.created_at DESC LIMIT 1")
      ev('last run.status', jobs)
    }
  })

  it('C3 T-C35-1: runbook, Control Plane roles stopped, offline restore, record-offline', async () => {
    const rb = await w.call('GET', `/api/v1/clusters/${cid()}/restore-runbook?repository=${repositoryId}`)
    expect(rb.status).toBe(200)
    mkdirSync('/var/lib/c35', { recursive: true })
    writeFileSync('/var/lib/c35/recover-cp.sh', rb.body.script, { mode: 0o755 })
    const expected = (await run('runuser', ['-u', 'postgres', '--', 'psql', '-X', '-A', '-t', '-p', '55417', '-d', 'app', '-c', 'SELECT pg_switch_wal(); SELECT count(*) FROM accounts'])).stdout.trim().split('\n').pop()
    await sh('sleep 3; runuser -u postgres -- pgbackrest --stanza=exdbnode check')
    await w.stopGateway()
    await w.stopWorker()
    ev('control plane roles stopped', { gateway: 'stopped', worker: 'stopped' })
    const t0 = Date.now()
    const out = await sh('rm -rf /var/lib/c35/cp-restore /var/lib/c35/cp-restore.exponetdb; chown postgres: /var/lib/c35; runuser -u postgres -- env TARGET_DIR=/var/lib/c35/cp-restore PG_BIN=/usr/lib/postgresql/17/bin PORT=55450 CIPHER_PASS_FILE=/var/lib/c35/pass sh /var/lib/c35/recover-cp.sh 2>&1 | tail -12')
    const seconds = (Date.now() - t0) / 1000
    const rows = await sh("runuser -u postgres -- psql -X -A -t -h /var/lib/c35/cp-restore.exponetdb/socket -p 55450 -d app -c 'SELECT count(*) FROM accounts'")
    const recovery = await sh("runuser -u postgres -- psql -X -A -t -h /var/lib/c35/cp-restore.exponetdb/socket -p 55450 -d postgres -c 'SELECT pg_is_in_recovery()'")
    ev('C-35 offline restore', { seconds, tail: out.slice(-900), restoredRows: rows, expectedRows: expected, inRecovery: recovery })
    const again = await sh('runuser -u postgres -- env TARGET_DIR=/var/lib/c35/cp-restore PG_BIN=/usr/lib/postgresql/17/bin PORT=55450 CIPHER_PASS_FILE=/var/lib/c35/pass sh /var/lib/c35/recover-cp.sh 2>&1 | tail -2; echo rc=$?')
    ev('C-35 non-empty TARGET_DIR', again)
    await sh('runuser -u postgres -- /usr/lib/postgresql/17/bin/pg_ctl -D /var/lib/c35/cp-restore stop -m fast')
    w.startGateway()
    w.startWorker()
    await w.nodeOnline()
    await w.reauth()
    const rec = await w.call('POST', `/api/v1/clusters/${cid()}/drills/offline`, { repositoryId, runbookDigest: rb.body.digest, restoredAt: new Date().toISOString(), durationSeconds: Math.max(1, Math.round(seconds)), outcome: rows === expected ? 'passed' : 'failed', notes: 'tc-node-2 offline drill, roles stopped, restored rows equal the source' })
    ev('record-offline', { status: rec.status, body: rec.body })
    const dr = await w.call('GET', `/api/v1/clusters/${cid()}/drills`)
    ev('drills after the record', dr.body.drills?.slice(0, 2))
    const cat = await w.call('GET', `/api/v1/clusters/${cid()}/backups`)
    ev('protection after the offline record', cat.body.protection)
    // wrong runbook digest
    await w.reauth()
    const bad = await w.call('POST', `/api/v1/clusters/${cid()}/drills/offline`, { repositoryId, runbookDigest: `sha256:${'0'.repeat(64)}`, restoredAt: new Date().toISOString(), durationSeconds: 60, outcome: 'passed', notes: 'wrong digest' })
    ev('record-offline with a wrong digest', { status: bad.status, code: bad.body?.code })
    readFileSync('/var/lib/c35/recover-cp.sh')
  })
})

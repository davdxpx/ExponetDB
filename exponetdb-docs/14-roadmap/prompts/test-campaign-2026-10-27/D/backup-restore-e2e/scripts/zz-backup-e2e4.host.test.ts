import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { hostScenario, run } from '../support/host-world.ts'

/** Test-campaign scenario 2 (tc-node-2): pitr_random / pitr drills, wal.archive_status, C-35 with the roles stopped, record-offline. */
const w = hostScenario({ scenario: 'backup-e2e3', freshCluster: false })
const EV = '/root/lab/logs/b3-evidence.log'
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
    await sh(`for d in $(runuser -u postgres -- psql -X -A -t -p 55417 -d postgres -c "select datname from pg_database where datallowconn"); do runuser -u postgres -- psql -X -q -p 55417 -d $d -c 'CREATE EXTENSION IF NOT EXISTS amcheck'; done`)
    ev('databases', await sh("runuser -u postgres -- psql -X -A -t -p 55417 -d postgres -c 'select string_agg(datname, chr(44)) from pg_database where datallowconn'"))
    await sh(`for d in $(runuser -u postgres -- psql -X -A -t -p 55417 -d postgres -c "select datname from pg_database where datallowconn"); do runuser -u postgres -- psql -X -q -p 55417 -d $d -c 'CREATE EXTENSION IF NOT EXISTS amcheck'; done`)
    await w.inspect('postgres.status@1')
    const a = await planApply(`/api/v1/clusters/${cid()}/backup-repositories`, { layer: 'l1_physical', engine: 'pgbackrest', provider: 'posix', location: { endpointHost: null, region: null, bucket: null, prefix: 'var/lib/pgbackrest/', stanza: 'exdbnode', repoIndex: 1 } })
    expect(a.done?.state).toBe('succeeded')
    repositoryId = (await w.call('GET', `/api/v1/clusters/${cid()}/backup-repositories`)).body.repositories[0].id
    await sh(`mkdir -p ${REPOS}/${repositoryId} && echo adopted_runs > ${REPOS}/${repositoryId}/mode && printf 'stanza=exdbnode\\nrepo=1\\n' > ${REPOS}/${repositoryId}/pgbackrest && chmod 644 ${REPOS}/${repositoryId}/*`)
    await planApply(`/api/v1/backup-repositories/${repositoryId}/ownership`, { to: 'adopted_runs', acknowledge: { hostConfigurationUnchanged: true } })
    const tb = Date.now()
    const inc = await planApply(`/api/v1/clusters/${cid()}/backup-runs`, { repositoryId, kind: 'incremental' })
    ev('fresh incremental (after amcheck everywhere)', { done: inc.done, seconds: (Date.now() - tb) / 1000 })
    await sh('runuser -u postgres -- psql -X -q -p 55417 -d app -c "SELECT pg_switch_wal()"; sleep 2; runuser -u postgres -- pgbackrest --stanza=exdbnode check')
    const arch = await w.inspect('wal.archive_status@1')
    ev('wal.archive_status', arch)
    ev('refresh', await refresh())
    const cat = (await w.call('GET', `/api/v1/clusters/${cid()}/backups`)).body
    ev('protection', cat.protection)
    const sorted = [...cat.backups].sort((x: any, y: any) => String(y.finishedAt).localeCompare(String(x.finishedAt)))
    for (const t of [sorted[0], sorted[1]]) {
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
    const base = (await w.call('GET', `/api/v1/clusters/${cid()}/backups`)).body.backups.filter((b: any) => b.verification?.state === 'passed').sort((x: any, y: any) => String(y.finishedAt).localeCompare(String(x.finishedAt)))[0]
    ev('newest verified base', base)
    for (const selection of [{ kind: 'latest' }, { kind: 'older' }, { kind: 'pitr_random' }, { kind: 'pitr_random' }, { kind: 'pitr', at: new Date(Date.parse(base.finishedAt) + 25_000).toISOString() }]) {
      const t1 = Date.now()
      const r = await planApply(`/api/v1/clusters/${cid()}/drills`, { repositoryId, selection })
      const { drill, restore } = await lastDrill()
      ev(`DRILL ${JSON.stringify(selection)}`, { head: r.head, done: r.done, seconds: (Date.now() - t1) / 1000, drill, restoreState: restore?.state, checks: restore?.checks, plan: r.planned?.body?.change?.source ?? r.planned?.body?.change?.analysis })
      const jobs = await w.sql("SELECT j.capability, left((j.completion - 'nodeSignature')::text, 1200) AS c FROM nodes.jobs j WHERE j.capability = 'run.status@1' ORDER BY j.created_at DESC LIMIT 1")
      ev('last run.status', jobs)
    }
  })

})

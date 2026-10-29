// S2: when is a pitr / pitr_random drill plannable? Refresh after a new archived segment without a fresh wal.archive_status observation, then with one. Plan only.
import { appendFileSync, mkdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { hostScenario, run } from '../support/host-world.ts'
const w = hostScenario({ scenario: 's2-cp-window', freshCluster: false })
const EV = '/srv/work/s2/logs/cp-window.log'
mkdirSync('/srv/work/s2/logs', { recursive: true })
const ev = (n: string, v: unknown) => appendFileSync(EV, `[${new Date().toISOString()}] ${n}: ${JSON.stringify(v)}\n`)
const sh = async (c: string) => (await run('bash', ['-c', c]).catch((e: any) => ({ stdout: `FAILED ${e.stderr ?? ''}` }))).stdout.trim()
const cid = () => w.clusterId
async function planApply(path: string, body: unknown) {
  const p = await w.call('POST', path, body); if (p.status !== 201) return { p } as any
  await w.reauth(); const a = await w.call('POST', `/api/v1/plans/${p.body.id}/apply`, {}); return { p, done: await w.finished(a.body.id, 600_000) } as any
}
const refresh = async () => { const r = await w.call('POST', `/api/v1/clusters/${cid()}/backups/refresh`, {}); return w.finished(r.body.id) }
const plan = async (sel: unknown, repo: string) => { const r = await w.call('POST', `/api/v1/clusters/${cid()}/drills`, { repositoryId: repo, selection: sel }); return { status: r.status, decision: r.body?.decision, code: r.body?.code, details: r.body?.details } }
describe('S2 pitr window', () => {
  it('pitr_random is plannable only after a fresh wal.archive_status observation', async () => {
    await w.inspect('postgres.status@1')
    const a = await planApply(`/api/v1/clusters/${cid()}/backup-repositories`, { layer: 'l1_physical', engine: 'pgbackrest', provider: 'posix', location: { endpointHost: null, region: null, bucket: null, prefix: 'var/lib/pgbackrest/', stanza: 'exdbnode', repoIndex: 1 } })
    expect(a.done?.state).toBe('succeeded')
    const repo = (await w.call('GET', `/api/v1/clusters/${cid()}/backup-repositories`)).body.repositories[0].id
    await sh(`mkdir -p /etc/exponetdb-node/repositories/${repo} && echo adopted_runs > /etc/exponetdb-node/repositories/${repo}/mode && printf 'stanza=exdbnode\\nrepo=1\\n' > /etc/exponetdb-node/repositories/${repo}/pgbackrest && chmod 644 /etc/exponetdb-node/repositories/${repo}/*`)
    await planApply(`/api/v1/backup-repositories/${repo}/ownership`, { to: 'adopted_runs', acknowledge: { hostConfigurationUnchanged: true } })
    ev('refresh only (no archive observation yet)', await refresh())
    const cat = (await w.call('GET', `/api/v1/clusters/${cid()}/backups`)).body
    const full = [...cat.backups].filter((b: any) => b.kind === 'full').sort((a: any, b: any) => String(b.finishedAt).localeCompare(String(a.finishedAt)))[0]
    const v = await w.call('POST', `/api/v1/clusters/${cid()}/backups/${full.id}/verify`, {}); ev('verify newest full', await w.finished(v.body.id, 600_000))
    ev('refresh after verify', await refresh())
    const cat0 = (await w.call('GET', `/api/v1/clusters/${cid()}/backups`)).body
    ev('protection pitrWindow before any observation', { pitrWindow: cat0.protection?.pitrWindow, rpo: cat0.protection?.rpo })
    ev('plan pitr_random (refresh only)', await plan({ kind: 'pitr_random' }, repo))
    ev('wal.archive_status', await w.inspect('wal.archive_status@1'))
    ev('refresh', await refresh())
    const cat1 = (await w.call('GET', `/api/v1/clusters/${cid()}/backups`)).body
    ev('protection pitrWindow after observation + refresh', { pitrWindow: cat1.protection?.pitrWindow, rpo: cat1.protection?.rpo, reasons: cat1.protection?.reasons })
    ev('plan pitr_random (observed, then refreshed)', await plan({ kind: 'pitr_random' }, repo))
    await sh('runuser -u postgres -- psql -X -q -p 55417 -d app -c "SELECT pg_switch_wal()"; sleep 3')
    ev('refresh after one new archived segment, no new observation', await refresh())
    ev('plan pitr_random (a segment newer than the observation)', await plan({ kind: 'pitr_random' }, repo))
    ev('wal.archive_status again', await w.inspect('wal.archive_status@1'))
    ev('plan pitr_random (observed again, no refresh)', await plan({ kind: 'pitr_random' }, repo))
    ev('refresh', await refresh())
    ev('plan pitr_random (observed again, refreshed)', await plan({ kind: 'pitr_random' }, repo))
  }, 900_000)
})

// R1: TC-009/010/011/013 through the real Control Plane (serve in process, gateway, worker), the real agent and
// root helper as systemd units, real pgBackRest 2.60 and PostgreSQL 17. Needs host-world.ts patched for
// backupExecution + the helper unit's ReadWritePaths (as the first campaign's D-block did).
import { appendFileSync, copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { hostScenario, run } from '../support/host-world.ts'

const w = hostScenario({ scenario: 'r1-cp-backup', freshCluster: false })
const TAG = process.env['R1_TAG'] ?? 'new'
const EV = `/srv/work/r1/logs/cp-${TAG}.log`
const REPOS = '/etc/exponetdb-node/repositories'
const ARC = '/var/lib/pgbackrest/archive/exdbnode/17-1/0000000100000000'
mkdirSync('/root/lab/walsave', { recursive: true })
const ev = (name: string, v: unknown) => appendFileSync(EV, `[${new Date().toISOString()}] ${name}: ${JSON.stringify(v)}\n`)
const sh = async (cmd: string) => (await run('bash', ['-c', cmd]).catch((e: any) => ({ stdout: `FAILED ${e.stdout ?? ''} ${e.stderr ?? ''}` }))).stdout.trim()
let repositoryId = ''
const cid = () => w.clusterId

async function planApply(path: string, body: unknown, ms = 900_000) {
  const t0 = Date.now()
  const planned = await w.call('POST', path, body)
  if (planned.status !== 201 || planned.body?.decision === 'deny') {
    return { planned, head: { status: planned.status, decision: planned.body?.decision, code: planned.body?.code, details: planned.body?.details ?? planned.body?.reasons } }
  }
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
const catalog = async () => (await w.call('GET', `/api/v1/clusters/${cid()}/backups`)).body
async function lastDrill() {
  const d = await w.call('GET', `/api/v1/clusters/${cid()}/drills`)
  const rs = await w.call('GET', `/api/v1/clusters/${cid()}/restores`)
  return { drill: d.body.drills[0], restore: rs.body.restores?.[0] }
}

describe(`R1 backups through the Control Plane (${TAG})`, () => {
  it('adopts the repository, sets adopted_runs, observes the archive, refreshes', async () => {
    await w.inspect('postgres.status@1')
    const a = await planApply(`/api/v1/clusters/${cid()}/backup-repositories`, {
      layer: 'l1_physical', engine: 'pgbackrest', provider: 'posix',
      location: { endpointHost: null, region: null, bucket: null, prefix: 'var/lib/pgbackrest/', stanza: 'exdbnode', repoIndex: 1 },
    })
    expect(a.done?.state, JSON.stringify(a.head)).toBe('succeeded')
    repositoryId = (await w.call('GET', `/api/v1/clusters/${cid()}/backup-repositories`)).body.repositories[0].id
    await sh(`mkdir -p ${REPOS}/${repositoryId} && echo adopted_runs > ${REPOS}/${repositoryId}/mode && printf 'stanza=exdbnode\\nrepo=1\\n' > ${REPOS}/${repositoryId}/pgbackrest && chmod 644 ${REPOS}/${repositoryId}/*`)
    const o = await planApply(`/api/v1/backup-repositories/${repositoryId}/ownership`, { to: 'adopted_runs', acknowledge: { hostConfigurationUnchanged: true } })
    expect(o.done?.state, JSON.stringify(o.head)).toBe('succeeded')
    await sh('runuser -u postgres -- psql -X -q -p 55417 -d app -c "SELECT pg_switch_wal()"; sleep 2; runuser -u postgres -- pgbackrest --stanza=exdbnode check')
    ev('wal.archive_status', await w.inspect('wal.archive_status@1'))
    const r = await refresh()
    ev('refresh', r)
    const cat = await catalog()
    ev('catalog', { n: cat.backups.length, labels: cat.backups.map((b: any) => b.engineLabel), protection: cat.protection })
    expect(cat.backups.length).toBeGreaterThanOrEqual(3)
  })

  it('verifies every backup (a clean repository)', async () => {
    const cat = await catalog()
    const states: unknown[] = []
    for (const b of cat.backups) {
      const v = await w.call('POST', `/api/v1/clusters/${cid()}/backups/${b.id}/verify`, {})
      expect(v.status, JSON.stringify(v.body)).toBe(202)
      const d = await w.finished(v.body.id)
      states.push({ label: b.engineLabel, state: d.state, verification: d.verificationOutcome })
    }
    ev('clean verify', states)
    await refresh()
    expect(states.every((s: any) => s.state === 'succeeded')).toBe(true)
  })

  it('TC-009/010: drills latest, older, pitr_random end passed with a measured RTO (amcheck exists in app only)', async () => {
    const results: Record<string, unknown> = {}
    for (const kind of ['latest', 'older', 'pitr_random']) {
      const t0 = Date.now()
      const r = await planApply(`/api/v1/clusters/${cid()}/drills`, { repositoryId, selection: { kind } })
      const { drill, restore } = await lastDrill()
      results[kind] = {
        head: r.head, done: r.done?.state, seconds: (Date.now() - t0) / 1000,
        drill: drill && { outcome: drill.outcome, rto: drill.measuredRtoSeconds, mode: drill.mode },
        restoreState: restore?.state,
        checks: (restore?.checks ?? []).map((c: any) => `${c.check}:${c.outcome}`),
        amcheck: (restore?.checks ?? []).find((c: any) => c.check === 'amcheck')?.detail,
        recovery: (restore?.checks ?? []).find((c: any) => c.check === 'recovery_target_reached'),
      }
      ev(`DRILL ${kind}`, results[kind])
    }
    for (const kind of ['latest', 'older', 'pitr_random']) {
      const x = results[kind] as any
      expect(x.drill?.outcome, `${kind}: ${JSON.stringify(x)}`).toBe('passed')
    }
  })

  it('TC-011: a corrupt WAL segment of the archive fails the backup verification', async () => {
    await sh('runuser -u postgres -- psql -X -q -p 55417 -d app -c "INSERT INTO public.accounts SELECT g, \'cp\'||g FROM generate_series(7001,7010) g" -c "SELECT pg_switch_wal()"; sleep 1; runuser -u postgres -- psql -X -q -p 55417 -d app -c "INSERT INTO public.accounts SELECT g, \'cq\'||g FROM generate_series(7101,7110) g" -c "SELECT pg_switch_wal()" -c "SELECT pg_switch_wal()"; for i in 1 2 3 4 5; do runuser -u postgres -- pgbackrest --stanza=exdbnode check && break; sleep 2; done')
    await refresh()
    const segs = readdirSync(ARC).filter((f) => /^0000000100000000000000[0-9A-F]{2}-/.test(f)).sort()
    const seg = segs[segs.length - 3]!
    copyFileSync(`${ARC}/${seg}`, `/root/lab/walsave/cp-${TAG}-${seg}`)
    const size = statSync(`${ARC}/${seg}`).size
    await sh(`printf '\\xde\\xad\\xbe\\xef\\xde\\xad\\xbe\\xef\\xde\\xad\\xbe\\xef' | dd of=${ARC}/${seg} bs=1 seek=${Math.floor(size / 2)} conv=notrunc 2>/dev/null`)
    let verifyState: unknown
    try {
      const cat = await catalog()
      const sorted = [...cat.backups].sort((x: any, y: any) => String(y.finishedAt).localeCompare(String(x.finishedAt)))
      const v = await w.call('POST', `/api/v1/clusters/${cid()}/backups/${sorted[0].id}/verify`, {})
      expect(v.status, JSON.stringify(v.body)).toBe(202)
      const d = await w.finished(v.body.id)
      await refresh()
      const after = (await catalog()).backups.find((b: any) => b.id === sorted[0].id)
      verifyState = { operation: d.state, verificationOutcome: d.verificationOutcome, errorCode: d.errorCode, catalogVerification: after?.verification }
      ev('verify with a corrupt WAL segment', verifyState)
    } finally {
      copyFileSync(`/root/lab/walsave/cp-${TAG}-${seg}`, `${ARC}/${seg}`)
    }
    const vs = verifyState as any
    expect(vs.operation === 'succeeded' && vs.verificationOutcome === 'passed', JSON.stringify(vs)).toBe(false)
  })

  it('TC-013: the offline drill is recorded (201), listed, and a wrong digest is a 422', async () => {
    const rb = await w.call('GET', `/api/v1/clusters/${cid()}/restore-runbook?repository=${repositoryId}`)
    expect(rb.status, JSON.stringify(rb.body)).toBe(200)
    await w.reauth()
    const rec = await w.call('POST', `/api/v1/clusters/${cid()}/drills/offline`, { repositoryId, runbookDigest: rb.body.digest, restoredAt: new Date().toISOString(), durationSeconds: 31, outcome: 'passed', notes: 'r1 verification: the offline restore of the generated runbook was run by hand' })
    ev('record-offline', { status: rec.status, body: rec.body })
    const dr = await w.call('GET', `/api/v1/clusters/${cid()}/drills`)
    ev('drills after the record', dr.body.drills?.slice(0, 2))
    await w.reauth()
    const wrong = await w.call('POST', `/api/v1/clusters/${cid()}/drills/offline`, { repositoryId, runbookDigest: `sha256:${'0'.repeat(64)}`, restoredAt: new Date().toISOString(), durationSeconds: 5, outcome: 'passed', notes: 'wrong digest' })
    ev('record-offline wrong digest', { status: wrong.status, code: wrong.body?.code })
    expect(rec.status, JSON.stringify(rec.body)).toBe(201)
    expect(dr.body.drills.some((d: any) => d.mode === 'offline_runbook' && d.outcome === 'attested')).toBe(true)
    expect(wrong.status).toBe(422)
  })
})

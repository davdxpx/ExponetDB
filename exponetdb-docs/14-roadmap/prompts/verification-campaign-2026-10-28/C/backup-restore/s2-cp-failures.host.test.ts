// S2: failure cases through the Control Plane (REST) at 7 GB: verify + drill after each injected damage, then repair.
// Injection and repair: /srv/work/s2/scripts/s2-inject.sh (reversible). Env: S2_TAG, S2_CASES (comma list), S2_SPECIAL (space,retention).
import { appendFileSync, mkdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { hostScenario, run } from '../support/host-world.ts'

const w = hostScenario({ scenario: 's2-cp-failures', freshCluster: false })
const TAG = process.env['S2_TAG'] ?? 'fail'
const LOGDIR = '/srv/work/s2/logs'
const EV = `${LOGDIR}/cp-${TAG}.log`
const REPOS = '/etc/exponetdb-node/repositories'
mkdirSync(LOGDIR, { recursive: true })
const ev = (name: string, v: unknown) => appendFileSync(EV, `[${new Date().toISOString()}] ${name}: ${JSON.stringify(v)}\n`)
const sh = async (cmd: string) => (await run('bash', ['-c', cmd]).catch((e: any) => ({ stdout: `FAILED ${e.stdout ?? ''} ${e.stderr ?? ''}` }))).stdout.trim()
const cid = () => w.clusterId
let repositoryId = ''
const secs = (t0: number) => (Date.now() - t0) / 1000
const CASES = (process.env['S2_CASES'] ?? 'corrupt-backup-file,corrupt-wal-mid,corrupt-wal-last,delete-wal-mid,delete-wal-last,delete-wal-stop,wrong-key,repo-deleted').split(',')

async function planApply(path: string, body: unknown, ms = 3_600_000) {
  const planned = await w.call('POST', path, body)
  if (planned.status !== 201 || planned.body?.decision === 'deny') return { planned, head: { status: planned.status, decision: planned.body?.decision, code: planned.body?.code, message: planned.body?.message, details: planned.body?.details ?? planned.body?.reasons } } as any
  await w.reauth()
  const applied = await w.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
  if (applied.status !== 202) return { planned, applied, head: { status: applied.status, body: applied.body } } as any
  const done = await w.finished(applied.body.id, ms)
  const opv = await w.call('GET', `/api/v1/operations/${applied.body.id}`)
  return { planned, applied, done, op: opv.body, head: { status: 201 } } as any
}
const refresh = async () => { const r = await w.call('POST', `/api/v1/clusters/${cid()}/backups/refresh`, {}); if (r.status !== 202) return { status: r.status, body: r.body }; return w.finished(r.body.id) }
const catalog = async () => (await w.call('GET', `/api/v1/clusters/${cid()}/backups`)).body
const newestFull = async () => [...(await catalog()).backups].filter((b: any) => b.kind === 'full').sort((a: any, b: any) => String(b.finishedAt).localeCompare(String(a.finishedAt)))[0]
async function verifyNewest(tag: string) {
  const b = await newestFull(); const t0 = Date.now()
  const v = await w.call('POST', `/api/v1/clusters/${cid()}/backups/${b.id}/verify`, {})
  if (v.status !== 202) { ev(`${tag} VERIFY refused`, { status: v.status, body: v.body }); return null }
  const d = await w.finished(v.body.id, 3_600_000); const opv = await w.call('GET', `/api/v1/operations/${v.body.id}`)
  await refresh()
  const after = (await catalog()).backups.find((x: any) => x.id === b.id)
  const out = { label: b.engineLabel, seconds: secs(t0), state: d.state, verification: d.verificationOutcome, errorCode: d.errorCode, errorMessage: opv.body?.error?.message ?? opv.body?.errorMessage ?? null, catalogVerification: after?.verification }
  ev(`${tag} VERIFY newest full`, out); return out
}
async function drillOf(tag: string, selection: unknown) {
  const t0 = Date.now()
  const r = await planApply(`/api/v1/clusters/${cid()}/drills`, { repositoryId, selection })
  const d = await w.call('GET', `/api/v1/clusters/${cid()}/drills`); const rs = await w.call('GET', `/api/v1/clusters/${cid()}/restores`)
  ev(`${tag} DRILL ${JSON.stringify(selection)}`, { seconds: secs(t0), head: r.head, op: r.done, opError: r.op?.error ?? null, drill: r.head?.status === 201 ? d.body.drills?.[0] : null, restore: r.head?.status === 201 ? rs.body.restores?.[0] : null })
  return r
}

describe(`S2 failure cases through the Control Plane (${TAG})`, () => {
  it('adopts the repository and verifies the newest backup (clean baseline)', async () => {
    await w.inspect('postgres.status@1')
    const a = await planApply(`/api/v1/clusters/${cid()}/backup-repositories`, { layer: 'l1_physical', engine: 'pgbackrest', provider: 'posix', location: { endpointHost: null, region: null, bucket: null, prefix: 'var/lib/pgbackrest/', stanza: 'exdbnode', repoIndex: 1 } })
    expect(a.done?.state, JSON.stringify(a.head)).toBe('succeeded')
    repositoryId = (await w.call('GET', `/api/v1/clusters/${cid()}/backup-repositories`)).body.repositories[0].id
    await sh(`mkdir -p ${REPOS}/${repositoryId} && echo adopted_runs > ${REPOS}/${repositoryId}/mode && printf 'stanza=exdbnode\\nrepo=1\\n' > ${REPOS}/${repositoryId}/pgbackrest && chmod 644 ${REPOS}/${repositoryId}/*`)
    const o = await planApply(`/api/v1/backup-repositories/${repositoryId}/ownership`, { to: 'adopted_runs', acknowledge: { hostConfigurationUnchanged: true } })
    expect(o.done?.state, JSON.stringify(o.head)).toBe('succeeded')
    ev('wal.archive_status baseline', await w.inspect('wal.archive_status@1'))
    ev('refresh baseline', await refresh())
    const base = await verifyNewest('BASELINE')
    expect(base?.state).toBe('succeeded')
    ev('protection baseline', (await catalog()).protection)
    // pitr_random: refused with no_backup_selectable until the archive was observed (wal.archive_status) after the last refresh
    const pr1 = await drillOf('BASELINE-pitr_random-before-inspect', { kind: 'pitr_random' })
    ev('wal.archive_status again', await w.inspect('wal.archive_status@1'))
    const t3 = await sh(`grep '^T3-after-full2' ${LOGDIR}/targets.tsv | cut -f3`)
    const at3 = new Date(t3.replace(' ', 'T').replace('+00', 'Z')).toISOString()
    const planOnly = await w.call('POST', `/api/v1/clusters/${cid()}/drills`, { repositoryId, selection: { kind: 'pitr', at: at3 } })
    ev('BASELINE plan pitr:T3 after inspect (plan only)', { status: planOnly.status, decision: planOnly.body?.decision, code: planOnly.body?.code, details: planOnly.body?.details ?? planOnly.body?.reasons })
    const pr2 = await drillOf('BASELINE-pitr_random-after-inspect', { kind: 'pitr_random' })
    await refresh()
    ev('protection after a passed drill and a refresh', (await catalog()).protection)
    const ov = await w.call('GET', '/api/v1/backups/overview'); ev('backup overview after the drill', ov.body)
    expect(pr1.head.status === 201 || pr2.head.status === 201).toBe(true)
  }, 3_600_000)

  for (const name of CASES) {
    it(`case ${name}: inject, verify, drill latest, repair`, async () => {
      ev(`CASE ${name} inject`, await sh(`bash /srv/work/s2/scripts/s2-inject.sh ${name} apply 2>&1 | tail -4`))
      try {
        if (name === 'wrong-key' || name === 'repo-deleted') {
          ev(`${name} REFRESH`, await refresh())
          ev(`${name} wal.archive_status`, await w.inspect('wal.archive_status@1').catch((e: any) => ({ error: String(e).slice(0, 400) })))
          const cat = await catalog(); ev(`${name} protection`, cat.protection)
          const repos = await w.call('GET', `/api/v1/clusters/${cid()}/backup-repositories`); ev(`${name} repositories`, repos.body.repositories?.map((r: any) => ({ health: r.health, state: r.state, reconciliation: r.reconciliation })))
          const f = await w.call('GET', `/api/v1/clusters/${cid()}/findings`); ev(`${name} findings`, f.body?.findings?.map((x: any) => ({ kind: x.kind ?? x.code, severity: x.severity, state: x.state })))
        }
        await verifyNewest(name)
        await drillOf(name, { kind: 'latest' })
        if (name === 'corrupt-backup-file' || name === 'delete-wal-stop') { const b = await newestFull(); await drillOf(`${name} (explicit backup)`, { kind: 'backup', backupId: b.id }) }
        const runs = await w.call('GET', `/api/v1/clusters/${cid()}/backup-runs`); ev(`${name} backup-runs`, runs.body.runs?.slice(0, 3))
      } finally {
        ev(`CASE ${name} repair`, await sh(`bash /srv/work/s2/scripts/s2-inject.sh ${name} revert 2>&1 | tail -3`))
        await refresh()
        const again = await verifyNewest(`${name} AFTER REPAIR`)
        ev(`CASE ${name} protection after repair`, (await catalog()).protection)
        expect(again?.state).toBe('succeeded')
      }
    }, 3_600_000)
  }

  if (process.env['S2_SPECIAL']?.includes('space')) {
    it('restore without disk space: the scratch root is a 3 GB loop filesystem, drill latest', async () => {
      const SC = '/var/lib/exponetdb-node-engine/scratch'
      ev('space setup', await sh(`OWN=$(stat -c '%U:%G' ${SC}); MODE=$(stat -c %a ${SC}); rm -f /srv/work/s2/loop-scratch2.img; truncate -s 3G /srv/work/s2/loop-scratch2.img; mkfs.ext4 -q -F -m 0 /srv/work/s2/loop-scratch2.img; mount -o loop /srv/work/s2/loop-scratch2.img ${SC}; chown $OWN ${SC}; chmod $MODE ${SC}; df -h ${SC} | tail -1`))
      try {
        const r = await drillOf('SPACE', { kind: 'latest' })
        ev('SPACE filesystem after', await sh(`df -h ${SC} | tail -1; ls ${SC}`))
        const restores = await w.call('GET', `/api/v1/clusters/${cid()}/restores`)
        ev('SPACE restores', restores.body.restores?.slice(0, 2))
        expect(r).toBeDefined()
      } finally {
        ev('space teardown', await sh(`umount ${SC}; losetup -D; rm -f /srv/work/s2/loop-scratch2.img; df -h ${SC} | tail -1`))
      }
    }, 3_600_000)
  }

  if (process.env['S2_SPECIAL']?.includes('retention')) {
    it('retention: expire at the boundary and the PITR window', async () => {
      const t = await sh(`grep '^T1-after-incr' ${LOGDIR}/targets.tsv | cut -f3`)
      const at = new Date(t.replace(' ', 'T').replace('+00', 'Z')).toISOString()
      const before = await w.call('POST', `/api/v1/clusters/${cid()}/drills`, { repositoryId, selection: { kind: 'pitr', at } })
      ev('RETENTION plan pitr T1 before expire', { status: before.status, decision: before.body?.decision, code: before.body?.code, reasons: before.body?.reasons ?? before.body?.details })
      ev('RETENTION protection before', (await catalog()).protection)
      ev('RETENTION expire (helper level, no Control Plane route exists)', await sh(`bash /srv/work/s2/scripts/s2-f-retention.sh 2>&1 | tail -25`))
      ev('RETENTION refresh', await refresh())
      const cat = await catalog()
      ev('RETENTION catalog after', { backups: cat.backups.map((b: any) => ({ label: b.engineLabel, kind: b.kind, verification: b.verification?.state, missing: b.missingInEngine ?? b.state })), protection: cat.protection, walCoverage: cat.walCoverage })
      const after = await w.call('POST', `/api/v1/clusters/${cid()}/drills`, { repositoryId, selection: { kind: 'pitr', at } })
      ev('RETENTION plan pitr T1 after expire', { status: after.status, decision: after.body?.decision, code: after.body?.code, details: after.body?.details ?? after.body?.reasons, message: after.body?.message })
      const older = await w.call('POST', `/api/v1/clusters/${cid()}/drills`, { repositoryId, selection: { kind: 'older' } })
      ev('RETENTION plan older after expire', { status: older.status, code: older.body?.code, details: older.body?.details })
      expect(before.status).toBeDefined()
    }, 3_600_000)
  }
})

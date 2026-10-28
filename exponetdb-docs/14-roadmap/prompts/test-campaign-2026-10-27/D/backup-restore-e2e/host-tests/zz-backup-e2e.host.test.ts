import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { hostScenario, run } from '../support/host-world.ts'

/** Test-campaign scenario (tc-node-2): backups, drills and the runbook through the real Control Plane, agent and helper. */
const w = hostScenario({ scenario: 'backup-e2e', freshCluster: false })
const EV = '/root/lab/logs/b-evidence.log'
const REPOS = '/etc/exponetdb-node/repositories'
const ARC = '/var/lib/pgbackrest/archive/exdbnode/17-1/0000000100000000'
mkdirSync('/root/lab/logs', { recursive: true })
const ev = (name: string, v: unknown) =>
  appendFileSync(EV, `[${new Date().toISOString()}] ${name}: ${JSON.stringify(v)}\n`)
const sh = async (cmd: string) => (await run('bash', ['-c', cmd])).stdout.trim()
let repositoryId = ''
const cid = () => w.clusterId

async function planApply(path: string, body: unknown, ms = 900_000) {
  const t0 = Date.now()
  const planned = await w.call('POST', path, body)
  const head = { status: planned.status, decision: planned.body?.decision, code: planned.body?.code, reasons: planned.body?.reasons ?? planned.body?.message }
  if (planned.status !== 201 || planned.body?.decision === 'deny') {
    ev(`plan ${path}`, head)
    return { planned, head }
  }
  await w.reauth()
  const applied = await w.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
  if (applied.status !== 202) {
    ev(`apply ${path}`, { status: applied.status, body: applied.body })
    return { planned, head, applied }
  }
  const done = await w.finished(applied.body.id, ms)
  ev(`plan+apply ${path}`, { ...head, done, seconds: (Date.now() - t0) / 1000 })
  return { planned, head, applied, done }
}

async function refresh() {
  const r = await w.call('POST', `/api/v1/clusters/${cid()}/backups/refresh`, {})
  expect(r.status, JSON.stringify(r.body)).toBe(202)
  return w.finished(r.body.id)
}
async function catalog() {
  const r = await w.call('GET', `/api/v1/clusters/${cid()}/backups`)
  expect(r.status).toBe(200)
  return r.body
}
const newest = (cat: any) =>
  [...cat.backups].sort((a: any, b: any) => String(b.finishedAt ?? b.startedAt).localeCompare(String(a.finishedAt ?? a.startedAt)))[0]
async function lastDrill() {
  const d = await w.call('GET', `/api/v1/clusters/${cid()}/drills`)
  const x = d.body.drills[0]
  const rs = await w.call('GET', `/api/v1/clusters/${cid()}/restores`)
  return { drill: x, restore: rs.body.restores?.[0] }
}
async function diag(tag: string) {
  const tables = await w.sql("select table_name from information_schema.tables where table_schema = 'backups' order by 1")
  const jobs = await w.sql("SELECT j.capability, j.state, (j.completion - 'nodeSignature')::text AS c FROM nodes.jobs j WHERE j.capability IN ('restore.prepare@1','restore.execute@1','run.status@1','restore.discard@1') ORDER BY j.created_at DESC LIMIT 6")
  const restores = await w.sql('SELECT restore_id, state, checks::text AS checks FROM backups.restores ORDER BY created_at DESC LIMIT 2')
  ev(`DIAG ${tag}`, { tables: tables.map((t: any) => t.table_name), restores, jobs: jobs.map((j: any) => ({ cap: j.capability, state: j.state, c: String(j.c).slice(0, 1800) })) })
}
const hostFiles = (mode: string) => {
  const d = `${REPOS}/${repositoryId}`
  mkdirSync(d, { recursive: true, mode: 0o755 })
  writeFileSync(`${d}/mode`, `${mode}\n`, { mode: 0o644 })
  writeFileSync(`${d}/pgbackrest`, 'stanza=exdbnode\nrepo=1\n', { mode: 0o644 })
}

describe('backups through the Control Plane, agent and helper (tc-node-2)', () => {
  it('B1 T-ADV-1: adopt the existing repository read-only and mirror its catalog', async () => {
    await w.inspect('postgres.status@1')
    const before = await sh('find /etc/pgbackrest /etc/postgresql/17/exdbnode/conf.d /var/spool/cron /etc/systemd/system -type f -newer /root/lab/lib.sh 2>/dev/null | sort | md5sum; systemctl list-timers --all --no-legend | wc -l')
    const { done } = await planApply(`/api/v1/clusters/${cid()}/backup-repositories`, {
      layer: 'l1_physical', engine: 'pgbackrest', provider: 'posix',
      location: { endpointHost: null, region: null, bucket: null, prefix: 'var/lib/pgbackrest/', stanza: 'exdbnode', repoIndex: 1 },
    })
    expect(done?.state).toBe('succeeded')
    const list = await w.call('GET', `/api/v1/clusters/${cid()}/backup-repositories`)
    repositoryId = list.body.repositories[0].id
    ev('repository', list.body.repositories[0])
    expect(list.body.repositories[0]).toMatchObject({ ownership: 'adopted_observed', secretSource: 'host_config' })
    const t0 = Date.now()
    const r = await refresh()
    ev('refresh (host mode file absent)', { ...r, seconds: (Date.now() - t0) / 1000 })
    expect(r.state).toBe('succeeded')
    const cat = await catalog()
    ev('catalog', { n: cat.backups.length, labels: cat.backups.map((b: any) => b.engineLabel), protection: cat.protection, repositories: cat.repositories })
    expect(cat.backups.length).toBeGreaterThan(0)
    expect(cat.protection.state).not.toBe('protected')
    const after = await sh('find /etc/pgbackrest /etc/postgresql/17/exdbnode/conf.d /var/spool/cron /etc/systemd/system -type f -newer /root/lab/lib.sh 2>/dev/null | sort | md5sum; systemctl list-timers --all --no-legend | wc -l')
    ev('host files before/after adoption+refresh (md5 of newer-than-lab files; timers)', { before, after })
    expect(after).toBe(before)
  })

  it('B2 M-4: a wrong key fails the refresh with BACKUP_REPOSITORY_UNAVAILABLE', async () => {
    copyFileSync('/etc/pgbackrest/pgbackrest.conf', '/root/lab/pgbackrest.conf.b2')
    await sh("sed -i 's#^repo1-cipher-pass=.*#repo1-cipher-pass=wrongwrongwrongwrongwrongwrongwrongwrong#' /etc/pgbackrest/pgbackrest.conf")
    try {
      const r = await refresh()
      ev('refresh with a wrong key', r)
      const reps = await w.call('GET', `/api/v1/clusters/${cid()}/backup-repositories`)
      ev('repository after wrong key', reps.body.repositories[0])
      const finds = await w.call('GET', `/api/v1/clusters/${cid()}/findings?state=open`)
      ev('findings after wrong key', finds.body.items?.map((f: any) => f.code))
      expect(r.errorCode).toBe('BACKUP_REPOSITORY_UNAVAILABLE')
    } finally {
      copyFileSync('/root/lab/pgbackrest.conf.b2', '/etc/pgbackrest/pgbackrest.conf')
      await sh('chown root:postgres /etc/pgbackrest/pgbackrest.conf; chmod 0640 /etc/pgbackrest/pgbackrest.conf')
    }
    expect((await refresh()).state).toBe('succeeded')
  })

  it('B3 T-NODE-3/M-4: ownership changes, and the runs the Control Plane may start', async () => {
    const own = await w.call('POST', `/api/v1/backup-repositories/${repositoryId}/ownership`, { to: 'owned', acknowledge: { hostConfigurationUnchanged: true } })
    ev('ownership -> owned', { status: own.status, code: own.body?.code, message: own.body?.message })
    const observed = await w.call('POST', `/api/v1/clusters/${cid()}/backup-runs`, { repositoryId, kind: 'incremental' })
    ev('run on adopted_observed (CP)', { status: observed.status, decision: observed.body?.decision })
    const { done } = await planApply(`/api/v1/backup-repositories/${repositoryId}/ownership`, { to: 'adopted_runs', acknowledge: { hostConfigurationUnchanged: true } })
    expect(done?.state).toBe('succeeded')
    for (const kind of ['full', 'differential']) {
      const r = await w.call('POST', `/api/v1/clusters/${cid()}/backup-runs`, { repositoryId, kind })
      ev(`CP plan for a ${kind} run on adopted_runs`, { status: r.status, decision: r.body?.decision, code: r.body?.code })
    }
    // CP says adopted_runs but the host file says adopted_observed (absent): refused by the host.
    hostFiles('adopted_runs')
    const t0 = Date.now()
    const ok = await planApply(`/api/v1/clusters/${cid()}/backup-runs`, { repositoryId, kind: 'incremental' })
    ev('incremental through the capability path', { done: ok.done, seconds: (Date.now() - t0) / 1000 })
    expect(ok.done?.state).toBe('succeeded')
    const runs = await w.call('GET', `/api/v1/clusters/${cid()}/backup-runs`)
    ev('runs', runs.body.runs?.slice(0, 3))
  })

  it('B4 M-6: verify the newest backup, then drills latest / older / pitr_random (amcheck as shipped)', async () => {
    await refresh()
    const cat = await catalog()
    const b = newest(cat)
    ev('newest backup', b)
    const sorted = [...cat.backups].sort((x: any, y: any) => String(y.finishedAt).localeCompare(String(x.finishedAt)))
    for (const target of [sorted[0], sorted[2], sorted[3]].filter(Boolean)) {
      const v = await w.call('POST', `/api/v1/clusters/${cid()}/backups/${target.id}/verify`, {})
      expect(v.status, JSON.stringify(v.body)).toBe(202)
      const t0 = Date.now()
      const vd = await w.finished(v.body.id)
      ev('backup verify', { label: target.engineLabel, vd, seconds: (Date.now() - t0) / 1000 })
    }
    await refresh()
    for (const kind of ['latest', 'older', 'pitr_random']) {
      const t1 = Date.now()
      const r = await planApply(`/api/v1/clusters/${cid()}/drills`, { repositoryId, selection: { kind } })
      const { drill, restore } = await lastDrill()
      ev(`DRILL ${kind}`, { head: r.head, done: r.done, seconds: (Date.now() - t1) / 1000, drill, restoreState: restore?.state, checks: restore?.checks })
      if (r.planned?.status !== 201) ev(`DRILL ${kind} plan body`, r.planned?.body)
      await diag(`after drill ${kind}`)
    }
  })

  it('B5 M-6: the same drills with amcheck installed in every database', async () => {
    await sh("for d in postgres template1; do runuser -u postgres -- psql -X -q -p 55417 -d $d -c 'CREATE EXTENSION IF NOT EXISTS amcheck'; done")
    for (const kind of ['latest', 'older', 'pitr_random']) {
      const t1 = Date.now()
      const r = await planApply(`/api/v1/clusters/${cid()}/drills`, { repositoryId, selection: { kind } })
      const { drill, restore } = await lastDrill()
      ev(`DRILL(amcheck everywhere) ${kind}`, { head: r.head, done: r.done, seconds: (Date.now() - t1) / 1000, drill, restoreState: restore?.state, checks: restore?.checks })
      if (r.planned?.status !== 201) ev(`DRILL(amcheck) ${kind} plan body`, r.planned?.body)
      await diag(`after drill(amcheck) ${kind}`)
    }
  })

  it('B6 M-7: duplicate and concurrent drills, scratch_exists, a stale plan', async () => {
    const a = await w.call('POST', `/api/v1/clusters/${cid()}/drills`, { repositoryId, selection: { kind: 'latest' } })
    const b = await w.call('POST', `/api/v1/clusters/${cid()}/drills`, { repositoryId, selection: { kind: 'latest' } })
    ev('two drill plans', { a: a.status, b: b.status })
    await w.reauth()
    const ap = await w.call('POST', `/api/v1/plans/${a.body.id}/apply`, {})
    const bp = await w.call('POST', `/api/v1/plans/${b.body.id}/apply`, {})
    ev('two drills applied at once', { a: [ap.status, ap.body?.code], b: [bp.status, bp.body?.code, bp.body?.message] })
    const ends: any[] = []
    for (const x of [ap, bp]) if (x.status === 202) ends.push(await w.finished(x.body.id))
    ev('two drills ends', ends)
    // a plan applied after the verification changed (stale source)
    const p = await w.call('POST', `/api/v1/clusters/${cid()}/drills`, { repositoryId, selection: { kind: 'latest' } })
    await w.sql(`UPDATE backups.backups SET verification = 'unverified' WHERE cluster_id = $1`, [cid()]).catch((e: unknown) => ev('stale: sql failed', String(e)))
    await w.reauth()
    const sp = await w.call('POST', `/api/v1/plans/${p.body.id}/apply`, {})
    ev('apply after the verification changed', { status: sp.status, code: sp.body?.code, message: sp.body?.message })
    if (sp.status === 202) ev('stale apply end', await w.finished(sp.body.id))
  })

  it('B7 M-4/M-7: a corrupt WAL segment after the newest backup fails the drill (never good enough)', async () => {
    await sh('runuser -u postgres -- psql -X -q -p 55417 -d app -c "INSERT INTO public.accounts SELECT g, \'cp\'||g FROM generate_series(7001,7010) g" -c "SELECT pg_switch_wal()"')
    await sh('sleep 1; runuser -u postgres -- psql -X -q -p 55417 -d app -c "INSERT INTO public.accounts SELECT g, \'cq\'||g FROM generate_series(7101,7110) g" -c "SELECT pg_switch_wal()" -c "SELECT pg_switch_wal()"; for i in 1 2 3 4 5; do runuser -u postgres -- pgbackrest --stanza=exdbnode check && break; sleep 2; done')
    await refresh()
    const segs = readdirSync(ARC).filter((f) => /^0000000100000000000000[0-9A-F]{2}-/.test(f)).sort()
    const seg = segs[segs.length - 3]
    copyFileSync(`${ARC}/${seg}`, `/root/lab/walsave/cp-${seg}`)
    ev('corrupting', seg)
    const size = statSync(`${ARC}/${seg}`).size
    await sh(`printf '\\xde\\xad\\xbe\\xef\\xde\\xad\\xbe\\xef\\xde\\xad\\xbe\\xef' | dd of=${ARC}/${seg} bs=1 seek=${Math.floor(size / 2)} conv=notrunc 2>/dev/null`)
    try {
      await refresh()
      const r = await planApply(`/api/v1/clusters/${cid()}/drills`, { repositoryId, selection: { kind: 'latest' } })
      const { drill, restore } = await lastDrill()
      ev('DRILL latest with a corrupt WAL segment', { head: r.head, done: r.done, drill, restoreState: restore?.state, checks: restore?.checks })
      const v = await w.call('POST', `/api/v1/clusters/${cid()}/backups/${newest(await catalog()).id}/verify`, {})
      if (v.status === 202) ev('backup verify with a corrupt WAL segment', await w.finished(v.body.id))
      else ev('verify refused', { status: v.status, body: v.body })
    } finally {
      copyFileSync(`/root/lab/walsave/cp-${seg}`, `${ARC}/${seg}`)
    }
  })

  it('B8 C-35: the generated runbook (written to /root/lab for the offline drill)', async () => {
    const r = await w.call('GET', `/api/v1/clusters/${cid()}/restore-runbook?repository=${repositoryId}`)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    writeFileSync('/root/lab/recover.sh', r.body.script, { mode: 0o700 })
    ev('runbook', { filename: r.body.filename, digest: r.body.digest, placeholders: r.body.placeholders, bytes: r.body.script.length, repositoryId })
    writeFileSync('/root/lab/runbook.digest', r.body.digest)
    writeFileSync('/root/lab/runbook.repo', repositoryId)
    const audit = await w.sql(`SELECT count(*)::int AS n FROM audit.audit_events WHERE action = 'backup.runbook.downloaded'`)
    ev('audit rows for the download', audit)
  })

  it('B9 T-NODE-2: kill helper and agent mid-run, restart; the run and the operation survive', async () => {
    await sh('runuser -u postgres -- psql -X -q -p 55417 -d app -c "CREATE TABLE IF NOT EXISTS public.big2 AS SELECT g, md5(random()::text)||md5(random()::text)||md5(random()::text)||md5(random()::text) AS pad FROM generate_series(1,9000000) g"')
    const planned = await w.call('POST', `/api/v1/clusters/${cid()}/backup-runs`, { repositoryId, kind: 'incremental' })
    expect(planned.status, JSON.stringify(planned.body)).toBe(201)
    await w.reauth()
    const v = await w.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
    expect(v.status, JSON.stringify(v.body)).toBe(202)
    const t0 = Date.now()
    let units = ''
    for (let i = 0; i < 120 && units === ''; i++) {
      await new Promise((r) => setTimeout(r, 500))
      units = await sh("systemctl list-units 'exponetdb-run-*' --state=active --no-legend | awk '{print $1,$3,$4}'")
    }
    await new Promise((r) => setTimeout(r, 2000))
    ev('run units before the kill', units)
    await sh(`systemctl kill -s KILL ${w.prefix}-helper.service ${w.prefix}-node.service; sleep 1; systemctl is-active ${w.prefix}-node.service ${w.prefix}-helper.service ${w.prefix}-helper.socket || true`)
    ev('state after kill', await sh(`systemctl is-active ${w.prefix}-node.service ${w.prefix}-helper.service ${w.prefix}-helper.socket || true`))
    ev('run unit survived', await sh("systemctl list-units 'exponetdb-run-*' --all --no-legend | awk '{print $1,$3,$4}'"))
    await sh(`systemctl start ${w.prefix}-helper.socket ${w.prefix}-node.service || true`)
    await w.nodeOnline()
    const done = await w.finished(v.body.id, 900_000)
    ev('incremental operation after agent+helper kill', { done, seconds: (Date.now() - t0) / 1000 })
    expect(done.state).toBe('succeeded')
  })
})

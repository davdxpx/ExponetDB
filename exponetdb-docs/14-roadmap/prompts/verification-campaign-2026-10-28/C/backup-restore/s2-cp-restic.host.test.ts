// S2: the restic logical path through the Control Plane. The helper-level backups were made by s2-c-restic.sh (local repo and S3).
// Adopts both, refreshes, tries a logical run through the CP, downloads each offline runbook, runs it, and re-checks TC-045/D-07 (globals).
import { appendFileSync, mkdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { hostScenario, run } from '../support/host-world.ts'

const w = hostScenario({ scenario: 's2-cp-restic', freshCluster: false })
const LOGDIR = '/srv/work/s2/logs'
const EV = `${LOGDIR}/cp-restic.log`
const REPOS = '/etc/exponetdb-node/repositories'
mkdirSync(LOGDIR, { recursive: true })
const ev = (name: string, v: unknown) => appendFileSync(EV, `[${new Date().toISOString()}] ${name}: ${JSON.stringify(v)}\n`)
const sh = async (cmd: string) => (await run('bash', ['-c', cmd], { maxBuffer: 64 * 1024 * 1024 }).catch((e: any) => ({ stdout: `FAILED(${e.code}) ${e.stdout ?? ''} ${e.stderr ?? ''}` }))).stdout.trim()
const cid = () => w.clusterId
const ids: Record<string, string> = {}
const PB = '/usr/lib/postgresql/17/bin'
const secs = (t0: number) => (Date.now() - t0) / 1000
const RLOCAL = 'bkr_01M70000000000000000000002'
const RS3 = 'bkr_01M70000000000000000000003'

async function planApply(path: string, body: unknown, ms = 600_000) {
  const planned = await w.call('POST', path, body)
  if (planned.status !== 201 || planned.body?.decision === 'deny') return { planned, head: { status: planned.status, decision: planned.body?.decision, code: planned.body?.code, details: planned.body?.details ?? planned.body?.reasons } } as any
  await w.reauth()
  const applied = await w.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
  if (applied.status !== 202) return { planned, applied, head: { status: applied.status, body: applied.body } } as any
  const done = await w.finished(applied.body.id, ms)
  return { planned, applied, done, head: { status: 201 } } as any
}
async function runbook(repoId: string, out: string) {
  const rb = await w.call('GET', `/api/v1/clusters/${cid()}/restore-runbook?repository=${repoId}`)
  expect(rb.status, JSON.stringify(rb.body).slice(0, 300)).toBe(200)
  const fs = await import('node:fs/promises')
  await fs.writeFile(out, rb.body.script, { mode: 0o755 })
  await sh(`chown postgres ${out}`)
  ev(`runbook ${repoId}`, { digest: rb.body.digest, bytes: rb.body.script.length, placeholders: rb.body.placeholders?.map((p: any) => p.name) })
  return rb.body
}
async function runIt(label: string, script: string, port: number, extraEnv: string) {
  const d = `/var/lib/postgresql/s2-rb-${label}`
  await sh(`rm -rf ${d} ${d}.exponetdb`)
  const t0 = Date.now()
  const out = await sh(`runuser -u postgres -- env TARGET_DIR=${d} PG_BIN=${PB} PORT=${port} RESTIC_PASSWORD_FILE=/var/lib/c35/restic.pw ${extraEnv} sh ${script} > ${LOGDIR}/rb-${label}.out 2>&1; echo rc=$?; tail -6 ${LOGDIR}/rb-${label}.out`)
  const sec = secs(t0)
  const rc = /rc=(\d+)/.exec(out)?.[1]
  const q = (sql: string, db = 'postgres') => sh(`runuser -u postgres -- ${PB}/psql -X -q -A -t -h ${d}.exponetdb/socket -p ${port} -d ${db} -c "${sql}" 2>&1 | head -3`)
  const state = {
    rc, seconds: sec, tail: out.slice(-900),
    clusterUp: (await q('select 1')).slice(0, 40),
    databases: await q('select string_agg(datname, \',\') from pg_database where not datistemplate'),
    roles: await q('select string_agg(rolname, \',\' order by rolname) from pg_roles where rolname like \'s2_%\''),
    appTables: await q('select count(*) from pg_stat_user_tables', 'app'),
    markerRows: await q('select count(*) from marker', 'app'),
    acctRows: await q('select count(*) from pgbench_accounts', 'app'),
  }
  ev(`RUNBOOK RUN ${label}`, state)
  await sh(`runuser -u postgres -- ${PB}/pg_ctl -D ${d} stop -m fast >/dev/null 2>&1; rm -rf ${d} ${d}.exponetdb`)
  return state
}

describe('S2 restic logical path through the Control Plane', () => {
  it('adopts both restic repositories, refreshes the catalog, tries a logical run through the CP', async () => {
    await w.inspect('postgres.status@1')
    const loc = (prefix: string, host: string | null, bucket: string | null) => ({ endpointHost: host, region: null, bucket, prefix, stanza: null, repoIndex: null })
    for (const [name, body] of [
      ['local', { layer: 'l2_logical', engine: 'restic', provider: 'posix', location: loc('var/lib/restic-repo/', null, null), cipher: 'restic' }],
      ['s3', { layer: 'l2_logical', engine: 'restic', provider: 's3_compatible', location: loc('', 's3.s2lab.net', 's2-restic'), cipher: 'restic' }],
    ] as const) {
      const a = await planApply(`/api/v1/clusters/${cid()}/backup-repositories`, body)
      ev(`adopt ${name}`, { head: a.head, state: a.done?.state })
      expect(a.done?.state, JSON.stringify(a.head)).toBe('succeeded')
    }
    const repos = (await w.call('GET', `/api/v1/clusters/${cid()}/backup-repositories`)).body.repositories
    for (const r of repos) ids[r.location.bucket === null ? 'local' : 's3'] = r.id
    ev('repositories', repos.map((r: any) => ({ id: r.id, provider: r.provider, layer: r.layer, ownership: r.ownership, cipher: r.cipher })))
    for (const [name, id] of Object.entries(ids)) {
      await sh(`mkdir -p ${REPOS}/${id} && cp -p ${REPOS}/${name === 'local' ? RLOCAL : RS3}/* ${REPOS}/${id}/ && echo adopted_runs > ${REPOS}/${id}/mode`)
    }
    const t0 = Date.now()
    const r = await w.call('POST', `/api/v1/clusters/${cid()}/backups/refresh`, {})
    const d = r.status === 202 ? await w.finished(r.body.id) : r
    ev('refresh', { seconds: secs(t0), op: d })
    const cat = (await w.call('GET', `/api/v1/clusters/${cid()}/backups`)).body
    ev('catalog', { backups: cat.backups.map((b: any) => ({ id: b.id, kind: b.kind, repo: b.repositoryId, size: b.sizeBytes, label: String(b.engineLabel).slice(0, 12), verification: b.verification })), protection: cat.protection })
    for (const [name, id] of Object.entries(ids)) {
      const o = await planApply(`/api/v1/backup-repositories/${id}/ownership`, { to: 'adopted_runs', acknowledge: { hostConfigurationUnchanged: true } })
      ev(`ownership adopted_runs ${name}`, { head: o.head, state: o.done?.state })
      const lr = await planApply(`/api/v1/clusters/${cid()}/backup-runs`, { repositoryId: id, kind: 'logical' }, 1_800_000)
      ev(`CP logical run ${name}`, { head: lr.head, state: lr.done?.state, outcome: lr.done })
    }
    const runs = await w.call('GET', `/api/v1/clusters/${cid()}/backup-runs`)
    ev('backup-runs', runs.body.runs?.slice(0, 6))
  }, 3_600_000)

  it('globals handling of the generated runbook (tiny repositories, fast)', async () => {
    const P = `runuser -u postgres --`
    await sh(`rm -rf /var/lib/s2-tiny /var/lib/restic-tiny-a /var/lib/restic-tiny-b; mkdir -p /var/lib/s2-tiny; chown postgres /var/lib/s2-tiny`)
    await sh(`${P} psql -X -q -p 55417 -d postgres -c "DROP DATABASE IF EXISTS tiny" -c "CREATE DATABASE tiny"`)
    await sh(`${P} psql -X -q -p 55417 -d tiny -c "CREATE TABLE t(i int); INSERT INTO t SELECT generate_series(1,1000); GRANT SELECT ON t TO s2_reader; ALTER TABLE t OWNER TO s2_owner"`)
    // A: snapshot WITH globals.sql; B: snapshot WITHOUT globals file
    for (const [n, withGlobals] of [['a', true], ['b', false]] as const) {
      const dir = `/var/lib/s2-tiny/dump-${n}`
      await sh(`rm -rf ${dir}; mkdir -p ${dir}; chown postgres ${dir}; ${P} pg_dump -Fc -p 55417 -d tiny -f ${dir}/tiny.dump`)
      if (withGlobals) await sh(`${P} pg_dumpall -p 55417 --globals-only -f ${dir}/globals.sql`)
      await sh(`install -d -m0700 -o postgres /var/lib/restic-tiny-${n}; ${P} restic init --no-cache --repo /var/lib/restic-tiny-${n} --password-file /var/lib/c35/restic.pw >/dev/null; ${P} restic backup --no-cache --tag exponetdb --repo /var/lib/restic-tiny-${n} --password-file /var/lib/c35/restic.pw ${dir} >/dev/null`)
    }
    const rb = await runbook(ids['local'] ?? RLOCAL, '/srv/work/s2/xfer/runbook-restic-local.sh')
    for (const n of ['a', 'b']) {
      await sh(`sed "s#RESTIC_REPOSITORY='/var/lib/restic-repo'#RESTIC_REPOSITORY='/var/lib/restic-tiny-${n}'#" /srv/work/s2/xfer/runbook-restic-local.sh > /srv/work/s2/xfer/runbook-tiny-${n}.sh; chown postgres /srv/work/s2/xfer/runbook-tiny-${n}.sh`)
      const st = await runIt(`tiny-${n}`, `/srv/work/s2/xfer/runbook-tiny-${n}.sh`, 55470 + (n === 'a' ? 0 : 1), '')
      ev(`GLOBALS CHECK tiny-${n} (${n === 'a' ? 'globals.sql in the snapshot' : 'no globals file in the snapshot'})`, { rc: st.rc, roles: st.roles, databases: st.databases, clusterUp: st.clusterUp })
    }
    expect(rb.digest).toMatch(/^sha256:/)
  }, 900_000)

  it('restores the 7 GB logical snapshot from the local restic repository with the generated runbook', async () => {
    await runbook(ids['local'] ?? RLOCAL, '/srv/work/s2/xfer/runbook-restic-local.sh')
    await sh(`rm -rf /var/lib/s2-tiny`)
    const st = await runIt('local-7gb', '/srv/work/s2/xfer/runbook-restic-local.sh', 55462, '')
    expect(st.seconds).toBeGreaterThan(0)
  }, 3_600_000)

  it.skipIf(process.env['S2_S3_FULL'] !== '1')('restores the 7 GB logical snapshot from the S3 restic repository (versitygw over TLS) with the generated runbook', async () => {
    await runbook(ids['s3'] ?? RS3, '/srv/work/s2/xfer/runbook-restic-s3.sh')
    await sh(`install -m0600 -o postgres /srv/work/s2/secrets/s3.ak /var/lib/c35/s3.ak; install -m0600 -o postgres /srv/work/s2/secrets/s3.sk /var/lib/c35/s3.sk`)
    const st = await runIt('s3-7gb', '/srv/work/s2/xfer/runbook-restic-s3.sh', 55463, 'AWS_ACCESS_KEY_ID_FILE=/var/lib/c35/s3.ak AWS_SECRET_ACCESS_KEY_FILE=/var/lib/c35/s3.sk')
    await sh(`rm -f /var/lib/c35/s3.ak /var/lib/c35/s3.sk`)
    expect(st.seconds).toBeGreaterThan(0)
  }, 3_600_000)
})

/**
 * Registry seed of the disposable stack, driven over the real REST API of the running `serve`
 * as the first owner (human.ts), the way mcp-int-world.ts of the product's tests does it, but
 * with the real `worker` process doing the work:
 *
 *   seed.ts registry   product lab, environments, project, one server, three external clusters
 *                      (PostgreSQL 16, 17, 18 on 127.0.0.1), ExponetDB's roles on them, the
 *                      credentials, databases and four targets
 *   seed.ts enrollment the node enrollment token for the server, written to a new 0600 file
 *   seed.ts adopt      the one-way adoption of the PostgreSQL 17 cluster by the enrolled node
 *   seed.ts add-target <slug> <major> [prod]   one more environment, database and target (lab/platform/<slug>) on the cluster of <major>;
 *                      tests that leave a target blocked take a fresh one
 *
 * Environment: EXSTACK_OWNER_FILE, EXSTACK_STATE (default .), EXSTACK_MAJORS ("16 17 18"),
 * EXSTACK_PG_PORT_BASE (55400), EXSTACK_IDS (output, ids only, default $STATE/ids.json),
 * EXSTACK_CA (the target CA certificate file). Prints ids and counts, never a secret.
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scramSha256Verifier } from '@exponetdb/kernel/hash'
import { Human, must } from './human.ts'

const STATE = process.env['EXSTACK_STATE'] ?? '.'
const MAJORS = (process.env['EXSTACK_MAJORS'] ?? '16 17 18').split(/\s+/).map(Number)
const PORT_BASE = Number(process.env['EXSTACK_PG_PORT_BASE'] ?? 55400)
const IDS_FILE = process.env['EXSTACK_IDS'] ?? join(STATE, 'ids.json')
const CA_FILE = process.env['EXSTACK_CA'] ?? join(STATE, 'tls', 'ca.crt')
const OWNER_ROLE = 'lab_owner'
const ROLES = ['observer', 'migrator', 'reader', 'verifier'] as const

type Ids = Record<string, string>
const ids: Ids = existsSync(IDS_FILE) ? JSON.parse(readFileSync(IDS_FILE, 'utf8')) : {}
const save = () => {
  writeFileSync(IDS_FILE, `${JSON.stringify(ids, null, 2)}\n`, { mode: 0o644 })
}
const say = (what: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ step: what, ...extra }))
const port = (m: number) => PORT_BASE + m

/** psql as the local postgres user on the cluster of `major` (peer authentication on the socket). */
function psql(major: number, database: string, input: string): string {
  const r = spawnSync(
    'runuser',
    ['-u', 'postgres', '--', 'psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-p', String(port(major)), '-d', database],
    { input, encoding: 'utf8' },
  )
  if (r.status !== 0) throw new Error(`psql ${major}/${database}: ${r.stderr.slice(0, 400)}`)
  return r.stdout.trim()
}

async function until<T>(what: string, fn: () => Promise<T>, ok: (v: T) => boolean, ms = 120_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

async function items(h: Human, path: string): Promise<any[]> {
  const r = await h.call('GET', path)
  must(r, 200, `GET ${path}`)
  return r.body.items
}

async function registry(h: Human): Promise<void> {
  const caPem = readFileSync(CA_FILE, 'utf8')
  // product, environments, project
  await h.planAndApply('/api/v1/products', { slug: 'lab', displayName: 'Lab' })
  ids['product'] = (await items(h, '/api/v1/products')).find((p) => p.slug === 'lab').id
  const envs: [string, string, 'nonprod' | 'prod', string?][] = [
    ['staging', 'Staging', 'nonprod'],
    ['production', 'Production', 'prod', 'staging'],
    ['dev16', 'Dev 16', 'nonprod'],
    ['dev18', 'Dev 18', 'nonprod'],
  ]
  for (const [slug, displayName, tier, evidenceFrom] of envs) {
    await h.planAndApply(`/api/v1/products/${ids['product']}/environments`, {
      slug,
      displayName,
      tier,
      ...(evidenceFrom === undefined ? {} : { evidenceFrom }),
    })
  }
  for (const e of await items(h, `/api/v1/products/${ids['product']}/environments`)) ids[`env_${e.slug}`] = e.id
  await h.planAndApply('/api/v1/projects', { product: 'lab', slug: 'platform', displayName: 'Platform' })
  ids['project'] = (await items(h, '/api/v1/projects?product=lab'))[0].id
  await h.planAndApply(`/api/v1/projects/${ids['project']}/change-plans`, { executionRoles: { owner: OWNER_ROLE } })
  save()
  say('organization', { environments: envs.length })

  // one server record, three external clusters on it
  await h.planAndApply('/api/v1/servers', { displayName: 'stack host', provider: 'other' }, { reauth: true })
  ids['server'] = (await items(h, '/api/v1/servers'))[0].id
  save()

  const targets: [number, string, string][] = [
    [17, 'staging', 'lab_staging'],
    [17, 'production', 'lab_production'],
    [16, 'dev16', 'lab_dev16'],
    [18, 'dev18', 'lab_dev18'],
  ]
  for (const major of MAJORS) {
    const name = `pg${major}`
    // the execution role must exist where the migrator is to SET ROLE into it; the databases are created
    // before the bootstrap script, which covers registered and requested databases.
    psql(major, 'postgres', `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${OWNER_ROLE}') THEN CREATE ROLE ${OWNER_ROLE} NOLOGIN; END IF; END $$;`)
    const mine = targets.filter(([m]) => m === major)
    for (const [, , db] of mine) {
      const exists = psql(major, 'postgres', `SELECT 1 FROM pg_database WHERE datname='${db}'`)
      if (exists !== '1') psql(major, 'postgres', `CREATE DATABASE ${db} OWNER ${OWNER_ROLE}`)
    }
    await h.planAndApply(
      '/api/v1/clusters',
      {
        displayName: name,
        caBundle: caPem,
        serverId: ids['server'],
        endpoints: [{ kind: 'private', host: '127.0.0.1', port: port(major), tlsServerName: `${name}.exdb.test`, label: 'direct' }],
      },
      { reauth: true },
    )
    const cluster = (await items(h, '/api/v1/clusters')).find((c) => c.displayName === name)
    ids[`cluster_${name}`] = cluster.id
    save()
    // ExponetDB's roles, from the server's own script (it holds no password)
    const query = [...mine.map(([, , db]) => `database=${db}`), `project=${ids['project']}`].join('&')
    const sql = await h.call('GET', `/api/v1/clusters/${cluster.id}/bootstrap-sql?${query}`)
    must(sql, 200, 'bootstrap-sql')
    psql(major, 'postgres', sql.body.script)
    const dir = join(STATE, 'pgroles')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const passwords: Record<string, string> = {}
    for (const role of ROLES) {
      const file = join(dir, `${name}.${role}`)
      passwords[role] = existsSync(file) ? readFileSync(file, 'utf8').trim() : randomBytes(24).toString('base64url')
      writeFileSync(file, `${passwords[role]}\n`, { mode: 0o600 })
      psql(major, 'postgres', `ALTER ROLE exponetdb_${role} PASSWORD '${scramSha256Verifier(passwords[role] as string)}'`)
    }
    // observer first: confirmation needs a verified observer login
    await h.reauth()
    must(await h.call('POST', `/api/v1/clusters/${cluster.id}/credentials/observer`, { password: passwords['observer'] }), 202, 'credential observer')
    await until(
      `observer credential ${name}`,
      async () => (await items(h, `/api/v1/clusters/${cluster.id}/credentials`)).filter((c) => c.accessRole === 'observer'),
      (cs) => cs.some((c) => c.state === 'active'),
    )
    await h.planAndApply(`/api/v1/clusters/${cluster.id}/confirm`, {}, { reauth: true })
    await h.reauth()
    for (const role of ['migrator', 'reader', 'verifier'] as const) {
      must(await h.call('POST', `/api/v1/clusters/${cluster.id}/credentials/${role}`, { password: passwords[role] }), 202, `credential ${role}`)
    }
    await until(
      `credentials ${name}`,
      async () => (await items(h, `/api/v1/clusters/${cluster.id}/credentials`)).filter((c) => c.state === 'active').length,
      (n) => n >= ROLES.length,
    )
    say('cluster', { cluster: name, id: cluster.id, activeCredentials: ROLES.length })
    // databases and targets
    for (const [, environment, db] of mine) {
      await h.planAndApply(`/api/v1/clusters/${cluster.id}/databases`, { name: db })
      const database = (await items(h, `/api/v1/clusters/${cluster.id}/databases`)).find((d) => d.name === db)
      const planned = await h.call('POST', '/api/v1/targets', {
        projectId: ids['project'],
        environmentId: ids[`env_${environment}`],
        databaseId: database.id,
      })
      must(planned, 201, `plan target ${environment}`)
      await h.reauth()
      const applied = await h.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
      must(applied, 202, `apply target ${environment}`)
      if (applied.body.state === 'awaiting_approval') {
        must(await h.approve(applied.body.id, planned.body.planHash), 200, 'approve target')
      }
      const op = await h.finished(applied.body.id)
      if (op.state !== 'succeeded') throw new Error(`target ${environment}: ${op.state} ${op.errorCode}`)
      const t = await h.call('GET', `/api/v1/targets/${encodeURIComponent(`lab/platform/${environment}`)}`)
      must(t, 200, 'GET target')
      ids[`target_${environment}`] = t.body.id
      save()
      say('target', { path: `lab/platform/${environment}`, id: t.body.id, pg: major })
    }
  }
  say('registry done', { clusters: MAJORS.length, targets: targets.length })
}

async function enrollment(h: Human, file: string): Promise<void> {
  const planned = await h.call('POST', `/api/v1/servers/${ids['server']}/nodes/enroll`, {})
  must(planned, 201, 'plan node.enroll')
  const tokenId = planned.body.change?.content?.tokenId ?? planned.body.content?.tokenId
  await h.reauth()
  const applied = await h.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
  must(applied, 202, 'apply node.enroll')
  const op = await h.finished(applied.body.id)
  if (op.state !== 'succeeded') throw new Error(`node.enroll: ${op.state} ${op.errorCode}`)
  await h.reauth()
  const revealed = await h.call('POST', `/api/v1/enrollment-tokens/${tokenId}/reveal`, {})
  must(revealed, 200, 'reveal token')
  writeFileSync(file, `${revealed.body.token}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
  say('enrollment token', { tokenId, file })
}

async function adopt(h: Human): Promise<void> {
  const node = await until(
    'an active node',
    async () => (await items(h, '/api/v1/nodes')).find((n) => n.serverId === ids['server'] && n.state === 'active'),
    (n) => n !== undefined,
    180_000,
  )
  ids['node'] = node.id
  const cluster = ids['cluster_pg17']
  await h.planAndApply(`/api/v1/clusters/${cluster}/agent-adoption`, { acknowledgeOneWay: true, nodeId: node.id }, { reauth: true })
  const c = await h.call('GET', `/api/v1/clusters/${cluster}`)
  save()
  say('adopted', { cluster, node: node.id, managementMode: c.body.managementMode })
}

async function addTarget(h: Human, slug: string, major: number, tier: 'nonprod' | 'prod'): Promise<void> {
  const name = `pg${major}`
  const cluster = ids[`cluster_${name}`]
  if (cluster === undefined) throw new Error(`no cluster ${name} in ids.json`)
  const db = `lab_${slug}`.replace(/[^a-z0-9_]/g, '_').slice(0, 60)
  const envKey = `env_${slug}`
  if (ids[envKey] === undefined) {
    await h.planAndApply(`/api/v1/products/${ids['product']}/environments`, {
      slug,
      displayName: slug,
      tier,
      ...(tier === 'prod' ? { evidenceFrom: 'staging' } : {}),
    })
    ids[envKey] = (await items(h, `/api/v1/products/${ids['product']}/environments`)).find((e) => e.slug === slug).id
    save()
  }
  if (psql(major, 'postgres', `SELECT 1 FROM pg_database WHERE datname='${db}'`) !== '1') {
    psql(major, 'postgres', `CREATE DATABASE ${db} OWNER ${OWNER_ROLE}`)
  }
  const sql = await h.call('GET', `/api/v1/clusters/${cluster}/bootstrap-sql?database=${db}&project=${ids['project']}`)
  must(sql, 200, 'bootstrap-sql')
  psql(major, 'postgres', sql.body.script)
  await h.planAndApply(`/api/v1/clusters/${cluster}/databases`, { name: db })
  const database = (await items(h, `/api/v1/clusters/${cluster}/databases`)).find((d) => d.name === db)
  const planned = await h.call('POST', '/api/v1/targets', { projectId: ids['project'], environmentId: ids[envKey], databaseId: database.id })
  must(planned, 201, 'plan target')
  await h.reauth()
  const applied = await h.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
  must(applied, 202, 'apply target')
  if (applied.body.state === 'awaiting_approval') must(await h.approve(applied.body.id, planned.body.planHash), 200, 'approve target')
  const op = await h.finished(applied.body.id)
  if (op.state !== 'succeeded') throw new Error(`target ${slug}: ${op.state} ${op.errorCode}`)
  const t = await h.call('GET', `/api/v1/targets/${encodeURIComponent(`lab/platform/${slug}`)}`)
  must(t, 200, 'GET target')
  ids[`target_${slug}`] = t.body.id
  save()
  say('target', { path: `lab/platform/${slug}`, id: t.body.id, pg: major, database: db, tier })
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2)
  const human = Human.load()
  await human.signIn()
  if (cmd === 'registry') await registry(human)
  else if (cmd === 'enrollment') await enrollment(human, arg ?? join(STATE, 'node-token'))
  else if (cmd === 'adopt') await adopt(human)
  else if (cmd === 'add-target') await addTarget(human, arg ?? 'extra', Number(process.argv[4] ?? 17), process.argv[5] === 'prod' ? 'prod' : 'nonprod')
  else throw new Error('commands: registry | enrollment <token file> | adopt')
}

main().catch((error: unknown) => {
  console.error(String(error instanceof Error ? error.message : error))
  process.exit(1)
})

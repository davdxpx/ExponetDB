// Resource exhaustion of the TARGET by allowlisted functions, through the product's own read path
// (executeDataRead, agent class, the 60 s statement timeout of the agent cap), on a disposable container
// that has a memory limit (docker update --memory 3g). Measures: peak container memory, temp-file rate,
// whether the postmaster killed and restarted every session (crash recovery), time to recover.
//   EXDB_TREE=... EXDB_TEST_TARGETS=... bun --conditions @exponetdb/source bomb.ts --major 17 --out DIR
import { spawnSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TREE = process.env['EXDB_TREE'] ?? ''
const argv = process.argv
const arg = (n: string, d: string) => (argv.includes(`--${n}`) ? (argv[argv.indexOf(`--${n}`) + 1] as string) : d)
const MAJOR = Number(arg('major', '17')) as 16 | 17 | 18
const OUT = arg('out', '.')
const pgp = await import(`${TREE}/packages/postgres/src/index.ts`)
const kit = await import(`${TREE}/packages/testkit/src/index.ts`)
const exec = await import(`${TREE}/packages/diagnostics/src/data-read/executor.ts`)
const { TargetSession, ROLE_NAMES } = pgp
const targets = kit.testTargets()
const server = kit.serverFor(MAJOR)
const container = server.container as string
const file = join(OUT, `bomb-pg${MAJOR}.jsonl`)
writeFileSync(file, '')
const log = (r: Record<string, unknown>) => appendFileSync(file, `${JSON.stringify({ major: MAJOR, ...r })}\n`)
const only = arg('only', '')
const stamp = (m: string) => appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), step: m })}\n`)
const dock = (...a: string[]) => spawnSync('docker', a, { encoding: 'utf8' }).stdout.trim()
const cg = (f: string) => dock('exec', container, 'cat', `/sys/fs/cgroup/${f}`)

await kit.provisionRoles(server, { roles: ROLE_NAMES, cluster: (v: any) => pgp.clusterBootstrapStatements(v), passwords: (v: any) => pgp.passwordStatements(v) })
const database = await kit.createDatabase(server, 'd2bomb')
await kit.runAsSuperuser(server, database, [...pgp.databaseBootstrapStatements(database), 'CREATE TABLE public.accounts (id int)'])
dock('update', '--memory', '3g', '--memory-swap', '3g', container)

async function read(sql: string, timeoutMs: number) {
  const session = await TargetSession.open({
    endpoint: { host: server.host, port: server.port, tlsServerName: targets.serverName, caPem: targets.caPem },
    database,
    role: 'reader',
    user: ROLE_NAMES.reader,
    password: kit.loginPassword(ROLE_NAMES.reader),
    applicationName: 'exponetdb/d2/bomb',
  })
  const started = Date.now()
  try {
    const o = await exec.executeDataRead(session, { kind: 'query', sql, params: [], callerClass: 'agent', maxRows: 500, maxBytes: 5 << 20, statementTimeoutMs: timeoutMs, analyze: false, sensitiveColumns: [], requestId: 'req_01M4S9000000000000000000D4' })
    return { outcome: o.kind === 'refused' ? `${o.code}${o.details?.sqlstate ? ` ${o.details.sqlstate}` : ''}` : o.kind, ms: Date.now() - started }
  } finally {
    await session.close().catch(() => undefined)
  }
}

async function scenario(label: string, sql: string, timeoutMs: number, watchTemp = false) {
  // a bystander session (another tenant of the same cluster) must survive
  const bystander = await kit.superuserClient(server, 'postgres')
  let bystanderError: string | null = null
  bystander.on('error', (e: Error) => {
    bystanderError = e.message.slice(0, 100)
  })
  const oomBefore = Number((cg('memory.events').match(/oom_kill (\d+)/) ?? [])[1] ?? 0)
  const samples: number[] = []
  const tempMb: number[] = []
  const sampler = setInterval(() => {
    samples.push(Number.parseInt(cg('memory.current'), 10) / 1048576)
    if (watchTemp) tempMb.push(Number.parseInt(dock('exec', container, 'sh', '-c', 'du -sm /var/lib/postgresql/data/base/pgsql_tmp 2>/dev/null | cut -f1') || '0', 10))
  }, 1000)
  stamp(`${label}: read starts`)
  const r = await Promise.race([
    read(sql, timeoutMs),
    new Promise<{ outcome: string; ms: number }>((res) => setTimeout(() => res({ outcome: 'HUNG: no result 100 s after the start (statement timeout was ' + timeoutMs / 1000 + ' s)', ms: 100_000 }), 100_000)),
  ])
  stamp(`${label}: read returned ${r.outcome}`)
  clearInterval(sampler)
  let bystanderAlive = true
  try {
    await bystander.query('SELECT 1')
  } catch (e) {
    bystanderAlive = false
    bystanderError ??= String((e as Error).message).slice(0, 100)
  }
  await bystander.end().catch(() => undefined)
  const oomAfter = Number((cg('memory.events').match(/oom_kill (\d+)/) ?? [])[1] ?? 0)
  // time until the server accepts connections again
  const t0 = Date.now()
  for (let i = 0; i < 120; i++) {
    try {
      const c = await kit.superuserClient(server, 'postgres')
      await c.query('SELECT 1')
      await c.end()
      break
    } catch {
      await new Promise((res) => setTimeout(res, 500))
    }
  }
  log({
    label,
    sql: sql.slice(0, 110),
    result: r,
    peakContainerMb: Math.round(Math.max(0, ...samples)),
    oomKills: oomAfter - oomBefore,
    bystanderSessionSurvived: bystanderAlive,
    bystanderError,
    recoveredAfterMs: Date.now() - t0,
    ...(watchTemp ? { tempDirMbMax: Math.max(0, ...tempMb), tempDirMbSamples: tempMb } : {}),
  })
}

if (only === '') {
// 1. temp-file rate of a plain row-capped read of a set-returning function (FunctionScan materializes it)
await scenario('temp-files-15s', 'SELECT g FROM generate_series(1, 1000000000) g', 15_000, true)
// 2. one value of 500 MB per row, streaming: the memory one backend can hold without any aggregate
await scenario('big-values-streaming', "SELECT sum(length(repeat('x', 500000000))) FROM generate_series(1, 6)", 30_000)
}
// 3. an aggregate that keeps every 100 MB value: ~10 GB asked within a second, no timeout can help
if (only === '' || only === '3') await scenario('aggregate-of-big-values', "SELECT array_agg(repeat('x', 100000000)) FROM generate_series(1, 100)", 60_000)
await kit.dropDatabase(server, database).catch(() => undefined)

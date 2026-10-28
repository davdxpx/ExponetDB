// What does the worker's read do when the target backend dies the way an OOM kill makes it die (SIGKILL ->
// the postmaster restarts every session)? Starts a long read through executeDataRead, SIGKILLs the reader's
// backend inside the disposable container, and times the outcome (a deadline of 90 s; the agent statement timeout is 60 s).
//   EXDB_TREE=... EXDB_TEST_TARGETS=... bun --conditions @exponetdb/source crash.ts --major 16 --out DIR
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TREE = process.env['EXDB_TREE'] ?? ''
const argv = process.argv
const arg = (n: string, d: string) => (argv.includes(`--${n}`) ? (argv[argv.indexOf(`--${n}`) + 1] as string) : d)
const MAJOR = Number(arg('major', '16')) as 16 | 17 | 18
const OUT = arg('out', '.')
const MODE = arg('mode', 'kill9') // kill9 = SIGKILL of the backend; sigterm = pg_terminate_backend
const pgp = await import(`${TREE}/packages/postgres/src/index.ts`)
const kit = await import(`${TREE}/packages/testkit/src/index.ts`)
const exec = await import(`${TREE}/packages/diagnostics/src/data-read/executor.ts`)
const { TargetSession, ROLE_NAMES } = pgp
const targets = kit.testTargets()
const server = kit.serverFor(MAJOR)
const container = server.container as string
await kit.provisionRoles(server, { roles: ROLE_NAMES, cluster: (v: any) => pgp.clusterBootstrapStatements(v), passwords: (v: any) => pgp.passwordStatements(v) })
const database = await kit.createDatabase(server, 'd2crash')
await kit.runAsSuperuser(server, database, [...pgp.databaseBootstrapStatements(database)])

const session = await TargetSession.open({
  endpoint: { host: server.host, port: server.port, tlsServerName: targets.serverName, caPem: targets.caPem },
  database,
  role: 'reader',
  user: ROLE_NAMES.reader,
  password: kit.loginPassword(ROLE_NAMES.reader),
  applicationName: 'exponetdb/d2/crash',
})
const started = Date.now()
const read = exec.executeDataRead(session, { kind: 'query', sql: 'SELECT count(*) FROM generate_series(1, 1000000000000)', params: [], callerClass: 'agent', maxRows: 500, maxBytes: 5 << 20, statementTimeoutMs: 60_000, analyze: false, sensitiveColumns: [], requestId: 'req_01M4S9000000000000000000D6' })
await new Promise((r) => setTimeout(r, 1500))
const su = await kit.superuserClient(server, 'postgres')
const pid = (await su.query(`SELECT pid FROM pg_stat_activity WHERE usename = 'exponetdb_reader' AND state = 'active' AND query LIKE '%generate_series%' LIMIT 1`)).rows[0]?.pid
if (MODE === 'sigterm') await su.query('SELECT pg_terminate_backend($1)', [pid]).catch(() => undefined)
else spawnSync('docker', ['exec', container, 'kill', '-9', String(pid)])
await su.end().catch(() => undefined)
const killedAt = Date.now()
const outcome = await Promise.race([
  read.then((o: any) => ({ returned: true, outcome: o.kind === 'refused' ? `${o.code}${o.details?.sqlstate ? ` ${o.details.sqlstate}` : ''}` : o.kind })),
  new Promise<{ returned: boolean; outcome: string }>((r) => setTimeout(() => r({ returned: false, outcome: 'NO RESULT within 90 s of the kill' }), 90_000)),
])
const result = { major: MAJOR, mode: MODE, statementTimeoutMs: 60_000, ...outcome, msFromKill: Date.now() - killedAt, msFromStart: Date.now() - started }
writeFileSync(join(OUT, `crash-pg${MAJOR}-${MODE}.json`), `${JSON.stringify(result)}\n`)
console.log(JSON.stringify(result))
await session.close().catch(() => undefined)
for (let i = 0; i < 60; i++) {
  try {
    const c = await kit.superuserClient(server, 'postgres')
    await c.query('SELECT 1')
    await c.end()
    break
  } catch {
    await new Promise((r) => setTimeout(r, 500))
  }
}
await kit.dropDatabase(server, database).catch(() => undefined)
process.exit(0)

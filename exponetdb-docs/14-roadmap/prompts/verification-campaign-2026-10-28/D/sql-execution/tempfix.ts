// Acceptance evidence for the temp-file finding: with `ALTER ROLE exponetdb_reader SET temp_file_limit = '256MB'`
// (a role setting an administrator can add to the bootstrap SQL; the reader itself cannot set it) the same
// read that writes ~135 MB/s stops within a second with SQLSTATE 53400.
//   EXDB_TREE=... EXDB_TEST_TARGETS=... bun --conditions @exponetdb/source tempfix.ts --major 16 --out DIR
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TREE = process.env['EXDB_TREE'] ?? ''
const argv = process.argv
const arg = (n: string, d: string) => (argv.includes(`--${n}`) ? (argv[argv.indexOf(`--${n}`) + 1] as string) : d)
const MAJOR = Number(arg('major', '16')) as 16 | 17 | 18
const OUT = arg('out', '.')
const pgp = await import(`${TREE}/packages/postgres/src/index.ts`)
const kit = await import(`${TREE}/packages/testkit/src/index.ts`)
const exec = await import(`${TREE}/packages/diagnostics/src/data-read/executor.ts`)
const { TargetSession, ROLE_NAMES } = pgp
const targets = kit.testTargets()
const server = kit.serverFor(MAJOR)
const container = server.container as string
await kit.provisionRoles(server, { roles: ROLE_NAMES, cluster: (v: any) => pgp.clusterBootstrapStatements(v), passwords: (v: any) => pgp.passwordStatements(v) })
const database = await kit.createDatabase(server, 'd2fix')
await kit.runAsSuperuser(server, database, [...pgp.databaseBootstrapStatements(database)])

async function read(sql: string, timeoutMs: number) {
  const session = await TargetSession.open({
    endpoint: { host: server.host, port: server.port, tlsServerName: targets.serverName, caPem: targets.caPem },
    database,
    role: 'reader',
    user: ROLE_NAMES.reader,
    password: kit.loginPassword(ROLE_NAMES.reader),
    applicationName: 'exponetdb/d2/tempfix',
  })
  const started = Date.now()
  try {
    const o = await exec.executeDataRead(session, { kind: 'query', sql, params: [], callerClass: 'agent', maxRows: 500, maxBytes: 5 << 20, statementTimeoutMs: timeoutMs, analyze: false, sensitiveColumns: [], requestId: 'req_01M4S9000000000000000000D5' })
    return { outcome: o.kind === 'refused' ? `${o.code}${o.details?.sqlstate ? ` ${o.details.sqlstate}` : ''}` : o.kind, ms: Date.now() - started }
  } finally {
    await session.close().catch(() => undefined)
  }
}
const tempMb = () => Number.parseInt(spawnSync('docker', ['exec', container, 'sh', '-c', 'du -sm /var/lib/postgresql/data/base/pgsql_tmp 2>/dev/null | cut -f1'], { encoding: 'utf8' }).stdout.trim() || '0', 10)

const results: Record<string, unknown>[] = []
for (const limit of [null, '256MB']) {
  if (limit !== null) await kit.runAsSuperuser(server, 'postgres', [`ALTER ROLE exponetdb_reader SET temp_file_limit = '${limit}'`])
  let peak = 0
  const sampler = setInterval(() => {
    peak = Math.max(peak, tempMb())
  }, 500)
  const r = await read('SELECT g FROM generate_series(1, 1000000000) g', 8000)
  clearInterval(sampler)
  results.push({ major: MAJOR, temp_file_limit: limit ?? '(unset: product bootstrap)', ...r, tempDirPeakMb: peak })
}
await kit.runAsSuperuser(server, 'postgres', ['ALTER ROLE exponetdb_reader RESET temp_file_limit'])
await kit.dropDatabase(server, database).catch(() => undefined)
writeFileSync(join(OUT, `tempfix-pg${MAJOR}.json`), `${JSON.stringify(results, null, 1)}\n`)
console.log(JSON.stringify(results))

// What the reader ROLE alone permits if both the guard and the read-only frame were escaped: statements are sent
// as the reader over the simple protocol, outside any frame, after `SET default_transaction_read_only = off`.
//   EXDB_TREE=... EXDB_TEST_TARGETS=... bun --conditions @exponetdb/source role-depth.ts --major 16 --out DIR
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const TREE = process.env['EXDB_TREE'] ?? ''
const argv = process.argv
const arg = (n: string, d: string) => (argv.includes(`--${n}`) ? (argv[argv.indexOf(`--${n}`) + 1] as string) : d)
const MAJOR = Number(arg('major', '16')) as 16 | 17 | 18
const OUT = arg('out', '.')
const pg = createRequire(`${TREE}/packages/postgres/package.json`)('pg')
const pgp = await import(`${TREE}/packages/postgres/src/index.ts`)
const kit = await import(`${TREE}/packages/testkit/src/index.ts`)
const { ROLE_NAMES } = pgp
const server = kit.serverFor(MAJOR)
await kit.provisionRoles(server, { roles: ROLE_NAMES, cluster: (v: any) => pgp.clusterBootstrapStatements(v), passwords: (v: any) => pgp.passwordStatements(v) })
const database = await kit.createDatabase(server, 'd2depth')
await kit.runAsSuperuser(server, database, [
  ...pgp.databaseBootstrapStatements(database),
  'CREATE TABLE public.accounts (id int PRIMARY KEY, note text)',
  "INSERT INTO public.accounts VALUES (1, 'one')",
  'CREATE SEQUENCE public.s',
])
const attempts: [string, string][] = [
  ['write a table row', "INSERT INTO public.accounts VALUES (2, 'two')"],
  ['update a table row', "UPDATE public.accounts SET note = 'x'"],
  ['delete table rows', 'DELETE FROM public.accounts'],
  ['truncate', 'TRUNCATE public.accounts'],
  ['create a table in public', 'CREATE TABLE public.d2_new (a int)'],
  ['create a schema', 'CREATE SCHEMA d2_new'],
  ['advance a sequence', "SELECT nextval('public.s')"],
  ['create a temporary table and write it', 'CREATE TEMP TABLE d2_tmp (a int); INSERT INTO d2_tmp VALUES (1)'],
  ['create a large object', 'SELECT lo_create(0)'],
  ['take an advisory lock', 'SELECT pg_advisory_lock(1)'],
  ['send a notification', "SELECT pg_notify('d2', 'x')"],
  ['read a server file', "SELECT pg_read_file('/etc/passwd')"],
  ['COPY to a program', "COPY (SELECT 1) TO PROGRAM 'true'"],
  ['become another role', 'SET ROLE postgres'],
  ['alter itself', 'ALTER ROLE exponetdb_reader SUPERUSER'],
  ['terminate another backend', 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND usename = \'postgres\''],
]
const results: Record<string, unknown>[] = []
for (const [label, text] of attempts) {
  const c = new pg.Client({ host: server.host, port: server.port, user: ROLE_NAMES.reader, password: kit.loginPassword(ROLE_NAMES.reader), database, ssl: kit.testTls() })
  c.on('error', () => undefined)
  await c.connect()
  let outcome: string
  try {
    await c.query('SET default_transaction_read_only = off')
    await c.query(text)
    outcome = 'ALLOWED'
  } catch (e) {
    outcome = `refused ${(e as { code?: string }).code ?? ''}`
  }
  await c.end().catch(() => undefined)
  results.push({ major: MAJOR, attempt: label, sql: text.slice(0, 70), outcome })
}
await kit.dropDatabase(server, database).catch(() => undefined)
writeFileSync(join(OUT, `role-depth-pg${MAJOR}.json`), `${JSON.stringify(results, null, 1)}\n`)
for (const r of results) console.log(String(r['attempt']).padEnd(40), r['outcome'])

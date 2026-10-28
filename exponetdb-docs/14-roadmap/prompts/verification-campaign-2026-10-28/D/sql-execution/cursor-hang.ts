// Minimal reproduction of the root cause with pg and pg-cursor only (no product code):
// after the backend is terminated, cursor.read() rejects but cursor.close() never settles,
// which is what `await cursor.close().catch(() => undefined)` in TargetSession.runAdmittedRead waits for.
//   EXDB_TREE=... EXDB_TEST_TARGETS=... bun --conditions @exponetdb/source cursor-hang.ts
import { createRequire } from 'node:module'

const TREE = process.env['EXDB_TREE'] ?? ''
const req = createRequire(`${TREE}/packages/postgres/package.json`)
const pg = req('pg')
const Cursor = req('pg-cursor')
const kit = await import(`${TREE}/packages/testkit/src/index.ts`)
const server = kit.serverFor(16)
const t = kit.testTargets()
const client = new pg.Client({ host: server.host, port: server.port, user: t.superuser, password: t.superuserPassword, database: 'postgres', ssl: kit.testTls() })
client.on('error', () => undefined)
await client.connect()
const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
await client.query('BEGIN')
const cursor = client.query(new Cursor('SELECT count(*) FROM generate_series(1, 1000000000000)'))
const read = cursor.read(10).then(() => 'rows', (e: Error) => `read rejected: ${e.message}`)
setTimeout(async () => {
  const other = await kit.superuserClient(server, 'postgres')
  await other.query('SELECT pg_terminate_backend($1)', [pid])
  await other.end()
}, 1500)
console.log(await read)
const closed = await Promise.race([
  cursor.close().then(() => 'close() resolved', (e: Error) => `close() rejected: ${e.message}`),
  new Promise((r) => setTimeout(() => r('close() still pending after 10 s'), 10_000)),
])
console.log(closed)
process.exit(0)

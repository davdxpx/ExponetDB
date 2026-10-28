/**
 * Reproduction (in process, no network, no database): at the REST layer the request body is
 * read, JSON-parsed and schema-validated BEFORE the use case asks the authorization engine
 * (apps/server/src/interfaces/http/api.ts:2240 readBody ... 2295 handler). A stub Application
 * stands in for the use cases: its `migrations.plan` refuses with PERMISSION_DENIED the way the
 * engine does for a caller without `migrations.plan`.
 *
 * Run from a checkout of the tree under test (copy this file to apps/server/ there):
 *   bun --conditions=@exponetdb/source ordering.repro.ts
 */
import { AuthError } from '@exponetdb/auth'
import { MIGRATION_BODY_LIMIT_BYTES } from '@exponetdb/contracts'
import { Hono } from 'hono'
import { mountApi } from './src/interfaces/http/api.ts'

const calls: string[] = []
const application: any = {
  authenticateBearer: async () => ({ identityId: 'idn_0AAAAAAAAAAAAAAAAAAAAAAAAA', identityKind: 'human', client: 'cli', label: 'human #1', delegation: { credential: { type: 'access_token', grantId: 'grt_0AAAAAAAAAAAAAAAAAAAAAAAAA', clientId: 'cli_0AAAAAAAAAAAAAAAAAAAAAAAAA', grantKind: 'delegated' }, resource: 'api', scopes: new Set(['targets.read']), restrictions: { targets: { kind: 'all' }, tiers: ['nonprod', 'prod'] } } }),
  noteGrantUse: () => {},
  migrations: {
    plan: async () => {
      calls.push('migrations.plan (the use case; the engine is asked here)')
      throw new AuthError('PERMISSION_DENIED')
    },
  },
}
const app = new Hono<any>()
app.use('*', async (c, next) => {
  c.set('requestId', 'req_0AAAAAAAAAAAAAAAAAAAAAAAAA')
  await next()
})
const noop = { info() {}, warn() {}, error() {}, debug() {} } as any
mountApi(app, { application, publicOrigin: 'https://db.example.test', trustedProxies: [], logger: noop, available: () => true })

const url = 'http://localhost/api/v1/targets/tgt_0AAAAAAAAAAAAAAAAAAAAAAAAA/migrations/plans'
const headers = { authorization: 'Bearer exdb_dummy', 'content-type': 'application/json' }
const send = async (label: string, body: string) => {
  calls.length = 0
  const rss0 = process.memoryUsage().rss
  const t0 = performance.now()
  const res = await app.request(url, { method: 'POST', headers, body })
  const text = await res.text()
  const code = (JSON.parse(text) as { code?: string }).code
  console.log(`${label}: ${body.length} bytes -> ${res.status} ${code}; use case reached: ${calls.length > 0}; ${(performance.now() - t0).toFixed(0)} ms; rss +${((process.memoryUsage().rss - rss0) / 1048576).toFixed(0)} MiB`)
}

await send('1 invalid body (not an object)  ', '[1]')
await send('2 valid small body              ', '{}')
const big = JSON.stringify({ bundles: Array.from({ length: 1 }, () => ({ directory: '0AAAAAAAAAAAAAAAAAAAAAAAAA_x', files: { 'migration.yaml': 'x', 'up.sql': 'a'.repeat(4 * 1024 * 1024 - 1) } })) })
await send('3 valid-shaped 4 MiB bundle body', big)
const limit = MIGRATION_BODY_LIMIT_BYTES
const huge = JSON.stringify({ bundles: Array.from({ length: 7 }, (_, i) => ({ directory: `0AAAAAAAAAAAAAAAAAAAAAAAA${i}_x`, files: { 'migration.yaml': 'x', 'up.sql': 'a'.repeat(4 * 1024 * 1024 - 1) } })) })
await send(`4 valid-shaped ~28 MiB (limit ${limit})`, huge)

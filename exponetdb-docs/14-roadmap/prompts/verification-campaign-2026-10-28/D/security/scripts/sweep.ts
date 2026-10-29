/**
 * S4: GET every read route of the REST API (D1's authz-samples.json) with real ids from fixtures.json, as
 *   - bearer `owner` (CLI token), - bearer `service-account` (API key), - the owner's Web App cookie session,
 * and store the bodies under $L4/sweep/<mode>/<operationId>.json (0600) for the sink scan. Prints counts per status only.
 *   bun --conditions=@exponetdb/source s4/sweep.ts <samples.json> <fixtures.json>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { Human } from '../human.ts'

const S4 = process.env['S4'] ?? '/srv/work/s4'
const L4 = process.env['L4'] ?? '/srv/work/logs-s4'
const BASE = process.env['EXSTACK_PUBLIC_URL'] ?? 'http://localhost:58480'
const [samplesFile, fixturesFile] = process.argv.slice(2) as [string, string]
const samples = JSON.parse(readFileSync(samplesFile, 'utf8')).rest as Record<string, any>
const fx = JSON.parse(readFileSync(fixturesFile, 'utf8')) as { targets: { nonprod: string; prod: string }; ids: Record<string, string> }
const fill = (v: any, key: string, tier: string): any => {
  if (typeof v === 'string' && v.startsWith('@id:')) {
    const p = v.slice(4)
    if (p === 'tgt') return tier === 'prod' ? fx.targets.prod : fx.targets.nonprod
    return fx.ids[key] ?? fx.ids[p] ?? `${p}_00000000000000000000000000`
  }
  if (Array.isArray(v)) return v.map((x) => fill(x, key, tier))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, k, tier)]))
  return v
}
type Fetcher = (path: string) => Promise<{ status: number; text: string }>
async function run(mode: string, get: Fetcher): Promise<void> {
  mkdirSync(`${L4}/sweep/${mode}`, { recursive: true, mode: 0o700 })
  const counts: Record<string, number> = {}
  for (const [op, s] of Object.entries(samples)) {
    if (s.method !== 'GET' || s.path.startsWith('/auth/') || s.path.includes('/export')) continue
    for (const tier of s.path.includes('{target}') ? ['nonprod', 'prod'] : ['none']) {
      const path = s.path.replace(/\{(\w+)\}/g, (_: string, k: string) => encodeURIComponent(String(fill(s.params?.[k], k, tier))))
      const q = new URLSearchParams(Object.entries(fill(s.query ?? {}, '', tier)).map(([k, v]) => [k, String(v)])).toString()
      const r = await get(`${path}${q === '' ? '' : `?${q}`}`).catch((e: unknown) => ({ status: 0, text: String(e).slice(0, 200) }))
      writeFileSync(`${L4}/sweep/${mode}/${op}.${tier}.json`, r.text, { mode: 0o600 })
      counts[String(r.status)] = (counts[String(r.status)] ?? 0) + 1
    }
  }
  console.log(JSON.stringify({ mode, counts }))
}
async function main(): Promise<void> {
  const bearer = (file: string): Fetcher => async (p) => {
    const t = readFileSync(file, 'utf8').trim()
    const r = await fetch(`${BASE}${p}`, { headers: { authorization: `Bearer ${t}`, accept: 'application/json' }, redirect: 'manual' })
    return { status: r.status, text: await r.text() }
  }
  await run('owner-bearer', bearer(`${S4}/creds/owner.token`))
  await run('apikey', bearer(`${S4}/creds/service-account.token`))
  await run('viewer-bearer', bearer(`${S4}/creds/viewer.token`))
  const h = Human.load()
  await h.signIn()
  await run('owner-session', async (p) => {
    const r = await h.call('GET', p)
    return { status: r.status, text: r.text }
  })
}
main().catch((e: unknown) => {
  console.error(String(e instanceof Error ? e.message : e).slice(0, 300))
  process.exit(1)
})

// Child-process probe: lintBundles on k dense bundles (66,000 x "SELECT 1;" = 198,000 tokens each, under the
// per-parse bound). Prints one JSON line per k with time and RSS: is memory bounded per REQUEST or only per parse?
//   usage: densescale.ts 1,2,4,8
import { lintBundles, prepareLint } from '@exponetdb/migrations/lint'
import { enc, mk, PROJECT, ulidOf } from '../lib/bundle.ts'
await prepareLint(17)
const dense = 'SELECT 1;\n'.repeat(66_000)
for (const k of (process.argv[2] ?? '1,2,4').split(',').map(Number)) {
  const inputs = Array.from({ length: k }, (_, i) => mk({ id: ulidOf(9000 + i), name: `d${i}`, up: enc(dense) }))
  const t0 = performance.now()
  const r = lintBundles(inputs, { major: 17, project: PROJECT, tier: 'prod' })
  const ms = performance.now() - t0
  const held = r.bundles.reduce((a, b) => a + b.statements.length, 0)
  console.log(JSON.stringify({ k, bundles: r.bundles.length, statementsHeld: held, ms: Math.round(ms), rssMb: Math.round(process.resourceUsage().maxRSS / 1024), heapMb: Math.round(process.memoryUsage().heapUsed / 1048576) }))
}

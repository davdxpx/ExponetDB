// Child-process probe: lintBundles on n bundles (chain = each depends on the previous; indep = no dependencies,
// all touching one table). Prints one JSON line per n.  usage: lintscale.ts <chain|indep> 50,100,200
import { lintBundles, prepareLint } from '@exponetdb/migrations/lint'
import { enc, mk, PROJECT, ulidOf } from '../lib/bundle.ts'
await prepareLint(17)
const mode = process.argv[2] ?? 'chain'
for (const n of (process.argv[3] ?? '100,200,400,800').split(',').map(Number)) {
  const inputs = Array.from({ length: n }, (_, i) =>
    mk({
      id: ulidOf(1000 + i),
      name: `c${i}`,
      up: enc(i === 0 ? 'CREATE TABLE public.ch (i int);\n' : `COMMENT ON TABLE public.ch IS 'step ${i}';\n`),
      dependsOn: mode === 'chain' && i > 0 ? [ulidOf(1000 + i - 1)] : [],
    }),
  )
  const t0 = performance.now()
  const r = lintBundles(inputs, { major: 17, project: PROJECT, tier: 'prod' })
  const ms = performance.now() - t0
  console.log(JSON.stringify({ mode, n, ms: Math.round(ms), msPerBundle: Math.round((ms / n) * 10) / 10, findings: r.bundles.reduce((a, b) => a + b.findings.length, 0), rssMb: Math.round(process.memoryUsage().rss / 1048576) }))
}

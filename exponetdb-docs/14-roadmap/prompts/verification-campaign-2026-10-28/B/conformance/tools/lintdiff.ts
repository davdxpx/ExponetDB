import { lintBundles, prepareLint } from '@exponetdb/migrations/lint'
import { enc, mk, PROJECT, ulidOf } from '../lib/bundle.ts'
import { script } from '../lib/gen.ts'
await prepareLint(17)
const SQLS: string[] = ['CREATE TABLE public.t (id int);\n', 'ALTER TABLE public.t ADD COLUMN c2 int;\n', 'ALTER TABLE public.t ADD COLUMN c3 int;\n', 'CREATE INDEX i ON public.t (id);\n', 'DROP TABLE public.t;\n']
const bundles = SQLS.map((up, i) => mk({ id: ulidOf(100 + i), name: `b${i}`, up: enc(up), dependsOn: i === 0 ? [] : [ulidOf(100)] }))
const a = lintBundles(bundles, { major: 17, project: PROJECT, tier: 'prod' })
const b = lintBundles([...bundles].reverse(), { major: 17, project: PROJECT, tier: 'prod' })
const norm = (r: typeof a) => Object.fromEntries(r.bundles.map((x) => [x.directory, x]))
const na = norm(a), nb = norm(b)
for (const d of Object.keys(na)) {
  const ja = JSON.stringify(na[d]), jb = JSON.stringify(nb[d])
  if (ja !== jb) {
    const fa = na[d]!.findings, fb = nb[d]!.findings
    console.log('BUNDLE', d, 'differs')
    for (let i = 0; i < Math.max(fa.length, fb.length); i++) if (JSON.stringify(fa[i]) !== JSON.stringify(fb[i])) console.log('  A', JSON.stringify(fa[i])?.slice(0, 300), '\n  B', JSON.stringify(fb[i])?.slice(0, 300))
  }
}
console.log('graph', JSON.stringify(a.graph) === JSON.stringify(b.graph), 'findings', JSON.stringify(a.findings) === JSON.stringify(b.findings))

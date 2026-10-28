// Prints ONE canonical JSON document of everything deterministic the bundle libraries compute for a fixed
// corpus: digests, executable texts, lint reports (PostgreSQL 16, 17 and 18 parsers), statement
// analysis, graph order and a plan hash over a fixed body. Run under every runtime / TZ / LANG of the
// matrix (I1); the output must be byte-identical. `--shuffle <seed>` permutes input order (bundles,
// file maps, statements of the corpus) which must not change a single byte of the output.
//
//   node|bun --conditions=@exponetdb/source dump.ts [--shuffle seed] [--out file]
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { validateBundle } from '@exponetdb/migrations/format'
import { buildGraph } from '@exponetdb/migrations/graph'
import { lintBundles, prepareLint } from '@exponetdb/migrations/lint'
import { computePlanHash } from '@exponetdb/kernel/hash'
import { analyzeMigrationSql, loadParser } from '@exponetdb/postgres/parser'
import { enc, mk, PROJECT, ulidOf } from '../lib/bundle.ts'
import { script } from '../lib/gen.ts'

const args = process.argv.slice(2)
const shuffleSeed = args.includes('--shuffle') ? Number(args[args.indexOf('--shuffle') + 1]) : null
const outFile = args.includes('--out') ? (args[args.indexOf('--out') + 1] as string) : null

function shuffled<T>(a: readonly T[]): T[] {
  const out = a.slice()
  if (shuffleSeed === null) return out
  let s = (shuffleSeed >>> 0) || 1
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    const j = s % (i + 1)
    ;[out[i], out[j]] = [out[j] as T, out[i] as T]
  }
  return out
}

// ---------- corpus ----------
const SQLS: string[] = [
  'CREATE TABLE public.t (id int PRIMARY KEY, "Mixed Case" text DEFAULT \'x\');\n',
  "CREATE INDEX i ON public.t (id) WHERE id > 0;\n",
  'ALTER TABLE public.t ADD COLUMN c2 int NOT NULL DEFAULT 5;\nALTER TABLE public.t DROP COLUMN c2;\n',
  'CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 -- c\n $$;\n',
  'DO $do$ BEGIN PERFORM 1; END $do$;\n',
  "COMMENT ON TABLE public.t IS E'a\\'b';\n",
  "SELECT 'I' || 'i' || 'İ' || 'ı';\n", // Turkish dotted / dotless I
  'CREATE TABLE "I" (i int); CREATE TABLE "i" (i int); CREATE TABLE "İ" (i int);\n',
  'CREATE TABLE public.café (i int); CREATE TABLE public."café" (i int);\n',
  'GRANT SELECT ON public.t TO PUBLIC;\n',
  'CREATE POLICY p ON public.t FOR ALL USING (true);\n',
  'COMMIT;\n',
  'SET LOCAL search_path = evil;\n',
  "SELECT set_config('role','x',true);\n",
  'CREATE INDEX CONCURRENTLY i2 ON public.t (id);\n',
  'DROP TABLE public.t;\n',
  'ALTER TABLE public.t RENAME TO t2;\n',
  "SELECT 'a'\n'b';\n",
  'U&"d\\0061t" ',
  '/* /* nested */ */ SELECT 1;\n',
  'SELECT 1 UNION ALL SELECT 2;\nVACUUM public.t;\n',
]
for (let seed = 1; seed <= 12; seed++) SQLS.push(script(seed * 31, 6 + (seed % 7)).text)
SQLS.push('SELECT 1;\r\nSELECT 2;\rSELECT 3;\n')
SQLS.push('SELECT 1\u000bFROM t;')

// ---------- computation ----------
await Promise.all([16, 17, 18].map((m) => loadParser(m as 16 | 17 | 18)))
for (const m of [16, 17, 18] as const) await prepareLint(m)

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const out: Record<string, unknown> = {}

out['icu-trap'] = {
  // proves the locale trap is armed in this process; NOT part of the comparison (stripped below)
  lowerI: 'I'.toLocaleLowerCase(),
  collator: new Intl.Collator().resolvedOptions().locale,
}

const bundles = SQLS.map((up, i) =>
  mk({ id: ulidOf(100 + i), name: `b${i}`, up: enc(up), verify: i % 3 === 0 ? 'SELECT true AS ok;\n' : null, down: i % 4 === 0 ? 'DROP TABLE public.t;\n' : null, dependsOn: i === 0 ? [] : [ulidOf(100)] }),
)
out['digests'] = [...bundles]
  .sort((a, b) => (a.directory < b.directory ? -1 : 1))
  .map((b) => {
    const r = validateBundle(b)
    if (!r.ok) return { dir: b.directory, refused: r.error }
    const d = r.value.digests
    return { dir: b.directory, checksum: d.checksum, verify: d.verifyDigest, rollback: d.rollbackDigest, bundle: d.bundleDigest, source: d.sourceDigest, x: sha(d.executableText['up.sql']), manifest: sha(JSON.stringify(d.canonicalManifest)) }
  })

const inputs = shuffled(
  bundles.map((b) => ({ ...b, files: new Map(shuffled([...b.files.entries()])) })),
)
const lintReports: Record<string, string> = {}
const lintRaw: Record<string, string> = {}
const sortFindings = (fs: readonly { rule: string; message: string }[]) => [...fs].map((f) => JSON.stringify(f)).sort()
for (const major of [16, 17, 18] as const) {
  const rep = lintBundles(inputs, { major, project: PROJECT, tier: 'prod' })
  // canonical form: bundles keyed by directory, findings sorted (the order of findings is checked on its own: lintRaw)
  const byDir = Object.fromEntries(rep.bundles.map((b) => [b.directory, sha(JSON.stringify({ ...b, findings: sortFindings(b.findings) }))]))
  lintReports[`pg${major}`] = sha(JSON.stringify({ byDir: Object.entries(byDir).sort(), graph: rep.graph, errors: rep.errors, warnings: rep.warnings, blocking: rep.blocking, findings: sortFindings(rep.findings) }))
  lintRaw[`pg${major}`] = sha(JSON.stringify(rep))
}
out['lint'] = lintReports

const analysis: Record<string, unknown> = {}
for (const major of [16, 17, 18] as const) {
  analysis[`pg${major}`] = shuffled(SQLS.map((s, i) => [i, s] as const)).map(([i, s]) => {
    const a = analyzeMigrationSql(major, s.replaceAll('\r\n', '\n').replaceAll('\r', '\n'), { trustedExtensions: [] })
    return [i, sha(JSON.stringify(a.ok ? a.statements : a))] as const
  }).sort((x, y) => x[0] - y[0])
}
out['analysis'] = analysis

// graph: a seeded random DAG of 400 nodes
let s = 20261028
const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)
const nodes = Array.from({ length: 400 }, (_, i) => ({ id: ulidOf(5000 + ((i * 7919) % 400)), dependsOn: [] as string[], i }))
for (let i = 1; i < nodes.length; i++) for (let k = 0; k < 3; k++) if (rnd() < 0.5) (nodes[i] as { dependsOn: string[] }).dependsOn.push((nodes[Math.floor(rnd() * i)] as { id: string }).id)
const g = buildGraph({ migrations: shuffled(nodes.map((n) => ({ id: n.id, dependsOn: shuffled(n.dependsOn) }))) })
out['graph'] = g.ok ? sha(JSON.stringify(g.value.order())) : g.error

// plan hash over a fixed body (the real hash also binds a random id and timestamps; see I13/I3 int)
const content = { migrations: (out['digests'] as { checksum?: string }[]).map((d) => d.checksum ?? null) }
out['planHash'] = computePlanHash({
  id: 'pln_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z',
  kind: 'migration.apply',
  kindVersion: 1,
  createdAt: '2026-10-28T00:00:00.000Z',
  expiresAt: '2026-10-28T01:00:00.000Z',
  actor: { kind: 'human', identityId: 'idn_x' },
  client: { kind: 'web', clientId: null },
  subject: { targetId: 'tgt_x' },
  content,
  contentChecksum: `sha256:${sha(JSON.stringify(content))}`,
  policy: { decision: 'allow', rules: [], policyVersion: 1, evaluatedAt: '2026-10-28T00:00:00.000Z' },
} as never)

const trap = out['icu-trap']
delete out['icu-trap']
const text = JSON.stringify(out)
const hash = sha(text)
if (outFile !== null) writeFileSync(outFile, text)
const sections = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, sha(JSON.stringify(v))]))
console.log(JSON.stringify({ hash, sections, lintRaw: sha(JSON.stringify(lintRaw)), bytes: text.length, trap, runtime: typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined' ? 'bun ' + (globalThis as { Bun?: { version: string } }).Bun?.version : 'node ' + process.versions.node, tz: process.env['TZ'] ?? null, lang: process.env['LANG'] ?? null }))

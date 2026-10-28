// Child-process probe: runs ONE hostile input through load/lint/plan-level code and prints one JSON line
// with wall time, CPU time, peak RSS and the outcome. Run by I14/I15 under `timeout`, so a hang or a
// crash of the child is itself a result.  usage: node --conditions=@exponetdb/source probe.ts <case> [n]
import { executableText, validateBundle } from '@exponetdb/migrations/format'
import { lintBundles, prepareLint } from '@exponetdb/migrations/lint'
import { analyzeMigrationSql, loadParser } from '@exponetdb/postgres/parser'
import { mk, PROJECT, enc } from './../lib/bundle.ts'

const [name = '', arg = '1'] = process.argv.slice(2)
const n = Number(arg)

function textFor(): string {
  switch (name) {
    case 'nested-comments': return '/*'.repeat(n) + '*/'.repeat(n) + 'SELECT 1;'
    case 'unterminated-nested-comments': return '/*'.repeat(n) + 'SELECT 1;'
    case 'parens': return `SELECT ${'('.repeat(n)}1${')'.repeat(n)};`
    case 'brackets': return `SELECT ${'ARRAY['.repeat(n)}1${']'.repeat(n)};`
    case 'subselects': return `SELECT 1 FROM ${'(SELECT 1 FROM '.repeat(n)}t${') x'.repeat(n)};`
    case 'case-nesting': return `SELECT ${'CASE WHEN true THEN '.repeat(n)}1${' END'.repeat(n)};`
    case 'concat-chain': return `SELECT ${Array.from({ length: n }, () => "'a'").join(' || ')};`
    case 'tiny-statements': return 'SELECT 1;\n'.repeat(n)
    case 'comment-statements': return Array.from({ length: n }, (_, i) => `COMMENT ON TABLE t IS 'c${i}';`).join('\n')
    case 'long-string': return `SELECT '${'x'.repeat(n)}';`
    case 'long-ident': return `CREATE TABLE "${'x'.repeat(n)}" (c int);`
    case 'dollar-tags': return Array.from({ length: n }, (_, i) => `DO $t${i}$ BEGIN NULL; END $t${i}$;`).join('\n')
    case 'dollar-long-tag': return `SELECT $${'t'.repeat(n)}$ x $${'t'.repeat(n)}$;`
    case 'many-semicolons': return ';'.repeat(n)
    case 'unterminated-string': return `SELECT '${'x'.repeat(n)}`
    case 'do-body-statements': return `DO $$ BEGIN ${'PERFORM 1; '.repeat(n)} END $$;`
    case 'in-list': return `SELECT 1 WHERE 1 IN (${Array.from({ length: n }, (_, i) => i).join(',')});`
    case 'columns': return `CREATE TABLE t (${Array.from({ length: n }, (_, i) => `c${i} int`).join(',')});`
    case 'whitespace': return `SELECT${' '.repeat(n)}1;`
    case 'line-comment': return `--${'x'.repeat(n)}\nSELECT 1;`
    case 'unicode-ident': return `CREATE TABLE "${'\u{1F600}'.repeat(n)}" (c int);`
    default: throw new Error(`unknown case ${name}`)
  }
}

// manifest-side cases: the hostile content is migration.yaml (at most 64 KiB)
function yamlFor(): string | null {
  const head = 'schema: exponetdb.migration/v1\nid: 01JB2Z6G8M4Q7R9T1V3W5X7Y9Z\nname: change\ndescription: x\ndependsOn: []\nexecution:\n  transactional: true\ncompatibility:\n  declared: additive\nverification:\n  expectations: auto\n  runtimeChecks: none\n'
  switch (name) {
    case 'yaml-flow-depth': return head + 'extra: ' + '['.repeat(n) + ']'.repeat(n) + '\n'
    case 'yaml-block-depth': return head + Array.from({ length: n }, (_, i) => `${' '.repeat(i + 1)}k${i}:`).join('\n') + ' 1\n'
    case 'yaml-map-depth': return head + 'extra: ' + '{a: '.repeat(n) + '1' + '}'.repeat(n) + '\n'
    case 'yaml-alias-bomb': {
      const lines = ['a0: &a0 [x,x,x,x,x,x,x,x,x]']
      for (let i = 1; i < n; i++) lines.push(`a${i}: &a${i} [${Array.from({ length: 9 }, () => `*a${i - 1}`).join(',')}]`)
      return head + lines.join('\n') + '\n'
    }
    case 'yaml-many-keys': return head + Array.from({ length: n }, (_, i) => `k${i}: 1`).join('\n') + '\n'
    case 'yaml-long-scalar': return head + 'extra: ' + 'x'.repeat(n) + '\n'
    case 'yaml-many-docs': return head + '---\n'.repeat(n)
    case 'yaml-deps': return head.replace('dependsOn: []', 'dependsOn: [' + Array.from({ length: n }, (_, i) => `01JB2Z6G8M4Q${String(i).padStart(14, '0').replace(/[ILOU]/g, '0')}`).join(',') + ']')
    default: return null
  }
}
const yamlText = name.startsWith('yaml-') ? yamlFor() : null
const text = yamlText === null ? textFor() : ''
const t0 = performance.now()
const c0 = process.cpuUsage()
const out: Record<string, unknown> = { case: name, n, bytes: Buffer.byteLength(text), runtime: typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined' ? 'bun' : 'node' }
if (yamlText !== null) {
  try {
    const v = validateBundle({ directory: '01JB2Z6G8M4Q7R9T1V3W5X7Y9Z_change', files: new Map([['migration.yaml', enc(yamlText)], ['up.sql', enc('SELECT 1;')]]), projectDefaults: { role: 'owner', searchPath: ['public'] } })
    out['validate'] = v.ok ? 'ok' : `${v.error.code} ${JSON.stringify((v.error as { details: unknown }).details).slice(0, 100)}`
  } catch (e) {
    out['threw'] = `${(e as Error).name}: ${(e as Error).message.slice(0, 120)}`
  }
  out['bytes'] = Buffer.byteLength(yamlText)
} else try {
  await loadParser(17)
  await prepareLint(17)
  const t1 = performance.now()
  const x = executableText(enc(text))
  out['c1'] = x.ok ? `ok ${x.value.length}` : x.error
  const t2 = performance.now()
  const a = analyzeMigrationSql(17, text, { trustedExtensions: [] })
  out['analysis'] = a.ok ? `ok ${a.statements.length} statements` : `refused ${JSON.stringify((a as { failure: unknown }).failure)}`
  const t3 = performance.now()
  const v = validateBundle(mk({ up: enc(text) }))
  out['validate'] = v.ok ? 'ok' : (v.error as { details?: { reason?: string } }).details?.reason ?? 'refused'
  const rep = lintBundles([mk({ up: enc(text) })], { major: 17, project: PROJECT, tier: 'prod' })
  const t4 = performance.now()
  out['lint'] = { rules: [...new Set(rep.bundles[0]?.findings.map((f) => `${f.rule}${f.blocking ? '!' : ''}`) ?? [])].slice(0, 6), valid: rep.bundles[0]?.valid }
  out['ms'] = { load: Math.round(t1 - t0), c1: Math.round(t2 - t1), analysis: Math.round(t3 - t2), lint: Math.round(t4 - t3) }
} catch (e) {
  out['threw'] = `${(e as Error).name}: ${(e as Error).message.slice(0, 120)}`
}
const c = process.cpuUsage(c0)
out['cpuMs'] = Math.round((c.user + c.system) / 1000)
out['wallMs'] = Math.round(performance.now() - t0)
out['maxRssMb'] = Math.round(process.resourceUsage().maxRSS / 1024)
console.log(JSON.stringify(out))

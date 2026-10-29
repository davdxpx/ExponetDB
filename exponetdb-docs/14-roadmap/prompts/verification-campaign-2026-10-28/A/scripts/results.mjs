// usage: node results.mjs <root> <label> <outdir>
// Collects <pkgdir>/.vr-<label>.json (vitest json reporter) into <outdir>/<label>.tsv and <label>.summary.json
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'
const [root, label, outdir] = process.argv.slice(2)
mkdirSync(outdir, { recursive: true })
const dirs = []
for (const top of ['apps', 'packages']) {
  if (existsSync(join(root, top))) for (const d of readdirSync(join(root, top))) dirs.push(join(top, d))
}
dirs.push('tooling')
const rows = []
const summary = {}
for (const d of dirs) {
  const f = join(root, d, `.vr-${label}.json`)
  if (!existsSync(f)) continue
  const j = JSON.parse(readFileSync(f, 'utf8'))
  const s = { files: j.testResults.length, filesFailed: 0, total: j.numTotalTests, passed: j.numPassedTests, failed: j.numFailedTests, pending: j.numPendingTests, todo: j.numTodoTests ?? 0, suiteFailures: j.numFailedTestSuites }
  for (const tr of j.testResults) {
    const file = relative(join(root, d), tr.name)
    if (tr.status === 'failed') s.filesFailed++
    if (tr.assertionResults.length === 0 && tr.status === 'failed') rows.push([d, file, '<file-level failure>', 'failed', 0, (tr.message || '').slice(0, 200).replace(/\s+/g, ' ')].join('\t'))
    for (const a of tr.assertionResults) rows.push([d, file, String(a.fullName).replace(/[\t\r\n]+/g, ' ⏎ '), a.status, Math.round(a.duration ?? 0), ''].join('\t'))
  }
  summary[d] = s
}
rows.sort()
writeFileSync(join(outdir, `${label}.tsv`), rows.join('\n') + '\n')
const tot = Object.values(summary).reduce((a, s) => { for (const k of Object.keys(s)) a[k] = (a[k] ?? 0) + s[k]; return a }, {})
writeFileSync(join(outdir, `${label}.summary.json`), JSON.stringify({ label, total: tot, packages: summary }, null, 1))
console.log(label, JSON.stringify(tot))

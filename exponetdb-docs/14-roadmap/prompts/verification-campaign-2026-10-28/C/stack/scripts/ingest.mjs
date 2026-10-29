// Ingest N synthetic bundles through POST /api/v1/projects/{id}/bundles (migrations.plan scope, the unaudited path of C1-11).
//   node ingest.mjs --project prj_.. --headers FILE --api http://127.0.0.1:58480 [--per 8] [--kb 4096] [--requests 1] [--tag s6]
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
const a = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => (v.startsWith('--') ? [...acc, [v.slice(2), arr[i + 1]]] : acc), []))
const headers = { 'content-type': 'application/json' }
for (const l of readFileSync(a.headers, 'utf8').split('\n')) { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).trim()] = l.slice(i + 1).trim() }
const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ulid = () => '0' + Array.from(randomBytes(25), (b) => CROCK[b % 32]).join('')
const per = Number(a.per ?? 8), kb = Number(a.kb ?? 4096), reqs = Number(a.requests ?? 1)
const statuses = {}; let bytes = 0; const t0 = Date.now()
for (let r = 0; r < reqs; r++) {
  const bundles = Array.from({ length: per }, () => {
    const id = ulid(), name = `${a.tag ?? 's6'}-fill`
    const yaml = `schema: exponetdb.migration/v1\nid: ${id}\nname: ${name}\ndescription: |\n  synthetic ingest filler\ndependsOn: []\nexecution:\n  transactional: true\ncompatibility:\n  declared: additive\nverification:\n  expectations: auto\n  runtimeChecks: verify.sql\n`
    const up = `CREATE TABLE s6_fill_${id.toLowerCase()} (id int);\n-- ${randomBytes(Math.floor((kb * 1024 * 3) / 4)).toString('base64')}\n`
    return { directory: `${id}_${name}`, files: { 'migration.yaml': yaml, 'up.sql': up, 'verify.sql': 'SELECT 1;\n' } }
  })
  const body = JSON.stringify({ bundles, defaults: { lockTimeout: '5s', statementTimeout: '15m', role: 'owner', searchPath: ['public'] } }); bytes += body.length
  const res = await fetch(`${a.api}/api/v1/projects/${a.project}/bundles`, { method: 'POST', headers, body })
  const txt = await res.text(); let code = ''
  if (res.status >= 400) { try { code = ' ' + (JSON.parse(txt).code ?? '') } catch { code = ' nonjson' } }
  statuses[res.status + code] = (statuses[res.status + code] ?? 0) + 1
  if (res.status >= 400 && r < 1) console.error(txt.slice(0, 300))
}
console.log(JSON.stringify({ requests: reqs, perRequest: per, kbEach: kb, sentMB: +(bytes / 1048576).toFixed(1), statuses, seconds: +((Date.now() - t0) / 1000).toFixed(1) }))

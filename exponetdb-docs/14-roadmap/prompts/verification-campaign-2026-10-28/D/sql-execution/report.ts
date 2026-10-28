// Builds results.md from the raw run output.   bun report.ts <out-dir> > results.md
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? './out'
const corpus = new Map<string, any>(
  readFileSync(new URL('./corpus.jsonl', import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const e = JSON.parse(l)
      return [e.id, e]
    }),
)
const byId = new Map<string, any[]>()
for (const major of [16, 17, 18]) {
  const f = join(dir, `corpus-pg${major}.jsonl`)
  if (!existsSync(f)) continue
  for (const l of readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(l)
    r.expected = corpus.get(r.id)?.expected ?? r.expected
    byId.set(r.id, [...(byId.get(r.id) ?? []), r])
  }
}

const GUARD_CODES = new Set(['QUERY_NOT_READ_ONLY', 'QUERY_CONSTRUCT_UNSUPPORTED', 'QUERY_PARSE_ERROR'])
const guardText = (r: any) => (r.guard.ok ? 'admit' : `refuse ${r.guard.reason}`)
const rawText = (x: any) => (x === undefined ? '-' : x.skipped ? 'n/a' : x.ok ? `ok(${x.rows})` : x.sqlstate)
function layerOf(r: any): string {
  const e = r.e2e
  if (e.kind === 'refused') {
    if (GUARD_CODES.has(e.code)) return 'guard'
    const s = e.sqlstate ?? e.code
    if (s === '42501') return 'server role'
    if (s === '25006' || s === '25001') return 'read-only frame'
    return `server ${s}`
  }
  if (e.kind === 'query' || e.kind === 'explain') return 'nothing (ran)'
  return 'error'
}
const outcomeText = (r: any) => {
  const e = r.e2e
  if (e.kind === 'refused') return e.sqlstate ? `QUERY_FAILED ${e.sqlstate}` : e.code.replace('QUERY_', '')
  if (e.kind === 'query') return `rows ${e.rows}${e.truncated ? ' (truncated)' : ''}`
  return e.kind
}
function verdict(r: any): string {
  const L = layerOf(r)
  const fx = [...(r.fx_e2e ?? []), ...(r.fx_R ?? [])]
  if (fx.length > 0) return 'FAIL effect'
  if (r.expected === 'REFUSED_BY_GUARD') return L === 'guard' ? 'ok' : L === 'nothing (ran)' ? 'FAIL ran' : 'GAP (server stopped)'
  if (r.expected === 'RUNS_READ_ONLY') return L === 'nothing (ran)' ? 'ok' : 'over-refused'
  return L === 'nothing (ran)' ? 'FAIL ran' : 'ok'
}
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
const short = (id: string) => {
  const e = corpus.get(id)
  const t = (e.gen ? `${e.sql}` : e.sql).replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮﻿]/g, (c: string) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
  return t.length > 70 ? `${t.slice(0, 67)}...` : t
}

const lines: string[] = []
const tally: Record<string, number> = {}
const rows: string[] = []
const effects: string[] = []
for (const [id, rs] of byId) {
  const e = corpus.get(id)
  const same = (f: (r: any) => string) => new Set(rs.map(f)).size === 1
  const agg = (f: (r: any) => string) => (same(f) ? f(rs[0]) : rs.map((r) => `${r.major}:${f(r)}`).join(' '))
  const v = agg(verdict)
  for (const r of rs) tally[verdict(r)] = (tally[verdict(r)] ?? 0) + 1
  const server = agg((r) => {
    const parts = [`R ${rawText(r.R)}`, `S ${rawText(r.S)}`]
    if (r.Ss) parts.push(`Ss ${rawText(r.Ss)}`)
    if (r.R0) parts.push(`R0 ${rawText(r.R0)}`)
    return parts.join(', ')
  })
  const fx = agg((r) => {
    const a = [...(r.fx_e2e ?? []), ...(r.fx_R ?? [])]
    return a.length === 0 ? 'no' : a.join('+')
  })
  rows.push(
    `| ${id} | ${e.class} | \`${cell(short(id))}\` | ${cell(agg(guardText))} | ${cell(server)} | ${cell(agg(outcomeText))} | ${agg(layerOf)} | ${fx} | ${v} |`,
  )
  for (const r of rs) {
    const wo = ['S', 'Ss', 'R0'].filter((m) => (r[`fx_${m}`] ?? []).length > 0).map((m) => `${m}:${r[`fx_${m}`].join('+')}`)
    if (wo.length > 0) effects.push(`| ${id} | ${r.major} | \`${cell(short(id))}\` | ${wo.join('; ')} |`)
  }
}

lines.push('# D2 results: SQL execution safety (sql_query / sql_explain)')
lines.push('')
lines.push(`Corpus statements run: ${byId.size} (x 3 majors = ${[...byId.values()].reduce((n, r) => n + r.length, 0)} runs); the 15 resource-limit statements and the limit scenarios are in limits.md.`)
lines.push('')
lines.push('Verdict tally (per statement and major): ' + Object.entries(tally).map(([k, n]) => `${k} ${n}`).join(', '))
lines.push('')
lines.push('Columns: guard = `admitRead` on the text the worker would send (`EXPLAIN (FORMAT JSON) ...` for explain). server = the statement WITHOUT the guard: R reader in the read-only frame (extended protocol), S superuser in the frame, Ss superuser in the frame over the simple protocol, R0 reader with no frame (simple protocol); `ok(n)` ran, a SQLSTATE is the server error. outcome/layer = the product path (`executeDataRead` on a real reader session). side effect = snapshot difference after the product run or R. Several majors with different values are listed as `major:value`.')
lines.push('')
lines.push('| id | class | statement | guard | server | outcome | layer | side effect | verdict |')
lines.push('|---|---|---|---|---|---|---|---|---|')
lines.push(...rows)
lines.push('')
lines.push('## Effects of statements run WITHOUT the guard (S, Ss, R0), not product paths')
lines.push('')
lines.push('A superuser or an unframed session changed the fixture. This shows which statements the guard, the extended protocol, the role or the read-only frame each have to stop.')
lines.push('')
lines.push('| id | major | statement | effect |')
lines.push('|---|---|---|---|')
lines.push(...effects)
process.stdout.write(`${lines.join('\n')}\n`)

// Exploratory (NOT a verdict): c1 identity probes, B1, 2026-10-28.
// Run from a checkout of the tree under test after `bun install`:
//   bun --conditions=@exponetdb/source c1-pairs.ts
// The output recorded in c1-pairs.out came from the lead's machine (Bun 1.3.14),
// which is outside the pinned toolchain. The pinned-toolchain run is the verdict.
import { computeBundleDigests } from '@exponetdb/migrations/format'
const enc = new TextEncoder()
const M: any = {
  schema: 'exponetdb.migration/v1', id: '01JB2Z6G8M4Q7R9T1V3W5X7Y9Z', name: 'add-lead-index', description: 'd',
  dependsOn: [], execution: { transactional: true, role: 'owner', searchPath: ['public'] },
  compatibility: { declared: 'additive' }, verification: { expectations: 'auto', runtimeChecks: 'none' },
}
const defs = { role: 'owner', searchPath: ['public'] }
const c = (up: string, m: any = M, dd: any = defs) => {
  const r = computeBundleDigests({ manifest: m, projectDefaults: dd, files: { 'up.sql': enc.encode(up) } })
  return r.ok ? r.value.checksum.slice(10, 22) : 'ERR:' + JSON.stringify(r.error)
}
const wm = (f: (m: any) => void) => { const m = structuredClone(M); f(m); return m }
function pair(name: string, a: string, b: string) { console.log((a === b ? 'SAME ' : 'DIFF ') + name) }
pair('comment-only: "(a int,b text)" -> "(a int,/*c*/b text)"', c('CREATE TABLE t (a int,b text);'), c('CREATE TABLE t (a int,/*c*/b text);'))
pair('comment-only: "a int, b" -> "a int,/*c*/ b" (space already there)', c('CREATE TABLE t (a int, b text);'), c('CREATE TABLE t (a int,/*c*/ b text);'))
pair('comment-only at line end: "x -- c" ', c('SELECT 1;\nSELECT 2;'), c('SELECT 1; -- c\nSELECT 2;'))
pair('comment-only trailing comment w/o newline sep: "SELECT 1;SELECT 2;" -> "SELECT 1;--c\\nSELECT 2;"', c('SELECT 1;SELECT 2;'), c('SELECT 1;--c\nSELECT 2;'))
pair('whitespace-only: newline between statements added (";SELECT" -> ";\\nSELECT")', c('SELECT 1;SELECT 2;'), c('SELECT 1;\nSELECT 2;'))
pair('whitespace-only: run width "a  b" vs "a b"', c('SELECT  1;'), c('SELECT 1;'))
pair('whitespace-only: indentation reflow of multi-line stmt', c('CREATE TABLE t (\n  a int,\n  b text\n);'), c('CREATE TABLE t (\na int,\nb text\n);'))
pair('whitespace-only: prettier-style "( a int )" vs "(a int)"', c('CREATE TABLE t ( a int );'), c('CREATE TABLE t (a int);'))
pair('trailing newline', c('SELECT 1;\n'), c('SELECT 1;'))
pair('CRLF vs LF in multi-line string literal', c("SELECT 'a\nb';"), c("SELECT 'a\r\nb';"))
pair('CRLF vs LF in dollar-quoted body', c("DO $$ a\nb $$;"), c("DO $$ a\r\nb $$;"))
pair('keyword case', c('select 1;'), c('SELECT 1;'))
pair('quoted vs unquoted identifier "t" vs t', c('SELECT * FROM t;'), c('SELECT * FROM "t";'))
pair('dependsOn order', c('SELECT 1;', wm(m=>m.dependsOn=['01JB2YX7M3K5N7Q9S1V3W5Y7A8','01JB2YX7M3K5N7Q9S1V3W5Y7A9'])), c('SELECT 1;', wm(m=>m.dependsOn=['01JB2YX7M3K5N7Q9S1V3W5Y7A9','01JB2YX7M3K5N7Q9S1V3W5Y7A8'])))
pair('dependsOn duplicate', c('SELECT 1;', wm(m=>m.dependsOn=['01JB2YX7M3K5N7Q9S1V3W5Y7A8'])), c('SELECT 1;', wm(m=>m.dependsOn=['01JB2YX7M3K5N7Q9S1V3W5Y7A8','01JB2YX7M3K5N7Q9S1V3W5Y7A8'])))
pair('explicit execution.role=owner vs default role owner', c('SELECT 1;'), c('SELECT 1;', wm(m=>delete m.execution.role)))
pair('explicit lockTimeout 5s vs engine default', c('SELECT 1;'), c('SELECT 1;', wm(m=>m.execution.lockTimeout='5s')))
pair('1m vs 60s', c('SELECT 1;', wm(m=>m.execution.lockTimeout='1m')), c('SELECT 1;', wm(m=>m.execution.lockTimeout='60s')))
pair('PROJECT default lockTimeout 5s(absent) vs 10s, manifest silent', c('SELECT 1;'), c('SELECT 1;', M, { ...defs, lockTimeout: '10s' }))
pair('PROJECT default statementTimeout absent vs 15m (=engine)', c('SELECT 1;'), c('SELECT 1;', M, { ...defs, statementTimeout: '15m' }))
pair('PROJECT default searchPath [public] vs [public,extensions], manifest silent', c('SELECT 1;', wm(m=>delete m.execution.searchPath), defs), c('SELECT 1;', wm(m=>delete m.execution.searchPath), {role:'owner',searchPath:['public','extensions']}))
pair('YAML: key order / quoting not hashed (same JSON)', c('SELECT 1;'), c('SELECT 1;', { ...M, execution: { searchPath: ['public'], role: 'owner', transactional: true } }))
pair('unknown extra manifest key', c('SELECT 1;'), c('SELECT 1;', wm(m=>m.typo=1)))
pair('NFC vs NFD in line comment (comment dropped)', c('SELECT 1; -- é'), c('SELECT 1; -- é'))
pair('NFC vs NFD in identifier', c('SELECT é;'), c('SELECT é;'))
pair('semicolon ";" vs ";;"', c('SELECT 1;'), c('SELECT 1;;'))
pair('trailing ";" absent', c('SELECT 1;'), c('SELECT 1'))

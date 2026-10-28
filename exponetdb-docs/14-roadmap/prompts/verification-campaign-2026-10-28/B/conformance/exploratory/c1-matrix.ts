// Exploratory (NOT a verdict): the first, unpaired c1 matrix (each variant against one base). Superseded by c1-pairs.ts
// where the two disagree: the "vs" rows of the matrix compare against the base, not against each other.
import { computeBundleDigests } from '@exponetdb/migrations/format'
const enc = new TextEncoder()
const baseManifest: any = {
  schema: 'exponetdb.migration/v1',
  id: '01JB2Z6G8M4Q7R9T1V3W5X7Y9Z',
  name: 'add-lead-index',
  description: 'd',
  dependsOn: [],
  execution: { transactional: true, role: 'owner', searchPath: ['public'] },
  compatibility: { declared: 'additive' },
  verification: { expectations: 'auto', runtimeChecks: 'none' },
}
const defaults = { role: 'owner', searchPath: ['public'] }
function d(up: string | Uint8Array, manifest: any = baseManifest, defs: any = defaults, extra: any = {}) {
  const r = computeBundleDigests({
    manifest, projectDefaults: defs,
    files: { 'up.sql': typeof up === 'string' ? enc.encode(up) : up, ...extra },
  })
  if (!r.ok) return { err: JSON.stringify(r.error) } as any
  return r.value
}
const base = "CREATE TABLE t (a int, b text);\nINSERT INTO t VALUES (1, 'x');\n"
const B = d(base)
function cmp(name: string, v: any) {
  if (v.err) { console.log(name.padEnd(62), 'REFUSED', v.err); return }
  console.log(name.padEnd(62),
    'checksum', v.checksum === B.checksum ? 'SAME ' : 'DIFF ',
    'source', v.sourceDigest === B.sourceDigest ? 'same' : 'diff',
    'bundle', v.bundleDigest === B.bundleDigest ? 'same' : 'diff')
}
console.log('base checksum', B.checksum)
cmp('comment appended at end', d(base + '-- note\n'))
cmp('comment on own line between statements', d("CREATE TABLE t (a int, b text);\n-- note\nINSERT INTO t VALUES (1, 'x');\n"))
cmp('block comment after a space already present', d("CREATE TABLE t (a int, /*c*/ b text);\nINSERT INTO t VALUES (1, 'x');\n"))
cmp('block comment between ADJACENT tokens (a,b)->(a,/*c*/b)', d("CREATE TABLE t (a int,b text);\nINSERT INTO t VALUES (1, 'x');\n"))
cmp('   vs: comment inserted into "(a int,b text)" variant', d("CREATE TABLE t (a int,/*c*/b text);\nINSERT INTO t VALUES (1, 'x');\n"))
cmp('double spaces / tabs (runs collapse)', d("CREATE   TABLE\tt (a int,   b text);\n\n\nINSERT INTO t VALUES (1, 'x');"))
cmp('NO trailing newline', d(base.trimEnd()))
cmp('leading blank lines + trailing blank lines', d('\n\n' + base + '\n\n'))
cmp('space removed: (a int, b text) -> (a int,b text)', d("CREATE TABLE t (a int,b text);\nINSERT INTO t VALUES (1, 'x');\n"))
cmp('space added: ";" -> " ;"', d("CREATE TABLE t (a int, b text) ;\nINSERT INTO t VALUES (1, 'x');\n"))
cmp('newline added after ";" is run -> same? (; NL INSERT)', d("CREATE TABLE t (a int, b text);INSERT INTO t VALUES (1, 'x');\n"))
cmp('CRLF line endings', d(base.replaceAll('\n', '\r\n')))
cmp('lone CR line endings', d(base.replaceAll('\n', '\r')))
cmp('BOM prefix', d('﻿' + base))
cmp('NUL byte', d(base + '\u0000'))
cmp('invalid UTF-8 (0xC3 0x28)', d(new Uint8Array([0x43, 0xc3, 0x28])))
cmp('keyword case: create table', d("create table t (a int, b text);\ninsert into t values (1, 'x');\n"))
cmp('identifier case t -> T (unquoted)', d("CREATE TABLE T (a int, b text);\nINSERT INTO T VALUES (1, 'x');\n"))
cmp('string literal changed x -> y', d("CREATE TABLE t (a int, b text);\nINSERT INTO t VALUES (1, 'y');\n"))
cmp("whitespace INSIDE string literal 'x' -> 'x '", d("CREATE TABLE t (a int, b text);\nINSERT INTO t VALUES (1, 'x ');\n"))
cmp('statement order swapped', d("INSERT INTO t VALUES (1, 'x');\nCREATE TABLE t (a int, b text);\n"))
cmp('trailing semicolon dropped on last statement', d("CREATE TABLE t (a int, b text);\nINSERT INTO t VALUES (1, 'x')\n"))
cmp('extra empty statement ";;"', d("CREATE TABLE t (a int, b text);;\nINSERT INTO t VALUES (1, 'x');\n"))
cmp('comment inside dollar-quoted body (kept)', d("DO $$ BEGIN -- hi\n NULL; END $$;\n"))
cmp('   same without comment', d("DO $$ BEGIN \n NULL; END $$;\n"))
cmp('NFC vs NFD in literal: é U+00E9 vs e+U+0301',
  d("INSERT INTO t VALUES ('é');"))
cmp('   NFD form', d("INSERT INTO t VALUES ('é');"))
cmp('nested block comment', d(base + '/* a /* b */ c */'))
cmp('line comment w/ unicode LS U+2028 (not newline in PG)', d(base + '-- x y\n'))
cmp('NBSP U+00A0 between tokens (ident char in PG!)', d("CREATE TABLE t (a int, b text);\nINSERT INTO t VALUES (1, 'x');\n"))
// manifest classes
const withM = (mut: (m: any) => void) => { const m = structuredClone(baseManifest); mut(m); return m }
console.log('--- manifest fields (up.sql identical)')
cmp('description changed', d(base, withM(m => m.description = 'other')))
cmp('name changed (also dir)', d(base, withM(m => m.name = 'other-name')))
cmp('compatibility.notes added', d(base, withM(m => { m.compatibility.notes = 'n' })))
cmp('compatibility.declared additive->destructive', d(base, withM(m => { m.compatibility.declared = 'destructive'; m.compatibility.notes = 'n' })))
cmp('source.authors added', d(base, withM(m => { m.source = { authors: ['author-1'] } })))
cmp('dependsOn reordered (2 entries)', d(base, withM(m => m.dependsOn = ['01JB2YX7M3K5N7Q9S1V3W5Y7A9', '01JB2YX7M3K5N7Q9S1V3W5Y7A8'])))
cmp('  vs original order', d(base, withM(m => m.dependsOn = ['01JB2YX7M3K5N7Q9S1V3W5Y7A8', '01JB2YX7M3K5N7Q9S1V3W5Y7A9'])))
cmp('dependsOn duplicate entry removed', d(base, withM(m => m.dependsOn = ['01JB2YX7M3K5N7Q9S1V3W5Y7A8'])))
cmp('  duplicate present', d(base, withM(m => m.dependsOn = ['01JB2YX7M3K5N7Q9S1V3W5Y7A8','01JB2YX7M3K5N7Q9S1V3W5Y7A8'])))
cmp('lockTimeout 5s explicit (= engine default 5000ms)', d(base, withM(m => m.execution.lockTimeout = '5s')))
cmp('lockTimeout 5000ms explicit', d(base, withM(m => m.execution.lockTimeout = '5000ms')))
cmp('lockTimeout 10s', d(base, withM(m => m.execution.lockTimeout = '10s')))
cmp('statementTimeout 15m explicit (= engine default)', d(base, withM(m => m.execution.statementTimeout = '15m')))
cmp('transactional false', d(base, withM(m => m.execution.transactional = false)))
cmp('searchPath [public, extensions]', d(base, withM(m => m.execution.searchPath = ['public','extensions'])))
cmp('verification.expectations none', d(base, withM(m => m.verification.expectations = 'none')))
cmp('rollback block added (no down.sql file)', d(base, withM(m => m.rollback = { script: 'none' })))
cmp('requires.postgres added', d(base, withM(m => m.requires = { postgres: '>=16' })))
console.log('--- PROJECT DEFAULTS (not part of bundle!)')
cmp('same bundle, project default lockTimeout 10s', d(base, baseManifest, { ...defaults, lockTimeout: '10s' }))
cmp('same bundle, project default statementTimeout 30m', d(base, baseManifest, { ...defaults, statementTimeout: '30m' }))
cmp('same bundle, manifest w/o role, default role "owner" (explicit in manifest is same)', d(base, withM(m => { delete m.execution.role }), defaults))
cmp('same bundle, manifest w/o role, default role "admin"', d(base, withM(m => { delete m.execution.role }), { role: 'admin', searchPath: ['public'] }))
console.log('--- verify/rollback digests')
const V1 = d(base, withM(m => { m.verification.runtimeChecks = 'verify.sql' }), defaults, { 'verify.sql': enc.encode('-- check: a\nSELECT true AS ok;\n') })
const V2 = d(base, withM(m => { m.verification.runtimeChecks = 'verify.sql' }), defaults, { 'verify.sql': enc.encode('-- check: a\nSELECT true AS ok; -- c\n') })
const V3 = d(base, withM(m => { m.verification.runtimeChecks = 'verify.sql' }), defaults, { 'verify.sql': enc.encode('-- check: a\r\nSELECT true AS ok;\r\n') })
console.log('verify comment appended: verifyDigest', V1.verifyDigest === V2.verifyDigest ? 'same' : 'DIFF', ' checksum', V1.checksum === V2.checksum ? 'same' : 'DIFF', 'bundleDigest', V1.bundleDigest === V2.bundleDigest ? 'same':'DIFF')
console.log('verify CRLF:             verifyDigest', V1.verifyDigest === V3.verifyDigest ? 'same' : 'DIFF')

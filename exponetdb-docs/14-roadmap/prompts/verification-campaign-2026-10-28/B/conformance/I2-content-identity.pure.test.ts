// I2 Content identity: the apply checksum (c1) changes if and only if the executable text of up.sql
// or an execution field of the manifest changes. Compared edit class by edit class with
// exponetdb-docs/04-migrations/migration-bundles.md §2 (field table), §3 (N1..N7) and §7 (edge cases).
//
// Case kinds
//   doc:  the documentation states the outcome; the assertion is the documentation.
//   char: the documentation is silent or ambiguous; the assertion pins the OBSERVED outcome so that
//         a change is noticed (each is listed as an ambiguity in RESULTS.md / decisions-B2.md).
import fc from 'fast-check'
import { stringify } from 'yaml'
import { describe, expect, test } from 'vitest'
import { validateBundle, type BundleInput } from '@exponetdb/migrations/format'
import { enc, mk, ulidOf, PROJECT_DEFAULTS, type Spec } from './lib/bundle.ts'

type Rel = 'same' | 'diff'
interface Expect {
  checksum: Rel
  verify?: Rel
  rollback?: Rel
  source?: Rel
}

function run(input: BundleInput | Spec) {
  const i = 'files' in input ? input : mk(input)
  return validateBundle(i)
}
function rel(a: string | null, b: string | null): Rel {
  return a === b ? 'same' : 'diff'
}

const PRE = 'CREATE TABLE public.t (id int, note text DEFAULT '
const LIT = "'a b'"
const BASE_UP = `${PRE}${LIT});\n`
const base: Spec = { up: BASE_UP, verify: 'SELECT true AS ok;\n', down: 'DROP TABLE public.t;\n' }
const bytes = (s: string) => enc(s)

interface Case {
  id: string
  title: string
  kind: 'doc' | 'char'
  ref: string
  a?: Spec | BundleInput
  b: Spec | BundleInput
  expect: Expect | 'refused'
  reason?: string
}

const mkYaml = (obj: unknown) => stringify(obj, { lineWidth: 0 })
const id = ulidOf(1)
function manifestObject(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'exponetdb.migration/v1',
    id,
    name: 'change',
    description: 'A change of the conformance suite.',
    dependsOn: [ulidOf(4), ulidOf(5)],
    execution: {
      transactional: true,
      lockTimeout: '5s',
      statementTimeout: '15m',
      role: 'owner',
      searchPath: ['public'],
    },
    requires: { postgres: '>=16 <19', extensions: [{ name: 'pg_trgm' }, { name: 'vector', version: '>=0.7.0' }] },
    compatibility: { declared: 'additive' },
    verification: { expectations: 'auto', runtimeChecks: 'verify.sql' },
    rollback: { script: 'down.sql', safety: 'safe', notes: 'reviewed' },
    source: { authors: ['a@example.invalid'], ticket: 'T-1' },
    ...extra,
  }
}
function withManifest(obj: Record<string, unknown>): Spec {
  return { ...base, yaml: mkYaml(obj) }
}
const m0 = manifestObject()
function edit(path: string[], value: unknown): Record<string, unknown> {
  const copy = structuredClone(m0) as Record<string, any>
  let cur = copy
  for (const p of path.slice(0, -1)) cur = cur[p]
  const last = path.at(-1) as string
  if (value === undefined) delete cur[last]
  else cur[last] = value
  return copy
}

const SQL = (s: string): Spec => ({ ...base, up: s })
const FN = 'CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\n'

const cases: Case[] = [
  // ---- SQL text: comments and whitespace (N4/N5, §7) ----
  { id: 'sql-comment-line', title: 'line comment added outside literals', kind: 'doc', ref: '§3 N5, §7', b: SQL('-- note\n' + BASE_UP), expect: { checksum: 'same', source: 'diff', verify: 'same', rollback: 'same' } },
  { id: 'sql-comment-block', title: 'block comment added between tokens', kind: 'doc', ref: '§3 N5', b: SQL(BASE_UP.replace('(id', '/* x */ (id')), expect: { checksum: 'same', source: 'diff' } },
  { id: 'sql-comment-nested', title: 'nested block comment', kind: 'doc', ref: '§3 N4 R2', b: SQL('/* a /* b */ c */' + BASE_UP), expect: { checksum: 'same', source: 'diff' } },
  { id: 'sql-comment-in-function-body', title: 'comment edited inside a dollar-quoted body', kind: 'doc', ref: '§7', a: SQL(FN), b: SQL(FN.replace('SELECT 1', 'SELECT 1 -- x\n')), expect: { checksum: 'diff' } },
  { id: 'sql-comment-in-string', title: 'comment marker inside a string literal is content', kind: 'doc', ref: '§3 N4', a: SQL("SELECT '-- a';"), b: SQL("SELECT '-- b';"), expect: { checksum: 'diff' } },
  { id: 'sql-ws-collapse', title: 'extra spaces, tabs and newlines between tokens', kind: 'doc', ref: '§3 N5', b: SQL(PRE.replace(/ /g, ' \t \n ') + LIT + ');\n'), expect: { checksum: 'same', source: 'diff' } },
  { id: 'sql-ws-vt-ff', title: 'VT and FF count as whitespace', kind: 'doc', ref: '§3 N3', a: SQL('SELECT 1;'), b: SQL('SELECT\u000b\u000c1;'), expect: { checksum: 'same' } },
  { id: 'sql-ws-nbsp', title: 'U+00A0 is an identifier character, not whitespace', kind: 'doc', ref: '§3 N3', a: SQL('SELECT 1;'), b: SQL('SELECT 1;'), expect: { checksum: 'diff' } },
  { id: 'sql-ws-leading-trailing', title: 'leading and trailing whitespace and newline', kind: 'doc', ref: '§3 N5', b: SQL('\n\n  ' + BASE_UP.trimEnd() + '   \n\n\n'), expect: { checksum: 'same' } },
  { id: 'sql-trailing-newline-removed', title: 'trailing newline removed', kind: 'doc', ref: '§3 N5', b: SQL(BASE_UP.trimEnd()), expect: { checksum: 'same' } },
  { id: 'sql-ws-in-string', title: 'trailing spaces inside a string literal', kind: 'doc', ref: '§3 N4/N5', b: SQL(BASE_UP.replace("'a b'", "'a b  '")), expect: { checksum: 'diff' } },
  { id: 'sql-ws-in-qident', title: 'whitespace inside a quoted identifier', kind: 'doc', ref: '§3 N4 R8', a: SQL('CREATE TABLE "a b" (i int);'), b: SQL('CREATE TABLE "a  b" (i int);'), expect: { checksum: 'diff' } },
  { id: 'sql-tab-in-string', title: 'tab vs space inside a string literal', kind: 'doc', ref: '§3 N5', a: SQL("SELECT 'a b';"), b: SQL("SELECT 'a\tb';"), expect: { checksum: 'diff' } },
  { id: 'sql-tab-outside', title: 'tabs instead of spaces outside literals', kind: 'doc', ref: '§3 N5', b: SQL(PRE.replace(/ /g, '\t') + LIT + ');\n'), expect: { checksum: 'same' } },
  { id: 'sql-comment-instead-of-space', title: 'comment between two tokens equals one space (foo/**/bar)', kind: 'doc', ref: '§3 N5', a: SQL('SELECT 1 AS foo;'), b: SQL('SELECT 1/**/AS/**/foo;'), expect: { checksum: 'same' } },
  { id: 'sql-minus-comment-minus', title: '-/**/- stays two minus signs', kind: 'doc', ref: '§3 N5', a: SQL('SELECT - -1;'), b: SQL('SELECT -/**/-1;'), expect: { checksum: 'same' } },
  { id: 'sql-string-continuation', title: 'string continuation across a newline is one token', kind: 'doc', ref: '§3 N4', a: SQL("SELECT 'a'\n'b';"), b: SQL("SELECT 'a'\n  'b';"), expect: { checksum: 'diff' }, reason: 'whitespace inside a continued literal token is copied unchanged' },
  // ---- line endings, BOM, encoding ----
  { id: 'eol-crlf', title: 'CRLF checkout instead of LF', kind: 'doc', ref: '§3 N2, §7', b: SQL(BASE_UP.replaceAll('\n', '\r\n')), expect: { checksum: 'same', source: 'same' } },
  { id: 'eol-cr', title: 'lone CR line endings', kind: 'doc', ref: '§3 N2', b: SQL(BASE_UP.replaceAll('\n', '\r')), expect: { checksum: 'same', source: 'same' } },
  { id: 'eol-crlf-in-literal', title: 'CRLF vs LF inside a string literal', kind: 'doc', ref: '§3 N2 (also inside literals)', a: SQL("SELECT 'a\nb';"), b: SQL("SELECT 'a\r\nb';"), expect: { checksum: 'same', source: 'same' } },
  { id: 'eol-mixed-line-comment', title: 'CR ends a line comment after normalisation', kind: 'doc', ref: '§3 N2', a: SQL('-- c\nSELECT 1;'), b: SQL('-- c\rSELECT 1;'), expect: { checksum: 'same' } },
  { id: 'bom-up', title: 'BOM at the start of up.sql', kind: 'doc', ref: '§1, §3 N1, §7', b: { ...base, up: new Uint8Array([0xef, 0xbb, 0xbf, ...enc(BASE_UP)]) }, expect: 'refused', reason: 'bom' },
  { id: 'bom-verify', title: 'BOM at the start of verify.sql', kind: 'doc', ref: '§1, §3 N1', b: { ...base, verify: new Uint8Array([0xef, 0xbb, 0xbf, ...enc('SELECT true AS ok;')]) }, expect: 'refused', reason: 'bom' },
  { id: 'bom-down', title: 'BOM at the start of down.sql', kind: 'doc', ref: '§1, §3 N1', b: { ...base, down: new Uint8Array([0xef, 0xbb, 0xbf, ...enc('DROP TABLE t;')]) }, expect: 'refused', reason: 'bom' },
  { id: 'bom-manifest', title: 'BOM at the start of migration.yaml', kind: 'doc', ref: '§1', b: { ...base, yaml: new Uint8Array([0xef, 0xbb, 0xbf, ...enc(mkYaml(m0))]) }, expect: 'refused', reason: 'bom' },
  { id: 'bom-inside', title: 'U+FEFF elsewhere is an ordinary character', kind: 'doc', ref: '§3 N1.2', a: SQL('SELECT 1;'), b: SQL('SELECT 1;﻿'), expect: { checksum: 'diff' } },
  { id: 'nul', title: 'NUL byte in up.sql', kind: 'doc', ref: '§1, §3 N1.3', b: { ...base, up: new Uint8Array([...enc('SELECT 1;'), 0]) }, expect: 'refused', reason: 'nul' },
  { id: 'bad-utf8', title: 'invalid UTF-8 in up.sql', kind: 'doc', ref: '§1, §3 N1.1', b: { ...base, up: new Uint8Array([...enc('SELECT '), 0xc3, 0x28]) }, expect: 'refused', reason: 'invalid_utf8' },
  { id: 'overlong-utf8', title: 'overlong UTF-8 encoding of "/"', kind: 'doc', ref: '§3 N1.1', b: { ...base, up: new Uint8Array([...enc('SELECT 1 '), 0xc0, 0xaf]) }, expect: 'refused', reason: 'invalid_utf8' },
  { id: 'surrogate-utf8', title: 'CESU-8 surrogate in up.sql', kind: 'doc', ref: '§3 N1.1', b: { ...base, up: new Uint8Array([...enc('SELECT '), 0xed, 0xa0, 0x80]) }, expect: 'refused', reason: 'invalid_utf8' },
  // ---- executable change ----
  { id: 'sql-literal-change', title: 'string literal changed', kind: 'doc', ref: '§3', b: SQL(BASE_UP.replace("'a b'", "'a c'")), expect: { checksum: 'diff' } },
  { id: 'sql-keyword-case', title: 'keyword case (CREATE TABLE -> create table)', kind: 'doc', ref: '§3 N5 (no case folding)', b: SQL(BASE_UP.replace('CREATE TABLE', 'create table')), expect: { checksum: 'diff' } },
  { id: 'sql-identifier-case', title: 'unquoted identifier case', kind: 'doc', ref: '§3 N5 (no case folding)', b: SQL(BASE_UP.replace('public.t', 'PUBLIC.T')), expect: { checksum: 'diff' } },
  { id: 'sql-order', title: 'statement order swapped', kind: 'doc', ref: '§3', a: SQL('CREATE TABLE a (i int); CREATE TABLE b (i int);'), b: SQL('CREATE TABLE b (i int); CREATE TABLE a (i int);'), expect: { checksum: 'diff' } },
  { id: 'sql-unicode-nfc-nfd-ident', title: 'NFC vs NFD in a quoted identifier', kind: 'doc', ref: '§3 N5 (no Unicode normalization)', a: SQL('CREATE TABLE "café" (i int);'), b: SQL('CREATE TABLE "café" (i int);'), expect: { checksum: 'diff' } },
  { id: 'sql-unicode-nfc-nfd-unquoted', title: 'NFC vs NFD in an unquoted identifier', kind: 'doc', ref: '§3 N5', a: SQL('CREATE TABLE café (i int);'), b: SQL('CREATE TABLE café (i int);'), expect: { checksum: 'diff' } },
  { id: 'sql-unicode-nfc-nfd-string', title: 'NFC vs NFD in a string literal', kind: 'doc', ref: '§3 N5', a: SQL("SELECT 'café';"), b: SQL("SELECT 'café';"), expect: { checksum: 'diff' } },
  { id: 'sql-dollar-tag', title: 'dollar-quote tag renamed ($$ -> $f$) with the same body', kind: 'char', ref: '§3 N4 R9', a: SQL(FN), b: SQL(FN.replaceAll('$$', '$f$')), expect: { checksum: 'diff' }, reason: 'tags are copied verbatim: a purely cosmetic edit that PostgreSQL ignores is drift' },
  { id: 'sql-extra-semicolon', title: 'extra empty statement (;;)', kind: 'char', ref: '§3', a: SQL('SELECT 1;'), b: SQL('SELECT 1;;'), expect: { checksum: 'diff' }, reason: 'an empty statement is executable text for c1 although PostgreSQL ignores it' },
  { id: 'sql-missing-final-semicolon', title: 'final semicolon removed', kind: 'char', ref: '§3', a: SQL('SELECT 1;'), b: SQL('SELECT 1'), expect: { checksum: 'diff' } },
  { id: 'sql-paren-space', title: 'space removed between tokens: "f (x)" vs "f(x)"', kind: 'char', ref: '§3 N5', a: SQL('SELECT abs (1);'), b: SQL('SELECT abs(1);'), expect: { checksum: 'diff' }, reason: 'whitespace is collapsed to one space but never removed: spacing around punctuation is still identity' },
  { id: 'sql-semicolon-only', title: 'up.sql that is a single semicolon', kind: 'char', ref: '§7 (empty / no_statements)', b: SQL(';'), expect: { checksum: 'diff' }, reason: 'accepted by validateBundle; see lint/plan tests for what happens next' },
  // ---- verify.sql / down.sql ----
  { id: 'verify-comment', title: 'comment edited in verify.sql', kind: 'doc', ref: '§3 table, N6', b: { ...base, verify: '-- check: x\nSELECT true AS ok;\n' }, expect: { checksum: 'same', verify: 'diff', rollback: 'same' } },
  { id: 'verify-whitespace', title: 'whitespace edited in verify.sql', kind: 'doc', ref: '§3 pre-G1 correction', b: { ...base, verify: 'SELECT  true  AS ok;\n' }, expect: { checksum: 'same', verify: 'diff' } },
  { id: 'verify-crlf', title: 'CRLF in verify.sql', kind: 'doc', ref: '§3 N2', b: { ...base, verify: 'SELECT true AS ok;\r\n' }, expect: { checksum: 'same', verify: 'same' } },
  { id: 'down-comment', title: 'comment edited in down.sql', kind: 'doc', ref: '§3 table', b: { ...base, down: '-- why\nDROP TABLE public.t;\n' }, expect: { checksum: 'same', verify: 'same', rollback: 'same' } },
  { id: 'down-code', title: 'code edited in down.sql', kind: 'doc', ref: '§3 table', b: { ...base, down: 'DROP TABLE public.t CASCADE;\n' }, expect: { checksum: 'same', verify: 'same', rollback: 'diff' } },
  // ---- manifest: execution fields vs metadata ----
  { id: 'm-description', title: 'description edited', kind: 'doc', ref: '§2 table', a: withManifest(m0), b: withManifest(edit(['description'], 'other text')), expect: { checksum: 'same', verify: 'same', rollback: 'same' } },
  { id: 'm-source', title: 'source.authors / ticket edited', kind: 'doc', ref: '§2 table', a: withManifest(m0), b: withManifest(edit(['source'], { authors: ['b@example.invalid'], ticket: 'T-2' })), expect: { checksum: 'same', verify: 'same', rollback: 'same' } },
  { id: 'm-source-removed', title: 'source block removed', kind: 'doc', ref: '§2 table', a: withManifest(m0), b: withManifest(edit(['source'], undefined)), expect: { checksum: 'same' } },
  { id: 'm-compat-notes', title: 'compatibility.notes edited', kind: 'doc', ref: '§2 table', a: withManifest(edit(['compatibility'], { declared: 'destructive', notes: 'one' })), b: withManifest(edit(['compatibility'], { declared: 'destructive', notes: 'two' })), expect: { checksum: 'same' } },
  { id: 'm-compat-declared', title: 'compatibility.declared changed', kind: 'doc', ref: '§2 table', a: withManifest(m0), b: withManifest(edit(['compatibility'], { declared: 'destructive', notes: 'x' })), expect: { checksum: 'diff' } },
  { id: 'm-dependsOn-edit', title: 'dependsOn gains an entry', kind: 'doc', ref: '§7', a: withManifest(m0), b: withManifest(edit(['dependsOn'], [ulidOf(4), ulidOf(5), ulidOf(6)])), expect: { checksum: 'diff' } },
  { id: 'm-dependsOn-order', title: 'dependsOn order', kind: 'doc', ref: '§3 item 2 (sorted)', a: withManifest(m0), b: withManifest(edit(['dependsOn'], [ulidOf(5), ulidOf(4)])), expect: { checksum: 'same' } },
  { id: 'm-dependsOn-dup', title: 'dependsOn duplicate entry', kind: 'doc', ref: '§2 (duplicates removed)', a: withManifest(m0), b: withManifest(edit(['dependsOn'], [ulidOf(4), ulidOf(4), ulidOf(5)])), expect: { checksum: 'same' } },
  { id: 'm-transactional', title: 'execution.transactional toggled', kind: 'doc', ref: '§2 table', a: withManifest(m0), b: withManifest(edit(['execution', 'transactional'], false)), expect: { checksum: 'diff' } },
  { id: 'm-lockTimeout', title: 'execution.lockTimeout changed', kind: 'doc', ref: '§2 table', a: withManifest(m0), b: withManifest(edit(['execution', 'lockTimeout'], '6s')), expect: { checksum: 'diff' } },
  { id: 'm-statementTimeout', title: 'execution.statementTimeout changed', kind: 'doc', ref: '§2 table', a: withManifest(m0), b: withManifest(edit(['execution', 'statementTimeout'], '16m')), expect: { checksum: 'diff' } },
  { id: 'm-duration-notation', title: 'statementTimeout 90s vs 1m30s', kind: 'doc', ref: '§3 item 2 (ms)', a: withManifest(edit(['execution', 'statementTimeout'], '90s')), b: withManifest(edit(['execution', 'statementTimeout'], '1m30s')), expect: { checksum: 'same' } },
  { id: 'm-duration-ms', title: 'lockTimeout 5s vs 5000ms', kind: 'doc', ref: '§3 item 2 (ms)', a: withManifest(m0), b: withManifest(edit(['execution', 'lockTimeout'], '5000ms')), expect: { checksum: 'same' } },
  { id: 'm-default-materialized', title: 'explicit lockTimeout equal to the project default vs omitted', kind: 'doc', ref: '§3 item 2 (defaults materialized)', a: withManifest(m0), b: withManifest(edit(['execution', 'lockTimeout'], undefined)), expect: { checksum: 'same' } },
  { id: 'm-role', title: 'execution.role changed', kind: 'doc', ref: '§2 table', a: withManifest(m0), b: withManifest(edit(['execution', 'role'], 'other')), expect: { checksum: 'diff' } },
  { id: 'm-searchPath', title: 'execution.searchPath changed', kind: 'doc', ref: '§2 table', a: withManifest(m0), b: withManifest(edit(['execution', 'searchPath'], ['public', 'extra'])), expect: { checksum: 'diff' } },
  { id: 'm-searchPath-order', title: 'execution.searchPath order', kind: 'doc', ref: '§3 N7 (order kept)', a: withManifest(edit(['execution', 'searchPath'], ['a', 'b'])), b: withManifest(edit(['execution', 'searchPath'], ['b', 'a'])), expect: { checksum: 'diff' } },
  { id: 'm-requires-postgres', title: 'requires.postgres changed', kind: 'doc', ref: '§2 table', a: withManifest(m0), b: withManifest(edit(['requires', 'postgres'], '>=17 <19')), expect: { checksum: 'diff' } },
  { id: 'm-requires-postgres-spelling', title: 'requires.postgres: same range spelled differently', kind: 'char', ref: '§3 N7 ("the string as written")', a: withManifest(m0), b: withManifest(edit(['requires', 'postgres'], '<19 >=16')), expect: { checksum: 'diff' }, reason: 'an equivalent range written differently is a different identity (a false MIGRATION_CHECKSUM_MISMATCH after apply)' },
  { id: 'm-requires-ext-order', title: 'requires.extensions order', kind: 'doc', ref: '§3 item 2 (sorted by name)', a: withManifest(m0), b: withManifest(edit(['requires', 'extensions'], [{ name: 'vector', version: '>=0.7.0' }, { name: 'pg_trgm' }])), expect: { checksum: 'same' } },
  { id: 'm-requires-ext-version', title: 'requires.extensions version changed', kind: 'doc', ref: '§2 table', a: withManifest(m0), b: withManifest(edit(['requires', 'extensions'], [{ name: 'pg_trgm' }, { name: 'vector', version: '>=0.8.0' }])), expect: { checksum: 'diff' } },
  { id: 'm-requires-absent', title: 'requires block removed vs empty', kind: 'char', ref: '§3 N7', a: withManifest(edit(['requires'], { extensions: [] })), b: withManifest(edit(['requires'], undefined)), expect: { checksum: 'same' } },
  { id: 'm-verification', title: 'verification.expectations auto -> none', kind: 'doc', ref: '§2 table (verify digest)', a: withManifest(m0), b: withManifest(edit(['verification', 'expectations'], 'none')), expect: { checksum: 'same', verify: 'diff', rollback: 'same' } },
  { id: 'm-rollback-safety', title: 'rollback.safety safe -> lossy', kind: 'doc', ref: '§2 table (rollback digest)', a: withManifest(m0), b: withManifest(edit(['rollback', 'safety'], 'lossy')), expect: { checksum: 'same', verify: 'same', rollback: 'diff' } },
  { id: 'm-rollback-notes', title: 'rollback.notes edited', kind: 'doc', ref: '§2 table', a: withManifest(m0), b: withManifest(edit(['rollback', 'notes'], 'changed')), expect: { checksum: 'same', rollback: 'diff' } },
  { id: 'm-schema-id', title: 'migration id changed (directory renamed with it)', kind: 'doc', ref: '§3', a: mk(withManifest(m0)), b: (() => { const o = manifestObject({ id: ulidOf(2) }); return mk({ ...withManifest(o), id: ulidOf(2) }) })(), expect: { checksum: 'diff' } },
  { id: 'm-name', title: 'name changed with the directory', kind: 'doc', ref: '§2 table, §7', a: mk(withManifest(m0)), b: mk({ ...withManifest(edit(['name'], 'renamed')), name: 'renamed' }), expect: { checksum: 'same' } },
  // ---- YAML surface ----
  { id: 'y-key-order', title: 'YAML top-level key order reversed', kind: 'doc', ref: '§3 item 3 (JCS)', a: withManifest(m0), b: { ...base, yaml: stringify(Object.fromEntries(Object.entries(m0).reverse()), { lineWidth: 0 }) }, expect: { checksum: 'same', verify: 'same', rollback: 'same' } },
  { id: 'y-comments', title: 'YAML comments added', kind: 'doc', ref: '§2', a: withManifest(m0), b: { ...base, yaml: '# top\n' + mkYaml(m0).replace('dependsOn:', '# deps\ndependsOn:') + '\n# end\n' }, expect: { checksum: 'same' } },
  { id: 'y-flow-style', title: 'YAML flow style instead of block style', kind: 'doc', ref: '§2', a: withManifest(m0), b: { ...base, yaml: stringify(m0, { collectionStyle: 'flow', lineWidth: 0 }) }, expect: { checksum: 'same' } },
  { id: 'y-crlf', title: 'migration.yaml with CRLF line endings', kind: 'doc', ref: '§3', a: withManifest(m0), b: { ...base, yaml: mkYaml(m0).replaceAll('\n', '\r\n') }, expect: { checksum: 'same' } },
  { id: 'y-quoting', title: 'YAML scalars quoted', kind: 'doc', ref: '§2', a: withManifest(m0), b: { ...base, yaml: mkYaml(m0).replace('role: owner', 'role: "owner"').replace('name: change', "name: 'change'") }, expect: { checksum: 'same' } },
  { id: 'y-anchor', title: 'YAML anchor/alias', kind: 'doc', ref: '§2 (no anchors or aliases)', b: { ...base, yaml: mkYaml(m0).replace("description: A change of the conformance suite.", 'description: &d x\nsource: {ticket: *d}').replace(/source:\n[\s\S]*$/, '') }, expect: 'refused', reason: 'yaml_anchor' },
  { id: 'y-dup-key', title: 'duplicate YAML key', kind: 'doc', ref: '§2 (unique keys)', b: { ...base, yaml: mkYaml(m0) + 'description: again\n' }, expect: 'refused', reason: 'yaml_syntax' },
  { id: 'y-tag', title: 'YAML explicit tag', kind: 'doc', ref: '§2 (no tags)', b: { ...base, yaml: mkYaml(m0).replace('role: owner', 'role: !!str owner') }, expect: 'refused', reason: 'yaml_tag' },
  { id: 'y-two-docs', title: 'two YAML documents', kind: 'doc', ref: '§2 (single document)', b: { ...base, yaml: mkYaml(m0) + '---\nx: 1\n' }, expect: 'refused', reason: 'yaml_multiple_documents' },
  { id: 'y-yes-string', title: 'YAML 1.2 core: "yes" is a string, not a boolean', kind: 'doc', ref: '§2', b: { ...base, yaml: mkYaml(m0).replace('transactional: true', 'transactional: yes') }, expect: 'refused', reason: 'MIGRATION_MANIFEST_INVALID' },
  { id: 'y-merge-key', title: 'YAML merge key <<', kind: 'doc', ref: '§2 (no anchors; merge off)', b: { ...base, yaml: mkYaml(m0) + '<<: {x: 1}\n' }, expect: 'refused', reason: 'MIGRATION_MANIFEST_INVALID' },
  { id: 'y-unknown-key', title: 'unknown manifest key', kind: 'doc', ref: '§2 (strict)', b: { ...base, yaml: mkYaml(m0) + 'transactinal: false\n' }, expect: 'refused', reason: 'MIGRATION_MANIFEST_INVALID' },
]

describe('I2 content identity: edit classes against migration-bundles.md', () => {
  for (const c of cases) {
    test(`[${c.kind}] ${c.id}: ${c.title} (${c.ref})`, () => {
      const b = run(c.b)
      if (c.expect === 'refused') {
        expect(b.ok, `${c.id} must be refused`).toBe(false)
        if (!b.ok && c.reason !== undefined) {
          const e = b.error as { code: string; details: Record<string, unknown> }
          const flat = JSON.stringify(e)
          expect(flat, `${c.id} refusal reason`).toContain(c.reason)
        }
        return
      }
      const a = run(c.a ?? base)
      expect(a.ok, `${c.id}: baseline bundle must be valid: ${a.ok ? '' : JSON.stringify(a.error).slice(0, 300)}`).toBe(true)
      expect(b.ok, `${c.id}: edited bundle must be valid: ${b.ok ? '' : JSON.stringify(b.error).slice(0, 300)}`).toBe(true)
      if (!a.ok || !b.ok) return
      const da = a.value.digests
      const db = b.value.digests
      expect(rel(da.checksum, db.checksum), `${c.id} apply checksum`).toBe(c.expect.checksum)
      if (c.expect.verify !== undefined) expect(rel(da.verifyDigest, db.verifyDigest), `${c.id} verify digest`).toBe(c.expect.verify)
      if (c.expect.rollback !== undefined) expect(rel(da.rollbackDigest, db.rollbackDigest), `${c.id} rollback digest`).toBe(c.expect.rollback)
      if (c.expect.source !== undefined) expect(rel(da.sourceDigest, db.sourceDigest), `${c.id} source digest`).toBe(c.expect.source)
      // The bundle digest is derived from the three digests, never from bytes.
      const derived = da.bundleDigest === db.bundleDigest
      expect(derived, `${c.id} bundle digest follows the three digests`).toBe(
        da.checksum === db.checksum && da.verifyDigest === db.verifyDigest && da.rollbackDigest === db.rollbackDigest,
      )
    })
  }
})

// ---------- property based ----------
const IDENTS = ['a', 'b', 'tbl', 'Col_1', 'x$y', 'café', 'e', 'u', 'b2', '_z']
const KEYWORDS = ['SELECT', 'select', 'FROM', 'CREATE', 'TABLE', 'AS', 'DEFAULT', 'e', 'E', 'U']
const OPS = ['+', '-', '*', '/', '=', '<', '>', '(', ')', ',', '.', '::', '||', '~', '!', '%', '^', '&', '|', '[', ']', '@']
const NUMS = ['0', '1', '42', '3.14', '1e5', '.5', '0x1F']
const STRS = ["'x'", "''", "'a''b'", "'--'", "'/*'", "E'a\\'b'", "E'\\\\'", "U&'d\\0061t'", "'$$'", "'a;b'", "' trailing  '"]
const QIDS = ['"q"', '"a b"', '"--"', '"/*"', '"a""b"', 'U&"d\\0061t"', '";"']
const DOLLAR = ['$$ x $$', '$$ -- c\n $$', '$t$ $$ $t$', '$_a1$ /* x $_a1$', '$$;$$']

const tokenArb = fc.oneof(
  fc.constantFrom(...IDENTS),
  fc.constantFrom(...KEYWORDS),
  fc.constantFrom(...OPS),
  fc.constantFrom(...NUMS),
  fc.constantFrom(...STRS),
  fc.constantFrom(...QIDS),
  fc.constantFrom(...DOLLAR),
)
// A comment gap starts with a space: `-` + `-- c` would otherwise fuse into one line comment (that
// is PostgreSQL's rule too, and why the generator avoids it instead of testing it).
const gapArb = fc.oneof(
  fc.constantFrom(' ', '  ', '\t', '\n', ' \n ', '\u000b', '\u000c'),
  fc.constantFrom(' /**/', ' /* a */', ' /* a /* b */ c */', ' /*\n*/'),
  fc.constantFrom(' -- c\n', ' --\n', ' -- /* x */\n'),
)

/**
 * Joins tokens with a gap that cannot change tokenization: always at least one whitespace-or-comment.
 * Two string literals are never adjacent: a gap with a newline between them is PostgreSQL's string
 * continuation (one literal), which is a real tokenization difference and is covered by a case above.
 */
function joined(raw: string[], gaps: string[]): string {
  const tokens: string[] = []
  for (const t of raw) {
    const prev = tokens.at(-1)
    if (prev !== undefined && prev.endsWith("'") && t.startsWith("'")) tokens.push(',')
    tokens.push(t)
  }
  let out = ''
  tokens.forEach((t, i) => {
    out += t
    if (i < tokens.length - 1) out += gaps[i] ?? ' '
  })
  return out
}

describe('I2 property: decoration of gaps never changes the checksum, token edits always do', () => {
  test('whitespace and comment decoration between tokens keeps the checksum (400 runs)', () => {
    fc.assert(
      fc.property(
        fc.array(tokenArb, { minLength: 1, maxLength: 14 }),
        fc.array(gapArb, { minLength: 14, maxLength: 14 }),
        fc.boolean(),
        (tokens, gaps, crlf) => {
          const plain = joined(tokens, tokens.map(() => ' '))
          let fancy = '/* lead */' + joined(tokens, gaps) + '\n-- tail'
          if (crlf) fancy = fancy.replaceAll('\n', '\r\n')
          // Both texts must be lexically valid for the c1 scanner; invalid pairs are skipped.
          const a = run({ ...base, up: plain })
          const b = run({ ...base, up: fancy })
          if (!a.ok || !b.ok) return a.ok === b.ok
          return a.value.digests.checksum === b.value.digests.checksum
        },
      ),
      { numRuns: 400, seed: 20261028 },
    )
  })

  test('replacing one token by a different token changes the checksum (400 runs)', () => {
    fc.assert(
      fc.property(
        fc.array(tokenArb, { minLength: 2, maxLength: 12 }),
        fc.nat(),
        tokenArb,
        (tokens, at, replacement) => {
          const i = at % tokens.length
          if (tokens[i] === replacement) return true
          const edited = tokens.slice()
          edited[i] = replacement
          const sp = (t: string[]) => joined(t, t.map(() => ' '))
          const a = run({ ...base, up: sp(tokens) })
          const b = run({ ...base, up: sp(edited) })
          if (!a.ok || !b.ok) return true // lexically broken either way: refused, not hashed
          const same = a.value.digests.checksum === b.value.digests.checksum
          const textSame = a.value.digests.executableText['up.sql'] === b.value.digests.executableText['up.sql']
          return same === textSame // checksum equal iff executable text equal
        },
      ),
      { numRuns: 400, seed: 20261029 },
    )
  })

  test('line-ending form never changes the checksum or the source digest (300 runs)', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(tokenArb, gapArb), { minLength: 1, maxLength: 20 }), (parts) => {
        const lf = parts.join(' ').replaceAll('\r', '')
        const a = run({ ...base, up: lf })
        const b = run({ ...base, up: lf.replaceAll('\n', '\r\n') })
        const c = run({ ...base, up: lf.replaceAll('\n', '\r') })
        if (!a.ok) return !b.ok && !c.ok
        return (
          b.ok && c.ok &&
          a.value.digests.checksum === b.value.digests.checksum &&
          a.value.digests.checksum === c.value.digests.checksum &&
          a.value.digests.sourceDigest === b.value.digests.sourceDigest
        )
      }),
      { numRuns: 300, seed: 20261030 },
    )
  })
})

// The project defaults are part of the identity at ingest time (materialized), never later.
describe('I2 project defaults', () => {
  test('a changed project default changes the checksum of a bundle that relies on it (documented: materialized at ingest)', () => {
    const spec = { ...base, yaml: mkYaml(edit(['execution', 'lockTimeout'], undefined)) }
    const a = validateBundle({ ...mk(spec), projectDefaults: PROJECT_DEFAULTS })
    const b = validateBundle({ ...mk(spec), projectDefaults: { ...PROJECT_DEFAULTS, lockTimeout: '9s' } })
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) expect(a.value.digests.checksum).not.toBe(b.value.digests.checksum)
  })
  test('an explicit manifest value is immune to a changed project default', () => {
    const spec = { ...base, yaml: mkYaml(m0) }
    const a = validateBundle({ ...mk(spec), projectDefaults: PROJECT_DEFAULTS })
    const b = validateBundle({ ...mk(spec), projectDefaults: { ...PROJECT_DEFAULTS, lockTimeout: '9s', role: 'owner', searchPath: ['public'] } })
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) expect(a.value.digests.checksum).toBe(b.value.digests.checksum)
  })
})

void bytes

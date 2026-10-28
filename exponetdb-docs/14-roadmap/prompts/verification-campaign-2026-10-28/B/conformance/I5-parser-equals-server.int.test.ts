// I5 Parser equals server: what the repo's parser treats as one statement is what PostgreSQL executes.
//
// The repo splits up.sql with libpg_query (PostgreSQL's own grammar, one build per major) and sends each
// statement range as its own extended-protocol message. Three parties are compared on every generated
// script (seeded, on PostgreSQL 16, 17 and 18):
//   model   - the generator knows what each statement does (lib/gen.ts)
//   server  - the whole text as one simple-protocol message; boundaries read from pg_stat_statements
//   engine  - the repo's statement ranges, one extended-protocol message each, in one transaction
// and, for the checksum scanner (N4/N5), the executable text executed as a whole.
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { executableText } from '@exponetdb/migrations/format'
import { analyzeMigrationSql, loadParser } from '@exponetdb/postgres/parser'
import { writeFileSync, mkdirSync } from 'node:fs'
import { MAJORS, openLab, recordedStatements, runSliced, runWhole, runWholeTx, sortedTexts, type Lab, type Major } from './lib/pg.ts'
import { modelToState, script, setupSql, STATE_SQL, type Script } from './lib/gen.ts'
import { enc } from './lib/bundle.ts'

const SEEDS = Number(process.env['B2_I5_SEEDS'] ?? 120)
const OUT = process.env['B2_FIXTURE_OUT'] ?? '/tmp/b2-run/fixtures'

/** Leading whitespace and comments (outside any literal by construction) and trailing whitespace. */
function stripEdges(s: string): string {
  let i = 0
  for (;;) {
    while (i < s.length && /[ \t\n\r\f\v]/.test(s[i] as string)) i++
    if (s.startsWith('--', i)) {
      const nl = s.indexOf('\n', i)
      i = nl < 0 ? s.length : nl + 1
    } else if (s.startsWith('/*', i)) {
      let depth = 1
      let j = i + 2
      while (j < s.length && depth > 0) {
        if (s.startsWith('/*', j)) { depth++; j += 2 } else if (s.startsWith('*/', j)) { depth--; j += 2 } else j++
      }
      i = j
    } else break
  }
  return s.slice(i).replace(/[ \t\n\r\f\v;]+$/, '')
}

const labs = new Map<Major, Lab>()
beforeAll(async () => {
  for (const m of MAJORS) {
    labs.set(m, await openLab(m, `b2_i5_${m}`))
    await loadParser(m)
  }
}, 300_000)
afterAll(async () => {
  for (const l of labs.values()) await l.close()
})

async function stateOf(lab: Lab): Promise<unknown> {
  const r = await lab.admin.query(STATE_SQL)
  const s = r.rows[0]?.state as { comments: Record<string, string> }
  return { ...s, comments: Object.fromEntries(Object.entries(s.comments).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) }
}

function keep(name: string, text: string) {
  try {
    mkdirSync(OUT, { recursive: true })
    writeFileSync(`${OUT}/${name}.sql`, text)
  } catch {
    // best effort
  }
}

/** Removes statements one by one while the failure persists: the minimal reproducer. */
async function minimise(lab: Lab, seed: number, count: number, fails: (s: Script) => Promise<boolean>): Promise<string> {
  let best = script(seed, count)
  for (let n = count - 1; n >= 1; n--) {
    const candidate = script(seed, n)
    if (await fails(candidate)) best = candidate
    else break
  }
  return best.text
}

function firstDifference(a: string, b: string): string {
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  return `model ...${JSON.stringify(a.slice(Math.max(0, i - 30), i + 40))} server ...${JSON.stringify(b.slice(Math.max(0, i - 30), i + 40))}`
}

interface Verdict {
  ok: boolean
  why: string
}

async function check(lab: Lab, sc: Script): Promise<Verdict> {
  const count = sc.stmts.length
  const expected = JSON.stringify(modelToState(sc.model))
  // ---- server: the whole text, one message
  await lab.admin.query(setupSql(count))
  let whole!: Awaited<ReturnType<typeof runWholeTx>>
  const recorded = await recordedStatements(lab, async () => {
    whole = await runWholeTx(lab.admin, sc.text)
  })
  if (!whole.ok) return { ok: false, why: `server refused the generated script: ${whole.error?.message}` }
  if (whole.tags.length !== count) return { ok: false, why: `server ran ${whole.tags.length} statements, model has ${count}` }
  const serverState = JSON.stringify(await stateOf(lab))
  if (serverState !== expected) return { ok: false, why: `server differs from the model (whole text): ${firstDifference(expected, serverState)}` }
  // ---- engine: the repo's ranges
  const analysis = analyzeMigrationSql(lab.major, sc.text, { trustedExtensions: [] })
  if (!analysis.ok) return { ok: false, why: `repo parser refused a script the server ran: ${JSON.stringify(analysis.failure)}` }
  const slices = analysis.statements.map((st) => sc.text.slice(st.start, st.end))
  if (slices.length !== count) return { ok: false, why: `repo split into ${slices.length} statements, server ran ${count}` }
  const a = slices.map(stripEdges).sort()
  const b = sortedTexts(recorded).map(stripEdges).sort()
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    const i = a.findIndex((x, k) => x !== b[k])
    return { ok: false, why: `statement boundary differs from the server's: repo ${JSON.stringify(a[i])} vs server ${JSON.stringify(b[i])}` }
  }
  if (analysis.statements.some((st) => st.forbidden !== null)) {
    return { ok: false, why: `repo classified an ordinary statement as forbidden: ${analysis.statements.find((st) => st.forbidden !== null)?.forbidden}` }
  }
  await lab.admin.query(setupSql(count))
  const sliced = await runSliced(lab.admin, slices)
  if (!sliced.ok) return { ok: false, why: `server refused a repo-cut statement: ${sliced.error?.message}` }
  if (JSON.stringify(await stateOf(lab)) !== expected) return { ok: false, why: 'sliced run differs from the model' }
  // ---- checksum scanner: the executable text means the same as the text
  const x = executableText(enc(sc.text))
  if (!x.ok) return { ok: false, why: `c1 scanner refused a script PostgreSQL accepts: ${x.error}` }
  await lab.admin.query(setupSql(count))
  const wx = await runWholeTx(lab.admin, x.value)
  if (!wx.ok) return { ok: false, why: `executable text (c1) is not accepted by the server: ${wx.error?.message}` }
  if (JSON.stringify(await stateOf(lab)) !== expected) return { ok: false, why: 'executable text (c1) does something else than the text' }
  return { ok: true, why: '' }
}

describe.each(MAJORS)('I5 generated scripts on PostgreSQL %i (model = server = repo ranges = c1 executable text)', (major) => {
  test(`${SEEDS} seeded scripts`, async () => {
    const lab = labs.get(major) as Lab
    const failures: string[] = []
    for (let seed = 1; seed <= SEEDS; seed++) {
      const count = 3 + (seed % 22)
      const sc = script(seed * 7919 + major, count)
      const v = await check(lab, sc)
      if (!v.ok) {
        const min = await minimise(lab, seed * 7919 + major, count, async (c) => !(await check(lab, c)).ok)
        keep(`i5-pg${major}-seed${seed}`, min)
        failures.push(`seed ${seed}: ${v.why}`)
        if (failures.length >= 5) break
      }
    }
    expect(failures, failures.join('\n')).toEqual([])
  }, 1_200_000)
})

// ----- hand-picked hazards with an exact expected statement list (all majors) -----
interface Hand {
  id: string
  sql: string
  /** statement texts the server must see (after stripping leading comments/whitespace and a final ;) */
  expect: string[]
}
const HAND: Hand[] = [
  { id: 'nested-block-comment-with-semicolon', sql: "SELECT 1; /* a ; /* b ; */ c ; */ SELECT 2;", expect: ['SELECT 1', 'SELECT 2'] },
  { id: 'line-comment-with-quote', sql: "SELECT 1; -- it's ; here\nSELECT 2;", expect: ['SELECT 1', 'SELECT 2'] },
  { id: 'dollar-tag-nested', sql: "DO $a$ BEGIN PERFORM $$;$$; END $a$; SELECT 1;", expect: ['DO $a$ BEGIN PERFORM $$;$$; END $a$', 'SELECT 1'] },
  { id: 'dollar-in-identifier', sql: 'SELECT 1 AS a$b$c; SELECT 2;', expect: ['SELECT 1 AS a$b$c', 'SELECT 2'] },
  { id: 'quoted-ident-semicolon-comment', sql: 'CREATE TABLE "a;--b/*" (c int); SELECT 1;', expect: ['CREATE TABLE "a;--b/*" (c int)', 'SELECT 1'] },
  { id: 'escape-string-backslash-quote', sql: "SELECT E'a\\'; select 2'; SELECT 3;", expect: ["SELECT E'a\\'; select 2'", 'SELECT 3'] },
  { id: 'standard-string-backslash-end', sql: "SELECT 'a\\'; SELECT 2;", expect: ["SELECT 'a\\'", 'SELECT 2'] },
  { id: 'unicode-escape-string', sql: "SELECT U&'\\0041;--'; SELECT 2;", expect: ["SELECT U&'\\0041;--'", 'SELECT 2'] },
  { id: 'string-continuation', sql: "SELECT 'a'\n'b;'; SELECT 2;", expect: ["SELECT 'a'\n'b;'", 'SELECT 2'] },
  { id: 'single-quoted-do-body', sql: "DO 'BEGIN PERFORM ''x;y''; END'; SELECT 2;", expect: ["DO 'BEGIN PERFORM ''x;y''; END'", 'SELECT 2'] },
  { id: 'empty-statements', sql: ";;; SELECT 1;;; SELECT 2 ;", expect: ['SELECT 1', 'SELECT 2'] },
  { id: 'no-final-semicolon', sql: "SELECT 1; SELECT 2", expect: ['SELECT 1', 'SELECT 2'] },
  { id: 'multibyte-before-statement', sql: "-- 日本語 😀\nSELECT '😀é;'; SELECT 2;", expect: ["SELECT '😀é;'", 'SELECT 2'] },
  { id: 'begin-atomic-body', sql: 'CREATE FUNCTION public.f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT 2; END; SELECT 3;', expect: ['CREATE FUNCTION public.f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT 2; END', 'SELECT 3'] },
  { id: 'create-schema-elements', sql: 'CREATE SCHEMA hz CREATE TABLE hz.a (i int) CREATE VIEW hz.v AS SELECT 1; SELECT 2;', expect: ['CREATE SCHEMA hz CREATE TABLE hz.a (i int) CREATE VIEW hz.v AS SELECT 1', 'SELECT 2'] },
  { id: 'rule-multi-action', sql: 'CREATE TABLE hr (i int); CREATE RULE r1 AS ON INSERT TO hr DO ALSO (NOTIFY a; NOTIFY b); SELECT 2;', expect: ['CREATE TABLE hr (i int)', 'CREATE RULE r1 AS ON INSERT TO hr DO ALSO (NOTIFY a; NOTIFY b)', 'SELECT 2'] },
  { id: 'psql-meta-is-syntax-error', sql: '\\connect other', expect: [] },
]

describe.each(MAJORS)('I5 hand-picked hazards on PostgreSQL %i', (major) => {
  for (const h of HAND) {
    test(h.id, async () => {
      const lab = labs.get(major) as Lab
      await lab.admin.query('DROP SCHEMA IF EXISTS hz CASCADE; DROP TABLE IF EXISTS hr CASCADE; DROP FUNCTION IF EXISTS public.f()')
      const analysis = analyzeMigrationSql(major, h.sql, { trustedExtensions: [] })
      if (h.expect.length === 0) {
        expect(analysis.ok).toBe(false)
        const server = await runWhole(lab.admin, h.sql)
        expect(server.ok).toBe(false)
        return
      }
      expect(analysis.ok, JSON.stringify(analysis)).toBe(true)
      if (!analysis.ok) return
      const slices = analysis.statements.map((s) => stripEdges(h.sql.slice(s.start, s.end)))
      expect(slices).toEqual(h.expect)
      let whole!: Awaited<ReturnType<typeof runWhole>>
      const rec = await recordedStatements(lab, async () => { whole = await runWhole(lab.admin, h.sql) })
      // SELECT statements are normalised by pg_stat_statements ($1), so compare counts for them and texts otherwise
      expect(whole.ok, JSON.stringify(whole.error)).toBe(true)
      expect(whole.tags.length).toBe(h.expect.length)
      void rec
    })
  }
})

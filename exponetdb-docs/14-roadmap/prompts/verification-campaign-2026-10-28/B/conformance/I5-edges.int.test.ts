// I5 edges: inputs where the repo's parser (libpg_query, one build per major) and the server can disagree.
// Each test states the SERVER's behaviour as ground truth (it runs the text itself) and compares the repo.
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { analyzeMigrationSql, loadParser } from '@exponetdb/postgres/parser'
import { executableText } from '@exponetdb/migrations/format'
import { enc } from './lib/bundle.ts'
import { MAJORS, openLab, runSliced, runWhole, type Lab, type Major } from './lib/pg.ts'

const labs = new Map<Major, Lab>()
beforeAll(async () => {
  for (const m of MAJORS) {
    labs.set(m, await openLab(m, `b2_i5e_${m}`))
    await loadParser(m)
  }
}, 300_000)
afterAll(async () => {
  for (const l of labs.values()) await l.close()
})

const repo = (m: Major, sql: string) => analyzeMigrationSql(m, sql, { trustedExtensions: [] })

describe.each(MAJORS)('I5 edges on PostgreSQL %i', (major) => {
  const lab = () => labs.get(major) as Lab

  test('string continuation across a line comment: the server joins the literals; the repo parser must too', async () => {
    const sql = "SELECT 'a'\n-- a comment between the pieces\n'b' AS v;"
    const server = await runWhole(lab().admin, sql)
    expect(server.ok, `server: ${JSON.stringify(server.error)}`).toBe(true)
    const row = (await lab().admin.query(sql)) as unknown as { rows: { v: string }[] }
    expect(row.rows[0]?.v).toBe('ab')
    // scan.l: whitespace_with_newline = horiz_whitespace* newline special_whitespace*, and a `--` comment is
    // horiz_whitespace. migration-bundles.md N4 says the same; libpg_query 16/17/18 do not accept it.
    expect(repo(major, sql).ok, 'libpg_query accepts what the server accepts').toBe(true)
    // the c1 scanner follows the server (one literal token), so the checksum text keeps the continuation
    const x = executableText(enc(sql))
    expect(x.ok && x.value.includes('\n')).toBe(true)
  })

  test('string continuation with a comment in the middle of a DO body quote form', async () => {
    const sql = "DO 'BEGIN NULL; END'\n-- c\n'';"
    const server = await runWhole(lab().admin, sql)
    expect(repo(major, sql).ok).toBe(server.ok)
  })

  test('form feed between statements is whitespace for both', async () => {
    const sql = 'SELECT 1;\fSELECT 2;'
    expect((await runWhole(lab().admin, sql)).ok).toBe(true)
    expect(repo(major, sql).ok).toBe(true)
  })

  test('vertical tab: whitespace on PostgreSQL 17+, a syntax error on 16 (migration-bundles.md N3); the parser and the server agree', async () => {
    const sql = 'SELECT\u000b1;'
    const server = await runWhole(lab().admin, sql)
    expect(server.ok).toBe(major >= 17)
    expect(repo(major, sql).ok).toBe(server.ok)
  })

  test('backslashes: with standard_conforming_strings = on a backslash is ordinary (the pinned setting)', async () => {
    const sql = "COMMENT ON SCHEMA public IS 'a\\'; COMMENT ON SCHEMA public IS 'b';"
    const a = repo(major, sql)
    expect(a.ok && a.statements.length).toBe(2)
    expect((await runWhole(lab().admin, sql)).tags).toEqual(['COMMENT', 'COMMENT'])
  })

  test('characterisation: under standard_conforming_strings = off the server lexes the SAME text differently from the repo (why the engine pins the setting and reads a guard after every statement)', async () => {
    const sql = "COMMENT ON SCHEMA public IS 'a\\'; COMMENT ON SCHEMA public IS 'b';"
    const mine = repo(major, sql)
    expect(mine.ok && mine.statements.length, 'the repo assumes scs = on: two statements').toBe(2)
    const client = lab().admin
    await client.query('BEGIN')
    await client.query('SET LOCAL standard_conforming_strings = off')
    const off = await runWhole(client, sql)
    await client.query('ROLLBACK')
    // with scs off, \' is an escaped quote: the first literal runs on and the text is not two COMMENT statements
    expect(off.ok && off.tags.length === 2, 'scs off: the server sees the same two statements').toBe(false)
    const on = await runWhole(client, sql)
    expect(on.tags).toEqual(['COMMENT', 'COMMENT'])
  })

  test('nesting depth: parentheses at 1,000 / 3,000 / 5,000 / 8,000 / 12,000 / 20,000: repo and server accept or refuse together', async () => {
    const verdicts: string[] = []
    for (const n of [1000, 3000, 5000, 8000, 12_000, 20_000]) {
      const sql = `SELECT ${'('.repeat(n)}1${')'.repeat(n)};`
      const server = await runWhole(lab().admin, sql)
      const mine = repo(major, sql)
      verdicts.push(`${n}: repo=${mine.ok ? 'ok' : 'refused'} server=${server.ok ? 'ok' : server.error?.code}`)
    }
    console.log(`I5[pg${major}] parentheses: ${verdicts.join(' | ')}`)
    const split = verdicts.filter((v) => /repo=ok server=(?!ok)|repo=refused server=ok/.test(v))
    expect(split, 'depths where the repo parser and the server disagree').toEqual([])
  }, 120_000)

  test('a script of 30 statements with 100 KB literals (3 MB): the repo ranges and the server agree on the effects', async () => {
    await lab().admin.query('DROP SCHEMA IF EXISTS big CASCADE; CREATE SCHEMA big')
    const tables = Array.from({ length: 30 }, (_, i) => `CREATE TABLE big.t${i} (c int);`).join('\n')
    await lab().admin.query(tables)
    const big = (i: number) => `COMMENT ON TABLE big.t${i} IS '${`${i};--/*'`.repeat(10_000).replaceAll("'", "''")}';`
    const sql = Array.from({ length: 30 }, (_, i) => big(i)).join('\n')
    expect(Buffer.byteLength(sql)).toBeGreaterThan(2_000_000)
    const a = repo(major, sql)
    expect(a.ok, JSON.stringify(a.ok ? '' : a)).toBe(true)
    if (!a.ok) return
    expect(a.statements).toHaveLength(30)
    const slices = a.statements.map((s) => sql.slice(s.start, s.end))
    const sliced = await runSliced(lab().admin, slices)
    expect(sliced.ok, JSON.stringify(sliced.error)).toBe(true)
    const r = await lab().admin.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'big' AND obj_description(c.oid, 'pg_class') IS NOT NULL")
    expect(r.rows[0]?.n).toBe(30)
  }, 120_000)

  test('100,000 tiny statements: the server runs them; the repo refuses with the named token bound (documented in deployment.md §2a)', async () => {
    const sql = 'SELECT 1;\n'.repeat(100_000)
    expect((await runWhole(lab().admin, sql)).ok).toBe(true)
    const a = repo(major, sql)
    expect(a.ok).toBe(false)
    expect(JSON.stringify(a)).toContain('too_large')
  }, 120_000)

  test('statement ranges are exact for multibyte text: BMP, astral, combining marks, in comments and literals', async () => {
    const sql = "-- 日本語 😀 é\nSELECT 'é😀日' AS a;\n/* 😀 */ SELECT 'ıİ' AS b;\nSELECT 3 AS c"
    const a = repo(major, sql)
    expect(a.ok).toBe(true)
    if (!a.ok) return
    expect(a.statements.map((s) => sql.slice(s.start, s.end).trim())).toEqual(["SELECT 'é😀日' AS a", "SELECT 'ıİ' AS b", 'SELECT 3 AS c'])
  })
})

import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'
import { lex, loadParser, redactStatementSync } from '../src/parser/index.ts'
import { SUPPORTED_MAJORS } from '../src/versions.ts'

/**
 * G4 item 10 (security): the statement-redaction corpus of
 * statement-redaction.md §5 (every weakness found in the REOSA audit, and the
 * listed edge cases) on every supported grammar, plus a property: a secret
 * written as any literal form never survives redaction.
 */
beforeAll(async () => {
  for (const major of SUPPORTED_MAJORS) await loadParser(major)
})

const SECRET = 'S3cr3tV4lue'

/** [input, expected mode]; the output must never contain SECRET. */
const CORPUS: readonly (readonly [string, string])[] = [
  [`SELECT * FROM users WHERE email = '${SECRET}@example.com'`, 'parse'],
  [`SELECT * FROM t WHERE id = 4242${SECRET.length}`, 'parse'],
  [`UPDATE t SET token = $$${SECRET}$$ WHERE id = 1`, 'parse'],
  [`UPDATE t SET token = $tag$a $$ ${SECRET} $$ b$tag$`, 'parse'],
  [`SELECT 1 -- ${SECRET}\n, 2`, 'parse'],
  [`SELECT /* outer /* nested '${SECRET}' */ still comment */ 1`, 'parse'],
  [`SELECT E'it\\'s ${SECRET}'`, 'parse'],
  [`SELECT E'\\\\${SECRET}\\x41'`, 'parse'],
  [`SELECT U&'d\\0061t\\+000061 ${SECRET}' UESCAPE '!'`, 'parse'],
  [`SELECT U&'!0061${SECRET}' UESCAPE '!'`, 'parse'],
  [`SELECT B'1010', X'${'ff'.repeat(4)}', N'${SECRET}'`, 'parse'],
  [`INSERT INTO t VALUES ('${SECRET}', 1.5e10, -42, 0x1F, 1_000)`, 'parse'],
  [`SELECT DATE '2026-10-06', INTERVAL '${SECRET.length} days', '${SECRET}'::text`, 'parse'],
  [`SELECT 'a'\n'${SECRET}'`, 'parse'],
  // cut at track_activity_query_size: an unterminated literal runs to the end
  [`SELECT * FROM t WHERE note = 'first part of ${SECRET}`, 'lexical'],
  [`SELECT * FROM t WHERE body = $x$ ${SECRET}`, 'lexical'],
  [`SELECT 1 /* unterminated ${SECRET}`, 'lexical'],
  // standard_conforming_strings = off at the source: the conservative lexer keeps it inside
  [`SELECT * FROM t WHERE n = 'it\\'s ${SECRET}' AND`, 'lexical'],
  // a backslash before a quote flips the pairing of every later literal (review H1)
  [`INSERT INTO t VALUES ('C:\\', '${SECRET}@example.com', 'diagnosis F32`, 'lexical'],
  [`INSERT INTO t VALUES ('C:\\', 'x', '${SECRET}')`, 'lexical'],
  // a session with standard_conforming_strings = off reads this as one literal (review L4)
  [`INSERT INTO t VALUES ('v\\', ${SECRET}) --', 'w')`, 'lexical'],
  // a dollar-quote tag longer than 256 characters (review M1)
  [`SELECT $${'a'.repeat(300)}$${SECRET}$${'a'.repeat(300)}$`, 'parse'],
  [`SELECT $${'a'.repeat(300)}$${SECRET}`, 'lexical'],
  // sensitive commands, whatever the literal form
  [`ALTER ROLE app PASSWORD '${SECRET}'`, 'summary'],
  [`ALTER USER app WITH ENCRYPTED PASSWORD '${SECRET}'`, 'summary'],
  [`CREATE ROLE app LOGIN PASSWORD '${SECRET}'`, 'summary'],
  [`CREATE USER MAPPING FOR app SERVER s OPTIONS (user 'u', password '${SECRET}')`, 'summary'],
  [`ALTER USER MAPPING FOR app SERVER s OPTIONS (SET password '${SECRET}')`, 'summary'],
  [`CREATE SERVER s FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host '${SECRET}')`, 'summary'],
  [`SET app.api_password = '${SECRET}'`, 'summary'],
  [`SELECT set_config('app.secret_token', '${SECRET}', false)`, 'summary'],
  [`COPY t TO PROGRAM 'curl -d ${SECRET} http://x'`, 'summary'],
  [`ALTER ROLE app PASSWORD '${SECRET}`, 'summary'],
  // a setting's value written as a bare or quoted word (G4 review R1)
  [`SET app.claims = ${SECRET}`, 'parse'],
  [`SET app.claims TO ${SECRET}`, 'parse'],
  [`SET LOCAL app.claims = ${SECRET}`, 'parse'],
  [`SET app.claims = "${SECRET}"`, 'parse'],
  [`ALTER SYSTEM SET app.claims = ${SECRET}`, 'parse'],
  [`ALTER ROLE app SET app.claims = ${SECRET}`, 'parse'],
  [`ALTER ROLE app IN DATABASE d SET app.claims TO ${SECRET}`, 'parse'],
  [`ALTER DATABASE d SET app.claims = ${SECRET}`, 'parse'],
  [`SET search_path = app, ${SECRET}`, 'parse'],
  [`SET app.claims = ${SECRET}; SELECT 'cut`, 'lexical'],
  [`ALTER ROLE app SET app.claims TO "${SECRET}"; SELECT 'cut`, 'lexical'],
]

describe.each(SUPPORTED_MAJORS.map((m) => [m]))(
  'redaction on the PostgreSQL %i grammar',
  (major) => {
    it.each(CORPUS)('redacts %s', (text, mode) => {
      const r = redactStatementSync(text, { major })
      expect(r.text).not.toContain(SECRET)
      expect(r.text).not.toContain('S3cr3t')
      expect(r.mode).toBe(mode)
      expect(r.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    })

    it('keeps identifiers, keywords and parameters and numbers constants after them', () => {
      const r = redactStatementSync(
        'SELECT u."e@mail.example" FROM public.users u WHERE u.id = $1 AND u.name = \'x\' LIMIT 10',
        { major },
      )
      expect(r).toMatchObject({
        mode: 'parse',
        text: 'SELECT u."e@mail.example" FROM public.users u WHERE u.id = $1 AND u.name = $2 LIMIT $3',
      })
    })

    it('removes comments and collapses whitespace, never splitting a line into fake log lines', () => {
      const r = redactStatementSync("SELECT 1\n\n-- note\nFROM\tpublic.t\r\n/* x */WHERE a = 'b'", {
        major,
      })
      expect(r.text).toBe('SELECT $1 FROM public.t WHERE a = $2')
    })

    it('keeps the column names of an UPDATE, INSERT … ON CONFLICT and MERGE without a parse tree', () => {
      const cut = (text: string) => redactStatementSync(`${text} AND c = 'cut`, { major })
      expect(cut("UPDATE t SET a = b WHERE c = 'x'")).toMatchObject({
        mode: 'lexical',
        text: 'UPDATE t SET a = b WHERE c = $? AND c = $?',
      })
      expect(
        cut("INSERT INTO t VALUES (1) ON CONFLICT (id) DO UPDATE SET a = excluded.a WHERE c = 'x'"),
      ).toMatchObject({
        mode: 'lexical',
        text: 'INSERT INTO t VALUES ($?) ON CONFLICT (id) DO UPDATE SET a = excluded.a WHERE c = $? AND c = $?',
      })
      // A setting's bare value is still hidden in the next statement.
      expect(
        redactStatementSync(
          `UPDATE t SET a = b; ALTER ROLE app SET app.claims = ${SECRET}; SELECT 'cut`,
          {
            major,
          },
        ),
      ).toMatchObject({
        mode: 'lexical',
        text: 'UPDATE t SET a = b; ALTER ROLE app SET app.claims = $?; SELECT $?',
      })
    })

    // The quadratic implementation needed 34 s (lexical) to 56 s (parsed) for this input
    // on its own; the linear one needs well under a second alone and stays far below the
    // bound when every package's tests run at once.
    it('redacts 100,000 constants in linear time, parsed or not (G4 review R2)', () => {
      const list = Array.from({ length: 100_000 }, (_, i) => `'v${i}'`).join(',')
      const text = `SELECT 1 FROM t WHERE id IN (${list})`
      for (const [input, mode] of [
        [text, 'parse'],
        [`${text} AND x = 'cut`, 'lexical'],
      ] as const) {
        const started = performance.now()
        const r = redactStatementSync(input, { major })
        expect(performance.now() - started).toBeLessThan(20_000)
        expect(r.mode).toBe(mode)
        expect(r.text).not.toContain("'v")
      }
    }, 120_000)

    it('shortens a long IN list and caps the length with a flag', () => {
      const list = Array.from({ length: 5000 }, (_, i) => String(i)).join(', ')
      const r = redactStatementSync(`SELECT * FROM t WHERE id IN (${list})`, { major })
      expect(r.text).toBe('SELECT * FROM t WHERE id IN ($1, $2, $3, $4, $5, ...)')
      const long = redactStatementSync(`SELECT ${'a, '.repeat(2000)}b FROM t`, {
        major,
        maxLength: 500,
      })
      expect(long.truncated).toBe(true)
      expect(long.text.length).toBe(500)
    })

    it('masks every literal of either string reading, and keeps the statement shape', () => {
      const r = redactStatementSync(
        "INSERT INTO t VALUES ('C:\\', 'jane.doe@example.com', 'diagnosis F32",
        { major },
      )
      expect(r.mode).toBe('lexical')
      expect(r.text).not.toMatch(/jane|doe|example|diagnosis|F32/)
      expect(r.text.startsWith('INSERT INTO t VALUES (')).toBe(true)
    })

    it('marks text that is not well-formed Unicode as unparseable', () => {
      const r = redactStatementSync(`SELECT '\uD800${SECRET}'`, { major })
      expect(r.mode).toBe('unparseable')
      expect(r.text).not.toContain(SECRET)
    })

    it('never lets a literal of any form through (property)', () => {
      const secret = fc.stringMatching(/^[A-Za-z0-9]{6,24}$/).map((s) => `Q${s}Z`)
      const forms: readonly ((s: string) => string)[] = [
        (s) => `'${s}'`,
        (s) => `E'${s}\\n'`,
        (s) => `$$${s}$$`,
        (s) => `$q$${s}$q$`,
        (s) => `U&'${s}'`,
        (s) => `'${s}'::text`,
        (s) => `'pre''${s}'`,
      ]
      fc.assert(
        fc.property(
          secret,
          fc.integer({ min: 0, max: forms.length - 1 }),
          fc.boolean(),
          (s, f, cut) => {
            const form = forms[f] ?? forms[0]
            const full = `SELECT a FROM t WHERE b = ${form?.(s)} AND c = 1`
            const text = cut ? full.slice(0, full.indexOf(s) + Math.floor(s.length / 2)) : full
            const r = redactStatementSync(text, { major })
            return (
              !r.text.includes(s.slice(1, -1)) &&
              !r.text.includes(s.slice(0, Math.ceil(s.length / 2)))
            )
          },
        ),
        { numRuns: 300 },
      )
    })
  },
)

describe('lexer', () => {
  it('finds literals, comments, identifiers and parameters', () => {
    const text = `SELECT "a""b", $1, E'x\\'y', $t$z$t$, 1.5e3 /* c /* d */ */ -- e`
    const kinds = lex(text)
      .filter((t) => t.kind !== 'space')
      .map((t) => `${t.kind}:${text.slice(t.start, t.end)}`)
    expect(kinds).toEqual([
      'ident:SELECT',
      'qident:"a""b"',
      'op:,',
      'param:$1',
      'op:,',
      "string:E'x\\'y'",
      'op:,',
      'dollar:$t$z$t$',
      'op:,',
      'number:1.5e3',
      'comment:/* c /* d */ */',
      'comment:-- e',
    ])
  })
})

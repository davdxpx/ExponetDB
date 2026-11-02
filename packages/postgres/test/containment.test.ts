import { beforeAll, describe, expect, it } from 'vitest'
import {
  analyzeMigrationSql,
  loadParser,
  MAX_COMMENT_DEPTH,
  MAX_COMMENT_RUN,
  MAX_MIGRATION_STATEMENTS,
  parseWith,
} from '../src/parser/index.ts'
import { commentDepth, commentRun } from '../src/parser/lexer.ts'
import { SUPPORTED_MAJORS } from '../src/versions.ts'

/**
 * Hostile input (verification campaign VC-013, VC-068): PostgreSQL's own scanner is quadratic in
 * the nesting of block comments and the token bound ignores comments, so a 160 KB file held a
 * thread for 38 s. The nesting is bounded before the text reaches the parser, with a named
 * limit, in every path that parses.
 */
beforeAll(async () => {
  for (const major of SUPPORTED_MAJORS) await loadParser(major)
})

// Spaced, as real nested comments are: unspaced `/*/*/*` is also one long run of operator characters.
const nested = (depth: number, tail = 'SELECT 1;') =>
  `${'/* '.repeat(depth)}${' */'.repeat(depth)}\n${tail}\n`

describe('the nesting of block comments (VC-013)', () => {
  it('counts the depth of real comments only, not the markers inside literals or line comments', () => {
    expect(commentDepth(nested(5), 100)).toBe(5)
    expect(commentDepth(`SELECT '${'/*'.repeat(500)}';`, 100)).toBe(0)
    expect(commentDepth(`-- ${'/*'.repeat(500)}\nSELECT 1;`, 100)).toBe(0)
    expect(commentDepth(`SELECT $q$${'/*'.repeat(500)}$q$;`, 100)).toBe(0)
    // An unterminated comment still counts what it opened.
    expect(commentDepth('/*'.repeat(7), 100)).toBe(7)
  })

  it.each(SUPPORTED_MAJORS)(
    'refuses a file nested deeper than the limit before it is parsed (%i)',
    (major) => {
      const ok = parseWith(major, nested(MAX_COMMENT_DEPTH))
      expect(ok.ok).toBe(true)
      const refused = parseWith(major, nested(MAX_COMMENT_DEPTH + 1))
      expect(refused).toMatchObject({
        ok: false,
        failure: { kind: 'too_large', limit: 'comment_depth' },
      })
    },
  )

  it('refuses 40,000 nested comments at once, in time that does not grow with the depth', () => {
    const time = (depth: number) => {
      const text = nested(depth)
      let best = Number.POSITIVE_INFINITY
      let result: ReturnType<typeof analyzeMigrationSql> | undefined
      for (let i = 0; i < 4; i++) {
        const started = performance.now()
        result = analyzeMigrationSql(17, text)
        best = Math.min(best, performance.now() - started)
      }
      return { ms: best, result }
    }
    const small = time(10_000)
    const large = time(40_000)
    expect(large.result).toMatchObject({
      ok: false,
      failure: { kind: 'too_large', limit: 'comment_depth' },
    })
    expect(large.ms).toBeLessThan(2000)
    // Four times the depth: a linear check is about 4, the parser's scanner about 16 (9 s at 40,000).
    expect(large.ms / Math.max(small.ms, 5)).toBeLessThan(8)
  })
})

/**
 * The cost in PostgreSQL's scanner is not the nesting: every `/*` rescans the whole run of
 * operator characters that follows it (scan.l `xcstart`, `yyless(2)`), so a run of closed
 * comments `/**\/` repeated is quadratic at depth 1 (the review of group E: 6.8 s at 160 KB).
 */
describe('comment starts inside one run of operator characters (VC-013)', () => {
  it('counts the starts of each maximal operator run, not the markers in separate runs', () => {
    expect(commentRun('/**/'.repeat(5), 100)).toBe(5)
    expect(commentRun('+/**/'.repeat(5), 100)).toBe(5)
    expect(commentRun('/**/ '.repeat(500), 100)).toBe(1)
    expect(commentRun(`/*${'*'.repeat(500)}/`, 100)).toBe(1)
    expect(commentRun(`SELECT 1; /* a */ /* b */`, 100)).toBe(1)
  })

  it.each([
    ['closed comments in a row', (n: number) => `${'/**/'.repeat(n)}\nSELECT 1;\n`],
    ['comments between operators', (n: number) => `SELECT 1 ${'+/**/'.repeat(n)} 1;\n`],
  ])('refuses %s past the limit, at once', (_name, build) => {
    for (const major of SUPPORTED_MAJORS) {
      expect(parseWith(major, build(MAX_COMMENT_RUN))).toMatchObject({ ok: true })
      expect(parseWith(major, build(MAX_COMMENT_RUN + 2))).toMatchObject({
        ok: false,
        failure: { kind: 'too_large', limit: 'comment_run' },
      })
    }
    const started = performance.now()
    const refused = analyzeMigrationSql(17, build(40_000))
    expect(performance.now() - started).toBeLessThan(2000)
    expect(refused).toMatchObject({ ok: false, failure: { limit: 'comment_run' } })
  })

  it('lets ordinary comments through: banners, spaced comments and many separate ones', () => {
    const banner = `/*${'*'.repeat(200)}*/\n/* ${'-'.repeat(200)} */\nSELECT 1;\n`
    expect(parseWith(17, banner)).toMatchObject({ ok: true })
    expect(parseWith(17, `${'/**/ '.repeat(5000)}SELECT 1;`)).toMatchObject({ ok: true })
    expect(parseWith(17, `${'/* c */\n'.repeat(5000)}SELECT 1;`)).toMatchObject({ ok: true })
  })
})

describe('the statements of one migration file (VC-068)', () => {
  it('refuses a file with more statements than the limit, named, before classifying any of them', () => {
    const text = 'SELECT 1;\n'.repeat(MAX_MIGRATION_STATEMENTS + 1)
    const started = performance.now()
    const refused = analyzeMigrationSql(17, text)
    expect(refused).toMatchObject({
      ok: false,
      failure: { kind: 'too_large', limit: 'statements' },
    })
    expect(performance.now() - started).toBeLessThan(2000)
    expect(analyzeMigrationSql(17, 'SELECT 1;\n'.repeat(MAX_MIGRATION_STATEMENTS))).toMatchObject({
      ok: true,
    })
  })
})

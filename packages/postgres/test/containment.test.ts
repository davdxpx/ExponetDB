import { beforeAll, describe, expect, it } from 'vitest'
import {
  analyzeMigrationSql,
  loadParser,
  MAX_COMMENT_DEPTH,
  parseWith,
} from '../src/parser/index.ts'
import { commentDepth } from '../src/parser/lexer.ts'
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

const nested = (depth: number, tail = 'SELECT 1;') =>
  `${'/*'.repeat(depth)}${'*/'.repeat(depth)}\n${tail}\n`

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
      const started = performance.now()
      const result = analyzeMigrationSql(17, text)
      return { ms: performance.now() - started, result }
    }
    const small = time(10_000)
    const large = time(40_000)
    expect(large.result).toMatchObject({
      ok: false,
      failure: { kind: 'too_large', limit: 'comment_depth' },
    })
    expect(large.ms).toBeLessThan(2000)
    // Four times the depth: a linear check is about 4, the parser's scanner about 16.
    expect(large.ms / Math.max(small.ms, 1)).toBeLessThan(8)
  })
})

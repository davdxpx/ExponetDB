import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { executableText, ledgerStateHash } from '../src/format/index.ts'
import { loadGolden } from './golden.ts'

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

/** Deterministic pseudo-random numbers (no Math.random in tests). */
function rng(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) % 2 ** 31
    return s
  }
}

const TOKENS = [
  'SELECT',
  'foo',
  'a$b',
  '_x1',
  'ünïcode',
  '42',
  '(',
  ')',
  ',',
  ';',
  '=',
  '::',
  "'it''s -- no comment'",
  "E'a\\'b /* x */'",
  '"Quoted -- Ident"',
  '$$ body -- kept /* kept */ $$',
  '$fn$ $$ inner $$ $fn$',
  "U&'d\\0061t'",
  "B'1010'",
]
const SEPARATORS = [
  ' ',
  '\n',
  '\t\t',
  ' \n ',
  '/* c */',
  ' -- c\n',
  '/**/',
  '\u000b',
  '\f',
  ' /* a /* nested */ b */ ',
  '\r\n',
]

describe('c1 properties', () => {
  it('comments and whitespace between tokens never change the executable text (token boundaries survive)', () => {
    const next = rng(7)
    for (let round = 0; round < 3000; round++) {
      const count = 1 + (next() % 12)
      const tokens: string[] = []
      for (let i = 0; i < count; i++) {
        let t = TOKENS[next() % TOKENS.length] ?? 'x'
        // A string directly after a string with a newline in between would be a continuation.
        if (t.endsWith("'") && tokens.at(-1)?.endsWith("'")) {
          t = 'x'
        }
        tokens.push(t)
      }
      const lead = SEPARATORS[next() % SEPARATORS.length] ?? ''
      let text = lead
      for (const [i, t] of tokens.entries()) {
        text += t
        if (i < tokens.length - 1 || next() % 2 === 0) {
          text += SEPARATORS[next() % SEPARATORS.length] ?? ' '
        }
      }
      expect(executableText(utf8(text)), JSON.stringify(text)).toEqual({
        ok: true,
        value: tokens.join(' '),
      })
    }
  })

  it('is idempotent on every successful golden output', () => {
    const { vectors } = loadGolden(
      'c1-sql.json',
      z.object({
        vectors: z.array(z.object({ id: z.string(), expected: z.string().optional() })),
      }),
    )
    let checked = 0
    for (const v of vectors) {
      if (v.expected !== undefined) {
        expect(executableText(utf8(v.expected)), v.id).toEqual({ ok: true, value: v.expected })
        checked++
      }
    }
    expect(checked).toBeGreaterThan(90)
  })

  it('never throws on arbitrary bytes', () => {
    const next = rng(11)
    for (let round = 0; round < 2000; round++) {
      const bytes = Uint8Array.from({ length: next() % 64 }, () => next() % 256)
      const result = executableText(bytes)
      expect(typeof result.ok).toBe('boolean')
    }
  })

  it('keeps an edited comment inside a function body significant', () => {
    const a = executableText(
      utf8('CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 -- a $$ LANGUAGE sql;'),
    )
    const b = executableText(
      utf8('CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 -- b $$ LANGUAGE sql;'),
    )
    expect(a.ok && b.ok && a.value !== b.value).toBe(true)
  })
})

describe('ls1 properties', () => {
  it('does not depend on row order', () => {
    const next = rng(3)
    const rows = Array.from({ length: 40 }, (_, i) => ({
      migrationId:
        i % 5 === 0
          ? `legacy:${String(i).padStart(4, '0')}_x`
          : `01JB2Z6G8M4Q7R9T1V3W5X7${String(i).padStart(3, '0')}`,
      checksum: `sha256:c1:${String(i).padStart(64, 'a')}`,
      reverted: i % 7 === 0,
    }))
    const reference = ledgerStateHash(rows, 'baseline:demo')
    for (let round = 0; round < 50; round++) {
      const shuffled = [...rows].sort(() => (next() % 3) - 1)
      expect(ledgerStateHash(shuffled, 'baseline:demo')).toEqual(reference)
    }
  })

  it('changes when anything changes', () => {
    const row = {
      migrationId: '01JB2Z6G8M4Q7R9T1V3W5X7Y9Z',
      checksum: `sha256:c1:${'a'.repeat(64)}`,
      reverted: false,
    }
    const base = [row]
    const hash = (rows: (typeof row)[], baseline: string | null): string => {
      const r = ledgerStateHash(rows, baseline)
      return r.ok ? r.value.hash : r.error.code
    }
    const reference = hash(base, null)
    expect(hash([{ ...row, reverted: true }], null)).not.toBe(reference)
    expect(hash([{ ...row, checksum: `sha256:c1:${'b'.repeat(64)}` }], null)).not.toBe(reference)
    expect(hash(base, 'baseline:x')).not.toBe(reference)
    expect(hash([], null)).not.toBe(reference)
  })
})

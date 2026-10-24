import { describe, expect, it } from 'vitest'
import { markHidden, sqlstateOf, statementAtCursor } from '../../src/features/sql/sql-model.ts'
import { classifyText } from './support.tsx'

describe('statementAtCursor', () => {
  const text = 'SELECT 1;\nSELECT 2;\n\n-- note\nSELECT 3'
  const result = classifyText(text)

  function at(offset: number) {
    return statementAtCursor(text, result, offset)
  }

  it('picks the statement the cursor is in, with its text, number and line', () => {
    expect(at(2)).toEqual({
      scope: { kind: 'statement', n: 1, count: 3, line: 1 },
      text: 'SELECT 1',
    })
    expect(at(text.indexOf('SELECT 2') + 4)).toEqual({
      scope: { kind: 'statement', n: 2, count: 3, line: 2 },
      text: 'SELECT 2',
    })
    expect(at(text.length)?.scope).toEqual({ kind: 'statement', n: 3, count: 3, line: 5 })
  })

  it('counts the end of a statement and the semicolon after it as part of it', () => {
    const end = text.indexOf('SELECT 1') + 'SELECT 1'.length
    expect(at(end)?.text).toBe('SELECT 1')
    expect(at(end + 1)?.text).toBe('SELECT 1')
  })

  it('takes the statement before the cursor between statements, and the first before all', () => {
    expect(at(text.indexOf('\n\n') + 1)?.text).toBe('SELECT 2')
    expect(statementAtCursor(`  \n${text}`, classifyText(`  \n${text}`), 0)?.text).toBe('SELECT 1')
  })

  it('clamps an offset outside the text', () => {
    expect(at(-5)?.text).toBe('SELECT 1')
    expect(at(10_000)?.text).toBe('SELECT 3')
  })

  it('picks nothing for one statement, an empty text or a text that did not parse', () => {
    expect(statementAtCursor('SELECT 1', classifyText('SELECT 1'), 3)).toBeUndefined()
    expect(statementAtCursor('', classifyText(''), 0)).toBeUndefined()
    expect(
      statementAtCursor(text, { ...result, status: 'parse_error', statements: [] }, 3),
    ).toBeUndefined()
  })

  it('slices by UTF-16 offsets, so text with astral characters stays whole', () => {
    const emoji = "SELECT '😀' AS a; SELECT 2"
    const pick = statementAtCursor(emoji, classifyText(emoji), emoji.length)
    expect(pick?.text).toBe('SELECT 2')
    const first = statementAtCursor(emoji, classifyText(emoji), 3)
    expect(first?.text).toBe("SELECT '😀' AS a")
  })
})

describe('sqlstateOf', () => {
  it('reads a SQLSTATE of the five characters of the class for QUERY_FAILED only', () => {
    expect(sqlstateOf('QUERY_FAILED', { sqlstate: '22012' })).toBe('22012')
    expect(sqlstateOf('QUERY_FAILED', { sqlstate: 'XX000' })).toBe('XX000')
    expect(sqlstateOf('QUERY_TIMEOUT', { sqlstate: '57014' })).toBeUndefined()
  })

  it('ignores anything that is not a SQLSTATE', () => {
    for (const details of [
      undefined,
      null,
      'x',
      42,
      [],
      {},
      { sqlstate: null },
      { sqlstate: 22012 },
      { sqlstate: '2201' },
      { sqlstate: '220122' },
      { sqlstate: '22a12' },
      { sqlstate: ' 22012' },
      { sqlstate: '22012\n' },
    ]) {
      expect(sqlstateOf('QUERY_FAILED', details)).toBeUndefined()
    }
  })
})

describe('markHidden', () => {
  it('writes hidden and direction characters as code points and keeps line breaks and tabs', () => {
    expect(markHidden(`a‮b​c\td\ne`)).toBe('a⟨U+202E⟩b⟨U+200B⟩c\td\ne')
  })

  it('leaves ordinary text, markup and non-ASCII letters as they are', () => {
    expect(markHidden('<b>é ñ 日本</b>')).toBe('<b>é ñ 日本</b>')
  })
})

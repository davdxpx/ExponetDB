import { describe, expect, it } from 'vitest'

import { codePointCount, takeCodePoints, truncateText } from '../../src/untrusted/truncate.ts'

describe('codePointCount', () => {
  it('counts code points, not UTF-16 units', () => {
    expect(codePointCount('abc')).toBe(3)
    expect(codePointCount('😀😀')).toBe(2)
    expect(codePointCount('')).toBe(0)
  })
})

describe('takeCodePoints', () => {
  it('returns the text unchanged when it fits', () => {
    expect(takeCodePoints('abc', 3)).toEqual({ head: 'abc', truncated: false })
    expect(takeCodePoints('abc', 10)).toEqual({ head: 'abc', truncated: false })
  })

  it('cuts at the limit', () => {
    expect(takeCodePoints('abcdef', 3)).toEqual({ head: 'abc', truncated: true })
  })

  it('never splits a surrogate pair', () => {
    expect(takeCodePoints('a😀b', 2)).toEqual({ head: 'a😀', truncated: true })
    expect(takeCodePoints('😀😀😀', 1)).toEqual({ head: '😀', truncated: true })
  })

  it('treats a limit of zero or less as nothing shown', () => {
    expect(takeCodePoints('abc', 0)).toEqual({ head: '', truncated: true })
    expect(takeCodePoints('abc', -4)).toEqual({ head: '', truncated: true })
    expect(takeCodePoints('', 0)).toEqual({ head: '', truncated: false })
  })

  it('does not call a text that has exactly as many code points as the limit truncated', () => {
    expect(takeCodePoints('😀😀', 2)).toEqual({ head: '😀😀', truncated: false })
  })
})

describe('truncateText', () => {
  it('keeps a text within both limits', () => {
    expect(truncateText('a\nb', { maxCodePoints: 10, maxLines: 5 })).toEqual({
      lines: ['a', 'b'],
      truncated: false,
    })
  })

  it('cuts by lines', () => {
    expect(truncateText('1\n2\n3\n4', { maxCodePoints: 100, maxLines: 2 })).toEqual({
      lines: ['1', '2'],
      truncated: true,
    })
  })

  it('cuts by code points inside a line and stops there', () => {
    expect(truncateText('abcdef\nghi', { maxCodePoints: 4, maxLines: 10 })).toEqual({
      lines: ['abcd'],
      truncated: true,
    })
  })

  it('counts a line break as one code point', () => {
    expect(truncateText('ab\ncd', { maxCodePoints: 4, maxLines: 10 })).toEqual({
      lines: ['ab', 'c'],
      truncated: true,
    })
  })

  it('splits on CRLF, LF and a lone CR', () => {
    expect(truncateText('a\r\nb\rc\nd', { maxCodePoints: 100, maxLines: 100 }).lines).toEqual([
      'a',
      'b',
      'c',
      'd',
    ])
  })

  it('accepts unlimited lines', () => {
    const text = Array.from({ length: 50 }, () => 'x').join('\n')
    const result = truncateText(text, {
      maxCodePoints: 1000,
      maxLines: Number.POSITIVE_INFINITY,
    })
    expect(result.lines).toHaveLength(50)
    expect(result.truncated).toBe(false)
  })
})

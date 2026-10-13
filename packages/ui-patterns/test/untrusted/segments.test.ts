import { describe, expect, it } from 'vitest'
import { describeCodePoint } from '../../src/untrusted/describe-code-point.ts'
import {
  codePointLabel,
  isInvisible,
  segmentLine,
  splitLines,
} from '../../src/untrusted/segments.ts'

describe('untrusted text segments', () => {
  it('keeps printable ASCII as one text run', () => {
    expect(segmentLine('DROP TABLE users;')).toEqual({
      segments: [{ kind: 'text', text: 'DROP TABLE users;' }],
      marked: 0,
    })
  })

  it('shows bidi overrides, zero-width and tag characters by code point and never applies them', () => {
    const { segments, marked } = segmentLine('a‮b​c\u{E0041}d')
    expect(segments).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'hidden', codePoint: 0x202e, label: '⟨U+202E⟩' },
      { kind: 'text', text: 'b' },
      { kind: 'hidden', codePoint: 0x200b, label: '⟨U+200B⟩' },
      { kind: 'text', text: 'c' },
      { kind: 'hidden', codePoint: 0xe0041, label: '⟨U+E0041⟩' },
      { kind: 'text', text: 'd' },
    ])
    expect(marked).toBe(3)
  })

  it('marks homoglyphs and shows tabs and control characters', () => {
    const { segments, marked } = segmentLine('\tа\u0000')
    expect(segments).toEqual([
      { kind: 'tab' },
      { kind: 'non-ascii', text: 'а', codePoint: 0x430 },
      { kind: 'hidden', codePoint: 0, label: '⟨U+0000⟩' },
    ])
    expect(marked).toBe(2)
  })

  it('knows the invisible ranges', () => {
    for (const cp of [
      0x7f, 0x9f, 0xad, 0x61c, 0x180e, 0x2028, 0x2066, 0x3164, 0xfe0f, 0xfeff, 0xe0001,
    ]) {
      expect(isInvisible(cp), cp.toString(16)).toBe(true)
    }
    for (const cp of [0x20, 0x41, 0x7e, 0xe9, 0x4e2d]) {
      expect(isInvisible(cp), cp.toString(16)).toBe(false)
    }
    expect(codePointLabel(0x41)).toBe('⟨U+0041⟩')
  })

  it('knows every default-ignorable and format character by Unicode property', () => {
    // These draw nothing (or a zero-width box) in a browser: `users` plus them looks like `users`.
    for (const cp of [
      0x1d173, 0x1d17a, 0x1bca0, 0x1bca3, 0x0600, 0x0605, 0x06dd, 0x070f, 0x0890, 0x08e2, 0x110bd,
      0x110cd, 0x13430, 0x1343f,
    ]) {
      expect(isInvisible(cp), cp.toString(16)).toBe(true)
      expect(describeCodePoint(cp), cp.toString(16)).not.toBe('')
    }
    expect(describeCodePoint(0x1d173)).toBe('format character')
    // Letters and visible symbols stay visible.
    for (const cp of [0x41, 0xe9, 0x5d0, 0x4e2d, 0x1f600]) expect(isInvisible(cp)).toBe(false)
  })

  it('splits CRLF, LF and lone CR so no line hides another', () => {
    expect(splitLines('a\r\nb\nc\rd')).toEqual(['a', 'b', 'c', 'd'])
  })
})

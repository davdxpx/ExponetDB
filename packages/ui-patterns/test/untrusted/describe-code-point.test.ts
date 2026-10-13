import { describe, expect, it } from 'vitest'

import { codePointId, describeCodePoint } from '../../src/untrusted/describe-code-point.ts'
import { isInvisible } from '../../src/untrusted/segments.ts'

describe('codePointId', () => {
  it('writes upper-case hexadecimal with at least four digits', () => {
    expect(codePointId(0x202e)).toBe('U+202E')
    expect(codePointId(0x9)).toBe('U+0009')
    expect(codePointId(0xe0041)).toBe('U+E0041')
  })
})

describe('describeCodePoint', () => {
  it('names the direction and joiner characters', () => {
    expect(describeCodePoint(0x202e)).toBe('right-to-left override')
    expect(describeCodePoint(0x2066)).toBe('left-to-right isolate')
    expect(describeCodePoint(0x200d)).toBe('zero width joiner')
    expect(describeCodePoint(0xfeff)).toBe('zero width no-break space')
  })

  it('names the class of the characters it has no name for', () => {
    expect(describeCodePoint(0x0001)).toBe('control character')
    expect(describeCodePoint(0x0085)).toBe('control character')
    expect(describeCodePoint(0xe0041)).toBe('tag character')
    expect(describeCodePoint(0xfe0f)).toBe('variation selector')
    expect(describeCodePoint(0xe0100)).toBe('variation selector')
    expect(describeCodePoint(0x2063)).toBe('invisible formatting character')
  })

  it('has an answer for every code point that segmentLine treats as invisible', () => {
    for (let cp = 0; cp < 0x10000; cp += 1) {
      if (isInvisible(cp)) expect(describeCodePoint(cp).length).toBeGreaterThan(0)
    }
    for (let cp = 0xe0000; cp <= 0xe0fff; cp += 1) {
      expect(describeCodePoint(cp).length).toBeGreaterThan(0)
    }
  })
})

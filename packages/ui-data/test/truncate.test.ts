import { describe, expect, it } from 'vitest'
import { truncateText } from '../src/index.ts'

describe('truncateText', () => {
  it('keeps short text and cuts long text at a code point boundary', () => {
    expect(truncateText('abc', 5)).toEqual({ shown: 'abc', truncated: false, total: 3 })
    expect(truncateText('a😀bc', 2)).toEqual({ shown: 'a😀', truncated: true, total: 4 })
  })
})

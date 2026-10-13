import { describe, expect, it } from 'vitest'
import { utf8Length } from '../src/rest/resources.ts'

describe('utf8Length', () => {
  it('counts UTF-8 bytes exactly as an encoder does', () => {
    for (const text of [
      '',
      'a',
      'é',
      '€',
      '😀',
      'a😀é€\u0000',
      'SELECT 1 -- ⟨U+202E⟩ ‮',
      '\ud800',
      'x\udc00y',
    ]) {
      expect(utf8Length(text), JSON.stringify(text)).toBe(Buffer.byteLength(text, 'utf8'))
    }
  })
})

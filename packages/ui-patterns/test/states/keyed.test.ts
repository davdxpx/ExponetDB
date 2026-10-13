import { describe, expect, it } from 'vitest'

import { keyedStrings } from '../../src/states/keyed.ts'

describe('keyedStrings', () => {
  it('gives equal strings different keys and keeps the order', () => {
    const keyed = keyedStrings(['a', 'b', 'a'])

    expect(keyed.map((item) => item.text)).toEqual(['a', 'b', 'a'])
    expect(new Set(keyed.map((item) => item.key)).size).toBe(3)
  })

  it('does not depend on the position of an item', () => {
    const before = keyedStrings(['x', 'y'])
    const after = keyedStrings(['y', 'x'])

    expect(after.find((item) => item.text === 'x')?.key).toBe(
      before.find((item) => item.text === 'x')?.key,
    )
  })
})

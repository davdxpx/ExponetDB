import { describe, expect, it } from 'vitest'
import { CATALOG_PARTS, en } from '../../src/lib/i18n/en.ts'

describe('the parts of the message catalog', () => {
  it('define each key once, and the catalog holds every key of every part', () => {
    const seen = new Map<string, string>()
    const twice: string[] = []
    for (const [part, messages] of Object.entries(CATALOG_PARTS)) {
      for (const key of Object.keys(messages)) {
        const earlier = seen.get(key)
        if (earlier !== undefined) twice.push(`${key} (${earlier} and ${part})`)
        seen.set(key, part)
      }
    }
    expect(twice).toEqual([])
    expect(Object.keys(en).sort()).toEqual([...seen.keys()].sort())
  })
})

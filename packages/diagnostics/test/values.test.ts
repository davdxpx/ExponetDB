import { describe, expect, it } from 'vitest'
import { typedValue } from '../src/data-read/values.ts'

const JSONB = 3802

describe('json and jsonb values (Wave 7 review)', () => {
  it('keeps a value as its exact text when a number would not survive a JavaScript number', () => {
    for (const text of [
      '{"id": 1234567890123456789}',
      '[1e400]',
      '[1e-400]',
      '0.1000000000000000055511',
      '{"a": {"b": [-9007199254740993]}}',
    ]) {
      expect(typedValue(text, JSONB, 'jsonb'), text).toBe(text)
    }
  })

  it('parses values whose numbers are exact, and skips digits inside strings', () => {
    expect(typedValue('{"p": 12.50, "n": -3, "e": 1.5e3, "z": 0.0}', JSONB, 'jsonb')).toEqual({
      p: 12.5,
      n: -3,
      e: 1500,
      z: 0,
    })
    expect(typedValue('{"a": [1, 2], "b": "x\\"9999999999999999999"}', JSONB, 'jsonb')).toEqual({
      a: [1, 2],
      b: 'x"9999999999999999999',
    })
    expect(typedValue('[9007199254740991, 0.123456789012345]', JSONB, 'jsonb')).toEqual([
      9007199254740991, 0.123456789012345,
    ])
  })

  it('stays linear on a value with many numbers (up to the JSON cap)', () => {
    const many = `[${Array.from({ length: 12_000 }, (_, i) => i).join(',')}]`
    expect(many.length).toBeLessThan(65_536)
    const started = performance.now()
    expect((typedValue(many, JSONB, 'jsonb') as number[]).length).toBe(12_000)
    expect(performance.now() - started).toBeLessThan(2_000)
  })
})

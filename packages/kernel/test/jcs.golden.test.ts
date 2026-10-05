import { describe, expect, it } from 'vitest'
import { sha256Hex } from '../src/hash/index.ts'
import { canonicalize, parseJson } from '../src/index.ts'
import { loadGolden } from './golden.ts'

interface JcsVector {
  id: string
  description: string
  input: string
  expected?: string
  sha256?: string
  expectedError?: string
}

const { vectors } = loadGolden<{ vectors: JcsVector[] }>('jcs.json')

describe('RFC 8785 golden vectors (tooling/golden/jcs.json)', () => {
  it('has vectors', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(50)
  })

  for (const v of vectors) {
    it(`${v.id}: ${v.description}`, () => {
      const parsed = parseJson(v.input)
      if (v.expectedError !== undefined) {
        expect(parsed.ok ? 'ok' : parsed.error.code).toBe(v.expectedError)
        return
      }
      if (!parsed.ok) {
        throw new Error(`parse failed: ${parsed.error.code}`)
      }
      const canonical = canonicalize(parsed.value)
      expect(canonical).toEqual({ ok: true, value: v.expected })
      expect(sha256Hex(v.expected ?? '')).toBe(v.sha256)
    })
  }
})

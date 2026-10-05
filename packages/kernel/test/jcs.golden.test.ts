import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { sha256Hex } from '../src/hash/index.ts'
import { canonicalize, parseJson } from '../src/index.ts'
import { loadGolden } from './golden.ts'

const JcsVectorSchema = z.strictObject({
  id: z.string(),
  description: z.string(),
  input: z.string(),
  expected: z.string().optional(),
  sha256: z.string().optional(),
  expectedError: z.string().optional(),
})

const { vectors } = loadGolden('jcs.json', z.object({ vectors: z.array(JcsVectorSchema) }))

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

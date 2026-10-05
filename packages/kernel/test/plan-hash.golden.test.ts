import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { computePlanHash } from '../src/hash/index.ts'
import { canonicalize, type JsonValue, toJsonValue } from '../src/index.ts'
import { loadGolden } from './golden.ts'

const PlanVectorSchema = z.strictObject({
  id: z.string(),
  description: z.string(),
  plan: z.unknown(),
  expected: z.strictObject({ canonical: z.string(), planHash: z.string() }).optional(),
  expectedError: z.string().optional(),
})

const { vectors } = loadGolden('plan-hash.json', z.object({ vectors: z.array(PlanVectorSchema) }))

function json(value: unknown): JsonValue {
  const checked = toJsonValue(value)
  if (!checked.ok) {
    throw new Error(checked.error.code)
  }
  return checked.value
}

describe('plan hash golden vectors (tooling/golden/plan-hash.json)', () => {
  for (const v of vectors) {
    it(`${v.id}: ${v.description}`, () => {
      const result = computePlanHash(json(v.plan))
      if (v.expectedError !== undefined) {
        expect(result.ok ? 'ok' : result.error.code).toBe(v.expectedError)
        return
      }
      expect(canonicalize(v.plan)).toEqual({ ok: true, value: v.expected?.canonical })
      expect(result).toEqual({ ok: true, value: v.expected?.planHash })
    })
  }

  it('refuses a value that is not an object', () => {
    expect(computePlanHash([])).toEqual({ ok: false, error: { code: 'not_json' } })
  })
})

import { describe, expect, it } from 'vitest'
import { computePlanHash } from '../src/hash/index.ts'
import { canonicalize, type JsonValue, toJsonValue } from '../src/index.ts'
import { loadGolden } from './golden.ts'

interface PlanVector {
  id: string
  description: string
  plan: unknown
  expected?: { canonical: string; planHash: string }
  expectedError?: string
}

const { vectors } = loadGolden<{ vectors: PlanVector[] }>('plan-hash.json')

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

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  isJsonArray,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  parseJson,
} from '@exponetdb/kernel'
import { describe, expect, it } from 'vitest'
import { policyVersion } from '../src/index.ts'

/**
 * pv1 golden vectors (tooling/golden/policy-version.json), derived by an
 * independent Python script from the specification.
 */
const file = fileURLToPath(new URL('../../../tooling/golden/policy-version.json', import.meta.url))
const parsed = parseJson(readFileSync(file, 'utf8'))
if (!parsed.ok || !isJsonObject(parsed.value) || !isJsonArray(parsed.value['vectors'])) {
  throw new Error('policy-version.json is not a vector file')
}
const vectors = parsed.value['vectors'].filter(isJsonObject)
const obj = (value: JsonValue | undefined): JsonObject => {
  if (!isJsonObject(value)) {
    throw new Error('expected an object in the vector')
  }
  return value
}

const computed = new Map<string, string>()

describe('pv1 golden vectors', () => {
  it('cover empty input, ordering, code, rule versions, configuration and refusals', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(17)
  })

  for (const v of vectors) {
    const id = String(v['id'])
    it(`${id}: ${String(v['description'])}`, () => {
      const input = obj(v['input'])
      const rules = input['rules']
      const result = policyVersion(
        String(input['codeVersion']),
        isJsonArray(rules) ? rules : [],
        input['config'] ?? null,
      )
      if (typeof v['expectedError'] === 'string') {
        expect(result).toEqual({ ok: false, error: v['expectedError'] })
        return
      }
      const expected = obj(v['expected'])
      expect(result).toEqual({ ok: true, value: expected['policyVersion'] })
      computed.set(id, String(expected['policyVersion']))
      for (const other of isJsonArray(v['sameAs']) ? v['sameAs'] : []) {
        expect(computed.get(String(other))).toBe(expected['policyVersion'])
      }
      for (const other of isJsonArray(v['differsFrom']) ? v['differsFrom'] : []) {
        expect(computed.get(String(other))).not.toBe(expected['policyVersion'])
      }
    })
  }
})

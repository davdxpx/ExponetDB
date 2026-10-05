import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isJsonArray, isJsonObject, type JsonValue, parseJson } from '@exponetdb/kernel'
import { describe, expect, it } from 'vitest'
import { auditChainHash } from '../src/index.ts'

/**
 * ac1 golden vectors (tooling/golden/audit-chain.json). The expected values
 * were derived from the specification with an independent Python script,
 * not from this code. Locked and append-only like every golden file.
 */
const file = fileURLToPath(new URL('../../../tooling/golden/audit-chain.json', import.meta.url))
const parsed = parseJson(readFileSync(file, 'utf8'))
if (!parsed.ok || !isJsonObject(parsed.value) || !isJsonArray(parsed.value['vectors'])) {
  throw new Error('audit-chain.json is not a vector file')
}
const vectors = parsed.value['vectors'].filter(isJsonObject)

function str(v: JsonValue | undefined): string {
  if (typeof v !== 'string') {
    throw new Error('expected a string in the vector')
  }
  return v
}

function eventOf(
  v: Record<string, JsonValue>,
): { ok: true; value: JsonValue } | { ok: false; code: string } {
  if (Object.hasOwn(v, 'eventJson')) {
    const p = parseJson(str(v['eventJson']))
    return p.ok ? { ok: true, value: p.value } : { ok: false, code: p.error.code }
  }
  const e = v['event']
  if (e === undefined) {
    throw new Error('vector without event')
  }
  return { ok: true, value: e }
}

const computed = new Map<string, string>()

describe('ac1 golden vectors', () => {
  it('covers genesis, chaining, unicode, nulls, optional members, order, changes and refusals', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(27)
  })

  for (const v of vectors) {
    const id = str(v['id'])
    it(`${id}: ${str(v['description'])}`, () => {
      const event = eventOf(v)
      const expected = v['expected']
      if (isJsonObject(expected)) {
        expect(event.ok).toBe(true)
        if (!event.ok) {
          return
        }
        const result = auditChainHash(str(v['prevHash']), event.value)
        expect(result).toEqual({
          ok: true,
          value: { canonical: expected['canonical'], hash: expected['hash'] },
        })
        if (result.ok) {
          computed.set(id, result.value.hash)
        }
        return
      }
      const error = str(v['expectedError'])
      if (!event.ok) {
        expect(event.code).toBe(error)
        return
      }
      const result = auditChainHash(str(v['prevHash']), event.value)
      expect(result.ok ? 'ok' : result.error.code).toBe(error)
    })
  }

  it('relations: sameHashAs and differsFrom hold as stated', () => {
    for (const v of vectors) {
      const id = str(v['id'])
      const same = v['sameHashAs']
      const differs = v['differsFrom']
      if (typeof same === 'string') {
        expect(computed.get(id), id).toBe(computed.get(same))
      }
      if (typeof differs === 'string') {
        expect(computed.get(id), id).not.toBe(computed.get(differs))
        expect(computed.get(id)).toBeDefined()
      }
    }
  })

  it('the chain of ac1-001 and ac1-002 links: ac1-002 prevHash is the hash of ac1-001', () => {
    const second = vectors.find((v) => v['id'] === 'ac1-002')
    expect(second?.['prevHash']).toBe(computed.get('ac1-001'))
  })
})

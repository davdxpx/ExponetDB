import { describe, expect, it } from 'vitest'
import { canonicalize, isJsonObject, isJsonValue, parseJson, toJsonValue } from '../src/index.ts'

describe('strict JSON parsing', () => {
  it('keeps __proto__ as an ordinary member and does not touch the prototype', () => {
    const parsed = parseJson('{"__proto__": {"polluted": true}, "a": 1}')
    if (!parsed.ok) {
      throw new Error(parsed.error.code)
    }
    if (!isJsonObject(parsed.value)) {
      throw new Error('expected a JSON object')
    }
    expect(Object.keys(parsed.value)).toEqual(['__proto__', 'a'])
    expect(Object.getPrototypeOf(parsed.value)).toBe(Object.prototype)
    const fresh: Record<string, unknown> = {}
    expect(fresh['polluted']).toBeUndefined()
    expect(canonicalize(parsed.value)).toEqual({
      ok: true,
      value: '{"__proto__":{"polluted":true},"a":1}',
    })
  })

  it('limits nesting depth', () => {
    expect(parseJson(`${'['.repeat(300)}${']'.repeat(300)}`)).toMatchObject({
      ok: false,
      error: { code: 'nesting_too_deep' },
    })
    expect(parseJson(`${'['.repeat(100)}${']'.repeat(100)}`).ok).toBe(true)
  })

  it('reports the offset of a syntax error', () => {
    expect(parseJson('{"a": 1,}')).toEqual({
      ok: false,
      error: { code: 'invalid_json', offset: 8 },
    })
  })

  it('refuses text with lone surrogates before parsing', () => {
    expect(parseJson('"\ud800"')).toEqual({ ok: false, error: { code: 'lone_surrogate' } })
  })
})

describe('in-memory JSON values', () => {
  const sparse = new Array<number>(3)
  sparse[0] = 1
  sparse[2] = 3
  const refusals: [string, unknown, string][] = [
    ['undefined', undefined, 'not_json'],
    ['a function', () => 1, 'not_json'],
    ['a bigint', 1n, 'not_json'],
    ['a symbol', Symbol('x'), 'not_json'],
    ['NaN', Number.NaN, 'number_not_finite'],
    ['Infinity', [Number.POSITIVE_INFINITY], 'number_not_finite'],
    ['a Date', new Date(0), 'not_json'],
    ['a Map', new Map(), 'not_json'],
    ['an object member that is undefined', { a: undefined }, 'not_json'],
    ['a sparse array', sparse, 'not_json'],
    ['a lone surrogate', 'a\udc00', 'lone_surrogate'],
    ['a lone surrogate member name', { '\ud800': 1 }, 'lone_surrogate'],
    ['a symbol-keyed member', { [Symbol('s')]: 1 }, 'not_json'],
  ]
  for (const [name, value, code] of refusals) {
    it(`refuses ${name}`, () => {
      expect(toJsonValue(value)).toEqual({ ok: false, error: { code } })
      expect(isJsonValue(value)).toBe(false)
      expect(canonicalize(value)).toEqual({ ok: false, error: { code } })
    })
  }

  it('refuses cycles', () => {
    const a: Record<string, unknown> = {}
    a['self'] = a
    expect(toJsonValue(a)).toEqual({ ok: false, error: { code: 'not_json' } })
  })

  it('accepts shared but acyclic references', () => {
    const shared = { x: 1 }
    expect(canonicalize({ a: shared, b: shared })).toEqual({
      ok: true,
      value: '{"a":{"x":1},"b":{"x":1}}',
    })
  })

  it('accepts null-prototype objects', () => {
    const o: Record<string, unknown> = Object.create(null)
    o['b'] = 1
    o['a'] = 2
    expect(canonicalize(o)).toEqual({ ok: true, value: '{"a":2,"b":1}' })
  })
})

describe('canonical form', () => {
  it('sorts integer-like member names as strings, not numerically', () => {
    expect(canonicalize({ 10: 'a', 9: 'b', '\r': 'c', a: 'd' })).toEqual({
      ok: true,
      value: '{"\\r":"c","10":"a","9":"b","a":"d"}',
    })
  })

  it('is idempotent', () => {
    const once = canonicalize({ b: [1.5, -0, 'é'], a: { d: null, c: true } })
    if (!once.ok) {
      throw new Error(once.error.code)
    }
    const reparsed = parseJson(once.value)
    if (!reparsed.ok) {
      throw new Error(reparsed.error.code)
    }
    expect(canonicalize(reparsed.value)).toEqual(once)
  })
})

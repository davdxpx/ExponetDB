import { describe, expect, it } from 'vitest'

import { cellFromWire } from '../../src/grid/wire.ts'

describe('cellFromWire', () => {
  it('passes NULL, booleans, numbers and strings through', () => {
    expect(cellFromWire('text', null)).toBeNull()
    expect(cellFromWire('text', undefined)).toBeNull()
    expect(cellFromWire('bool', true)).toBe(true)
    expect(cellFromWire('int4', 42)).toBe(42)
    expect(cellFromWire('int8', '9007199254740993')).toBe('9007199254740993')
    expect(cellFromWire('numeric', '12.50')).toBe('12.50')
    expect(cellFromWire('timestamptz', '2026-10-13T08:00:00.5Z')).toBe('2026-10-13T08:00:00.5Z')
    expect(cellFromWire('text', '')).toBe('')
  })

  it('keeps a number that is not finite as text', () => {
    expect(cellFromWire('float8', Number.NaN)).toBe('NaN')
    expect(cellFromWire('float8', Number.POSITIVE_INFINITY)).toBe('Infinity')
  })

  it('writes a parsed JSON value as compact JSON text', () => {
    expect(cellFromWire('jsonb', { a: [1, 2], b: null })).toBe('{"a":[1,2],"b":null}')
    expect(cellFromWire('json', [1, 'x'])).toBe('[1,"x"]')
    expect(cellFromWire('jsonb', 12)).toBe(12)
    expect(cellFromWire('jsonb', false)).toBe(false)
  })

  it('takes a string of a json column as JSON text when it is valid JSON, else as a JSON string', () => {
    // The server keeps the raw text when a number would not survive a double.
    expect(cellFromWire('jsonb', '{"id":12345678901234567890}')).toBe('{"id":12345678901234567890}')
    expect(cellFromWire('jsonb', 'hello')).toBe('"hello"')
    expect(cellFromWire('jsonb', 'say "hi"')).toBe('"say \\"hi\\""')
    // Not a json column: a string is a string.
    expect(cellFromWire('text', '{"a":1}')).toBe('{"a":1}')
  })

  it('writes a bytea value as \\x hex', () => {
    expect(cellFromWire('bytea', { hex: 'deadbeef', bytes: 4 })).toBe('\\xdeadbeef')
  })

  it('marks a bytea value the server cut with the size of the whole', () => {
    expect(cellFromWire('bytea', { hex: 'dead', bytes: 5_000, truncatedAt: 2 })).toEqual({
      truncated: true,
      preview: '\\xdead',
      bytes: 5_000,
      unit: 'bytes',
    })
  })

  it('marks a text the server cut with its length in characters', () => {
    expect(cellFromWire('text', { value: 'abc', truncatedAt: 3, length: 12_000 })).toEqual({
      truncated: true,
      preview: 'abc',
      bytes: 12_000,
      unit: 'characters',
    })
  })

  it('writes a whole vector as text and marks a vector cut to its first values', () => {
    expect(cellFromWire('vector', { dimension: 3, head: [1, 2, 3] })).toBe('[1,2,3]')
    expect(cellFromWire('vector', { dimension: 1536, head: [0.1, 0.2] })).toEqual({
      truncated: true,
      preview: '[0.1,0.2,',
      bytes: 1_536,
      unit: 'dimensions',
    })
  })

  it('does not mistake a json object that looks like a bytea value for one', () => {
    expect(cellFromWire('jsonb', { hex: 'dead', bytes: 2 })).toBe('{"hex":"dead","bytes":2}')
  })

  it('does not mistake a json object that looks like a vector for one', () => {
    expect(cellFromWire('jsonb', { dimension: 2, head: [1, 2] })).toBe(
      '{"dimension":2,"head":[1,2]}',
    )
  })

  it('writes any other object as JSON text and a bigint as digits', () => {
    expect(cellFromWire('text', { a: 1 })).toBe('{"a":1}')
    expect(cellFromWire('text', [1, 2])).toBe('[1,2]')
    expect(cellFromWire('int8', 12n)).toBe('12')
  })
})

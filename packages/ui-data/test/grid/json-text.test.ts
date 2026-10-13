import { describe, expect, it } from 'vitest'

import { compactJson, prettyJson } from '../../src/grid/json-text.ts'

describe('compactJson', () => {
  it('removes whitespace outside strings and keeps it inside', () => {
    const text = '{\n  "a": [1, 2,  3],\n  "b c": "x  y\\n z"\n}'
    expect(compactJson(text, 1_000)).toEqual({
      head: '{"a":[1,2,3],"b c":"x  y\\n z"}',
      cut: false,
    })
  })

  it('keeps every digit of a number a double cannot hold', () => {
    expect(compactJson('{ "id": 12345678901234567890, "e": 1e400 }', 1_000).head).toBe(
      '{"id":12345678901234567890,"e":1e400}',
    )
  })

  it('does not mistake an escaped quote for the end of a string', () => {
    expect(compactJson('[ "a \\" b" , 1 ]', 1_000).head).toBe('["a \\" b",1]')
  })

  it('stops at the limit and says it went on', () => {
    const result = compactJson(`[${'1, '.repeat(1_000)}1]`, 20)
    expect(result.cut).toBe(true)
    expect(result.head.length).toBeLessThanOrEqual(20)
  })

  it('passes text that is not JSON through the same scan', () => {
    expect(compactJson('not json  at all', 1_000).head).toBe('notjsonatall')
  })
})

describe('prettyJson', () => {
  it('indents valid JSON by two spaces and leaves digits and strings alone', () => {
    expect(prettyJson('{"a":[1,2],"b":{"c":"x, y: z"},"d":12345678901234567890}')).toBe(
      [
        '{',
        '  "a": [',
        '    1,',
        '    2',
        '  ],',
        '  "b": {',
        '    "c": "x, y: z"',
        '  },',
        '  "d": 12345678901234567890',
        '}',
      ].join('\n'),
    )
  })

  it('keeps empty objects and arrays on one line', () => {
    expect(prettyJson('{"a":{},"b":[ ]}')).toBe('{\n  "a": {},\n  "b": []\n}')
  })

  it('returns text that is not valid JSON as it is', () => {
    expect(prettyJson('{"a":')).toBe('{"a":')
    expect(prettyJson('plain text')).toBe('plain text')
  })

  it('returns a scalar as it is', () => {
    expect(prettyJson('"just a string"')).toBe('"just a string"')
    expect(prettyJson('42')).toBe('42')
  })
})

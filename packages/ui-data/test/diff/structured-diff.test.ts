import { describe, expect, it } from 'vitest'

import {
  classifyDiffRow,
  countDiffRows,
  type StructuredDiffRow,
} from '../../src/diff/structured-diff.ts'

describe('classifyDiffRow', () => {
  it.each<[string, StructuredDiffRow, string]>([
    ['absent before', { key: 'a', before: null, after: '1' }, 'added'],
    ['absent after', { key: 'a', before: '1', after: null }, 'removed'],
    ['different text', { key: 'a', before: '1', after: '2' }, 'changed'],
    ['same text', { key: 'a', before: '1', after: '1' }, 'unchanged'],
    ['absent on both sides', { key: 'a', before: null, after: null }, 'unchanged'],
    ['empty before and absent after', { key: 'a', before: '', after: null }, 'removed'],
    ['absent before and empty after', { key: 'a', before: null, after: '' }, 'added'],
    ['empty to non-empty', { key: 'a', before: '', after: 'x' }, 'changed'],
    ['text that differs only in case', { key: 'a', before: 'on', after: 'ON' }, 'changed'],
    ['text that differs only in whitespace', { key: 'a', before: 'a b', after: 'a  b' }, 'changed'],
  ])('%s is %s', (_name, row, expected) => {
    expect(classifyDiffRow(row)).toBe(expected)
  })

  it('counts every row once', () => {
    expect(
      countDiffRows([
        { key: 'a', before: null, after: '1' },
        { key: 'b', before: '1', after: '2' },
        { key: 'c', before: '1', after: null },
        { key: 'd', before: '1', after: '1' },
        { key: 'e', before: '1', after: '1' },
      ]),
    ).toEqual({ added: 1, changed: 1, removed: 1, unchanged: 2 })
  })
})

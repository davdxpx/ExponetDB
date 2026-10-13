import { describe, expect, it } from 'vitest'

import {
  countSchemaChanges,
  countSchemaClasses,
  groupSchemaDiff,
  type SchemaDiffEntry,
} from '../../src/diff/schema-diff.ts'

function entry(
  objectType: string,
  name: string,
  change: SchemaDiffEntry['change'] = 'changed',
  classes: SchemaDiffEntry['classes'] = [],
): SchemaDiffEntry {
  return { objectType, schema: 'public', name, change, classes, details: '' }
}

describe('groupSchemaDiff', () => {
  it('orders known types by dependency and unknown types after them by first appearance', () => {
    const groups = groupSchemaDiff([
      entry('function', 'f'),
      entry('zeta', 'z1'),
      entry('table', 't'),
      entry('alpha', 'a1'),
      entry('extension', 'e'),
      entry('zeta', 'z2'),
    ])
    expect(groups.map((group) => group.objectType)).toEqual([
      'extension',
      'table',
      'function',
      'zeta',
      'alpha',
    ])
    expect(groups.find((group) => group.objectType === 'table')?.label).toBe('Tables')
    expect(groups.find((group) => group.objectType === 'zeta')?.label).toBeNull()
  })

  it('keeps the order the server gave within a group', () => {
    const groups = groupSchemaDiff([entry('table', 'b'), entry('table', 'a'), entry('table', 'c')])
    expect(groups[0]?.items.map((item) => item.entry.name)).toEqual(['b', 'a', 'c'])
  })

  it('gives entries that repeat a name distinct keys', () => {
    const groups = groupSchemaDiff([entry('function', 'f'), entry('function', 'f')])
    const keys = groups[0]?.items.map((item) => item.key) ?? []
    expect(new Set(keys).size).toBe(2)
  })

  it('drops repeated classes of an entry', () => {
    const groups = groupSchemaDiff([
      entry('table', 't', 'changed', ['rewrite', 'rewrite', 'security']),
    ])
    expect(groups[0]?.items[0]?.classes).toEqual(['rewrite', 'security'])
  })

  it('does not treat names of Object.prototype as labels', () => {
    const groups = groupSchemaDiff([entry('constructor', 'x'), entry('__proto__', 'y')])
    expect(groups.map((group) => group.label)).toEqual([null, null])
  })
})

describe('schema diff counts', () => {
  const entries = [
    entry('table', 'a', 'added'),
    entry('table', 'b', 'removed', ['destructive']),
    entry('table', 'c', 'changed', ['rewrite', 'security']),
    entry('view', 'd', 'changed', ['security']),
    { ...entry('view', 'e'), change: 'renamed' as SchemaDiffEntry['change'] },
  ]

  it('counts the changes and counts an unknown one apart', () => {
    expect(countSchemaChanges(entries)).toEqual({ added: 1, removed: 1, changed: 2, other: 1 })
  })

  it('counts each statement class once per entry', () => {
    expect(countSchemaClasses(entries)).toEqual([
      ['destructive', 1],
      ['rewrite', 1],
      ['security', 2],
    ])
  })
})

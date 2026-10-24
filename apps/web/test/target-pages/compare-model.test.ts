import type { SchemaDiff } from '@exponetdb/sdk/operations'
import { describe, expect, it } from 'vitest'
import {
  compareSearch,
  diffCounts,
  diffEntries,
  namedRefusal,
} from '../../src/features/compare/model.ts'

function ref(schema: string, name: string, kind: string, parent: string | null = null) {
  return { key: [kind, schema, parent ?? '', name], kind, name, parent, schema, signature: null }
}

const DIFF = {
  comparable: true,
  left: { fingerprint: `fp1:17:${'a'.repeat(64)}` },
  right: { fingerprint: `fp1:17:${'b'.repeat(64)}` },
  groups: [
    {
      objectClass: 'function',
      added: [{ ...ref('public', 'touch', 'function'), signature: '(integer)' }],
      removed: [],
      changed: [],
    },
    {
      objectClass: 'policy',
      added: [],
      removed: [ref('public', 'old', 'policy', 'orders')],
      changed: [
        { ref: ref('public', 'tenant', 'policy', 'orders'), attributes: ['qual', 'roles'] },
      ],
    },
  ],
  totals: { added: 1, removed: 1, changed: 5, matched: 2, securityRelevant: 1 },
  securityRelevant: [ref('public', 'tenant', 'policy', 'orders')],
  truncated: true,
} as unknown as SchemaDiff

describe('the compare search', () => {
  it('keeps a slug and drops everything else, always returning the key', () => {
    expect(compareSearch({ to: 'production' })).toEqual({ to: 'production' })
    for (const bad of ['', '../x', 'Production', 'a/b', `prod‮`, 7, ['production'], null]) {
      expect(compareSearch({ to: bad }), String(bad)).toEqual({ to: undefined })
    }
    expect(compareSearch({})).toEqual({ to: undefined })
  })
})

describe('the diff as entries', () => {
  it('turns groups into added, removed and changed entries with names, details and security', () => {
    expect(diffEntries(DIFF)).toEqual([
      {
        objectType: 'function',
        schema: 'public',
        name: 'touch(integer)',
        change: 'added',
        classes: [],
        details: '',
      },
      {
        objectType: 'policy',
        schema: 'public',
        name: 'orders.old',
        change: 'removed',
        classes: [],
        details: '',
      },
      {
        objectType: 'policy',
        schema: 'public',
        name: 'orders.tenant',
        change: 'changed',
        classes: ['security'],
        details: 'qual, roles',
      },
    ])
  })

  it('counts what the diff lists against the totals before any cap', () => {
    expect(diffCounts(DIFF)).toEqual({ listed: 3, total: 7 })
  })

  it('names only the refusals the page explains', () => {
    expect(namedRefusal('SCHEMA_FINGERPRINT_MISMATCH')).toBe('SCHEMA_FINGERPRINT_MISMATCH')
    expect(namedRefusal('SAMPLE_STALE')).toBe('SAMPLE_STALE')
    expect(namedRefusal('INTERNAL')).toBeUndefined()
    expect(namedRefusal('constructor')).toBeUndefined()
  })
})

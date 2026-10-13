import type { Readable } from '@exponetdb/ui-patterns'
import { describe, expect, it } from 'vitest'

import type { SchemaTreeObject } from '../../src/schema/schema-tree-types.ts'
import {
  type BranchLoad,
  branchObjects,
  branchStatus,
  buildSchemaTree,
  ROOT_ID,
  selectionOf,
} from '../../src/schema/tree-model.ts'
import { FAILED, partial, ready, stale } from './fixtures.ts'

type Answer = Readable<readonly SchemaTreeObject[]>

const CLASSES = [
  { id: 'table', label: 'Tables' },
  { id: 'view', label: 'Views' },
]

function load(readable: Answer | null, loading = false): BranchLoad {
  return { readable, loading }
}

describe('branchStatus', () => {
  it.each<[string, BranchLoad | undefined, string | null]>([
    ['a branch never read', undefined, null],
    ['the first read open', load(null, true), 'loading'],
    ['a loader that answered loading', load({ state: 'loading' }), 'loading'],
    ['a failed read', load(FAILED), 'failed'],
    ['a failed read being retried', load(FAILED, true), 'loading'],
    ['an earlier read', load(stale([{ name: 'a' }])), 'stale'],
    ['an earlier read being refreshed', load(stale([{ name: 'a' }]), true), 'refreshing'],
    ['a partial read', load(partial([{ name: 'a' }], ['x'])), 'partial'],
    ['a partial read, empty', load(partial([], ['x'])), 'partial'],
    ['a complete read with objects', load(ready([{ name: 'a' }])), null],
    ['a complete read with none', load(ready([])), 'empty'],
    ['a complete read being refreshed', load(ready([{ name: 'a' }]), true), 'refreshing'],
  ])('%s', (_name, input, expected) => {
    expect(branchStatus(input)?.type ?? null).toBe(expected)
  })

  it('reads a state it does not know as a failed read, never as empty', () => {
    const malformed = { state: 'bogus' } as unknown as Answer
    expect(branchStatus(load(malformed))).toEqual({
      type: 'failed',
      error: { code: 'UNKNOWN', message: 'The state of this read was not recognized.' },
    })
    expect(branchObjects(load(malformed))).toEqual([])
  })

  it('keeps the objects of a read that has some, and none otherwise', () => {
    const objects = [{ name: 'a' }]
    expect(branchObjects(load(ready(objects)))).toBe(objects)
    expect(branchObjects(load(stale(objects)))).toBe(objects)
    expect(branchObjects(load(partial(objects, ['x'])))).toBe(objects)
    expect(branchObjects(load(FAILED))).toEqual([])
    expect(branchObjects(load(null, true))).toEqual([])
    expect(branchObjects(undefined)).toEqual([])
  })
})

describe('buildSchemaTree', () => {
  it('builds a root, the schemas, the classes and the objects of a loaded class', () => {
    const first = buildSchemaTree([{ name: 'public' }], CLASSES, {})
    const classNode = first.data.find((node) => first.info.get(node.id)?.kind === 'class')
    if (classNode === undefined) throw new Error('no class node')
    const model = buildSchemaTree([{ name: 'public' }], CLASSES, {
      [String(classNode.id)]: load(ready([{ name: 'users' }, { name: 'orders' }])),
    })

    expect(model.data[0]).toMatchObject({ id: ROOT_ID, parent: null })
    expect(model.data).toHaveLength(1 + 1 + 2 + 2)
    const kinds = model.data.map((node) => model.info.get(node.id)?.kind)
    expect(kinds).toEqual([undefined, 'schema', 'class', 'object', 'object', 'class'])
    expect(model.info.get(classNode.id)).toMatchObject({ kind: 'class', count: 2, loading: false })
    expect(model.branches.get(classNode.id)).toEqual({ schema: 'public', classId: 'table' })
  })

  it('puts a status row before the objects of a branch that has both', () => {
    const base = buildSchemaTree([{ name: 'public' }], CLASSES, {})
    const classNode = base.data.find((node) => base.info.get(node.id)?.kind === 'class')
    if (classNode === undefined) throw new Error('no class node')
    const model = buildSchemaTree([{ name: 'public' }], CLASSES, {
      [String(classNode.id)]: load(partial([{ name: 'a' }], ['Row counts.'])),
    })
    const children = model.data.find((node) => node.id === classNode.id)?.children ?? []
    expect(children.map((id) => model.info.get(id)?.kind)).toEqual(['status', 'object'])
    // A partial read has no count.
    expect(model.info.get(classNode.id)).toMatchObject({ count: null })
  })

  it('gives every node its own id, whatever the names are', () => {
    const schemas = [
      { name: 'a' },
      { name: 'a' },
      { name: 'a:b' },
      { name: 'a' },
      { name: '' },
      { name: '__proto__' },
      { name: 'constructor' },
    ]
    const classes = [
      { id: 'x', label: 'X' },
      { id: 'x', label: 'X again' },
      { id: 'b:c', label: 'BC' },
    ]
    const base = buildSchemaTree(schemas, classes, {})
    const loads: Record<string, BranchLoad> = {}
    for (const node of base.data) {
      if (base.info.get(node.id)?.kind === 'class') {
        loads[String(node.id)] = load(
          ready([{ name: 'o' }, { name: 'o' }, { name: 'p', key: 'o' }, { name: 'q:r' }]),
        )
      }
    }
    const model = buildSchemaTree(schemas, classes, loads)
    const ids = model.data.map((node) => node.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const node of model.data) {
      for (const child of node.children) {
        expect(model.data.find((other) => other.id === child)?.parent).toBe(node.id)
      }
    }
  })

  it('never gives a node an empty name, which the type-ahead of the tree cannot take', () => {
    const base = buildSchemaTree([{ name: '' }], [{ id: 't', label: 'T' }], {})
    const classNode = base.data.find((node) => base.info.get(node.id)?.kind === 'class')
    if (classNode === undefined) throw new Error('no class node')
    const model = buildSchemaTree([{ name: '' }], [{ id: 't', label: 'T' }], {
      [String(classNode.id)]: load(partial([{ name: '' }], ['x'])),
    })
    for (const node of model.data.slice(1)) expect(node.name).not.toBe('')
  })
})

describe('selectionOf', () => {
  it('describes schemas, classes and objects, and nothing for a status row or an unknown node', () => {
    const base = buildSchemaTree([{ name: 'public' }], CLASSES, {})
    const classNode = base.data.find((node) => base.info.get(node.id)?.kind === 'class')
    if (classNode === undefined) throw new Error('no class node')
    const model = buildSchemaTree([{ name: 'public' }], CLASSES, {
      [String(classNode.id)]: load(partial([{ name: 'a', key: 'a(1)' }], ['x'])),
    })
    const selections = model.data.map((node) => selectionOf(model.info.get(node.id)))
    expect(selections).toEqual([
      null,
      { kind: 'schema', schema: 'public' },
      { kind: 'class', schema: 'public', classId: 'table' },
      null,
      { kind: 'object', schema: 'public', classId: 'table', name: 'a', key: 'a(1)' },
      { kind: 'class', schema: 'public', classId: 'view' },
    ])
    expect(selectionOf(undefined)).toBeNull()
  })
})

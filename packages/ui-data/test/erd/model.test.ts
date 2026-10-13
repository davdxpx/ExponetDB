import { describe, expect, it } from 'vitest'

import { buildErdModel } from '../../src/erd/model.ts'
import type { ErdRelation, ErdTable, SchemaErdData } from '../../src/erd/types.ts'

function table(id: string, name: string, columns: ErdTable['columns'] = []): ErdTable {
  return { id, schema: 'public', name, columns }
}

function relation(
  name: string,
  fromTable: string,
  fromColumns: string[],
  toTable: string,
  toColumns: string[] = ['id'],
): ErdRelation {
  return { name, fromTable, fromColumns, toTable, toColumns }
}

const SCHEMA: SchemaErdData = {
  tables: [
    table('users', 'users', [
      { name: 'id', type: 'uuid', pk: true },
      { name: 'email', type: 'text' },
    ]),
    table('orders', 'orders', [
      { name: 'id', type: 'uuid', pk: true },
      { name: 'user_id', type: 'uuid' },
      { name: 'billing_user_id', type: 'uuid' },
    ]),
    table('items', 'items', [
      { name: 'order_id', type: 'uuid' },
      { name: 'sku', type: 'text' },
    ]),
  ],
  relations: [
    relation('orders_user_fk', 'orders', ['user_id'], 'users'),
    relation('orders_billing_fk', 'orders', ['billing_user_id'], 'users'),
    relation('items_order_fk', 'items', ['order_id'], 'orders'),
  ],
}

describe('buildErdModel', () => {
  it('gives each table a node id of its own that is not the table id', () => {
    const model = buildErdModel(SCHEMA)

    expect(model.nodes.map((node) => node.nodeId)).toEqual(['t0', 't1', 't2'])
    expect(model.nodes.map((node) => node.table.id)).toEqual(['users', 'orders', 'items'])
  })

  it('merges the foreign keys between one pair of tables into one connection', () => {
    const model = buildErdModel(SCHEMA)

    expect(model.edges).toHaveLength(2)
    const toUsers = model.edges.find((edge) => edge.target === 't0')
    expect(toUsers?.source).toBe('t1')
    expect(toUsers?.relations.map((entry) => entry.name)).toEqual([
      'orders_user_fk',
      'orders_billing_fk',
    ])
  })

  it('marks the columns that are the source of a foreign key', () => {
    const model = buildErdModel(SCHEMA)

    expect([...(model.nodes[1]?.foreignKeyColumns ?? [])].sort()).toEqual([
      'billing_user_id',
      'user_id',
    ])
    expect([...(model.nodes[2]?.foreignKeyColumns ?? [])]).toEqual(['order_id'])
    expect(model.nodes[0]?.foreignKeyColumns.size).toBe(0)
  })

  it('records which tables reference which', () => {
    const model = buildErdModel(SCHEMA)

    expect(model.nodes[1]?.references).toEqual(['t0'])
    expect(model.nodes[1]?.referencedBy).toEqual(['t2'])
    expect(model.nodes[0]?.referencedBy).toEqual(['t1'])
  })

  it('counts a relation from a table to itself and does not draw it', () => {
    const model = buildErdModel({
      tables: [table('emp', 'employees', [{ name: 'manager_id', type: 'uuid' }])],
      relations: [relation('emp_manager_fk', 'emp', ['manager_id'], 'emp')],
    })

    expect(model.edges).toEqual([])
    expect(model.selfRelationCount).toBe(1)
    expect(model.nodes[0]?.selfRelationCount).toBe(1)
    expect(model.nodes[0]?.foreignKeyColumns.has('manager_id')).toBe(true)
  })

  it('counts a relation that names a table the read does not have', () => {
    const model = buildErdModel({
      tables: [table('a', 'a')],
      relations: [relation('a_x_fk', 'a', ['x'], 'ghost'), relation('g_a_fk', 'ghost', ['y'], 'a')],
    })

    expect(model.edges).toEqual([])
    expect(model.unresolvedRelationCount).toBe(2)
    expect(model.issues).toContainEqual({ kind: 'unresolved_relations', count: 2 })
    expect(model.relations).toHaveLength(2)
  })

  it('keeps the first of two tables with one id and says so', () => {
    const model = buildErdModel({
      tables: [table('a', 'first'), table('a', 'second'), table('b', 'third')],
      relations: [],
    })

    expect(model.nodes.map((node) => node.table.name)).toEqual(['first', 'third'])
    expect(model.issues).toContainEqual({ kind: 'duplicate_table', id: 'a', dropped: 1 })
  })

  it('draws the first columns and counts the rest', () => {
    const columns = Array.from({ length: 30 }, (_, index) => ({ name: `c${index}`, type: 'int' }))
    const model = buildErdModel({ tables: [table('wide', 'wide', columns)], relations: [] }, 24)

    expect(model.nodes[0]?.shownColumns).toHaveLength(24)
    expect(model.nodes[0]?.hiddenColumnCount).toBe(6)
    expect(model.nodes[0]?.table.columns).toHaveLength(30)
  })

  it('does not hide a column for a table that fits', () => {
    const model = buildErdModel(SCHEMA, 3)

    expect(model.nodes.map((node) => node.hiddenColumnCount)).toEqual([0, 0, 0])
  })

  it('builds an empty model from an empty read', () => {
    const model = buildErdModel({ tables: [], relations: [] })

    expect(model.nodes).toEqual([])
    expect(model.edges).toEqual([])
    expect(model.issues).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'

import {
  layoutErd,
  NODE_HEADER_HEIGHT,
  NODE_ROW_HEIGHT,
  NODE_WIDTH,
  nodeHeight,
} from '../../src/erd/layout.ts'
import { buildErdModel } from '../../src/erd/model.ts'
import type { ErdRelation, ErdTable, SchemaErdData } from '../../src/erd/types.ts'

function table(id: string, columns = 2): ErdTable {
  return {
    id,
    schema: 'public',
    name: id,
    columns: Array.from({ length: columns }, (_, index) => ({ name: `c${index}`, type: 'int' })),
  }
}

function relation(from: string, to: string): ErdRelation {
  return {
    name: `${from}_${to}`,
    fromTable: from,
    fromColumns: ['c0'],
    toTable: to,
    toColumns: ['c0'],
  }
}

function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

describe('nodeHeight', () => {
  it('is the header plus one row per drawn column plus the border', () => {
    expect(nodeHeight({ shownColumns: [{ name: 'a', type: 'int' }], hiddenColumnCount: 0 })).toBe(
      NODE_HEADER_HEIGHT + NODE_ROW_HEIGHT + 2,
    )
  })

  it('has a row for a table without columns and a row for the columns it does not draw', () => {
    expect(nodeHeight({ shownColumns: [], hiddenColumnCount: 0 })).toBe(
      NODE_HEADER_HEIGHT + NODE_ROW_HEIGHT + 2,
    )
    expect(nodeHeight({ shownColumns: [{ name: 'a', type: 'int' }], hiddenColumnCount: 5 })).toBe(
      NODE_HEADER_HEIGHT + 2 * NODE_ROW_HEIGHT + 2,
    )
  })
})

describe('layoutErd', () => {
  const connected: SchemaErdData = {
    tables: ['a', 'b', 'c', 'd'].map((id) => table(id)),
    relations: [relation('a', 'b'), relation('b', 'c'), relation('a', 'd')],
  }

  it('places every table, at the size the drawing uses', () => {
    const model = buildErdModel(connected)
    const placed = layoutErd(model)

    expect([...placed.keys()].sort()).toEqual(['t0', 't1', 't2', 't3'])
    for (const node of model.nodes) {
      const box = placed.get(node.nodeId)
      expect(box?.width).toBe(NODE_WIDTH)
      expect(box?.height).toBe(nodeHeight(node))
    }
  })

  it('puts a referenced table to the right of the table that references it', () => {
    const model = buildErdModel(connected)
    const placed = layoutErd(model)

    const x = (id: string) => placed.get(id)?.x ?? Number.NaN
    expect(x('t0')).toBeLessThan(x('t1'))
    expect(x('t1')).toBeLessThan(x('t2'))
    expect(x('t0')).toBeLessThan(x('t3'))
  })

  it('never lets two tables overlap, connected or not', () => {
    const lone = Array.from({ length: 40 }, (_, index) => table(`lone${index}`, 1 + (index % 7)))
    const model = buildErdModel({
      tables: [...connected.tables, ...lone],
      relations: connected.relations,
    })
    const boxes = [...layoutErd(model).values()]

    expect(boxes).toHaveLength(44)
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]
        const b = boxes[j]
        if (a !== undefined && b !== undefined) expect(overlaps(a, b)).toBe(false)
      }
    }
  })

  it('packs tables without relations into rows instead of one tall column', () => {
    const model = buildErdModel({
      tables: Array.from({ length: 60 }, (_, index) => table(`t${index}`)),
      relations: [],
    })
    const boxes = [...layoutErd(model).values()]
    const width = Math.max(...boxes.map((box) => box.x + box.width))
    const height = Math.max(...boxes.map((box) => box.y + box.height))

    expect(new Set(boxes.map((box) => box.y)).size).toBeGreaterThan(1)
    expect(new Set(boxes.map((box) => box.x)).size).toBeGreaterThan(1)
    // About as wide as tall, not a column 60 tables high.
    expect(height).toBeLessThan(width * 3)
  })

  it('gives the same placement for the same model', () => {
    const first = [...layoutErd(buildErdModel(connected)).entries()]
    const second = [...layoutErd(buildErdModel(connected)).entries()]

    expect(second).toEqual(first)
  })

  it('lays out a cycle of foreign keys without losing a table', () => {
    const model = buildErdModel({
      tables: [table('a'), table('b'), table('c')],
      relations: [relation('a', 'b'), relation('b', 'c'), relation('c', 'a')],
    })
    const placed = layoutErd(model)

    expect(placed.size).toBe(3)
    for (const box of placed.values()) {
      expect(Number.isFinite(box.x)).toBe(true)
      expect(Number.isFinite(box.y)).toBe(true)
    }
  })

  it('lays out a few hundred tables in reasonable time', () => {
    const tables = Array.from({ length: 300 }, (_, index) => table(`t${index}`, 5))
    const relations = tables
      .slice(1)
      .map((entry, index) => relation(entry.id, `t${Math.floor(index / 2)}`))
    const started = Date.now()

    const placed = layoutErd(buildErdModel({ tables, relations }))

    expect(placed.size).toBe(300)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('lays out an empty model', () => {
    expect(layoutErd(buildErdModel({ tables: [], relations: [] })).size).toBe(0)
  })
})

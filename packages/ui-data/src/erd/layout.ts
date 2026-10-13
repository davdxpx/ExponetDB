import { Graph, layout } from '@dagrejs/dagre'

import type { ErdModel, ErdNodeModel } from './model.ts'

/** The size of a table in the diagram, in pixels: fixed, so the layout and the drawing agree. */
export const NODE_WIDTH = 288
export const NODE_HEADER_HEIGHT = 40
export const NODE_ROW_HEIGHT = 24
/** The border of the table box, top and bottom together. */
const NODE_BORDER = 2

/** The height of a table: header, one row per drawn column (at least one), a row for the rest. */
export function nodeHeight(node: Pick<ErdNodeModel, 'shownColumns' | 'hiddenColumnCount'>): number {
  const rows = Math.max(1, node.shownColumns.length) + (node.hiddenColumnCount > 0 ? 1 : 0)
  return NODE_HEADER_HEIGHT + rows * NODE_ROW_HEIGHT + NODE_BORDER
}

export interface PlacedNode {
  /** Top left corner. */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Space between the tables of a connected group and between the groups. */
const NODE_SEPARATION = 28
const RANK_SEPARATION = 110
const GROUP_GAP = 56
/** Groups are packed left to right into rows about this wide. */
const TARGET_ROW_WIDTH = 2_400

interface Group {
  readonly ids: readonly string[]
  readonly positions: ReadonlyMap<string, PlacedNode>
  readonly width: number
  readonly height: number
}

/** Connected groups of tables, largest first, each group's tables in table order. */
function connectedGroups(model: ErdModel): string[][] {
  const parent = new Map<string, string>()
  for (const node of model.nodes) parent.set(node.nodeId, node.nodeId)
  const find = (id: string): string => {
    let root = id
    for (;;) {
      const up = parent.get(root)
      if (up === undefined || up === root) break
      root = up
    }
    // Path compression.
    let current = id
    while (current !== root) {
      const up = parent.get(current)
      parent.set(current, root)
      if (up === undefined) break
      current = up
    }
    return root
  }
  for (const edge of model.edges) {
    const a = find(edge.source)
    const b = find(edge.target)
    if (a !== b) parent.set(b, a)
  }
  const groups = new Map<string, string[]>()
  for (const node of model.nodes) {
    const root = find(node.nodeId)
    const list = groups.get(root)
    if (list === undefined) groups.set(root, [node.nodeId])
    else list.push(node.nodeId)
  }
  // Stable: larger groups first, then by the position of their first table.
  return [...groups.values()].sort((a, b) => b.length - a.length)
}

function layoutGroup(
  ids: readonly string[],
  sizes: ReadonlyMap<string, { width: number; height: number }>,
  edges: readonly { source: string; target: string }[],
): Group {
  const members = new Set(ids)
  if (ids.length === 1) {
    const only = ids[0] ?? ''
    const size = sizes.get(only) ?? { width: NODE_WIDTH, height: NODE_HEADER_HEIGHT }
    return {
      ids,
      positions: new Map([[only, { x: 0, y: 0, ...size }]]),
      width: size.width,
      height: size.height,
    }
  }

  const graph = new Graph<
    { rankdir: 'LR'; nodesep: number; ranksep: number; marginx: number; marginy: number },
    { width: number; height: number; x?: number; y?: number },
    Record<string, never>
  >()
  graph.setGraph({
    rankdir: 'LR',
    nodesep: NODE_SEPARATION,
    ranksep: RANK_SEPARATION,
    marginx: 0,
    marginy: 0,
  })
  graph.setDefaultEdgeLabel(() => ({}))
  for (const id of ids) {
    const size = sizes.get(id) ?? { width: NODE_WIDTH, height: NODE_HEADER_HEIGHT }
    graph.setNode(id, { width: size.width, height: size.height })
  }
  for (const edge of edges) {
    if (members.has(edge.source) && members.has(edge.target))
      graph.setEdge(edge.source, edge.target)
  }
  layout(graph)

  const positions = new Map<string, PlacedNode>()
  let right = 0
  let bottom = 0
  for (const id of ids) {
    const placed = graph.node(id)
    const size = sizes.get(id) ?? { width: NODE_WIDTH, height: NODE_HEADER_HEIGHT }
    // dagre reports the center of a node.
    const x = (placed?.x ?? 0) - size.width / 2
    const y = (placed?.y ?? 0) - size.height / 2
    positions.set(id, { x, y, ...size })
    right = Math.max(right, x + size.width)
    bottom = Math.max(bottom, y + size.height)
  }
  return { ids, positions, width: right, height: bottom }
}

/**
 * Places the tables of the model: tables that are connected by foreign keys are laid out together
 * by dagre (left to right, referencing tables before referenced ones where the graph allows it),
 * and the groups, the many lone tables included, are packed left to right into rows, so a schema
 * with a hundred unrelated tables is a block and not one tall column. The same model always gives
 * the same placement.
 */
export function layoutErd(model: ErdModel): ReadonlyMap<string, PlacedNode> {
  const sizes = new Map<string, { width: number; height: number }>()
  for (const node of model.nodes)
    sizes.set(node.nodeId, { width: NODE_WIDTH, height: nodeHeight(node) })

  const groups = connectedGroups(model).map((ids) => layoutGroup(ids, sizes, model.edges))

  const placed = new Map<string, PlacedNode>()
  let cursorX = 0
  let cursorY = 0
  let rowHeight = 0
  for (const group of groups) {
    if (cursorX > 0 && cursorX + group.width > TARGET_ROW_WIDTH) {
      cursorX = 0
      cursorY += rowHeight + GROUP_GAP
      rowHeight = 0
    }
    for (const [id, position] of group.positions) {
      placed.set(id, { ...position, x: position.x + cursorX, y: position.y + cursorY })
    }
    cursorX += group.width + GROUP_GAP
    rowHeight = Math.max(rowHeight, group.height)
  }
  return placed
}

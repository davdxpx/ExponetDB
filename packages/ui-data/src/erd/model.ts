import type { ErdColumn, ErdRelation, ErdTable, SchemaErdData } from './types.ts'

/** The defaults of the diagram limits; the props of `SchemaErd` override them. */
export const DEFAULT_MAX_NODES = 150
export const DEFAULT_MAX_EDGES = 600
export const DEFAULT_MAX_COLUMNS_PER_NODE = 24

/** A table of the read with what the diagram needs to draw it. */
export interface ErdNodeModel {
  /** The id used inside the diagram (`t0`, `t1`, ...), never the table id: it ends up in the DOM. */
  readonly nodeId: string
  readonly table: ErdTable
  /** The columns drawn: the first `maxColumns`, in table order. */
  readonly shownColumns: readonly ErdColumn[]
  readonly hiddenColumnCount: number
  /** Names of the columns that are the source of a foreign key of this table. */
  readonly foreignKeyColumns: ReadonlySet<string>
  /** Node ids of the tables this table references (not itself), in order of appearance. */
  readonly references: readonly string[]
  /** Node ids of the tables that reference this one (not itself). */
  readonly referencedBy: readonly string[]
  /** Relations from this table to itself. */
  readonly selfRelationCount: number
}

/** One connection of the diagram: all foreign keys from one table to one other table. */
export interface ErdEdgeModel {
  readonly edgeId: string
  readonly source: string
  readonly target: string
  readonly relations: readonly ErdRelation[]
}

export type ErdIssue =
  /** The table id appears more than once; the first table is kept. */
  | { readonly kind: 'duplicate_table'; readonly id: string; readonly dropped: number }
  /** Relations whose table id is not a table of the read; they are listed, not drawn. */
  | { readonly kind: 'unresolved_relations'; readonly count: number }

export interface ErdModel {
  readonly tables: readonly ErdTable[]
  readonly nodes: readonly ErdNodeModel[]
  readonly edges: readonly ErdEdgeModel[]
  /** All relations as given, in order. */
  readonly relations: readonly ErdRelation[]
  /** Table by table id, for the lists. */
  readonly tableById: ReadonlyMap<string, ErdTable>
  readonly selfRelationCount: number
  readonly unresolvedRelationCount: number
  readonly issues: readonly ErdIssue[]
}

/**
 * Resolves the relations of a schema read against its tables and merges them into connections.
 * Everything that cannot be drawn is counted, not dropped: a relation that names an unknown table
 * is unresolved, one from a table to itself is a self relation (the lists show both), and two
 * foreign keys between the same pair of tables are one connection with two relations.
 */
export function buildErdModel(
  data: SchemaErdData,
  maxColumnsPerNode: number = DEFAULT_MAX_COLUMNS_PER_NODE,
): ErdModel {
  const issues: ErdIssue[] = []
  const limit = Math.max(1, Math.floor(maxColumnsPerNode))

  const tables: ErdTable[] = []
  const nodeIdOf = new Map<string, string>()
  const dropped = new Map<string, number>()
  for (const table of data.tables) {
    if (nodeIdOf.has(table.id)) {
      dropped.set(table.id, (dropped.get(table.id) ?? 0) + 1)
      continue
    }
    nodeIdOf.set(table.id, `t${tables.length}`)
    tables.push(table)
  }
  for (const [id, count] of dropped) issues.push({ kind: 'duplicate_table', id, dropped: count })

  const foreignKeyColumns = new Map<string, Set<string>>()
  const references = new Map<string, string[]>()
  const referencedBy = new Map<string, string[]>()
  const selfCounts = new Map<string, number>()
  const edgeRelations = new Map<string, ErdRelation[]>()
  const edgeOrder: { key: string; source: string; target: string }[] = []

  let unresolved = 0
  let selfTotal = 0
  for (const relation of data.relations) {
    const source = nodeIdOf.get(relation.fromTable)
    const target = nodeIdOf.get(relation.toTable)
    if (source === undefined || target === undefined) {
      unresolved += 1
      continue
    }
    const columns = foreignKeyColumns.get(source) ?? new Set<string>()
    for (const column of relation.fromColumns) columns.add(column)
    foreignKeyColumns.set(source, columns)

    if (source === target) {
      selfTotal += 1
      selfCounts.set(source, (selfCounts.get(source) ?? 0) + 1)
      continue
    }
    const key = `${source}>${target}`
    const existing = edgeRelations.get(key)
    if (existing === undefined) {
      edgeRelations.set(key, [relation])
      edgeOrder.push({ key, source, target })
      const outgoing = references.get(source) ?? []
      outgoing.push(target)
      references.set(source, outgoing)
      const incoming = referencedBy.get(target) ?? []
      incoming.push(source)
      referencedBy.set(target, incoming)
    } else {
      existing.push(relation)
    }
  }
  if (unresolved > 0) issues.push({ kind: 'unresolved_relations', count: unresolved })

  const nodes = tables.map((table, index): ErdNodeModel => {
    const nodeId = `t${index}`
    const shown = table.columns.length > limit ? table.columns.slice(0, limit) : table.columns
    return {
      nodeId,
      table,
      shownColumns: shown,
      hiddenColumnCount: table.columns.length - shown.length,
      foreignKeyColumns: foreignKeyColumns.get(nodeId) ?? new Set<string>(),
      references: references.get(nodeId) ?? [],
      referencedBy: referencedBy.get(nodeId) ?? [],
      selfRelationCount: selfCounts.get(nodeId) ?? 0,
    }
  })

  const edges = edgeOrder.map(
    ({ key, source, target }, index): ErdEdgeModel => ({
      edgeId: `e${index}`,
      source,
      target,
      relations: edgeRelations.get(key) ?? [],
    }),
  )

  return {
    tables,
    nodes,
    edges,
    relations: data.relations,
    tableById: new Map(tables.map((table) => [table.id, table])),
    selfRelationCount: selfTotal,
    unresolvedRelationCount: unresolved,
    issues,
  }
}

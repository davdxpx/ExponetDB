import type { flattenTree } from '@exponetdb/ui'
import type { Readable, ReadFailure, ReadSource } from '@exponetdb/ui-patterns'

import type {
  SchemaTreeClass,
  SchemaTreeObject,
  SchemaTreeSchema,
  SchemaTreeSelection,
} from './schema-tree-types.ts'

/** A node of the tree library's flat data. */
export type TreeNode = ReturnType<typeof flattenTree>[number]
export type TreeNodeId = TreeNode['id']

/** The state of the load of one branch (the objects of one class in one schema). */
export interface BranchLoad {
  /** The last answer of the loader, or `null` while the first request is open. */
  readonly readable: Readable<readonly SchemaTreeObject[]> | null
  /** A request is open. */
  readonly loading: boolean
}

/** What the status row under a branch says; no status row when the branch has plain objects. */
export type BranchStatus =
  | { readonly type: 'loading' }
  | { readonly type: 'refreshing' }
  | { readonly type: 'failed'; readonly error: ReadFailure }
  | {
      readonly type: 'stale'
      readonly source: ReadSource
      readonly observedAt: string
      readonly error: ReadFailure | undefined
      readonly empty: boolean
    }
  | {
      readonly type: 'partial'
      readonly source: ReadSource
      readonly observedAt: string
      readonly missing: readonly string[]
    }
  | { readonly type: 'empty' }

const UNRECOGNIZED: ReadFailure = {
  code: 'UNKNOWN',
  message: 'The state of this read was not recognized.',
}

/**
 * The status of a branch from its load. A failed, partial, earlier or empty read
 * each has its own status, so no branch ever looks empty because it failed.
 */
export function branchStatus(load: BranchLoad | undefined): BranchStatus | null {
  if (load === undefined) return null
  const readable = load.readable
  if (readable === null) return load.loading ? { type: 'loading' } : null
  switch (readable.state) {
    case 'loading':
      return { type: 'loading' }
    case 'failed':
      return load.loading ? { type: 'loading' } : { type: 'failed', error: readable.error }
    case 'stale':
      return load.loading
        ? { type: 'refreshing' }
        : {
            type: 'stale',
            source: readable.source,
            observedAt: readable.observedAt,
            error: readable.error,
            empty: readable.value.length === 0,
          }
    case 'partial':
      return load.loading
        ? { type: 'refreshing' }
        : {
            type: 'partial',
            source: readable.source,
            observedAt: readable.observedAt,
            missing: readable.missing,
          }
    case 'ready':
      if (load.loading) return { type: 'refreshing' }
      return readable.value.length === 0 ? { type: 'empty' } : null
    default:
      return load.loading ? { type: 'loading' } : { type: 'failed', error: UNRECOGNIZED }
  }
}

/** The objects a load holds: those of a ready, earlier or partial read; none for a loading or failed one. */
export function branchObjects(load: BranchLoad | undefined): readonly SchemaTreeObject[] {
  const readable = load?.readable
  if (readable === undefined || readable === null) return []
  switch (readable.state) {
    case 'stale':
    case 'partial':
    case 'ready':
      return readable.value
    default:
      return []
  }
}

export type SchemaTreeNodeInfo =
  | { readonly kind: 'schema'; readonly schema: string }
  | {
      readonly kind: 'class'
      readonly schema: string
      readonly classId: string
      readonly label: string
      /** The number of objects of a complete (ready) read; `null` otherwise. */
      readonly count: number | null
      /** A request for the objects is open. */
      readonly loading: boolean
    }
  | {
      readonly kind: 'object'
      readonly schema: string
      readonly classId: string
      readonly name: string
      readonly key: string
    }
  | {
      readonly kind: 'status'
      readonly schema: string
      readonly classId: string
      /** The label of the class, as the status row words it. */
      readonly label: string
      /** The branch (class) node the status belongs to. */
      readonly branchId: TreeNodeId
      readonly status: BranchStatus
    }

export interface SchemaTreeModel {
  readonly data: TreeNode[]
  readonly info: ReadonlyMap<TreeNodeId, SchemaTreeNodeInfo>
  /** The class nodes by id, for the loader. */
  readonly branches: ReadonlyMap<TreeNodeId, { readonly schema: string; readonly classId: string }>
}

export const ROOT_ID = 'root'

/** An id nobody can mistake for another: a JSON array of the parts. */
function nodeId(...parts: readonly string[]): string {
  return JSON.stringify(parts)
}

/** The library types a typeahead on the first character of `name`; an empty name would throw there. */
function typeaheadName(name: string): string {
  return name === '' ? '(empty)' : name
}

/**
 * The flat data of the tree: a root that is never drawn, the schemas below it,
 * the object classes below each schema and the objects (or a status row, or
 * both) below each class. Ids never collide, whatever the names are.
 */
export function buildSchemaTree(
  schemas: readonly SchemaTreeSchema[],
  classes: readonly SchemaTreeClass[],
  loads: Readonly<Record<string, BranchLoad>>,
): SchemaTreeModel {
  const data: TreeNode[] = []
  const info = new Map<TreeNodeId, SchemaTreeNodeInfo>()
  const branches = new Map<TreeNodeId, { schema: string; classId: string }>()
  const root: TreeNode = { id: ROOT_ID, name: '', children: [], parent: null }
  data.push(root)

  const schemaSeen = new Map<string, number>()
  for (const schema of schemas) {
    const schemaCount = schemaSeen.get(schema.name) ?? 0
    schemaSeen.set(schema.name, schemaCount + 1)
    const schemaNodeId = nodeId('schema', String(schemaCount), schema.name)
    const schemaNode: TreeNode = {
      id: schemaNodeId,
      name: typeaheadName(schema.name),
      children: [],
      parent: ROOT_ID,
      isBranch: true,
    }
    root.children.push(schemaNodeId)
    data.push(schemaNode)
    info.set(schemaNodeId, { kind: 'schema', schema: schema.name })

    const classSeen = new Map<string, number>()
    for (const cls of classes) {
      const classCount = classSeen.get(cls.id) ?? 0
      classSeen.set(cls.id, classCount + 1)
      const classNodeId = nodeId('class', schemaNodeId, String(classCount), cls.id)
      const load = loads[classNodeId]
      const objects = branchObjects(load)
      const status = branchStatus(load)
      const classNode: TreeNode = {
        id: classNodeId,
        name: cls.label,
        children: [],
        parent: schemaNodeId,
        isBranch: true,
      }
      schemaNode.children.push(classNodeId)
      data.push(classNode)
      branches.set(classNodeId, { schema: schema.name, classId: cls.id })
      info.set(classNodeId, {
        kind: 'class',
        schema: schema.name,
        classId: cls.id,
        label: cls.label,
        count: load?.readable?.state === 'ready' && !load.loading ? objects.length : null,
        loading: load?.loading === true,
      })

      if (status !== null) {
        const statusId = nodeId('status', classNodeId)
        classNode.children.push(statusId)
        data.push({ id: statusId, name: ' ', children: [], parent: classNodeId })
        info.set(statusId, {
          kind: 'status',
          schema: schema.name,
          classId: cls.id,
          label: cls.label,
          branchId: classNodeId,
          status,
        })
      }

      const objectSeen = new Map<string, number>()
      for (const object of objects) {
        const natural = object.key ?? object.name
        const objectCount = objectSeen.get(natural) ?? 0
        objectSeen.set(natural, objectCount + 1)
        const objectId = nodeId('object', classNodeId, String(objectCount), natural)
        classNode.children.push(objectId)
        data.push({
          id: objectId,
          name: typeaheadName(object.name),
          children: [],
          parent: classNodeId,
        })
        info.set(objectId, {
          kind: 'object',
          schema: schema.name,
          classId: cls.id,
          name: object.name,
          key: natural,
        })
      }
    }
  }
  return { data, info, branches }
}

/** The selection the caller is told about for a node, or `null` for a status row. */
export function selectionOf(node: SchemaTreeNodeInfo | undefined): SchemaTreeSelection | null {
  if (node === undefined) return null
  switch (node.kind) {
    case 'schema':
      return { kind: 'schema', schema: node.schema }
    case 'class':
      return { kind: 'class', schema: node.schema, classId: node.classId }
    case 'object':
      return {
        kind: 'object',
        schema: node.schema,
        classId: node.classId,
        name: node.name,
        key: node.key,
      }
    default:
      return null
  }
}

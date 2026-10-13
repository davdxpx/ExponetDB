import type { Readable } from '@exponetdb/ui-patterns'

/**
 * The props and shapes of `SchemaTree`, without the tree library: import this
 * module for the types and the default object classes, and load
 * `schema-tree.tsx` lazily. Plain strings, so ui-data does not import the
 * contracts.
 *
 * Mapping to the contract: a schema is a `SchemaObject` of kind `schema` of the
 * inventory read; an object is one entry of a schema's objects of one class;
 * the class ids are the object kinds of the inventory (`table`, `view`, ...).
 */
export interface SchemaTreeSchema {
  /** The schema name. Untrusted text. */
  readonly name: string
}

export interface SchemaTreeObject {
  /** The object name. Untrusted text. */
  readonly name: string
  /**
   * A key that tells two objects of the same name apart (an overloaded function
   * has one per signature). Without it the name is the key; a repeated key is
   * made unique by the tree.
   */
  readonly key?: string
}

/** One class of objects a schema holds: the branch under a schema. */
export interface SchemaTreeClass {
  /** Passed to the loader and to the selection callback. */
  readonly id: string
  /** The plural noun the branch is headed with: "Tables". Trusted text of the caller. */
  readonly label: string
}

/** The classes of the tree unless the caller names its own: what a schema of a PostgreSQL database holds. */
export const DEFAULT_SCHEMA_TREE_CLASSES: readonly SchemaTreeClass[] = [
  { id: 'table', label: 'Tables' },
  { id: 'view', label: 'Views' },
  { id: 'materialized_view', label: 'Materialized views' },
  { id: 'foreign_table', label: 'Foreign tables' },
  { id: 'function', label: 'Functions' },
  { id: 'sequence', label: 'Sequences' },
  { id: 'type', label: 'Types' },
  { id: 'extension', label: 'Extensions' },
]

/** What a branch load asks for: the objects of one class in one schema. */
export interface SchemaTreeLoadRequest {
  readonly schema: string
  readonly classId: string
}

/**
 * Reads the objects of one class in one schema. The answer is a `Readable`, so a
 * failed read, an earlier read and a partial read each show as such inside the
 * branch. A promise that rejects is shown as a failed read with a fixed
 * message (the exception text is never shown).
 */
export type SchemaTreeLoader = (
  request: SchemaTreeLoadRequest,
) => Promise<Readable<readonly SchemaTreeObject[]>>

/** What a person selected in the tree. Names are the raw strings, for the caller to show as untrusted text. */
export type SchemaTreeSelection =
  | { readonly kind: 'schema'; readonly schema: string }
  | { readonly kind: 'class'; readonly schema: string; readonly classId: string }
  | {
      readonly kind: 'object'
      readonly schema: string
      readonly classId: string
      readonly name: string
      readonly key: string
    }

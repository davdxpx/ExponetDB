import type { HeadingLevel, NowInput, Readable } from '@exponetdb/ui-patterns'

/**
 * Types of the schema diagram. Light module: no component and no heavy library (`@xyflow/react`,
 * `@dagrejs/dagre`), so a page can import the shapes without loading the diagram.
 *
 * The props are presentational. Mapping to the contracts (`SchemaObject` of
 * `packages/contracts/src/rest/resources.ts`, which this package never imports):
 *
 * - `ErdTable` is a `SchemaObject` with `ref.kind` `table`: `schema` and `name` from `ref`, `id`
 *   from the canonical key (`ref.key`) joined by the caller, `columns` from `columns` (`name`,
 *   `type`); `pk` is true for the columns of the `primary_key` constraint.
 * - `ErdRelation` is a `foreign_key` constraint. The contract carries it as `definition` text, so
 *   the caller reads the columns and the referenced table out of it (an adapter outside this
 *   package); `name` is the constraint name, `fromTable` and `toTable` are `ErdTable.id`.
 */
export interface ErdColumn {
  /** The column name (untrusted text). */
  readonly name: string
  /** The canonical type (untrusted text), for example `uuid` or `numeric(12,2)`. */
  readonly type: string
  /** The column is part of the primary key. */
  readonly pk?: boolean
}

export interface ErdTable {
  /** Stable id of the table in this read; relations refer to it. */
  readonly id: string
  readonly schema: string
  readonly name: string
  readonly columns: readonly ErdColumn[]
}

export interface ErdRelation {
  /** The constraint name (untrusted text). */
  readonly name: string
  /** `ErdTable.id` of the table that holds the foreign key. */
  readonly fromTable: string
  readonly fromColumns: readonly string[]
  /** `ErdTable.id` of the referenced table. */
  readonly toTable: string
  readonly toColumns: readonly string[]
}

export interface SchemaErdData {
  readonly tables: readonly ErdTable[]
  readonly relations: readonly ErdRelation[]
}

export type ErdView = 'diagram' | 'table'

export interface SchemaErdProps {
  /** The tables and foreign keys of a schema read. A failed read never renders as an empty diagram. */
  readable: Readable<SchemaErdData>
  /** What is read, as a noun phrase for the state messages. Default "schema diagram". */
  what?: string
  /** Most tables drawn; above it only the table view is shown, with a note. Default 150. */
  maxNodes?: number
  /** Most connections drawn (one per pair of tables); above it only the table view is shown. Default 600. */
  maxEdges?: number
  /** Most columns listed inside a table of the diagram; the rest is counted. Default 24. */
  maxColumnsPerNode?: number
  /** The view shown first. Default `diagram`. */
  initialView?: ErdView
  onRetry?: () => void
  onRefresh?: () => void
  busy?: boolean
  now?: NowInput
  headingLevel?: HeadingLevel
  className?: string
}

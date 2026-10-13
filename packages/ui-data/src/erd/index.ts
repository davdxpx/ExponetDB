// The light part of the schema diagram: types, the model, and the table view. The diagram itself
// (`SchemaErd`, in `schema-erd.tsx`) loads `@xyflow/react` and `@dagrejs/dagre`: the app imports
// that module lazily (`React.lazy(() => import('@exponetdb/ui-data/erd/schema-erd'))` or the
// path its bundler setup uses) and never from this barrel.
export {
  RELATION_VIEW_PAGE_SIZE,
  SchemaErdTables,
  type SchemaErdTablesProps,
  TABLE_VIEW_PAGE_SIZE,
} from './erd-table-view.tsx'
export {
  buildErdModel,
  DEFAULT_MAX_COLUMNS_PER_NODE,
  DEFAULT_MAX_EDGES,
  DEFAULT_MAX_NODES,
  type ErdEdgeModel,
  type ErdIssue,
  type ErdModel,
  type ErdNodeModel,
} from './model.ts'
export type {
  ErdColumn,
  ErdRelation,
  ErdTable,
  ErdView,
  SchemaErdData,
  SchemaErdProps,
} from './types.ts'

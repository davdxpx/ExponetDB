/**
 * The light surface of the data components: types, pure helpers and the
 * components that pull in no heavy library. The heavy ones are subpath
 * exports the app loads lazily (`React.lazy`), never re-exported here, so
 * importing this barrel never loads CodeMirror, TanStack Table or xyflow:
 *
 * - `@exponetdb/ui-data/grid/data-grid` (`DataGrid`, TanStack Table and Virtual)
 * - `@exponetdb/ui-data/editor/sql-editor` (`SqlEditor`, CodeMirror)
 * - `@exponetdb/ui-data/editor/text-diff` (`TextDiffView`, CodeMirror merge)
 * - `@exponetdb/ui-data/erd/schema-erd` (`SchemaErd`, xyflow and dagre)
 */
export * from './diff/schema-diff.ts'
export * from './diff/schema-diff-view.tsx'
export * from './diff/structured-diff.ts'
export * from './diff/structured-diff-table.tsx'
export {
  MAX_DIFF_CHARACTERS,
  type ReadableTextDiffProps,
  type TextDiffSides,
  type TextDiffViewProps,
} from './editor/diff-types.ts'
export { ReadableTextDiff } from './editor/readable-text-diff.tsx'
export type {
  EditorHandle,
  SqlCompletionContext,
  SqlCompletionItem,
  SqlCompletionKind,
  SqlCompletionProvider,
  SqlDiagnostic,
  SqlDiagnosticSeverity,
  SqlEditorMode,
  SqlEditorProps,
} from './editor/types.ts'
export * from './erd/index.ts'
export * from './explain/explain-view.tsx'
export * from './explain/parse-explain.ts'
export * from './grid/index.ts'
export * from './plan/index.ts'
export * from './schema/schema-tree.tsx'
export * from './schema/schema-tree-types.ts'
export * from './timeline/index.ts'
export { type Truncated, truncateText } from './truncate.ts'

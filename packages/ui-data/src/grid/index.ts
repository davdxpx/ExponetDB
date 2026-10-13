// The light surface of the data grid: types and pure helpers that import no heavy
// library. `DataGrid` itself lives in `./data-grid.tsx` and is loaded lazily by
// the app (`React.lazy(() => import('…/data-grid'))`); it is not re-exported here.
export { type ColumnKind, columnKind, isNumericKind } from './column-kind.ts'
export { buildExport, DEFAULT_EXPORT_LIMIT, safeFileName } from './export.ts'
export type {
  CellValue,
  DataGridProps,
  ExportFormat,
  ExportLimit,
  ExportResult,
  GridColumn,
  GridPage,
  GridSort,
  GridTruncation,
  SortDirection,
  TruncatedCell,
} from './types.ts'
export { cellFromWire } from './wire.ts'

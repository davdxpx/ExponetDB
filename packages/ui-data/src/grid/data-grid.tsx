import { ArrowDown, ArrowUp, ChevronDown, ChevronsUpDown, Copy, Lock } from '@exponetdb/icons'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  cn,
  copyToClipboard,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  toast,
} from '@exponetdb/ui'
import {
  codePointCount,
  EmptyState,
  formatCount,
  isInvisible,
  ReadableView,
  renderLine,
  takeCodePoints,
  UntrustedName,
} from '@exponetdb/ui-patterns'
import {
  type ColumnDef,
  getCoreRowModel,
  type OnChangeFn,
  type Row,
  type SortingState,
  useReactTable,
} from '@tanstack/react-table'
import {
  defaultRangeExtractor,
  observeElementRect,
  type Range,
  type Rect,
  useVirtualizer,
  type Virtualizer,
} from '@tanstack/react-virtual'
import {
  type CSSProperties,
  type KeyboardEvent,
  memo,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { AriaColumnHeader, AriaGrid, AriaRow, AriaRowGroup } from './aria-grid.tsx'
import { type CellView, fullText, viewCell } from './cell-format.ts'
import {
  type ColumnKind,
  type ColumnMeta,
  describeColumns,
  isNumericKind,
  sameColumns,
} from './column-kind.ts'
import { downloadText } from './download.ts'
import { buildExport, DEFAULT_EXPORT_LIMIT, rowToTsv, safeFileName } from './export.ts'
import { FullValueSheet } from './full-value-sheet.tsx'
import { GridCell } from './grid-cell.tsx'
import { GridSkeleton } from './grid-skeleton.tsx'
import { type GridPosition, nextPosition } from './navigation.ts'
import type { CellValue, DataGridProps, ExportFormat } from './types.ts'

/** Height of the header row, in pixels. */
const HEADER_HEIGHT = 36
const DEFAULT_MAX_HEIGHT = 560
const DEFAULT_ROW_HEIGHT = 32
const OVERSCAN = 8
const COLUMN_OVERSCAN = 3
/** The width counted for a region that has none yet (not laid out, hidden), in pixels. */
const FALLBACK_WIDTH = 1280
/** Rows a PageUp or PageDown moves when the region has no measured height (not laid out yet). */
const FALLBACK_PAGE_ROWS = 10
const MAX_HEADER_CODE_POINTS = 128
/** The approximate width of one monospace character at the cell size, for "is this value cut?". */
const CHARACTER_WIDTH = 7.5

type GridStyle = CSSProperties & { [name: `--${string}`]: string }
type GridRowData = readonly CellValue[]

const BASE_WIDTH: Record<ColumnKind, number> = {
  integer: 120,
  float: 140,
  numeric: 150,
  boolean: 100,
  json: 280,
  bytea: 260,
  temporal: 220,
  uuid: 320,
  array: 240,
  text: 240,
}

function columnWidth(meta: ColumnMeta): number {
  const name = Math.min(MAX_HEADER_CODE_POINTS, codePointCount(meta.name.slice(0, 256)))
  const type = Math.min(MAX_HEADER_CODE_POINTS, codePointCount(meta.type.slice(0, 256)))
  const label = 24 + 24 + name * 8 + type * 7 + (meta.masked ? 64 : 0)
  return Math.min(480, Math.max(BASE_WIDTH[meta.kind], label))
}

function expandAbove(width: number): number {
  return Math.max(8, Math.floor((width - 48) / CHARACTER_WIDTH))
}

function hasTextSelection(): boolean {
  return (
    typeof window.getSelection === 'function' && (window.getSelection()?.toString() ?? '') !== ''
  )
}

/** Hidden or direction characters in a text a person copies (tab and line breaks are ordinary). */
function countHiddenCharacters(text: string): number {
  let count = 0
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0
    if (point !== 0x09 && point !== 0x0a && point !== 0x0d && isInvisible(point)) count += 1
  }
  return count
}

/** The indexes of a virtual range with `index` added in its place (the active row or column stays in the document). */
function withIndex(indexes: number[], index: number, count: number): number[] {
  if (index < 0 || index >= count || indexes.includes(index)) return indexes
  return index < (indexes[0] ?? 0) ? [index, ...indexes] : [...indexes, index]
}

function plural(count: number, one: string, many: string): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function HeaderLabel({ meta }: { meta: ColumnMeta }): ReactNode {
  const name = takeCodePoints(meta.name, MAX_HEADER_CODE_POINTS)
  const type = takeCodePoints(meta.type, MAX_HEADER_CODE_POINTS)
  return (
    <>
      <span dir="ltr" className="min-w-0 truncate font-medium [unicode-bidi:isolate-override]">
        {meta.name === '' ? (
          <span className="italic text-foreground-muted">(unnamed)</span>
        ) : (
          renderLine(name.head, 'name').nodes
        )}
        {name.truncated && <span aria-hidden="true">…</span>}
      </span>
      <span
        dir="ltr"
        className="min-w-0 shrink truncate font-mono text-[11px] font-normal text-foreground-lighter [unicode-bidi:isolate-override]"
      >
        {renderLine(type.head, 'type').nodes}
        {type.truncated && <span aria-hidden="true">…</span>}
      </span>
      {meta.masked && (
        <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-normal text-foreground-lighter">
          <Lock aria-hidden="true" className="size-3" />
          masked
        </span>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// One data row
// ---------------------------------------------------------------------------

interface GridRowProps {
  /** 0-based index among the data rows. */
  index: number
  row: Row<GridRowData>
  metas: readonly ColumnMeta[]
  /** The columns that are in the document. */
  colIndexes: readonly number[]
  expandLimits: readonly number[]
  offset: number
  rowHeight: number
  /** The active column when this row holds the active cell, else -1. */
  activeCol: number
  onOpen: (row: number, col: number) => void
}

const GridRow = memo(function GridRow({
  index,
  row,
  metas,
  colIndexes,
  expandLimits,
  offset,
  rowHeight,
  activeCol,
  onOpen,
}: GridRowProps): ReactNode {
  const cells = row.getVisibleCells()
  return (
    <AriaRow
      aria-rowindex={index + 2}
      className="absolute left-0 top-0 grid w-[var(--exdb-grid-width)] border-b border-default hover:bg-surface-200 [grid-template-columns:var(--exdb-grid-cols)]"
      style={{ height: rowHeight, transform: `translateY(${offset}px)` }}
    >
      {colIndexes.map((col) => {
        const meta = metas[col]
        const cell = cells[col]
        if (meta === undefined || cell === undefined) return null
        return (
          <GridCell
            key={cell.id}
            value={cell.getValue<CellValue | undefined>()}
            meta={meta}
            row={index + 1}
            col={col}
            focusable={activeCol === col}
            active={activeCol === col}
            expandAbove={expandLimits[col] ?? 24}
            onOpen={onOpen}
          />
        )
      })}
    </AriaRow>
  )
})

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

interface GridContentProps extends Omit<DataGridProps, 'rows' | 'className'> {
  rows: readonly GridRowData[]
  state: 'ready' | 'stale' | 'partial'
}

interface SheetTarget {
  readonly row: number
  readonly col: number
  readonly value: CellValue | undefined
  readonly meta: ColumnMeta
  readonly open: boolean
}

function GridContent({
  label,
  columns: columnsProp,
  rows,
  state,
  truncated,
  page,
  sort,
  exportLimit,
  fileName,
  onExport,
  busy = false,
  maxHeight = DEFAULT_MAX_HEIGHT,
  rowHeight = DEFAULT_ROW_HEIGHT,
}: GridContentProps): ReactNode {
  // A caller that builds `columns` inline gets the same columns, not a re-render of every cell.
  const [columns, setColumns] = useState(columnsProp)
  if (columns !== columnsProp && !sameColumns(columns, columnsProp)) setColumns(columnsProp)
  const metas = useMemo(() => describeColumns(columns), [columns])
  const widths = useMemo(() => metas.map(columnWidth), [metas])
  const expandLimits = useMemo(() => widths.map(expandAbove), [widths])
  const template = useMemo(() => widths.map((width) => `${width}px`).join(' '), [widths])
  const totalWidth = useMemo(() => widths.reduce((sum, width) => sum + width, 0), [widths])

  const scrollRef = useRef<HTMLDivElement>(null)
  const pendingFocus = useRef<GridPosition | null>(null)
  const [active, setActive] = useState<GridPosition>({ row: rows.length > 0 ? 1 : 0, col: 0 })
  const [sheet, setSheet] = useState<SheetTarget | null>(null)
  // The last thing the person did with these rows; a new result starts without a notice.
  const [notice, setNotice] = useState<{ text: string; rows: readonly GridRowData[] } | null>(null)

  // New rows or columns may be fewer than before: the active cell stays inside the grid.
  const activePosition: GridPosition = {
    row: Math.min(active.row, rows.length),
    col: Math.min(active.col, Math.max(0, metas.length - 1)),
  }

  // --- table (TanStack Table): columns, sorting state, row model ---------------------------
  const sortable = sort !== undefined
  const sortColumn = sort?.column ?? null
  const sortDirection = sort?.direction ?? 'asc'
  const sortChange = sort?.onSortChange
  const sorting = useMemo<SortingState>(
    () => (sortColumn === null ? [] : [{ id: `c${sortColumn}`, desc: sortDirection === 'desc' }]),
    [sortColumn, sortDirection],
  )
  const columnDefs = useMemo<ColumnDef<GridRowData>[]>(
    () =>
      metas.map((_meta, index) => ({
        id: `c${index}`,
        accessorFn: (row) => row[index],
        enableSorting: sortable,
      })),
    [metas, sortable],
  )
  const data = useMemo(() => [...rows], [rows])
  const onSortingChange: OnChangeFn<SortingState> = (updater) => {
    const next = typeof updater === 'function' ? updater(sorting) : updater
    const first = next[0]
    if (first === undefined) {
      sortChange?.(null)
      return
    }
    sortChange?.({
      column: Number.parseInt(first.id.slice(1), 10),
      direction: first.desc ? 'desc' : 'asc',
    })
  }
  const table = useReactTable({
    data,
    columns: columnDefs,
    state: { sorting },
    manualSorting: true,
    enableSorting: sortable,
    enableMultiSort: false,
    onSortingChange,
    getCoreRowModel: getCoreRowModel(),
  })
  const tableRows = table.getRowModel().rows
  const headers = table.getHeaderGroups()[0]?.headers ?? []

  // --- rows (TanStack Virtual): only the visible rows exist in the document -----------------
  const activeBodyIndex = activePosition.row - 1
  // The active row always stays in the document, so the grid keeps its one tab stop.
  const rangeExtractor = useCallback(
    (range: Range): number[] =>
      withIndex(defaultRangeExtractor(range), activeBodyIndex, range.count),
    [activeBodyIndex],
  )
  const columnRangeExtractor = useCallback(
    (range: Range): number[] =>
      withIndex(defaultRangeExtractor(range), activePosition.col, range.count),
    [activePosition.col],
  )
  // A region that has no size yet (not laid out, hidden) counts as a full-size one.
  const observeRect = useCallback(
    (instance: Virtualizer<HTMLDivElement, Element>, callback: (rect: Rect) => void) =>
      observeElementRect(instance, (rect) =>
        callback({
          width: rect.width === 0 ? FALLBACK_WIDTH : rect.width,
          height: rect.height === 0 ? maxHeight : rect.height,
        }),
      ),
    [maxHeight],
  )
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN,
    scrollMargin: HEADER_HEIGHT,
    scrollPaddingStart: HEADER_HEIGHT,
    initialRect: { width: FALLBACK_WIDTH, height: maxHeight },
    observeElementRect: observeRect,
    rangeExtractor,
  })
  // Columns are virtual too: a result of hundreds of columns keeps a few dozen in the document.
  const columnVirtualizer = useVirtualizer({
    horizontal: true,
    count: metas.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => widths[index] ?? BASE_WIDTH.text,
    overscan: COLUMN_OVERSCAN,
    initialRect: { width: FALLBACK_WIDTH, height: maxHeight },
    observeElementRect: observeRect,
    rangeExtractor: columnRangeExtractor,
  })
  // The virtualizers cache sizes; new sizes (other columns, another row height) need a new measure.
  const sizeKey = `${rowHeight}|${template}`
  const measuredKey = useRef(sizeKey)
  useLayoutEffect(() => {
    if (measuredKey.current === sizeKey) return
    measuredKey.current = sizeKey
    virtualizer.measure()
    columnVirtualizer.measure()
  }, [sizeKey, virtualizer, columnVirtualizer])
  const columnItems = columnVirtualizer.getVirtualItems()
  const colIndexes = useMemo(() => columnItems.map((item) => item.index), [columnItems])
  const items = virtualizer.getVirtualItems()

  // --- focus ----------------------------------------------------------------------------------
  const findCell = useCallback((position: GridPosition): HTMLElement | null => {
    return (
      scrollRef.current?.querySelector<HTMLElement>(
        `[data-exdb-r="${position.row}"][data-exdb-c="${position.col}"]`,
      ) ?? null
    )
  }, [])

  // A move to a row or column that was not in the document waits for the render that adds it.
  useLayoutEffect(() => {
    const target = pendingFocus.current
    if (target === null) return
    pendingFocus.current = null
    findCell(target)?.focus()
  })

  const moveTo = (position: GridPosition) => {
    setActive(position)
    if (position.row >= 1) virtualizer.scrollToIndex(position.row - 1)
    columnVirtualizer.scrollToIndex(position.col)
    const cell = findCell(position)
    if (cell === null) pendingFocus.current = position
    else cell.focus()
  }

  const openSheet = useCallback(
    (row: number, col: number) => {
      const meta = metas[col]
      if (meta === undefined) return
      setSheet({ row, col, value: rows[row - 1]?.[col], meta, open: true })
    },
    [metas, rows],
  )

  // --- copy and export ---------------------------------------------------------------------------
  const announce = (message: string) => setNotice({ text: message, rows })

  const writeToClipboard = async (
    text: string,
    copied: string,
    extra?: string,
    level: 'success' | 'warning' = 'success',
  ) => {
    const hidden = countHiddenCharacters(text)
    const ok = await copyToClipboard(text)
    if (!ok) {
      announce('Could not copy: the browser did not allow access to the clipboard.')
      toast.error('Could not copy to the clipboard', {
        description: 'The browser did not allow access. Select the text and copy it yourself.',
      })
      return
    }
    const notes = [
      extra,
      hidden > 0
        ? `It holds ${plural(hidden, 'hidden character', 'hidden characters')}, copied as they are.`
        : undefined,
    ].filter((note): note is string => note !== undefined)
    announce([copied, ...notes].join(' '))
    const options = notes.length === 0 ? undefined : { description: notes.join(' ') }
    if (level === 'warning') toast.warning(copied, options)
    else toast.success(copied, options)
  }

  const copyCell = (row: number, col: number) => {
    const meta = metas[col]
    const value = rows[row - 1]?.[col]
    const text = meta === undefined ? null : fullText(value, meta)
    if (text === null) {
      announce('Nothing was copied: the cell has no value.')
      toast.info('Nothing to copy', { description: 'The cell has no value (NULL or masked).' })
      return
    }
    const cut = typeof value === 'object' && value !== null
    void writeToClipboard(
      text,
      'Copied the cell value.',
      cut ? 'The server cut this value; the copy holds the part the grid has.' : undefined,
    )
  }

  const copyRow = (row: number) => {
    const values = rows[row - 1]
    if (values === undefined) return
    void writeToClipboard(rowToTsv(values, metas), 'Copied the row as tab-separated values.')
  }

  /**
   * Copies the loaded rows to the clipboard as a Markdown table, CSV or JSON,
   * up to the same caps as an export. The message says how many rows were
   * copied and what was left out, as an export does.
   */
  const copyAs = (format: ExportFormat) => {
    const result = buildExport({
      columns: metas,
      rows,
      format,
      limit: exportLimit ?? DEFAULT_EXPORT_LIMIT,
      moreRows: truncated !== undefined || page?.hasMore === true,
      purpose: 'copy',
    })
    void writeToClipboard(
      result.text,
      result.message,
      undefined,
      result.incomplete || result.truncatedValues > 0 ? 'warning' : 'success',
    )
  }

  const runExport = (format: ExportFormat) => {
    const result = buildExport({
      columns: metas,
      rows,
      format,
      limit: exportLimit ?? DEFAULT_EXPORT_LIMIT,
      moreRows: truncated !== undefined || page?.hasMore === true,
    })
    try {
      downloadText(
        result.text,
        safeFileName(fileName, format),
        format === 'csv'
          ? 'text/csv;charset=utf-8'
          : format === 'markdown'
            ? 'text/markdown;charset=utf-8'
            : 'application/json;charset=utf-8',
      )
    } catch {
      announce('Could not create the file.')
      toast.error('Could not create the file', {
        description: 'The browser did not start the download.',
      })
      return
    }
    announce(result.message)
    if (result.incomplete || result.truncatedValues > 0) toast.warning(result.message)
    else toast.success(result.message)
    onExport?.(result)
  }

  // --- keyboard ------------------------------------------------------------------------------------
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const root = scrollRef.current
    const target = event.target
    if (event.defaultPrevented || root === null || !(target instanceof HTMLElement)) return
    const cell = target.closest<HTMLElement>('[data-exdb-r]')
    if (cell === null || !root.contains(cell)) return
    const row = Number(cell.dataset['exdbR'])
    const col = Number(cell.dataset['exdbC'])
    if (Number.isNaN(row) || Number.isNaN(col)) return
    const ctrl = event.ctrlKey || event.metaKey

    if (ctrl && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'c') {
      if (row >= 1 && !hasTextSelection()) {
        event.preventDefault()
        copyCell(row, col)
      }
      return
    }
    if (
      row >= 1 &&
      cell === target &&
      (event.key === 'Enter' || event.key === ' ' || event.key === 'F2')
    ) {
      event.preventDefault()
      openSheet(row, col)
      return
    }
    const visibleRows = Math.floor((root.clientHeight - HEADER_HEIGHT) / rowHeight)
    const next = nextPosition(
      { row, col },
      { key: event.key, ctrl },
      {
        rows: rows.length,
        columns: metas.length,
        pageSize: visibleRows > 0 ? visibleRows : FALLBACK_PAGE_ROWS,
      },
    )
    if (next !== null) {
      event.preventDefault()
      moveTo(next)
    }
  }

  const onFocus = (event: React.FocusEvent<HTMLDivElement>) => {
    const root = scrollRef.current
    const target = event.target
    if (root === null || !(target instanceof HTMLElement)) return
    const cell = target.closest<HTMLElement>('[data-exdb-r]')
    if (cell === null || !root.contains(cell)) return
    const row = Number(cell.dataset['exdbR'])
    const col = Number(cell.dataset['exdbC'])
    if (Number.isNaN(row) || Number.isNaN(col)) return
    setActive((current) => (current.row === row && current.col === col ? current : { row, col }))
  }

  const sheetView: CellView | undefined = useMemo(
    () => (sheet === null ? undefined : viewCell(sheet.value, sheet.meta)),
    [sheet],
  )

  // --- render ----------------------------------------------------------------------------------------
  const style: GridStyle = {
    maxHeight,
    scrollPaddingTop: HEADER_HEIGHT,
    '--exdb-grid-cols': template,
    '--exdb-grid-width': `${totalWidth}px`,
  }
  const onBodyCell = activePosition.row >= 1
  const moreRows = page?.hasMore === true
  const summary = `${plural(rows.length, 'row', 'rows')}${page === undefined ? '' : ' loaded'}, ${plural(metas.length, 'column', 'columns')}`

  return (
    <div data-slot="data-grid" data-state={state} className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p data-slot="grid-summary" className="text-xs text-foreground-light">
          {summary}
        </p>
        {/* biome-ignore lint/a11y/useSemanticElements: the actions are a group of buttons; <fieldset> is a form section */}
        <div role="group" aria-label="Grid actions" className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            icon={<Copy />}
            disabled={!onBodyCell}
            onClick={() => copyCell(activePosition.row, activePosition.col)}
          >
            Copy cell
          </Button>
          <Button
            type="button"
            variant="outline"
            icon={<Copy />}
            disabled={!onBodyCell}
            onClick={() => copyRow(activePosition.row)}
          >
            Copy row
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                icon={<Copy />}
                iconRight={<ChevronDown className="size-3" />}
              >
                Copy as
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onSelect={() => copyAs('markdown')}>Markdown</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => copyAs('csv')}>CSV</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => copyAs('json')}>JSON</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button type="button" variant="outline" onClick={() => runExport('csv')}>
            Export CSV
          </Button>
          <Button type="button" variant="outline" onClick={() => runExport('json')}>
            Export JSON
          </Button>
        </div>
      </div>
      {notice !== null && notice.rows === rows && (
        <p data-slot="grid-notice" className="text-xs text-foreground-light">
          {notice.text}
        </p>
      )}
      {truncated !== undefined && (
        <Alert variant="warning" data-slot="grid-truncated">
          <AlertTitle>The server cut this result</AlertTitle>
          <AlertDescription>
            Reason: <UntrustedName name={truncated.reason} label="reason" />. Rows after the cut are
            not loaded and are not in exports.
          </AlertDescription>
        </Alert>
      )}
      <AriaGrid
        ref={scrollRef}
        aria-label={label}
        aria-readonly="true"
        aria-rowcount={moreRows ? -1 : rows.length + 1}
        aria-colcount={metas.length}
        aria-busy={busy || page?.loading === true ? 'true' : undefined}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        className="relative overflow-auto rounded-md border bg-surface-100 text-foreground"
        style={style}
      >
        <AriaRowGroup className="sticky top-0 z-10 w-[var(--exdb-grid-width)] bg-surface-100">
          <AriaRow
            aria-rowindex={1}
            className="grid border-b bg-surface-200 [grid-template-columns:var(--exdb-grid-cols)]"
            style={{ height: HEADER_HEIGHT }}
          >
            {colIndexes.map((col) => {
              const header = headers[col]
              const meta = metas[col]
              if (header === undefined || meta === undefined) return null
              const focusable = activePosition.row === 0 && activePosition.col === col
              const sorted = header.column.getIsSorted()
              if (!header.column.getCanSort()) {
                return (
                  <AriaColumnHeader
                    key={header.id}
                    aria-colindex={col + 1}
                    tabIndex={focusable ? 0 : -1}
                    data-exdb-r={0}
                    data-exdb-c={col}
                    style={{ gridColumnStart: col + 1 }}
                    className={cn(
                      'focus-inset flex min-w-0 items-center gap-2 px-3 text-xs',
                      isNumericKind(meta.kind) && 'justify-end',
                    )}
                  >
                    <HeaderLabel meta={meta} />
                  </AriaColumnHeader>
                )
              }
              const toggle = () => {
                if (sorted === false) header.column.toggleSorting(false)
                else if (sorted === 'asc') header.column.toggleSorting(true)
                else header.column.clearSorting()
              }
              return (
                <AriaColumnHeader
                  key={header.id}
                  aria-colindex={col + 1}
                  aria-sort={
                    sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'
                  }
                  style={{ gridColumnStart: col + 1 }}
                  className="min-w-0"
                >
                  <button
                    type="button"
                    tabIndex={focusable ? 0 : -1}
                    data-exdb-r={0}
                    data-exdb-c={col}
                    onClick={toggle}
                    className={cn(
                      'focus-inset flex h-full w-full min-w-0 items-center gap-2 px-3 text-left text-xs',
                      isNumericKind(meta.kind) && 'justify-end',
                    )}
                  >
                    <HeaderLabel meta={meta} />
                    <span
                      aria-hidden="true"
                      className={cn(
                        'shrink-0 text-foreground-lighter',
                        !isNumericKind(meta.kind) && 'ml-auto',
                      )}
                    >
                      {sorted === 'asc' ? (
                        <ArrowUp className="size-3" />
                      ) : sorted === 'desc' ? (
                        <ArrowDown className="size-3" />
                      ) : (
                        <ChevronsUpDown className="size-3 opacity-60" />
                      )}
                    </span>
                  </button>
                </AriaColumnHeader>
              )
            })}
          </AriaRow>
        </AriaRowGroup>
        <AriaRowGroup
          className="relative w-[var(--exdb-grid-width)]"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {items.map((item) => {
            const row = tableRows[item.index]
            if (row === undefined) return null
            return (
              <GridRow
                key={item.key}
                index={item.index}
                row={row}
                metas={metas}
                colIndexes={colIndexes}
                expandLimits={expandLimits}
                offset={item.start - virtualizer.options.scrollMargin}
                rowHeight={rowHeight}
                activeCol={activePosition.row === item.index + 1 ? activePosition.col : -1}
                onOpen={openSheet}
              />
            )
          })}
        </AriaRowGroup>
      </AriaGrid>
      {page !== undefined && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p data-slot="grid-page" className="text-xs text-foreground-light">
            {page.hasMore
              ? 'More rows are available.'
              : truncated === undefined
                ? 'All rows are loaded.'
                : 'The server cut this result; more rows exist than shown.'}
          </p>
          {page.hasMore && (
            <Button
              type="button"
              variant="outline"
              loading={page.loading}
              onClick={page.onLoadMore}
            >
              Load more rows
            </Button>
          )}
        </div>
      )}
      <FullValueSheet
        open={sheet?.open === true}
        onOpenChange={(open) =>
          setSheet((current) => (current === null ? null : { ...current, open }))
        }
        column={sheet?.meta}
        row={sheet?.row ?? 0}
        view={sheetView}
        onCloseFocus={() => {
          // Back to the cell the sheet was opened from, or the active one if it left the document.
          const origin = sheet === null ? null : findCell({ row: sheet.row, col: sheet.col })
          ;(origin ?? findCell(activePosition))?.focus()
        }}
        onCopy={() => {
          if (sheet === null) return
          const text = fullText(sheet.value, sheet.meta)
          if (text === null) return
          void writeToClipboard(
            text,
            'Copied the value.',
            typeof sheet.value === 'object' && sheet.value !== null
              ? 'The server cut this value; the copy holds the part the grid has.'
              : undefined,
          )
        }}
      />
    </div>
  )
}

/**
 * A read-only data grid for a result of rows: virtualized in both directions
 * (only the visible rows and columns are in the document), keyboard operable as
 * an ARIA grid, and truthful about what it shows.
 *
 * - States come from `ReadableView`: a failed read is "Could not read …" and
 *   never "No rows"; a stale or partial read keeps its banner above the rows.
 * - Values are text (C-26): invisible and direction characters appear as code
 *   points, NULL, an empty string, a masked value and a missing one look
 *   different, a long value is cut in the cell and opens whole in a side sheet.
 * - Copy a cell or a row (tab-separated), copy the loaded rows as a Markdown
 *   table, CSV or JSON ("Copy as"), or export them as CSV or JSON, up to
 *   `exportLimit`; a copy or an export that ends early or leaves rows on the
 *   server says so, in the status line and in a toast. CSV and the copied row
 *   guard against spreadsheet formulas (see `guardFormula`).
 * - Sorting is the server's: headers are sortable only when `sort` is passed.
 * - More rows are read only when the person presses "Load more rows" (`page`):
 *   every read of a target is an audited action, so scrolling never causes one.
 * - Keys: arrows, Home/End, PageUp/PageDown, Ctrl+Home/End move one active
 *   cell (the only tab stop; the header row is part of the grid); Enter, Space
 *   or F2 opens the full value; Ctrl or Cmd+C copies the cell.
 *
 * Pass `columns` and `rows` that change only when the result changes; equal
 * columns passed again cost nothing.
 */
export function DataGrid(props: DataGridProps): ReactNode {
  const {
    columns,
    rows,
    what = 'result rows',
    onRetry,
    onRefresh,
    busy,
    now,
    className,
    ...content
  } = props
  return (
    <div className={cn('min-w-0', className)}>
      <ReadableView
        readable={rows}
        what={what}
        loading={<GridSkeleton columns={columns.length} />}
        onRetry={onRetry}
        onRefresh={onRefresh}
        busy={busy}
        now={now}
        ready={(value, meta) => {
          if (columns.length === 0) {
            return (
              <EmptyState
                title="No columns"
                description={`The statement returned ${plural(value.length, 'row', 'rows')} but no columns, so there is nothing to show.`}
              />
            )
          }
          if (value.length === 0) {
            return meta.state === 'partial' ? (
              <p
                data-slot="grid-partial-empty"
                className="rounded-md border border-dashed px-4 py-6 text-sm text-foreground-light"
              >
                The part that was read holds no rows. Rows may be among what is missing.
              </p>
            ) : (
              <EmptyState
                title="No rows"
                description={
                  meta.state === 'stale'
                    ? 'The last successful read returned no rows.'
                    : 'The read succeeded and returned no rows.'
                }
              />
            )
          }
          return (
            <GridContent
              {...content}
              columns={columns}
              rows={value}
              state={meta.state}
              busy={busy}
            />
          )
        }}
      />
    </div>
  )
}

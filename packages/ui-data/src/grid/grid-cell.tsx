import { Eye, Lock } from '@exponetdb/icons'
import { Button, cn } from '@exponetdb/ui'
import { renderLine } from '@exponetdb/ui-patterns'
import { memo, type ReactNode, useMemo } from 'react'

import { AriaGridCell } from './aria-grid.tsx'
import { type CellView, viewCell } from './cell-format.ts'
import type { ColumnMeta } from './column-kind.ts'
import type { CellValue } from './types.ts'

/** NULL, an empty string, a masked value and a missing value never look like text. */
export function CellToken({ view }: { view: CellView }): ReactNode {
  switch (view.kind) {
    case 'null':
      return (
        <span
          data-cell="null"
          className="rounded-sm border border-default px-1 text-[11px] italic leading-4 text-foreground-muted"
        >
          <span aria-hidden="true">NULL</span>
          <span className="sr-only">null value</span>
        </span>
      )
    case 'empty':
      return (
        <span data-cell="empty" className="italic text-foreground-muted">
          <span aria-hidden="true">(empty)</span>
          <span className="sr-only">empty string</span>
        </span>
      )
    case 'masked':
      return (
        <span
          data-cell="masked"
          className="inline-flex items-center gap-1 rounded-sm border border-default px-1 text-[11px] leading-4 text-foreground-lighter"
        >
          <Lock aria-hidden="true" className="size-3" />
          masked
        </span>
      )
    case 'missing':
      return (
        <span data-cell="missing" className="italic text-foreground-muted">
          no value in this row
        </span>
      )
    default:
      return null
  }
}

export interface GridCellProps {
  value: CellValue | undefined
  meta: ColumnMeta
  /** 1-based grid row (the header is row 0). */
  row: number
  /** 0-based column. */
  col: number
  /** The roving tab stop: the one cell with `tabIndex` 0. */
  focusable: boolean
  /** The cell the copy actions act on. */
  active: boolean
  /** A value longer than this many characters is likely cut by the column width. */
  expandAbove: number
  onOpen: (row: number, col: number) => void
}

/**
 * One data cell: the value as text (never markup), cut in the cell with an
 * explicit "Show full value" when it is long, multi-line or cut by the server.
 */
export const GridCell = memo(function GridCell({
  value,
  meta,
  row,
  col,
  focusable,
  active,
  expandAbove,
  onOpen,
}: GridCellProps): ReactNode {
  const view = useMemo(() => viewCell(value, meta), [value, meta])
  const text = view.kind === 'text' ? view : undefined
  const expandable =
    text !== undefined &&
    (text.cut || text.multiline || text.serverCut !== undefined || text.length > expandAbove)
  const shown = useMemo(
    () => (text === undefined ? undefined : renderLine(text.shown, `cell${row}:${col}`).nodes),
    [text, row, col],
  )
  return (
    <AriaGridCell
      aria-colindex={col + 1}
      tabIndex={focusable ? 0 : -1}
      data-exdb-r={row}
      data-exdb-c={col}
      data-active={active ? 'true' : undefined}
      data-kind={meta.kind}
      data-align={text?.align}
      onDoubleClick={() => onOpen(row, col)}
      style={{ gridColumnStart: col + 1 }}
      className={cn(
        'focus-inset relative flex min-w-0 items-center gap-2 overflow-hidden px-3 font-mono text-xs tabular-nums',
        text?.align === 'end' && 'justify-end',
        active && 'bg-accent',
        expandable && 'pr-9',
      )}
    >
      {text === undefined ? (
        <CellToken view={view} />
      ) : (
        <>
          <span dir="ltr" className="min-w-0 truncate [unicode-bidi:isolate-override]">
            {shown}
            {text.cut && <span aria-hidden="true">…</span>}
          </span>
          {text.suffix !== undefined && (
            <span className="shrink-0 text-[11px] text-foreground-lighter">{text.suffix}</span>
          )}
        </>
      )}
      {expandable && (
        <Button
          type="button"
          size="tiny"
          variant="text"
          tabIndex={-1}
          aria-label="Show full value"
          icon={<Eye />}
          className="absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2 bg-surface-100"
          onClick={() => onOpen(row, col)}
        />
      )}
    </AriaGridCell>
  )
})

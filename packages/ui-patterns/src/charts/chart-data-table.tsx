import { Button, cn, TableCell, TableHead, TableHeader, TableRow } from '@exponetdb/ui'
import { type ReactNode, useId, useState } from 'react'

/** The most rows of a data table; a longer one says how many it left out. */
export const DATA_TABLE_ROW_LIMIT = 500

export interface ChartDataColumn {
  readonly id: string
  /** Header text. Untrusted text (a series label) is passed through `visibleText` by the caller. */
  readonly header: string
  readonly align?: 'left' | 'right'
}

export interface ChartDataRow {
  readonly id: string
  /** One cell per column, in column order. The first cell is the row header. */
  readonly cells: readonly ReactNode[]
}

/**
 * The text alternative of a chart: the same numbers as a real table, behind a
 * "Show data as table" toggle (WCAG 1.1.1). A chart is a picture of this table;
 * a person who cannot see the picture reads the table. The table sits in a named,
 * focusable region so a keyboard user can scroll it.
 */
export function ChartDataTableToggle({
  name,
  columns,
  rows,
  note,
  className,
}: {
  name: string
  columns: readonly ChartDataColumn[]
  rows: readonly ChartDataRow[]
  /** A line under the table, for what the table cannot show (for example a gap's cause). */
  note?: string
  className?: string
}): ReactNode {
  const id = useId()
  const [open, setOpen] = useState(false)
  const shown = rows.length > DATA_TABLE_ROW_LIMIT ? rows.slice(-DATA_TABLE_ROW_LIMIT) : rows
  return (
    <div className={cn('flex flex-col gap-2', className)} data-slot="data-table">
      <div>
        <Button
          type="button"
          size="tiny"
          variant="text"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? 'Hide data table' : 'Show data as table'}
        </Button>
      </div>
      <div id={id} hidden={!open}>
        {open ? (
          <section
            aria-label={`${name}, data table`}
            // A region that scrolls must be a tab stop so the keyboard can reach its content (WCAG 2.1.1).
            // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region
            tabIndex={0}
            className="focus-inset max-h-72 overflow-auto rounded-md border"
          >
            <table className="w-full caption-bottom text-xs">
              <caption className="sr-only">{name}</caption>
              <TableHeader>
                <TableRow>
                  {columns.map((column) => (
                    <TableHead
                      key={column.id}
                      scope="col"
                      className={cn(
                        'h-8 px-3 whitespace-nowrap',
                        column.align === 'right' && 'text-right',
                      )}
                    >
                      {column.header}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <tbody>
                {shown.map((row) => (
                  <TableRow key={row.id}>
                    {row.cells.map((cell, index) => {
                      const column = columns[index]
                      const key = column?.id ?? String(index)
                      const alignment = column?.align === 'right' && 'text-right'
                      return index === 0 ? (
                        <th
                          key={key}
                          scope="row"
                          className="px-3 py-1.5 text-left align-top font-normal whitespace-nowrap text-foreground-light"
                        >
                          {cell}
                        </th>
                      ) : (
                        <TableCell
                          key={key}
                          className={cn('px-3 py-1.5 align-top tabular-nums', alignment)}
                        >
                          {cell}
                        </TableCell>
                      )
                    })}
                  </TableRow>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
        {open && rows.length > shown.length ? (
          <p className="mt-1 text-xs text-foreground-lighter">
            Showing the newest {shown.length} of {rows.length} rows.
          </p>
        ) : null}
        {open && note ? <p className="mt-1 text-xs text-foreground-lighter">{note}</p> : null}
      </div>
    </div>
  )
}

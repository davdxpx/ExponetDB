// Derived from supabase/supabase packages/ui/src/components/shadcn/ui/table.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { ArrowDown, ArrowUp, ChevronsUpDown } from '@exponetdb/icons'
import type { ComponentProps } from 'react'
import * as React from 'react'

import { cn } from './lib/utils.ts'
import { ShadowScrollArea } from './shadow-scroll-area.tsx'

interface TableProps extends React.HTMLAttributes<HTMLTableElement> {
  containerProps?: Partial<ComponentProps<typeof ShadowScrollArea>>
}

const Table = React.forwardRef<HTMLTableElement, TableProps>(
  ({ className, containerProps, ...props }, ref) => {
    return (
      <ShadowScrollArea {...containerProps}>
        <table
          ref={ref}
          className={cn('group/table w-full caption-bottom text-sm', className)}
          {...props}
        />
      </ShadowScrollArea>
    )
  },
)
Table.displayName = 'Table'

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn('[&_tr]:border-b [&>tr]:bg-200', className)} {...props} />
))
TableHeader.displayName = 'TableHeader'

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody
    ref={ref}
    className={cn(
      '[&_tr:last-child]:border-0',
      // :where() keeps this at lower specificity than a row's own hover:* class, so rows can opt out (e.g. loading/empty states)
      '[:where(&)>tr]:hover:bg-surface-200',
      className,
    )}
    {...props}
  />
))
TableBody.displayName = 'TableBody'

const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tfoot ref={ref} className={cn('border-t font-medium', className)} {...props} />
))
TableFooter.displayName = 'TableFooter'

/**
 * A row that is a control (it has `onClick` or `tabIndex`) shows a visible inset focus. Such a row
 * must also be keyboard operable (`tabIndex={0}` and a key handler), or carry a link or button in
 * one of its cells instead.
 */
const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, onClick, tabIndex, ...props }, ref) => (
    <tr
      ref={ref}
      onClick={onClick}
      tabIndex={tabIndex}
      className={cn(
        'border-b group data-[state=selected]:bg-muted',
        (onClick !== undefined || tabIndex !== undefined) && 'focus-inset',
        className,
      )}
      {...props}
    />
  ),
)
TableRow.displayName = 'TableRow'

type AriaSort = 'ascending' | 'descending' | 'none'

/** Lets a sort button inside a column header report its state to the `th`, which owns `aria-sort`. */
const TableHeadSortContext = React.createContext<((sort: AriaSort | undefined) => void) | null>(
  null,
)

/**
 * A column header. `aria-sort` lives here (only a column header may carry it): set it yourself, or
 * put a `TableHeadSort` inside and the header takes the state of that button.
 */
const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => {
  const [reportedSort, setReportedSort] = React.useState<AriaSort | undefined>(undefined)

  return (
    <TableHeadSortContext.Provider value={setReportedSort}>
      <th
        ref={ref}
        aria-sort={reportedSort}
        className={cn(
          'h-(--table-head-height) px-4 text-left align-middle text-xs eyebrow whitespace-nowrap text-foreground-lighter [&:has([role=checkbox])]:pr-0',
          // Transition text color when NoSearchResults or NoFilterResults empty state is shown
          'transition-colors',
          className,
        )}
        {...props}
      />
    </TableHeadSortContext.Provider>
  )
})
TableHead.displayName = 'TableHead'

interface TableHeadSortProps<TColumn extends string = string> {
  column: TColumn
  /** `<column>:asc`, `<column>:desc`, or an empty string when nothing is sorted. */
  currentSort: string
  onSortChange: (column: TColumn) => void
  children: React.ReactNode
  className?: string
}

/**
 * The sort control of a column header: a real button, so Enter and Space sort, inside a `TableHead`
 * (which exposes the state as `aria-sort`). The arrows only repeat what the header states.
 */
function TableHeadSort<TColumn extends string = string>({
  column,
  currentSort,
  onSortChange,
  children,
  className,
}: TableHeadSortProps<TColumn>) {
  // A column id may contain colons; the direction is what follows the last one.
  const separator = currentSort.lastIndexOf(':')
  const currentCol = separator === -1 ? currentSort : currentSort.slice(0, separator)
  const currentOrder = separator === -1 ? '' : currentSort.slice(separator + 1)
  const isActive = currentCol === column
  const isAsc = isActive && currentOrder === 'asc'
  const isDesc = isActive && currentOrder === 'desc'
  const ariaSort: AriaSort = isAsc ? 'ascending' : isDesc ? 'descending' : 'none'

  const reportSort = React.useContext(TableHeadSortContext)
  React.useLayoutEffect(() => {
    reportSort?.(ariaSort)
    return () => reportSort?.(undefined)
  }, [reportSort, ariaSort])

  const baseIconClass = 'w-3 h-3 absolute inset-0'

  return (
    <button
      type="button"
      className={cn(
        'group/table-head-sort text-xs eyebrow whitespace-nowrap flex items-center gap-1 cursor-pointer select-none bg-transparent! border-none p-0 w-full text-left',
        'focus-inset',
        className,
      )}
      onClick={() => onSortChange(column)}
    >
      {children}
      <span aria-hidden="true" className="w-3 h-3 relative overflow-hidden">
        <ArrowUp
          className={cn(
            baseIconClass,
            'transition-transform motion-reduce:transition-none',
            isAsc ? 'translate-y-0' : 'translate-y-full',
          )}
        />
        <ArrowDown
          className={cn(
            baseIconClass,
            'transition-transform motion-reduce:transition-none',
            isDesc ? 'translate-y-0' : '-translate-y-full',
          )}
        />
        <ChevronsUpDown
          className={cn(
            baseIconClass,
            'transition-opacity motion-reduce:transition-none opacity-80 md:opacity-40',
            !isActive ? 'group-hover/table-head-sort:opacity-80' : 'opacity-0!',
          )}
        />
      </span>
    </button>
  )
}
TableHeadSort.displayName = 'TableHeadSort'

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td
    ref={ref}
    className={cn(
      'transition-colors px-4 py-(--row-padding-y) align-middle [&:has([role=checkbox])]:pr-0',
      className,
    )}
    {...props}
  />
))
TableCell.displayName = 'TableCell'

const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption
    ref={ref}
    className={cn(
      'border-t', // TableCaption is aligned by parent Table at caption-bottom
      'p-4 text-sm text-foreground-muted', // Match styling of TableCell
      className,
    )}
    // Should only contain inline elements
    {...props}
  />
))
TableCaption.displayName = 'TableCaption'

export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableHeadSort,
  TableRow,
}

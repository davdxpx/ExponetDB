// Derived from supabase/supabase packages/ui-patterns/src/Table/TanStackTableHeadSort.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { cn, TableHeadSort } from '@exponetdb/ui'
import type { Column } from '@tanstack/react-table'
import type { ReactNode } from 'react'

export interface TanStackTableHeadSortProps<TData, TValue> {
  column: Column<TData, TValue>
  children: ReactNode
  className?: string
}

/**
 * The sort control of a column header for a TanStack Table 8 table: it cycles the column through
 * ascending, descending and unsorted. Put it in the header of a `TableHead` from `@exponetdb/ui`:
 * that `th` then carries `aria-sort` (`ascending`, `descending` or `none`), and the control is a
 * real button, so Enter and Space sort. A column that cannot be sorted renders its label as
 * plain content, without a button and without `aria-sort`.
 */
export function TanStackTableHeadSort<TData, TValue>({
  column,
  children,
  className,
}: TanStackTableHeadSortProps<TData, TValue>) {
  if (!column.getCanSort()) {
    return <div className={cn(className)}>{children}</div>
  }

  const sort = column.getIsSorted()
  const currentSort = sort ? `${column.id}:${sort}` : ''

  const handleSortChange = () => {
    if (!sort) {
      column.toggleSorting(false)
      return
    }

    if (sort === 'asc') {
      column.toggleSorting(true)
      return
    }

    column.clearSorting()
  }

  return (
    <TableHeadSort
      column={column.id}
      currentSort={currentSort}
      onSortChange={handleSortChange}
      className={className}
    >
      {children}
    </TableHeadSort>
  )
}

import { cn, Skeleton } from '@exponetdb/ui'
import type { ReactNode } from 'react'

const MAX_SKELETON_COLUMNS = 6
const SKELETON_ROWS = 8

/**
 * The loading shape of the grid: a header row and a few rows of cells. It is
 * drawn with `Skeleton` blocks, which assistive technology skips; the loading
 * region of `ReadableView` announces "Loading …".
 */
export function GridSkeleton({
  columns,
  className,
}: {
  columns: number
  className?: string
}): ReactNode {
  const count = Math.min(MAX_SKELETON_COLUMNS, Math.max(2, columns))
  const slots = Array.from({ length: count }, (_, slot) => slot)
  const rows = Array.from({ length: SKELETON_ROWS }, (_, row) => row)
  return (
    <div
      data-slot="grid-skeleton"
      className={cn('overflow-hidden rounded-md border bg-surface-100', className)}
    >
      <div className="flex gap-4 border-b bg-surface-200 px-3 py-3">
        {slots.map((slot) => (
          <Skeleton key={slot} className="h-3 flex-1" />
        ))}
      </div>
      {rows.map((row) => (
        <div key={row} className="flex gap-4 border-b px-3 py-2.5 last:border-b-0">
          {slots.map((slot) => (
            <Skeleton key={slot} className="h-3 flex-1" />
          ))}
        </div>
      ))}
    </div>
  )
}

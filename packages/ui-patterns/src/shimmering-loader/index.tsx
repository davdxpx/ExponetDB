// Derived from supabase/supabase packages/ui-patterns/src/ShimmeringLoader/index.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import {
  Card,
  cn,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import { type CSSProperties, forwardRef } from 'react'

import './index.css'

export interface ShimmeringLoaderProps {
  className?: string
  style?: CSSProperties
  delayIndex?: number
  animationDelay?: number
}

/**
 * A block with a moving highlight that stands in for content that is loading. It is hidden
 * from assistive technology: the region that loads says "Loading" itself (`GenericSkeletonLoader`
 * and the state components do). The highlight stops under `prefers-reduced-motion`.
 */
export const ShimmeringLoader = forwardRef<HTMLDivElement, ShimmeringLoaderProps>(
  ({ className, style, delayIndex = 0, animationDelay = 150 }, ref) => {
    return (
      <div
        ref={ref}
        aria-hidden="true"
        className={cn('shimmering-loader rounded-sm py-3', className)}
        style={{
          ...style,
          animationFillMode: 'backwards',
          animationDelay: `${delayIndex * animationDelay}ms`,
        }}
      />
    )
  },
)
ShimmeringLoader.displayName = 'ShimmeringLoader'

interface GenericSkeletonLoaderProps {
  className?: string
  /** What the loading region is announced as. */
  label?: string
}

/** Three lines of placeholder; announces `label` ("Loading") as a status. */
export const GenericSkeletonLoader = ({
  className,
  label = 'Loading',
}: GenericSkeletonLoaderProps) => (
  <div role="status" className={cn(className, 'space-y-2')}>
    <span className="sr-only">{label}</span>
    <ShimmeringLoader />
    <ShimmeringLoader className="w-3/4" />
    <ShimmeringLoader className="w-1/2" />
  </div>
)

interface GenericSelectionSkeletonLoaderProps {
  className?: string
  // Selection primitives have different row indicators: command lists have none, Select uses
  // radio circles, and MultiSelector uses checkboxes.
  variant?: 'command' | 'multi-select' | 'select'
}

/** Placeholder rows of a selection list. Hidden: `SelectionListState` announces the loading. */
export const GenericSelectionSkeletonLoader = ({
  className,
  variant = 'multi-select',
}: GenericSelectionSkeletonLoaderProps) => {
  const hasIndicator = variant !== 'command'
  const isSelect = variant === 'select'

  return (
    <div className={cn(className, 'flex flex-col')} aria-hidden="true">
      {['w-2/3', 'w-1/2', 'w-3/4'].map((width, index) => (
        <div
          key={width}
          className={cn('flex items-center px-2', isSelect ? 'h-8 gap-2.5' : 'h-7 gap-2')}
        >
          {hasIndicator && (
            <ShimmeringLoader
              className={cn(
                'shrink-0 py-0',
                isSelect ? 'h-3.5 w-3.5 rounded-full' : 'h-4 w-4 rounded-sm',
              )}
              delayIndex={index}
            />
          )}
          <ShimmeringLoader className={cn('h-3 py-0', width)} delayIndex={index} />
        </div>
      ))}
    </div>
  )
}

interface GenericTableLoaderProps {
  /** The column headers; a `null` leaves a column without one (an actions column). */
  headers?: (string | null)[]
  numRows?: number
  /** What the loading table is announced as. */
  label?: string
}

/** A table whose rows are placeholders. The table is marked busy and named by `label`. */
export const GenericTableLoader = ({
  headers = [],
  numRows = 3,
  label = 'Loading',
}: GenericTableLoaderProps) => {
  const columns = Math.max(1, headers.length)
  return (
    <Card>
      <Table aria-busy="true" aria-label={label}>
        <TableHeader>
          <TableRow>
            {headers.length === 0 ? (
              <TableHead>
                <span className="sr-only">{label}</span>
              </TableHead>
            ) : (
              headers.map((header, index) => (
                // The header list is fixed for a table, so the position identifies the column.
                // biome-ignore lint/suspicious/noArrayIndexKey: columns have no other identity
                <TableHead key={`${header ?? 'column'}_${index}`}>{header}</TableHead>
              ))
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: numRows }, (_, row) => `row_${row}`).map((key) => (
            <TableRow key={key}>
              <TableCell colSpan={columns}>
                <ShimmeringLoader />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  )
}

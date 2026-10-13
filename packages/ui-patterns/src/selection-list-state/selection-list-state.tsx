// Derived from supabase/supabase packages/ui-patterns/src/SelectionListState/SelectionListState.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { cn } from '@exponetdb/ui'

import { GenericSelectionSkeletonLoader } from '../shimmering-loader/index.tsx'

export interface SelectionListStateProps {
  className?: string
  /** Shown when the read succeeded and there is nothing to choose. */
  emptyLabel?: string
  /** Shown when the read failed. It never says there are no options. */
  errorLabel?: string
  isEmpty?: boolean
  isError?: boolean
  isLoading?: boolean
  skeletonVariant?: 'command' | 'multi-select' | 'select'
}

/**
 * The state of a selection list that has no options to show: loading, failed or empty. One live
 * region stays mounted so a screen reader hears the state change. The states exclude each other
 * in this order: loading, then failed, then empty. A failed read therefore never reads as an
 * empty list, even if the caller also reports `isEmpty` (C-28).
 */
export const SelectionListState = ({
  className,
  emptyLabel = 'No options available',
  errorLabel = 'Could not read the options',
  isEmpty = false,
  isError = false,
  isLoading = false,
  skeletonVariant = 'select',
}: SelectionListStateProps) => {
  let statusLabel: string | undefined
  if (isLoading) statusLabel = 'Loading options'
  else if (isError) statusLabel = errorLabel
  else if (isEmpty) statusLabel = emptyLabel

  return (
    <>
      {isLoading && (
        <GenericSelectionSkeletonLoader
          className={cn('w-full', className)}
          variant={skeletonVariant}
        />
      )}
      <div
        aria-live="polite"
        className={cn(
          'px-2 py-3 text-xs text-foreground-lighter',
          (isLoading || statusLabel === undefined) && 'sr-only',
          className,
        )}
      >
        {statusLabel}
      </div>
    </>
  )
}

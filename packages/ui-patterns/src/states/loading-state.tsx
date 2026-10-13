import { cn, Skeleton } from '@exponetdb/ui'
import type { ReactNode } from 'react'

const MAX_DEFAULT_LINES = 12

export interface LoadingStateProps {
  /** What is loading, without an article: "backup inventory". Spoken as "Loading backup inventory". */
  what: string
  /**
   * The skeleton, shaped like the final layout. The caller passes `Skeleton`
   * blocks (hidden from assistive technology); without it a few text lines are drawn.
   */
  children?: ReactNode
  /** The number of lines of the default skeleton. Default 3. */
  lines?: number
  className?: string
}

/** A loading region: a skeleton for sighted readers, "Loading X" for everyone else. */
export function LoadingState({
  what,
  children,
  lines = 3,
  className,
}: LoadingStateProps): ReactNode {
  const count = Math.min(MAX_DEFAULT_LINES, Math.max(1, Math.floor(lines)))
  const rows = Array.from({ length: count }, (_, row) => row)
  return (
    <div role="status" data-state="loading" className={cn('flex flex-col gap-2', className)}>
      <span className="sr-only">{`Loading ${what}`}</span>
      {children ??
        rows.map((row) => (
          <Skeleton
            key={row}
            className={cn('h-4', row === count - 1 && count > 1 ? 'w-2/3' : 'w-full')}
          />
        ))}
    </div>
  )
}

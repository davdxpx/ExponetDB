import { cn } from '@exponetdb/ui'
import type { ReactNode } from 'react'

/** A slanted stroke between two steps of the header's path. */
export function PathSeparator({ className }: { readonly className?: string }): ReactNode {
  return (
    <span aria-hidden="true" className={cn('shrink-0 text-border-stronger', className)}>
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
      >
        <path d="M15.5 3.5 8.5 20.5" />
      </svg>
    </span>
  )
}

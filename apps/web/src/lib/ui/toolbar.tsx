import { cn } from '@exponetdb/ui'
import type { ReactNode } from 'react'

/**
 * The filters of a list's toolbar as Studio's list pages show them
 * (information-architecture.md §2): one compact row above the list, each
 * filter a pill with its name and its control side by side, so the name stays
 * visible and is the control's label. The control inside takes
 * `TOOLBAR_CONTROL`; the pill draws the border and the focus ring.
 */
export function ToolbarField({
  id,
  label,
  children,
  className,
}: {
  /** The id of the control, which the name labels. */
  readonly id: string
  readonly label: string
  readonly children: ReactNode
  readonly className?: string
}): ReactNode {
  return (
    <div
      className={cn(
        'flex h-[26px] min-w-0 items-stretch overflow-hidden rounded-md border border-control bg-field text-xs transition-colors hover:border-control-hover',
        'has-[:focus-visible]:ring-[length:var(--focus-ring-width)] has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-background',
        'has-[[aria-invalid=true]]:border-destructive-400 has-[:disabled]:opacity-60',
        className,
      )}
    >
      <label
        htmlFor={id}
        className="flex shrink-0 items-center border-r border-control bg-surface-200 px-2 text-foreground-lighter"
      >
        {label}
      </label>
      {children}
    </div>
  )
}

/** The class of the `select` or `input` inside a `ToolbarField`. */
export const TOOLBAR_CONTROL =
  'h-full min-w-0 border-0 bg-transparent px-2 py-0 text-xs text-foreground outline-hidden placeholder:text-foreground-muted disabled:cursor-not-allowed [&:is(select)]:cursor-pointer'

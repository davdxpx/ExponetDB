import { cn } from '@exponetdb/ui'
import type { ReactNode } from 'react'

/**
 * One row of a swatch list: a chip painted by Tailwind classes (never a literal color) and the
 * token it shows. Every class name is written out in full in the demo files, so the Tailwind
 * scanner finds it.
 */
export interface SwatchSpec {
  /** The token, as written in the CSS (`--card`) or the utility family (`primary-200`). */
  readonly token: string
  /** The utility a component uses (`bg-card`). */
  readonly utility: string
  /** Classes that paint the chip: a background and, for a fill, the matching `-foreground` text. */
  readonly className: string
  /** What the token is for, in a few words. */
  readonly use: string
  /** Text on the chip. Defaults to nothing for a surface and to "Aa" for a fill. */
  readonly sample?: string
}

export function SwatchList({
  items,
  label,
  className,
}: {
  readonly items: readonly SwatchSpec[]
  readonly label: string
  readonly className?: string
}): ReactNode {
  return (
    <ul aria-label={label} className={cn('grid gap-3 sm:grid-cols-2', className)}>
      {items.map((item) => (
        <li key={item.utility} className="flex items-center gap-3">
          <span
            aria-hidden
            className={cn(
              'flex h-10 w-14 shrink-0 items-center justify-center rounded-md border border-default text-sm font-medium',
              item.className,
            )}
          >
            {item.sample}
          </span>
          <span className="min-w-0 text-sm">
            <code className="font-mono text-xs text-foreground">{item.utility}</code>
            <span className="block text-foreground-light">{item.use}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

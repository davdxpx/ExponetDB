import { cn } from '@exponetdb/ui'
import { type HTMLAttributes, type ReactNode, useId } from 'react'

import { type HeadingLevel, StateHeading } from './heading.tsx'

export interface StateMessageProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** A decorative icon; it is hidden from assistive technology, the title says what it says. */
  icon?: ReactNode
  title: string
  headingLevel?: HeadingLevel
  /** What the person can do about it: links or buttons. */
  actions?: ReactNode
}

/**
 * The frame of the named states that are neither an error nor an empty list
 * (not supported, not permitted, not available yet): an icon, a heading, a few
 * sentences and optional actions, in a solid frame (the dashed frame belongs to
 * `EmptyState` alone).
 */
export function StateMessage({
  icon,
  title,
  headingLevel = 3,
  actions,
  children,
  className,
  ...rest
}: StateMessageProps): ReactNode {
  const titleId = useId()
  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        'flex w-full flex-col items-center gap-y-3 rounded-lg border border-default bg-surface-100 px-4 py-10 text-center',
        className,
      )}
      {...rest}
    >
      {icon !== undefined && (
        <span aria-hidden="true" className="text-foreground-muted">
          {icon}
        </span>
      )}
      <StateHeading
        id={titleId}
        level={headingLevel}
        className="text-base font-medium text-foreground"
      >
        {title}
      </StateHeading>
      <div className="flex max-w-[640px] flex-col gap-y-1 text-sm text-balance text-foreground-light">
        {children}
      </div>
      {actions}
    </section>
  )
}

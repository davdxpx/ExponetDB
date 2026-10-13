import { Card, cn } from '@exponetdb/ui'
import { type ReactNode, useId } from 'react'

import { type HeadingLevel, StateHeading } from '../states/heading.tsx'

export interface InfraCardProps {
  /** The title, usually an `UntrustedName`. */
  title: ReactNode
  headingLevel?: HeadingLevel
  /** At the end of the header: usually a `StateBadge`. */
  status?: ReactNode
  className?: string
  children: ReactNode
}

/** The frame of the node and cluster cards: an article with a heading, a status and facts. */
export function InfraCard({
  title,
  headingLevel = 3,
  status,
  className,
  children,
}: InfraCardProps): ReactNode {
  const titleId = useId()
  return (
    <article aria-labelledby={titleId}>
      <Card className={cn('p-4', className)}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <StateHeading
            id={titleId}
            level={headingLevel}
            className="min-w-0 text-sm font-medium text-foreground"
          >
            {title}
          </StateHeading>
          {status}
        </div>
        {children}
      </Card>
    </article>
  )
}

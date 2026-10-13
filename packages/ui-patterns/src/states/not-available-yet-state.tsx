import { Clock } from '@exponetdb/icons'
import type { ReactNode } from 'react'

import { isAppPath } from '../records/app-path.ts'
import { useLinkComponent } from '../seams/index.ts'
import type { HeadingLevel } from './heading.tsx'
import { StateMessage } from './state-message.tsx'

export interface NotAvailableYetStateProps {
  /** What is not available, as a noun phrase: "Backups", "Break-glass activation". */
  what: string
  /** Why, in a sentence: "Backups arrive with Wave 9." */
  reason: string
  /** An app path to the document that explains it. Anything that is not an app path is not linked. */
  docHref?: string
  /** The text of the link. Default "Read more". */
  docLabel?: string
  headingLevel?: HeadingLevel
  className?: string
}

/**
 * A page whose server side belongs to a later wave or waits for a decision. A
 * deliberate, named state: a heading and the reason. It shows no data, no
 * empty list and no control that looks usable, and it is not an error.
 */
export function NotAvailableYetState({
  what,
  reason,
  docHref,
  docLabel = 'Read more',
  headingLevel,
  className,
}: NotAvailableYetStateProps): ReactNode {
  const Link = useLinkComponent()
  return (
    <StateMessage
      data-state="not-available-yet"
      icon={<Clock aria-hidden className="size-5 text-foreground-light" />}
      title={`${what} is not available yet`}
      headingLevel={headingLevel}
      className={className}
    >
      <p>{reason}</p>
      {docHref !== undefined && isAppPath(docHref) && (
        <p>
          <Link href={docHref} className="text-foreground underline">
            {docLabel}
          </Link>
        </p>
      )}
    </StateMessage>
  )
}

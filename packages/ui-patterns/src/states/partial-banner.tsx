import { Alert, AlertDescription, AlertTitle } from '@exponetdb/ui'
import type { ReactNode } from 'react'

import { sourcePhrase } from '../badges/source-label.tsx'
import type { ReadSource } from '../readable.ts'
import type { NowInput } from './format.ts'
import { keyedStrings } from './keyed.ts'
import { ObservedTime } from './observed-time.tsx'

export interface PartialBannerProps {
  /** What is shown, without an article: "backup inventory". */
  what: string
  source: ReadSource
  /** ISO 8601 time of the read the value comes from. */
  observedAt: string
  /** What is missing and why, in words a person can act on. */
  missing: readonly string[]
  now?: NowInput
  className?: string
}

/**
 * The banner above a value that is only part of what was asked for (C-28): what
 * is missing and why, with the source and age of the part that is shown. A
 * partial read never claims to be complete, and never renders as empty.
 */
export function PartialBanner({
  what,
  source,
  observedAt,
  missing,
  now,
  className,
}: PartialBannerProps): ReactNode {
  const items = keyedStrings(missing)
  return (
    <Alert variant="warning" data-state="partial" className={className}>
      <AlertTitle>{`Showing part of ${what}`}</AlertTitle>
      <AlertDescription>
        <p>
          {`Source: ${sourcePhrase(source)}. Observed `}
          <ObservedTime observedAt={observedAt} withDate now={now} />.
        </p>
        {items.length === 0 ? (
          <p>What is missing was not reported.</p>
        ) : (
          <>
            <p>Missing:</p>
            <ul className="list-disc pl-5">
              {items.map((item) => (
                <li key={item.key}>{item.text}</li>
              ))}
            </ul>
          </>
        )}
      </AlertDescription>
    </Alert>
  )
}

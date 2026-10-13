import { Alert, AlertDescription, AlertTitle, Button } from '@exponetdb/ui'
import type { ReactNode } from 'react'

import { sourcePhrase } from '../badges/source-label.tsx'
import type { ReadFailure, ReadSource } from '../readable.ts'
import type { NowInput } from './format.ts'
import { ObservedTime } from './observed-time.tsx'

export interface StaleBannerProps {
  /** What is shown, without an article: "backup inventory". */
  what: string
  source: ReadSource
  /** ISO 8601 time of the read the value comes from. */
  observedAt: string
  /** Why the value could not be refreshed, if a refresh failed. */
  error?: ReadFailure
  /** Reads again. Without it no button is shown. */
  onRefresh?: () => void
  /** A read is running: the button shows it is busy and ignores presses. */
  refreshing?: boolean
  now?: NowInput
  className?: string
}

/**
 * The banner above a value that is older than it should be (C-28): its source
 * and age, the reason a refresh failed if there is one, and a refresh action.
 * The value stays visible below it; the banner is the reason not to trust it
 * as current.
 */
export function StaleBanner({
  what,
  source,
  observedAt,
  error,
  onRefresh,
  refreshing = false,
  now,
  className,
}: StaleBannerProps): ReactNode {
  return (
    <Alert
      variant={error === undefined ? 'info' : 'warning'}
      data-state="stale"
      className={className}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <AlertTitle>{`Showing an earlier read of ${what}`}</AlertTitle>
          <AlertDescription>
            <p>
              {`Source: ${sourcePhrase(source)}. Observed `}
              <ObservedTime observedAt={observedAt} withDate now={now} />.
            </p>
            {error !== undefined && (
              <p>
                {`Could not refresh: ${error.message} `}
                <code className="font-mono">{error.code}</code>
              </p>
            )}
          </AlertDescription>
        </div>
        {onRefresh !== undefined && (
          <Button
            type="button"
            size="tiny"
            variant="outline"
            loading={refreshing}
            onClick={onRefresh}
          >
            Refresh
          </Button>
        )}
      </div>
    </Alert>
  )
}

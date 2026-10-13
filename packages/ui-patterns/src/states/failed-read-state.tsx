import { Button } from '@exponetdb/ui'
import type { ReactNode } from 'react'
import { ErrorDisplay } from '../error-display/error-display.tsx'
import type { ReadFailure } from '../readable.ts'
import type { HeadingLevel } from './heading.tsx'

export interface FailedReadStateProps {
  /**
   * What could not be read, as a noun phrase that works after "no": "backup
   * inventory", "schema", "target list". It names the thing in the title and in
   * the sentence that says a failed read is not an empty one.
   */
  what: string
  error: ReadFailure
  /** Reads again. Without it no button is shown. */
  onRetry?: () => void
  /** A read is running: the button shows it is busy and ignores presses. */
  busy?: boolean
  headingLevel?: HeadingLevel
  className?: string
  /** Troubleshooting notes shown under the reason. */
  children?: ReactNode
}

/**
 * A read that failed (C-28): "Could not read X: reason. This does not mean
 * there is no X." with the stable error code and a retry. This is the only
 * thing a failed read renders; there is no way to turn it into an empty list.
 */
export function FailedReadState({
  what,
  error,
  onRetry,
  busy = false,
  headingLevel,
  className,
  children,
}: FailedReadStateProps): ReactNode {
  const reason = error.message.trim() === '' ? 'No reason was reported.' : error.message
  return (
    <ErrorDisplay
      data-state="failed"
      title={`Could not read ${what}`}
      message={reason}
      code={error.code}
      headingLevel={headingLevel}
      className={className}
      actions={
        onRetry === undefined ? undefined : (
          <Button type="button" size="tiny" variant="outline" loading={busy} onClick={onRetry}>
            Try again
          </Button>
        )
      }
    >
      <p className="px-4 py-3 text-sm text-foreground-light">{`This does not mean there is no ${what}.`}</p>
      {children}
    </ErrorDisplay>
  )
}

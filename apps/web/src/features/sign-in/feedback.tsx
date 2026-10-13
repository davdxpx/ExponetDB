import { cn } from '@exponetdb/ui'
import { type ReactNode, useCallback, useMemo, useState } from 'react'
import { describeError } from '../../lib/i18n/i18n.ts'

/**
 * The two message lines of the pages around a person's own sign-in (sign-in,
 * the one-time link pages, the account page), as the Wave 3A pages had them:
 * a polite status line (`.status`) for what just happened and an alert line
 * (`.alert`) for what failed. An error is shown with `describeError` only:
 * the catalog message and its stable code, a fixed text for network and
 * unknown failures, the retry time of a rate limit, never exception text.
 * Both lines are always in the page (empty when there is nothing to say), so
 * screen readers announce a change.
 */
export interface Feedback {
  readonly status: string
  readonly error: string
  /** Shows what just happened and clears an earlier error. */
  readonly say: (text: string) => void
  /** Shows a failure (an `ApiError` or anything thrown) and clears the status. */
  readonly fail: (error: unknown) => void
  /** Shows a fixed problem the page found itself (two passwords differ). */
  readonly warn: (text: string) => void
  readonly clear: () => void
}

export function useFeedback(): Feedback {
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const say = useCallback((text: string) => {
    setError('')
    setStatus(text)
  }, [])
  const warn = useCallback((text: string) => {
    setStatus('')
    setError(text)
  }, [])
  const fail = useCallback((thrown: unknown) => warn(describeError(thrown)), [warn])
  const clear = useCallback(() => {
    setStatus('')
    setError('')
  }, [])
  return useMemo(
    () => ({ status, error, say, fail, warn, clear }),
    [status, error, say, fail, warn, clear],
  )
}

export function FeedbackLines({
  feedback,
  className,
}: {
  readonly feedback: Feedback
  readonly className?: string
}): ReactNode {
  return (
    <div className={cn('flex flex-col gap-1 text-sm', className)}>
      <p role="status" className="status text-foreground-light">
        {feedback.status}
      </p>
      <p role="alert" className="alert font-medium text-destructive">
        {feedback.error}
      </p>
    </div>
  )
}

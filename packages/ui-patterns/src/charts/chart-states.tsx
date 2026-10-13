import { Alert, AlertDescription, AlertTitle, Button, cn, Skeleton } from '@exponetdb/ui'
import type { ReactNode } from 'react'

import type { Readable, ReadFailure } from '../readable.ts'
import { ClippedText, visibleText } from './clipped-text.tsx'
import { formatAge, formatDateTime, sourceLabel, withoutClosingPeriod } from './format.ts'
import { useChartNow } from './use-chart-now.ts'

/**
 * The truthful states of a chart (C-28, information-architecture.md section 6).
 * Every chart takes a `Readable<T>`; `ReadableChart` picks the state: a skeleton
 * of the chart's size while loading, a failed-read message that never reads as
 * "no data", the chart with its age when stale, the chart with what is missing
 * when partial, and the empty state only after a read that succeeded.
 */

/** "Could not read <what>: <reason>. This does not mean there is no data." with the code. */
export function ChartFailureText({ name, error }: { name: string; error: ReadFailure }): ReactNode {
  return (
    <>
      <p>
        Could not read {visibleText(name)}: {withoutClosingPeriod(error.message)}. This does not
        mean there is no data.
      </p>
      <p className="mt-1 font-mono text-xs text-foreground-lighter">
        Error code: <span>{error.code}</span>
      </p>
    </>
  )
}

/** A skeleton of the chart's size, announced to assistive technology as one status. */
export function ChartLoadingState({
  name,
  height = 160,
  className,
}: {
  name: string
  height?: number
  className?: string
}): ReactNode {
  return (
    <div role="status" data-state="loading" className={cn('w-full', className)}>
      <span className="sr-only">Loading {visibleText(name)}</span>
      <Skeleton className="w-full" style={{ height }} />
    </div>
  )
}

/** A read that failed: the reason, the code and an optional retry. Never an empty chart. */
export function ChartFailedState({
  name,
  error,
  onRetry,
  className,
}: {
  name: string
  error: ReadFailure
  onRetry?: () => void
  className?: string
}): ReactNode {
  return (
    <Alert variant="destructive" data-state="failed" className={className}>
      <AlertTitle>{visibleText(name)} could not be read</AlertTitle>
      <AlertDescription>
        <ChartFailureText name={name} error={error} />
        {onRetry ? (
          <Button type="button" size="tiny" variant="default" className="mt-2" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}

/** The empty state: shown only after a read that succeeded and found nothing. */
export function ChartEmptyState({
  title = 'No data in this period',
  description,
  height = 160,
  className,
}: {
  title?: string
  description?: string
  height?: number
  className?: string
}): ReactNode {
  return (
    <div
      data-state="empty"
      className={cn(
        'flex flex-col items-center justify-center rounded-md border border-dashed border-control px-4 text-center',
        className,
      )}
      style={{ minHeight: height }}
    >
      <p className="text-sm font-medium text-foreground-light">{title}</p>
      {description ? <p className="text-sm text-foreground-lighter">{description}</p> : null}
    </div>
  )
}

/**
 * A chart that cannot be shown here: the PostgreSQL version or a capability is
 * missing (`not_supported`), or the person lacks a permission (`not_permitted`).
 * It draws no placeholder data.
 */
export function ChartUnavailableState({
  kind,
  title,
  description,
  children,
  className,
}: {
  kind: 'not_supported' | 'not_permitted'
  title: string
  description: string
  /** Actions, such as a link to the documentation or to the access request. */
  children?: ReactNode
  className?: string
}): ReactNode {
  return (
    <Alert variant="info" data-state={kind} className={className}>
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{description}</p>
        {children ? <div className="mt-2 flex items-center gap-2">{children}</div> : null}
      </AlertDescription>
    </Alert>
  )
}

/** The age and source of a read, as a line of text with the absolute time in a `<time>`. */
export function ChartSourceNote({
  readable,
  now,
  timeZone = 'UTC',
  className,
}: {
  readable: Extract<Readable<unknown>, { state: 'stale' | 'partial' | 'ready' }>
  now: number
  timeZone?: string
  className?: string
}): ReactNode {
  const observed = Date.parse(readable.observedAt)
  const known = Number.isFinite(observed)
  return (
    <p className={cn('text-xs text-foreground-lighter', className)} data-slot="source-note">
      {sourceLabel(readable.source)}
      {known ? (
        <>
          , observed {formatAge(observed, now)} (
          <time dateTime={readable.observedAt}>{formatDateTime(observed, timeZone)}</time>)
        </>
      ) : (
        <>, observation time not known</>
      )}
    </p>
  )
}

/** Props every chart shares for the truthful states. */
export interface ReadableChartProps<T> {
  /** What the chart shows, as a noun phrase usable in a sentence: "query latency". */
  name: string
  readable: Readable<T>
  /** Whether a successful read found nothing to draw. Empty is never shown for a failed read. */
  isEmpty: (value: T) => boolean
  /** Height of the loading skeleton and the empty state, in pixels. */
  height?: number
  /** Current time in ms since the epoch; fixes the ages shown (tests). */
  now?: number
  /** IANA zone for the times shown; UTC by default. */
  timeZone?: string
  /** Offers "Refresh" on stale data. */
  onRefresh?: () => void
  /** Offers "Try again" on a failed read. */
  onRetry?: () => void
  /** Title and description of the empty state. */
  emptyTitle?: string
  emptyDescription?: string
  children: (value: T) => ReactNode
}

/**
 * Renders a `Readable<T>` as a chart state. The value is read from the union
 * only in the states that carry one, so a failed read has no way to reach
 * `children` or the empty state.
 */
export function ReadableChart<T>({
  name,
  readable,
  isEmpty,
  height = 160,
  now,
  timeZone,
  onRefresh,
  onRetry,
  emptyTitle,
  emptyDescription,
  children,
}: ReadableChartProps<T>): ReactNode {
  const current = useChartNow(now)

  if (readable.state === 'loading') {
    return <ChartLoadingState name={name} height={height} />
  }
  if (readable.state === 'failed') {
    return <ChartFailedState name={name} error={readable.error} {...(onRetry ? { onRetry } : {})} />
  }

  const empty = isEmpty(readable.value)
  const emptyProps = {
    height,
    ...(emptyTitle === undefined ? {} : { title: emptyTitle }),
    ...(emptyDescription === undefined ? {} : { description: emptyDescription }),
  }
  const timeProps = timeZone === undefined ? {} : { timeZone }

  return (
    <div data-state={readable.state} className="flex flex-col gap-2">
      {readable.state === 'stale' ? (
        <Alert variant="warning" data-slot="stale-note">
          <AlertTitle>Stale data</AlertTitle>
          <AlertDescription>
            <ChartSourceNote readable={readable} now={current} {...timeProps} />
            {readable.error ? (
              <p className="mt-1">
                Refreshing failed: {withoutClosingPeriod(readable.error.message)}.{' '}
                <span className="font-mono text-xs">Error code: {readable.error.code}</span>
              </p>
            ) : null}
            {onRefresh ? (
              <Button
                type="button"
                size="tiny"
                variant="default"
                className="mt-2"
                onClick={onRefresh}
              >
                Refresh
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {readable.state === 'partial' ? (
        <Alert variant="warning" data-slot="partial-note">
          <AlertTitle>Partial data</AlertTitle>
          <AlertDescription>
            <p>This chart does not show everything. Missing:</p>
            <ul className="mt-1 list-disc pl-5">
              {readable.missing.map((item, index) => (
                // The list is fixed by the read; an entry is text from the caller (UntrustedText).
                // biome-ignore lint/suspicious/noArrayIndexKey: entries may repeat and never reorder
                <li key={`${index}-${item}`}>
                  <ClippedText text={item} limit={160} />
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      {empty ? <ChartEmptyState {...emptyProps} /> : children(readable.value)}
      {readable.state === 'stale' ? null : (
        <ChartSourceNote readable={readable} now={current} {...timeProps} />
      )}
    </div>
  )
}

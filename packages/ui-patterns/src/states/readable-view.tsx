import { cn } from '@exponetdb/ui'
import type { ReactNode } from 'react'

import { EmptyState } from '../empty-state/index.tsx'
import type { Readable, ReadSource } from '../readable.ts'
import { FailedReadState } from './failed-read-state.tsx'
import type { NowInput } from './format.ts'
import type { HeadingLevel } from './heading.tsx'
import { LoadingState } from './loading-state.tsx'
import { PartialBanner } from './partial-banner.tsx'
import { StaleBanner } from './stale-banner.tsx'

/** Where a value shown by `ReadableView` comes from; passed to the `ready` render prop. */
export interface ReadMeta {
  readonly state: 'ready' | 'stale' | 'partial'
  readonly source: ReadSource
  /** ISO 8601 time of the read. */
  readonly observedAt: string
}

export interface ReadableViewProps<T> {
  readable: Readable<T>
  /**
   * What is read, as a noun phrase that works after "no": "backup inventory",
   * "schema", "target list". It is used in "Could not read X" and "This does
   * not mean there is no X".
   */
  what: string
  /** Renders the value of a read that produced one (ready, stale or partial). */
  ready: (value: T, meta: ReadMeta) => ReactNode
  /**
   * Decides when a successfully read value counts as empty and what to show
   * then. It is consulted only for `ready` and `stale` reads, and only with the
   * value: a loading, failed or partial read never reaches it, so none of them
   * can render as empty.
   */
  empty?: {
    readonly isEmpty: (value: T) => boolean
    /** Default: an `EmptyState` saying the read found nothing. */
    readonly content?: ReactNode
  }
  /** The skeleton, shaped like the final layout. Default: a few text lines. */
  loading?: ReactNode
  /** Reads again (failed state). Without it no button is shown. */
  onRetry?: () => void
  /** Reads again (stale state). Without it no button is shown. */
  onRefresh?: () => void
  /** A read is running: retry and refresh show it is busy. */
  busy?: boolean
  now?: NowInput
  headingLevel?: HeadingLevel
  className?: string
}

/**
 * Renders a `Readable<T>` truthfully (C-28, information-architecture.md §6):
 *
 * - loading: a skeleton;
 * - failed: "Could not read X: reason. This does not mean there is no X.", the
 *   stable code and a retry; never anything else;
 * - stale: the value under a banner with its source, age and a refresh;
 * - partial: the value under a banner saying what is missing and why; never the
 *   empty content, because what is missing may be what was asked for;
 * - ready: the value, or the empty content when the value is empty.
 *
 * The state is matched exhaustively, and a state that is not one of the five
 * (a malformed value) is rendered as a failed read, never as empty.
 */
export function ReadableView<T>({
  readable,
  what,
  ready,
  empty,
  loading,
  onRetry,
  onRefresh,
  busy = false,
  now,
  headingLevel,
  className,
}: ReadableViewProps<T>): ReactNode {
  const body = (value: T, meta: ReadMeta, mayBeEmpty: boolean): ReactNode => {
    if (mayBeEmpty && empty?.isEmpty(value) === true) {
      return (
        empty.content ?? (
          <EmptyState
            title="Nothing to show"
            description={
              meta.state === 'stale'
                ? `The last successful read found no ${what}.`
                : `The read succeeded and found no ${what}.`
            }
            headingLevel={headingLevel}
          />
        )
      )
    }
    return ready(value, meta)
  }

  switch (readable.state) {
    case 'loading':
      return (
        <LoadingState what={what} className={className}>
          {loading}
        </LoadingState>
      )
    case 'failed':
      return (
        <FailedReadState
          what={what}
          error={readable.error}
          onRetry={onRetry}
          busy={busy}
          headingLevel={headingLevel}
          className={className}
        />
      )
    case 'stale':
      return (
        <div className={cn('flex flex-col gap-3', className)}>
          <StaleBanner
            what={what}
            source={readable.source}
            observedAt={readable.observedAt}
            error={readable.error}
            onRefresh={onRefresh}
            refreshing={busy}
            now={now}
          />
          {body(
            readable.value,
            { state: 'stale', source: readable.source, observedAt: readable.observedAt },
            true,
          )}
        </div>
      )
    case 'partial':
      return (
        <div className={cn('flex flex-col gap-3', className)}>
          <PartialBanner
            what={what}
            source={readable.source}
            observedAt={readable.observedAt}
            missing={readable.missing}
            now={now}
          />
          {body(
            readable.value,
            { state: 'partial', source: readable.source, observedAt: readable.observedAt },
            false,
          )}
        </div>
      )
    case 'ready':
      return body(
        readable.value,
        { state: 'ready', source: readable.source, observedAt: readable.observedAt },
        true,
      )
    default:
      return (
        <FailedReadState
          what={what}
          error={{ code: 'UNKNOWN', message: 'The state of this read was not recognized.' }}
          onRetry={onRetry}
          busy={busy}
          headingLevel={headingLevel}
          className={className}
        />
      )
  }
}

import {
  EmptyState,
  NotPermittedState,
  PartialBanner,
  type Readable,
  ReadableView,
  StaleBanner,
} from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { classifyFailure } from '../../lib/query/errors.ts'

/**
 * A list read of an administration page, rendered truthfully (C-28): the
 * loading and failed states through `ReadableView` (a failed read is never
 * an empty list; a refused read names the missing permission), and a value
 * under its stale or partial banner. The value keeps one place in the tree
 * whether or not a banner shows, so a refresh that turns the read stale or
 * ready again never remounts the cards below: what a person typed into a
 * card's form, and a secret the page shows once, survive it.
 */
export interface ListViewProps<T> {
  readonly readable: Readable<T>
  /** The failed read's error, for the "not permitted" state. */
  readonly error: unknown
  /** What is read, after "Could not read" and "there is no": "OAuth client list". */
  readonly what: string
  /** The permission that reading needs, named when the server refuses the read. */
  readonly permission: string
  readonly isEmpty: (value: T) => boolean
  readonly emptyTitle: string
  readonly emptyDescription: string
  readonly children: (value: T) => ReactNode
  readonly onRetry: () => void
  readonly busy: boolean
}

export function ListView<T>({
  readable,
  error,
  what,
  permission,
  isEmpty,
  emptyTitle,
  emptyDescription,
  children,
  onRetry,
  busy,
}: ListViewProps<T>): ReactNode {
  if (readable.state === 'loading' || readable.state === 'failed') {
    if (readable.state === 'failed' && classifyFailure(error).kind === 'not_permitted') {
      return <NotPermittedState what={what} permission={permission} headingLevel={2} />
    }
    return (
      <ReadableView
        readable={readable}
        what={what}
        ready={() => null}
        onRetry={onRetry}
        busy={busy}
        headingLevel={2}
      />
    )
  }
  const value = readable.value
  // A partial list is never shown as empty: what is missing may be what was asked for.
  const empty = readable.state !== 'partial' && isEmpty(value)
  return (
    <div className="flex flex-col gap-3">
      {readable.state === 'stale' ? (
        <StaleBanner
          what={what}
          source={readable.source}
          observedAt={readable.observedAt}
          error={readable.error}
          onRefresh={onRetry}
          refreshing={busy}
        />
      ) : null}
      {readable.state === 'partial' ? (
        <PartialBanner
          what={what}
          source={readable.source}
          observedAt={readable.observedAt}
          missing={readable.missing}
        />
      ) : null}
      {empty ? (
        <EmptyState title={emptyTitle} description={emptyDescription} headingLevel={2} />
      ) : null}
      {children(value)}
    </div>
  )
}

import { Badge, Button } from '@exponetdb/ui'
import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import type { SectionQuery } from './read-section.tsx'

/** A keyset page as the server sends it: items and an opaque cursor. */
export interface Page<I> {
  readonly items: readonly I[]
  readonly nextCursor: string | null
}

export interface PagedItems<I> {
  readonly items: readonly I[]
  /** The server has more pages: the list is not the whole list. */
  readonly more: boolean
}

/**
 * The pages read so far as one list for `ReadSection`, with whether the
 * server has more. A page that failed after others succeeded keeps the
 * earlier items and makes the read stale (the section shows the failure),
 * never an empty list.
 */
export function pagedQuery<I>(
  query: UseInfiniteQueryResult<InfiniteData<Page<I>, unknown>>,
): SectionQuery<PagedItems<I>> {
  const pages = query.data?.pages
  return {
    data:
      pages === undefined
        ? undefined
        : { items: pages.flatMap((page) => page.items), more: query.hasNextPage },
    error: query.error,
    isError: query.isError,
    dataUpdatedAt: query.dataUpdatedAt,
    isFetching: query.isFetching,
    refetch: () => query.refetch(),
  }
}

/** "Load more": asks for the next keyset page; hidden when there is none. */
export function LoadMore({
  more,
  loading,
  onLoad,
  label,
}: {
  readonly more: boolean
  readonly loading: boolean
  readonly onLoad: () => void
  readonly label: string
}): ReactNode {
  if (!more) return null
  return (
    <div>
      <Button variant="default" size="small" loading={loading} onClick={onLoad}>
        {label}
      </Button>
    </div>
  )
}

/** The severity of a finding as a word in a badge (the word is the signal, the color only helps). */
export function SeverityBadge({ severity }: { readonly severity: string }): ReactNode {
  const [variant, label] =
    severity === 'critical'
      ? (['destructive', t('findings.severity.critical')] as const)
      : severity === 'warning'
        ? (['warning', t('findings.severity.warning')] as const)
        : severity === 'info'
          ? (['default', t('findings.severity.info')] as const)
          : (['default', t('findings.severity.unknown')] as const)
  return (
    <Badge variant={variant} data-severity={severity}>
      {label}
    </Badge>
  )
}

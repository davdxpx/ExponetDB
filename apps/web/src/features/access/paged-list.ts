import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query'

/** A keyset page as the server sends it. */
export interface CursorPage<I> {
  readonly items: readonly I[]
  readonly nextCursor: string | null
}

/**
 * The pages of an infinite list read as one page for `toReadable`: every item loaded so far
 * and the cursor of the last page, so the page says "more exist" until it is null. A failed
 * page after others keeps the earlier items (the read turns stale), never an empty list.
 */
export function loadedPages<I>(
  query: UseInfiniteQueryResult<InfiniteData<CursorPage<I>, unknown>>,
): {
  readonly data: CursorPage<I> | undefined
  readonly error: unknown
  readonly isError: boolean
  readonly dataUpdatedAt: number
} {
  const pages = query.data?.pages
  return {
    data:
      pages === undefined
        ? undefined
        : {
            items: pages.flatMap((page) => page.items),
            nextCursor: pages.at(-1)?.nextCursor ?? null,
          },
    error: query.error,
    isError: query.isError,
    dataUpdatedAt: query.dataUpdatedAt,
  }
}

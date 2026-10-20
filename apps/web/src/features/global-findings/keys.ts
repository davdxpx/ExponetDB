import { infiniteQueryOptions } from '@tanstack/react-query'
import type { ApiClient } from '../../lib/api/client.ts'
import type { GlobalFindingFilters } from './search.ts'

/**
 * Query keys and options of the findings across every target
 * (`GET /findings`, keyset pages by the server's opaque cursor). The key holds
 * the filters, so a filter change is another read, and the cache keeps the
 * server's answers as they came.
 */
export const globalFindingsKeys = {
  all: ['global-findings'] as const,
  list: (filters: GlobalFindingFilters) => ['global-findings', 'list', filters] as const,
}

/** How often an open page asks again. */
export const GLOBAL_FINDINGS_POLL_MS = 30_000
/** The most findings one page of the list reads (the contract's default). */
export const GLOBAL_FINDINGS_PAGE_LIMIT = 50

export function globalFindingsQuery(client: ApiClient, filters: GlobalFindingFilters) {
  return infiniteQueryOptions({
    queryKey: globalFindingsKeys.list(filters),
    queryFn: ({ signal, pageParam }) =>
      client.operation('listFindings', {
        query: {
          state: filters.state,
          limit: GLOBAL_FINDINGS_PAGE_LIMIT,
          ...(filters.severity === undefined ? {} : { severity: filters.severity }),
          ...(filters.kind === undefined ? {} : { kind: filters.kind }),
          ...(filters.target === undefined ? {} : { target: filters.target }),
          ...(pageParam === null ? {} : { cursor: pageParam }),
        },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: GLOBAL_FINDINGS_POLL_MS,
  })
}

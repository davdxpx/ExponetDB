import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import type { ApiClient, ResponseOf } from '../../lib/api/client.ts'
import { type AuditSearch, auditQuery } from './search.ts'

/**
 * Query keys and options of the audit page: the search (one page of 50 per
 * read, older pages on request through the server's cursor) and the chain
 * read. The chain verification is computed by the server on each read (a
 * repeat within 15 seconds gets the same result); it is read when the page
 * opens and when the person asks again, never polled in a loop.
 */
export const AUDIT_PAGE_SIZE = 50

export type AuditPage = ResponseOf<'searchAuditEvents'>
export type AuditEvent = AuditPage['items'][number]
export type AuditChain = ResponseOf<'getAuditChain'>

export const auditKeys = {
  events: (search: AuditSearch) => ['audit', 'events', search] as const,
  chain: ['audit', 'chain'] as const,
}

export function auditEventsQuery(client: ApiClient, search: AuditSearch) {
  return infiniteQueryOptions({
    queryKey: auditKeys.events(search),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      client.operation('searchAuditEvents', {
        query: auditQuery(search, pageParam, AUDIT_PAGE_SIZE),
        signal,
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  })
}

export function auditChainQuery(client: ApiClient) {
  return queryOptions({
    queryKey: auditKeys.chain,
    queryFn: ({ signal }) => client.operation('getAuditChain', { signal }),
  })
}

import type { OperationRead } from '@exponetdb/sdk/operations'
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import type { ApiClient } from '../../lib/api/client.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import { operationKeys } from '../plans/keys.ts'
import { isOperationId } from '../plans/plan-model.ts'
import {
  isProjectId,
  type OperationsSearch,
  operationPollInterval,
  operationsQueryOf,
} from './model.ts'

/**
 * Query keys and options of the Changes screens. The operation detail shares
 * its key with the plan review page (`operationKeys.detail`), so an action on
 * one page shows on the other. Keys are built from validated values only and
 * every query is disabled for anything else.
 */
export const changesKeys = {
  operations: (search: OperationsSearch) =>
    [
      ...operationKeys.all,
      'list',
      search.state ?? '',
      search.kind ?? '',
      search.actor ?? 'any',
    ] as const,
  stream: (projectId: string) => ['projects', 'stream', projectId] as const,
}

/** Operations per read of the list; "Show more" follows the cursor. */
export const OPERATION_PAGE_LIMIT = 50
/** How often the list asks again (every page read so far). */
export const OPERATION_LIST_POLL_MS = 30_000
/** How often the promotion view asks again: the mirrors change after operations only. */
export const STREAM_POLL_MS = 60_000

export function operationListQuery(client: ApiClient, search: OperationsSearch) {
  return infiniteQueryOptions({
    queryKey: changesKeys.operations(search),
    queryFn: ({ signal, pageParam }) =>
      client.operation('listOperations', {
        query: {
          ...operationsQueryOf(search),
          limit: OPERATION_PAGE_LIMIT,
          ...(pageParam === null ? {} : { cursor: pageParam }),
        },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: OPERATION_LIST_POLL_MS,
  })
}

/**
 * One operation, polled with backoff while it is at work and not at all once
 * it is terminal or not shown (`operationPollInterval`); paused while the tab
 * is hidden by the query cache.
 */
export function operationDetailQuery(client: ApiClient, operationId: string) {
  return queryOptions({
    queryKey: operationKeys.detail(operationId),
    queryFn: ({ signal }): Promise<OperationRead> =>
      client.operation('getOperation', { params: { operationId }, signal }),
    enabled: isOperationId(operationId),
    refetchInterval: (query) =>
      query.state.error !== null && classifyFailure(query.state.error).kind === 'not_found'
        ? false
        : operationPollInterval(query.state.data, query.state.fetchFailureCount, Date.now()),
  })
}

export function migrationStreamQuery(client: ApiClient, projectId: string) {
  return queryOptions({
    queryKey: changesKeys.stream(projectId),
    queryFn: ({ signal }) =>
      client.operation('getMigrationStream', { params: { projectId }, signal }),
    enabled: isProjectId(projectId),
    refetchInterval: STREAM_POLL_MS,
  })
}

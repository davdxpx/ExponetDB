import { queryOptions } from '@tanstack/react-query'
import type { ApiClient } from '../../lib/api/client.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import { isSlug, isTargetPath } from './params.ts'

/**
 * Query keys and query options of the target domain. The key of a target is
 * its path; the cache holds the server's answers as they came (the page turns
 * them into `Readable`s, never the cache). A key is only ever built from
 * validated slugs, and every query is disabled for anything else, so a path
 * that failed the grammar never reaches the server.
 */
export const targetKeys = {
  all: ['targets'] as const,
  detail: (path: string) => ['targets', 'detail', path] as const,
  health: (path: string) => ['targets', 'health', path] as const,
  environments: (product: string, project: string) =>
    ['targets', 'environments', product, project] as const,
}

/**
 * How often a target page asks again while it is open and visible. The
 * health sampler writes every 15 seconds and the page counts a read as
 * stale after 60 seconds (`toReadable`), so a page that stays open never
 * shows an earlier read as current.
 */
export const TARGET_POLL_MS = 30_000

/** The most environments one project's list read asks for (the API's page maximum). */
export const ENVIRONMENT_PAGE_LIMIT = 200

export function targetQuery(client: ApiClient, path: string) {
  return queryOptions({
    queryKey: targetKeys.detail(path),
    queryFn: ({ signal }) => client.operation('getTarget', { params: { target: path }, signal }),
    enabled: isTargetPath(path),
    // A target that is not there (or not visible) stays not there: no polling.
    refetchInterval: (query) =>
      classifyFailure(query.state.error).kind === 'not_found' ? false : TARGET_POLL_MS,
  })
}

export function targetHealthQuery(client: ApiClient, path: string, enabled: boolean) {
  return queryOptions({
    queryKey: targetKeys.health(path),
    queryFn: ({ signal }) =>
      client.operation('getTargetHealth', { params: { target: path }, signal }),
    enabled: enabled && isTargetPath(path),
    refetchInterval: TARGET_POLL_MS,
  })
}

export function environmentsQuery(client: ApiClient, product: string, project: string) {
  return queryOptions({
    queryKey: targetKeys.environments(product, project),
    queryFn: ({ signal }) =>
      client.operation('listTargets', {
        query: { product, project, limit: ENVIRONMENT_PAGE_LIMIT },
        signal,
      }),
    enabled: isSlug(product) && isSlug(project),
    refetchInterval: TARGET_POLL_MS,
  })
}

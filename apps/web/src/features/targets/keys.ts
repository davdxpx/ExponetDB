import type { TargetSummary } from '@exponetdb/sdk/operations'
import { queryOptions } from '@tanstack/react-query'
import type { ApiClient } from '../../lib/api/client.ts'

/**
 * Query keys and options of the targets list and the registration choices.
 * The list follows the cursor up to a bound and says when more exist; the
 * health of each row is the one the list carries (source and time), so the
 * number of requests does not grow with the number of targets.
 */
export const targetListKeys = {
  list: ['targets', 'list'] as const,
  products: ['registry', 'products'] as const,
  projects: ['registry', 'projects'] as const,
  environments: (productId: string) => ['registry', 'environments', productId] as const,
  clusters: ['registry', 'clusters'] as const,
  databases: (clusterId: string) => ['registry', 'databases', clusterId] as const,
}

/** Targets per request (the most the server allows) and pages followed: at most 1,000 targets. */
export const TARGET_PAGE_LIMIT = 200
export const TARGET_MAX_PAGES = 5
export const TARGET_LIST_POLL_MS = 30_000
const CHOICE_PAGE_LIMIT = 200
const CHOICE_MAX_PAGES = 5

export interface TargetList {
  readonly items: readonly TargetSummary[]
  /** The server has more targets than the pages followed. */
  readonly more: boolean
}

export function targetListQuery(client: ApiClient) {
  return queryOptions({
    queryKey: targetListKeys.list,
    queryFn: async ({ signal }): Promise<TargetList> => {
      const items: TargetSummary[] = []
      let cursor: string | undefined
      for (let page = 0; page < TARGET_MAX_PAGES; page++) {
        const answer = await client.operation('listTargets', {
          query: { limit: TARGET_PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) },
          signal,
        })
        items.push(...answer.items)
        if (answer.nextCursor === null) return { items, more: false }
        cursor = answer.nextCursor
      }
      return { items, more: true }
    },
    refetchInterval: TARGET_LIST_POLL_MS,
  })
}

/** Every page of a paged choice list (products, projects, clusters), bounded. */
async function allPages<T>(
  page: (cursor: string | undefined) => Promise<{ items: readonly T[]; nextCursor: string | null }>,
): Promise<{ items: readonly T[]; more: boolean }> {
  const items: T[] = []
  let cursor: string | undefined
  for (let i = 0; i < CHOICE_MAX_PAGES; i++) {
    const answer = await page(cursor)
    items.push(...answer.items)
    if (answer.nextCursor === null) return { items, more: false }
    cursor = answer.nextCursor
  }
  return { items, more: true }
}

const cursorOf = (cursor: string | undefined) => (cursor === undefined ? {} : { cursor })

export function productsQuery(client: ApiClient) {
  return queryOptions({
    queryKey: targetListKeys.products,
    queryFn: ({ signal }) =>
      allPages((cursor) =>
        client.operation('listProducts', {
          query: { limit: CHOICE_PAGE_LIMIT, ...cursorOf(cursor) },
          signal,
        }),
      ),
  })
}

export function projectsQuery(client: ApiClient) {
  return queryOptions({
    queryKey: targetListKeys.projects,
    queryFn: ({ signal }) =>
      allPages((cursor) =>
        client.operation('listProjects', {
          query: { limit: CHOICE_PAGE_LIMIT, ...cursorOf(cursor) },
          signal,
        }),
      ),
  })
}

export function environmentsQuery(client: ApiClient, productId: string) {
  return queryOptions({
    queryKey: targetListKeys.environments(productId),
    queryFn: ({ signal }) =>
      allPages((cursor) =>
        client.operation('listProductEnvironments', {
          params: { productId },
          query: { limit: CHOICE_PAGE_LIMIT, ...cursorOf(cursor) },
          signal,
        }),
      ),
    enabled: productId.length > 0,
  })
}

export function clustersQuery(client: ApiClient) {
  return queryOptions({
    queryKey: targetListKeys.clusters,
    queryFn: ({ signal }) =>
      allPages((cursor) =>
        client.operation('listClusters', {
          query: { limit: CHOICE_PAGE_LIMIT, ...cursorOf(cursor) },
          signal,
        }),
      ),
  })
}

export function clusterDatabasesQuery(client: ApiClient, clusterId: string) {
  return queryOptions({
    queryKey: targetListKeys.databases(clusterId),
    queryFn: ({ signal }) =>
      client.operation('listClusterDatabases', { params: { clusterId }, signal }),
    enabled: clusterId.length > 0,
  })
}

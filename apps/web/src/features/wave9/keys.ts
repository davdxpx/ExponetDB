import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import type { ApiClient } from '../../lib/api/client.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import { isTargetPath } from '../target/params.ts'
import { isClusterId } from '../target-ops/ids.ts'
import {
  type ProtectionState,
  type StatementLimit,
  type StatsOrder,
  type StatsWindow,
  windowRange,
} from './model.ts'

/**
 * Query keys and options of the Wave 9 pages. Every key is built from values
 * that passed their grammar (a target path, a cluster id, a value of a fixed
 * list), and every query is disabled for anything else, so such a value never
 * reaches the server. Backup reads are the Control Store's mirror of the
 * engine catalogs; statement and table statistics come from the target (the
 * statements through the sampler). The cache holds the server's answers as
 * they came; none carries a secret (a runbook is not cached: it is read when
 * the person downloads it).
 */
export const wave9Keys = {
  all: ['wave9'] as const,
  queryStats: (path: string, window: StatsWindow, order: StatsOrder, limit: StatementLimit) =>
    ['wave9', 'query-stats', path, window, order, limit] as const,
  tableStats: (path: string, schema: string | undefined) =>
    ['wave9', 'table-stats', path, schema ?? null] as const,
  advisorFindings: (path: string) => ['wave9', 'advisor-findings', path] as const,
  cluster: (clusterId: string) => ['wave9', 'cluster', clusterId] as const,
  catalog: (clusterId: string) => ['wave9', 'cluster', clusterId, 'catalog'] as const,
  protection: (clusterId: string) => ['wave9', 'cluster', clusterId, 'protection'] as const,
  repositories: (clusterId: string) => ['wave9', 'cluster', clusterId, 'repositories'] as const,
  policy: (clusterId: string) => ['wave9', 'cluster', clusterId, 'policy'] as const,
  runs: (clusterId: string) => ['wave9', 'cluster', clusterId, 'runs'] as const,
  drills: (clusterId: string) => ['wave9', 'cluster', clusterId, 'drills'] as const,
  restores: (clusterId: string) => ['wave9', 'cluster', clusterId, 'restores'] as const,
  clusterFindings: (clusterId: string) => ['wave9', 'cluster', clusterId, 'findings'] as const,
  overview: (state: ProtectionState | undefined) => ['wave9', 'overview', state ?? null] as const,
  overviewCounts: () => ['wave9', 'overview-counts'] as const,
}

/** How often an open page reads the Control Store's mirror again. */
export const BACKUP_POLL_MS = 30_000
/** How often the sampled statements and the live table statistics are read again. */
export const STATS_POLL_MS = 60_000
/** One page of a backup list. */
export const BACKUP_PAGE_LIMIT = 50
/** One page of the fleet's backup overview. */
export const OVERVIEW_PAGE_LIMIT = 50
/** One page of open advisor findings. */
export const FINDINGS_PAGE_LIMIT = 50
/** The rows one table statistics read asks for (the server's maximum is 1,000). */
export const TABLE_STATS_LIMIT = 500

function poll(interval: number) {
  return (query: { readonly state: { readonly error: unknown } }): number | false => {
    const kind = classifyFailure(query.state.error).kind
    return kind === 'not_permitted' || kind === 'not_found' || kind === 'session' ? false : interval
  }
}

export function queryStatsQuery(
  client: ApiClient,
  path: string,
  window: StatsWindow,
  order: StatsOrder,
  limit: StatementLimit,
) {
  return queryOptions({
    queryKey: wave9Keys.queryStats(path, window, order, limit),
    // The window ends when the read is made, so a refresh moves it.
    queryFn: ({ signal }) =>
      client.operation('getQueryStats', {
        params: { target: path },
        query: { ...windowRange(window, Date.now()), order, limit },
        signal,
      }),
    enabled: isTargetPath(path),
    refetchInterval: poll(STATS_POLL_MS),
  })
}

export function tableStatsQuery(client: ApiClient, path: string, schema: string | undefined) {
  return queryOptions({
    queryKey: wave9Keys.tableStats(path, schema),
    queryFn: ({ signal }) =>
      client.operation('getTableStats', {
        params: { target: path },
        query: { limit: TABLE_STATS_LIMIT, ...(schema === undefined ? {} : { schema }) },
        signal,
      }),
    enabled: isTargetPath(path),
    refetchInterval: poll(STATS_POLL_MS),
  })
}

/** The open advisor findings of one target, keyset pages by the server's cursor. */
export function advisorFindingsQuery(client: ApiClient, path: string) {
  return infiniteQueryOptions({
    queryKey: wave9Keys.advisorFindings(path),
    queryFn: ({ signal, pageParam }) =>
      client.operation('listFindings', {
        query: {
          target: path,
          kind: 'advisor',
          state: 'open',
          limit: FINDINGS_PAGE_LIMIT,
          ...(pageParam === null ? {} : { cursor: pageParam }),
        },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: isTargetPath(path),
    refetchInterval: poll(BACKUP_POLL_MS),
  })
}

/** The catalog mirror of a cluster: protection, repositories, WAL coverage and a page of backups. */
export function catalogQuery(client: ApiClient, clusterId: string) {
  return infiniteQueryOptions({
    queryKey: wave9Keys.catalog(clusterId),
    queryFn: ({ signal, pageParam }) =>
      client.operation('listClusterBackups', {
        params: { clusterId },
        query: {
          limit: BACKUP_PAGE_LIMIT,
          ...(pageParam === null ? {} : { cursor: pageParam }),
        },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: isClusterId(clusterId),
    refetchInterval: poll(BACKUP_POLL_MS),
  })
}

/** The protection of one cluster only (one backup asked for): the compact state of a target's overview. */
export function protectionQuery(client: ApiClient, clusterId: string) {
  return queryOptions({
    queryKey: wave9Keys.protection(clusterId),
    queryFn: ({ signal }) =>
      client.operation('listClusterBackups', {
        params: { clusterId },
        query: { limit: 1 },
        signal,
      }),
    enabled: isClusterId(clusterId),
    refetchInterval: poll(BACKUP_POLL_MS),
  })
}

export function repositoriesQuery(client: ApiClient, clusterId: string) {
  return queryOptions({
    queryKey: wave9Keys.repositories(clusterId),
    queryFn: ({ signal }) =>
      client.operation('listBackupRepositories', { params: { clusterId }, signal }),
    enabled: isClusterId(clusterId),
    refetchInterval: poll(BACKUP_POLL_MS),
  })
}

export function policyQuery(client: ApiClient, clusterId: string) {
  return queryOptions({
    queryKey: wave9Keys.policy(clusterId),
    queryFn: ({ signal }) => client.operation('getBackupPolicy', { params: { clusterId }, signal }),
    enabled: isClusterId(clusterId),
    refetchInterval: poll(BACKUP_POLL_MS),
  })
}

export function runsQuery(client: ApiClient, clusterId: string) {
  return infiniteQueryOptions({
    queryKey: wave9Keys.runs(clusterId),
    queryFn: ({ signal, pageParam }) =>
      client.operation('listBackupRuns', {
        params: { clusterId },
        query: { limit: BACKUP_PAGE_LIMIT, ...(pageParam === null ? {} : { cursor: pageParam }) },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: isClusterId(clusterId),
    refetchInterval: poll(BACKUP_POLL_MS),
  })
}

export function drillsQuery(client: ApiClient, clusterId: string) {
  return infiniteQueryOptions({
    queryKey: wave9Keys.drills(clusterId),
    queryFn: ({ signal, pageParam }) =>
      client.operation('listDrills', {
        params: { clusterId },
        query: { limit: BACKUP_PAGE_LIMIT, ...(pageParam === null ? {} : { cursor: pageParam }) },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: isClusterId(clusterId),
    refetchInterval: poll(BACKUP_POLL_MS),
  })
}

export function restoresQuery(client: ApiClient, clusterId: string) {
  return infiniteQueryOptions({
    queryKey: wave9Keys.restores(clusterId),
    queryFn: ({ signal, pageParam }) =>
      client.operation('listRestores', {
        params: { clusterId },
        query: { limit: BACKUP_PAGE_LIMIT, ...(pageParam === null ? {} : { cursor: pageParam }) },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: isClusterId(clusterId),
    refetchInterval: poll(BACKUP_POLL_MS),
  })
}

export function clusterFindingsQuery(client: ApiClient, clusterId: string) {
  return infiniteQueryOptions({
    queryKey: wave9Keys.clusterFindings(clusterId),
    queryFn: ({ signal, pageParam }) =>
      client.operation('listClusterFindings', {
        params: { clusterId },
        query: {
          state: 'open',
          limit: BACKUP_PAGE_LIMIT,
          ...(pageParam === null ? {} : { cursor: pageParam }),
        },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: isClusterId(clusterId),
    refetchInterval: poll(BACKUP_POLL_MS),
  })
}

/** The fleet's backup protection, a page of clusters (counts always cover every readable cluster). */
export function overviewQuery(client: ApiClient, state: ProtectionState | undefined) {
  return infiniteQueryOptions({
    queryKey: wave9Keys.overview(state),
    queryFn: ({ signal, pageParam }) =>
      client.operation('getBackupOverview', {
        query: {
          limit: OVERVIEW_PAGE_LIMIT,
          ...(state === undefined ? {} : { state }),
          ...(pageParam === null ? {} : { cursor: pageParam }),
        },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: poll(BACKUP_POLL_MS),
  })
}

/** The counts of the fleet's backup protection only (the overview slot asks for one cluster). */
export function overviewCountsQuery(client: ApiClient) {
  return queryOptions({
    queryKey: wave9Keys.overviewCounts(),
    queryFn: ({ signal }) => client.operation('getBackupOverview', { query: { limit: 1 }, signal }),
    refetchInterval: poll(BACKUP_POLL_MS),
  })
}

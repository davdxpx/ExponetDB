import { queryOptions } from '@tanstack/react-query'
import type { ApiClient } from '../../lib/api/client.ts'
import { isTargetPath } from '../target/params.ts'

/**
 * Query keys and options of the target overview blocks. Every block has its
 * own query, so one failing read never takes another block with it. Keys are
 * built from the validated target path (and a project id the server gave),
 * and every query is disabled for anything else.
 */
export const overviewKeys = {
  history: (path: string, range: HistoryRange) => ['overview', 'history', path, range] as const,
  findings: (path: string) => ['overview', 'findings', path] as const,
  migrations: (path: string) => ['overview', 'migrations', path] as const,
  stream: (projectId: string) => ['overview', 'stream', projectId] as const,
  operations: (path: string) => ['overview', 'operations', path] as const,
}

/** The ranges the history offers; the server keeps 3 to 60 days and answers 24 hours without a range. */
export const HISTORY_RANGES = ['24h', '7d', '14d'] as const
export type HistoryRange = (typeof HISTORY_RANGES)[number]

const RANGE_MS: Readonly<Record<HistoryRange, number>> = {
  '24h': 24 * 3_600_000,
  '7d': 7 * 24 * 3_600_000,
  '14d': 14 * 24 * 3_600_000,
}

export const OVERVIEW_POLL_MS = 30_000
/** The history is sampled every 15 seconds and bucketed; a minute is often enough. */
export const HISTORY_POLL_MS = 60_000
/** The most rows the findings and operations blocks ask for. */
export const OVERVIEW_LIST_LIMIT = 20

/** A project id of the registry: `prj_` and a ULID. */
const PROJECT_ID = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/

export function isProjectId(value: unknown): value is string {
  return typeof value === 'string' && PROJECT_ID.test(value)
}

export function historyQuery(client: ApiClient, path: string, range: HistoryRange) {
  return queryOptions({
    queryKey: overviewKeys.history(path, range),
    queryFn: ({ signal }) => {
      // The server refuses a time in the future: `to` is the request moment in whole seconds.
      const to = new Date()
      to.setMilliseconds(0)
      const from = new Date(to.getTime() - RANGE_MS[range])
      return client.operation('getTargetHealthHistory', {
        params: { target: path },
        query: { from: from.toISOString(), to: to.toISOString() },
        signal,
      })
    },
    enabled: isTargetPath(path),
    refetchInterval: HISTORY_POLL_MS,
  })
}

export function findingsQuery(client: ApiClient, path: string) {
  return queryOptions({
    queryKey: overviewKeys.findings(path),
    queryFn: ({ signal }) =>
      client.operation('listTargetFindings', {
        params: { target: path },
        query: { limit: OVERVIEW_LIST_LIMIT },
        signal,
      }),
    enabled: isTargetPath(path),
    refetchInterval: OVERVIEW_POLL_MS,
  })
}

export function targetMigrationsQuery(client: ApiClient, path: string) {
  return queryOptions({
    queryKey: overviewKeys.migrations(path),
    queryFn: ({ signal }) =>
      client.operation('getTargetMigrations', { params: { target: path }, signal }),
    enabled: isTargetPath(path),
    refetchInterval: OVERVIEW_POLL_MS,
  })
}

export function migrationStreamQuery(client: ApiClient, projectId: string) {
  return queryOptions({
    queryKey: overviewKeys.stream(projectId),
    queryFn: ({ signal }) =>
      client.operation('getMigrationStream', { params: { projectId }, signal }),
    enabled: isProjectId(projectId),
    refetchInterval: OVERVIEW_POLL_MS,
  })
}

export function operationsQuery(client: ApiClient, path: string) {
  return queryOptions({
    queryKey: overviewKeys.operations(path),
    queryFn: ({ signal }) =>
      client.operation('listOperations', {
        query: { target: path, limit: OVERVIEW_LIST_LIMIT },
        signal,
      }),
    enabled: isTargetPath(path),
    refetchInterval: OVERVIEW_POLL_MS,
  })
}

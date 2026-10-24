import { type Readable, useResolvedNow } from '@exponetdb/ui-patterns'
import { queryOptions, useQuery } from '@tanstack/react-query'
import type { ApiClient, ResponseOf } from '../../lib/api/client.ts'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { isTargetPath } from '../target/params.ts'
import { hasServerFilter, type ServerFilter } from './model.ts'

/**
 * Reads of the Connections and Locks pages. Sessions and the lock graph are
 * live reads of the target (`diagnostics.read`); while the page is open,
 * visible and not paused it asks again every 15 seconds, and it shows an
 * answer older than a minute as stale. Statement text in the sessions is
 * already redacted by the server. Keys are built from the validated target
 * path only. The raw statement is deliberately **not** a query: its text is
 * never put in the cache (see `raw-statement.tsx`).
 */
export const connectionKeys = {
  sessions: (path: string) => ['diagnostics', 'sessions', path] as const,
  /** A read the target filtered (the unfiltered list was cut): its own entry, under the same prefix. */
  filteredSessions: (path: string, filter: ServerFilter) =>
    [
      'diagnostics',
      'sessions',
      path,
      'filtered',
      filter.state ?? null,
      filter.application ?? null,
      filter.minAgeSeconds ?? null,
    ] as const,
  locks: (path: string) => ['diagnostics', 'locks', path] as const,
  endpoints: (clusterId: string) => ['diagnostics', 'endpoints', clusterId] as const,
}

export const DIAGNOSTICS_POLL_MS = 15_000
/** The sessions one read asks for (the server's cap is in the answer). */
export const SESSION_LIMIT = 500

const poll = (error: unknown): number | false =>
  classifyFailure(error).kind === 'not_found' ? false : DIAGNOSTICS_POLL_MS

/** The polling of a live read: the interval while live, nothing while paused or when the target is not found. */
const pollWhen =
  (live: boolean) =>
  (query: { readonly state: { readonly error: unknown } }): number | false =>
    live ? poll(query.state.error) : false

/**
 * A paused page reads nothing by itself: not on an interval, and not when the
 * tab is focused or the connection returns either. A refresh still reads.
 */
const pausable = (live: boolean) =>
  live ? {} : ({ refetchOnWindowFocus: false, refetchOnReconnect: false } as const)

export interface SessionsOptions {
  /** Poll while the page is visible (default); `false` pauses the polling, not the reads that are asked for. */
  readonly live?: boolean
  /** What the target filters by (the unfiltered list was cut at its cap). */
  readonly filter?: ServerFilter
  readonly enabled?: boolean
}

export function sessionsQuery(client: ApiClient, path: string, options: SessionsOptions = {}) {
  const filter = options.filter ?? {}
  return queryOptions({
    queryKey: hasServerFilter(filter)
      ? connectionKeys.filteredSessions(path, filter)
      : connectionKeys.sessions(path),
    queryFn: ({ signal }) =>
      client.operation('listSessions', {
        params: { target: path },
        query: {
          limit: SESSION_LIMIT,
          ...(filter.state === undefined ? {} : { state: filter.state }),
          ...(filter.application === undefined ? {} : { application: filter.application }),
          ...(filter.minAgeSeconds === undefined ? {} : { minAgeSeconds: filter.minAgeSeconds }),
        },
        signal,
      }),
    enabled: isTargetPath(path) && (options.enabled ?? true),
    refetchInterval: pollWhen(options.live ?? true),
    ...pausable(options.live ?? true),
  })
}

export function locksQuery(client: ApiClient, path: string, options: { live?: boolean } = {}) {
  return queryOptions({
    queryKey: connectionKeys.locks(path),
    queryFn: ({ signal }) => client.operation('getLockGraph', { params: { target: path }, signal }),
    enabled: isTargetPath(path),
    refetchInterval: pollWhen(options.live ?? true),
    ...pausable(options.live ?? true),
  })
}

export function endpointsQuery(client: ApiClient, clusterId: string | undefined) {
  return queryOptions({
    queryKey: connectionKeys.endpoints(clusterId ?? ''),
    queryFn: ({ signal }) =>
      client.operation('listClusterEndpoints', {
        params: { clusterId: clusterId ?? '' },
        query: {},
        signal,
      }),
    enabled: clusterId !== undefined && clusterId !== '',
    refetchInterval: (query) => poll(query.state.error),
  })
}

export interface LiveRead<T> {
  readonly readable: Readable<T>
  readonly refetch: () => void
  readonly fetching: boolean
}

export type Sessions = ResponseOf<'listSessions'>
export type LockGraph = ResponseOf<'getLockGraph'>
export type Endpoints = ResponseOf<'listClusterEndpoints'>

/**
 * The clock a live read measures its age against: the shared clock of the
 * page (one timer for every age on it). A read turns stale on time whether or
 * not a new answer arrives, so a paused page, or one whose polling hangs,
 * never keeps showing an old read as current.
 */
function useReadClock(): () => number {
  const now = useResolvedNow()
  return () => now
}

export function useSessions(path: string, options: SessionsOptions = {}): LiveRead<Sessions> {
  const { client } = useApi()
  const query = useQuery(sessionsQuery(client, path, options))
  const now = useReadClock()
  return {
    readable: toReadable(query, {
      now,
      missing: (value) =>
        value.truncated ? [t('connections.sessions.truncated', { cap: value.cap })] : undefined,
    }),
    refetch: () => void query.refetch(),
    fetching: query.isFetching,
  }
}

export function useLocks(path: string, options: { live?: boolean } = {}): LiveRead<LockGraph> {
  const { client } = useApi()
  const query = useQuery(locksQuery(client, path, options))
  const now = useReadClock()
  return {
    readable: toReadable(query, {
      now,
      missing: (value) => (value.truncated ? [t('locks.truncated')] : undefined),
    }),
    refetch: () => void query.refetch(),
    fetching: query.isFetching,
  }
}

export function useEndpoints(clusterId: string | undefined): LiveRead<Endpoints> {
  const { client } = useApi()
  const query = useQuery(endpointsQuery(client, clusterId))
  return {
    readable: toReadable(query, {
      missing: (value) => (value.truncated ? [t('connections.endpoints.truncated')] : undefined),
    }),
    refetch: () => void query.refetch(),
    fetching: query.isFetching,
  }
}

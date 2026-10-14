import type { Readable } from '@exponetdb/ui-patterns'
import { queryOptions, useQuery } from '@tanstack/react-query'
import type { ApiClient, ResponseOf } from '../../lib/api/client.ts'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { isTargetPath } from '../target/params.ts'

/**
 * Reads of the Connections and Locks pages. Sessions and the lock graph are
 * live reads of the target (`diagnostics.read`); the page asks again every 15
 * seconds while it is open and visible, and shows an answer older than a
 * minute as stale. Statement text in the sessions is already redacted by the
 * server. Keys are built from the validated target path only. The raw
 * statement is deliberately **not** a query: its text is never put in the
 * cache (see `raw-statement.tsx`).
 */
export const connectionKeys = {
  sessions: (path: string) => ['diagnostics', 'sessions', path] as const,
  locks: (path: string) => ['diagnostics', 'locks', path] as const,
  endpoints: (clusterId: string) => ['diagnostics', 'endpoints', clusterId] as const,
}

export const DIAGNOSTICS_POLL_MS = 15_000
/** The sessions one read asks for (the server's cap is in the answer). */
export const SESSION_LIMIT = 500

const poll = (error: unknown): number | false =>
  classifyFailure(error).kind === 'not_found' ? false : DIAGNOSTICS_POLL_MS

export function sessionsQuery(client: ApiClient, path: string) {
  return queryOptions({
    queryKey: connectionKeys.sessions(path),
    queryFn: ({ signal }) =>
      client.operation('listSessions', {
        params: { target: path },
        query: { limit: SESSION_LIMIT },
        signal,
      }),
    enabled: isTargetPath(path),
    refetchInterval: (query) => poll(query.state.error),
  })
}

export function locksQuery(client: ApiClient, path: string) {
  return queryOptions({
    queryKey: connectionKeys.locks(path),
    queryFn: ({ signal }) => client.operation('getLockGraph', { params: { target: path }, signal }),
    enabled: isTargetPath(path),
    refetchInterval: (query) => poll(query.state.error),
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

export function useSessions(path: string): LiveRead<Sessions> {
  const { client } = useApi()
  const query = useQuery(sessionsQuery(client, path))
  return {
    readable: toReadable(query, {
      missing: (value) =>
        value.truncated ? [t('connections.sessions.truncated', { cap: value.cap })] : undefined,
    }),
    refetch: () => void query.refetch(),
    fetching: query.isFetching,
  }
}

export function useLocks(path: string): LiveRead<LockGraph> {
  const { client } = useApi()
  const query = useQuery(locksQuery(client, path))
  return {
    readable: toReadable(query, {
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

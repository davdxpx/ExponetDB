import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import type { ApiClient } from '../../lib/api/client.ts'
import { isTargetPath } from '../target/params.ts'

/**
 * Query keys and options of the schema browser. Keys are built from the
 * validated target path and from what the person typed or chose; every query
 * is disabled for a path that failed the grammar. The cache holds the
 * server's answers as they came.
 */
export const schemaKeys = {
  overview: (path: string) => ['schema', 'overview', path] as const,
  fingerprint: (path: string) => ['schema', 'fingerprint', path] as const,
  drift: (path: string) => ['schema', 'drift', path] as const,
  search: (path: string, kinds: readonly string[], q: string) =>
    ['schema', 'search', path, kinds, q] as const,
  object: (path: string, kind: string, qualifiedName: string) =>
    ['schema', 'object', path, kind, qualifiedName] as const,
}

export const SCHEMA_POLL_MS = 60_000
/** Objects one search page asks for. */
export const SEARCH_PAGE_LIMIT = 50
/** The longest search the server takes (`q` is 1 to 128 characters). */
export const SEARCH_MAX_LENGTH = 128
/** The most tables the diagram reads in one go. */
export const ERD_MAX_TABLES = 30

export function overviewQuery(client: ApiClient, path: string) {
  return queryOptions({
    queryKey: schemaKeys.overview(path),
    queryFn: ({ signal }) =>
      client.operation('getSchemaOverview', { params: { target: path }, signal }),
    enabled: isTargetPath(path),
    refetchInterval: SCHEMA_POLL_MS,
  })
}

export function fingerprintQuery(client: ApiClient, path: string) {
  return queryOptions({
    queryKey: schemaKeys.fingerprint(path),
    queryFn: ({ signal }) =>
      client.operation('getSchemaFingerprint', { params: { target: path }, signal }),
    enabled: isTargetPath(path),
    refetchInterval: SCHEMA_POLL_MS,
  })
}

/** The drift findings of the target: the page has no read of the last drift check itself. */
export function driftFindingsQuery(client: ApiClient, path: string) {
  return queryOptions({
    queryKey: schemaKeys.drift(path),
    queryFn: ({ signal }) =>
      client.operation('listTargetFindings', {
        params: { target: path },
        query: { kind: 'drift', limit: 50 },
        signal,
      }),
    enabled: isTargetPath(path),
    refetchInterval: SCHEMA_POLL_MS,
  })
}

/** A search needs at least one character (`q` is 1 to 128 characters); the query is off without one. */
export function searchQuery(client: ApiClient, path: string, kinds: readonly string[], q: string) {
  return infiniteQueryOptions({
    queryKey: schemaKeys.search(path, kinds, q),
    queryFn: ({ signal, pageParam }) =>
      client.operation('searchSchema', {
        params: { target: path },
        query: {
          q,
          kinds,
          limit: SEARCH_PAGE_LIMIT,
          ...(pageParam === '' ? {} : { cursor: pageParam }),
        },
        signal,
      }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: isTargetPath(path) && q.length > 0 && q.length <= SEARCH_MAX_LENGTH,
  })
}

export function objectQuery(
  client: ApiClient,
  path: string,
  kind: string,
  qualifiedName: string | undefined,
) {
  return queryOptions({
    queryKey: schemaKeys.object(path, kind, qualifiedName ?? ''),
    queryFn: ({ signal }) =>
      client.operation('getSchemaObject', {
        params: { target: path, kind, qualifiedName: qualifiedName ?? '' },
        signal,
      }),
    enabled: isTargetPath(path) && qualifiedName !== undefined && qualifiedName.length >= 3,
  })
}

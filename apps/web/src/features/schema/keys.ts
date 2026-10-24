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
  objects: (path: string, kinds: readonly string[], schema: string, q: string) =>
    ['schema', 'objects', path, kinds, schema, q] as const,
  object: (path: string, kind: string, qualifiedName: string) =>
    ['schema', 'object', path, kind, qualifiedName] as const,
}

export const SCHEMA_POLL_MS = 60_000
/** Objects one page of the list asks for. */
export const LIST_PAGE_LIMIT = 100
/** Objects a class of the tree asks for; the tree has no "Load more", so it takes the API's page maximum. */
export const TREE_PAGE_LIMIT = 200
/** The code a cursor from an older snapshot is refused with (409): the schema changed between two pages. */
export const SNAPSHOT_CHANGED = 'SCHEMA_FINGERPRINT_MISMATCH'
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

/** The drift findings of the target, for the schema page's status (the drift page reads the last check itself). */
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

/** What narrows a list of schema objects: the kinds, one schema, and a name filter. */
export interface ObjectFilter {
  readonly kinds: readonly string[]
  /** One schema by its exact name, or all. */
  readonly schema: string | null
  /** Part of a name, or `''` for no name filter. */
  readonly q: string
}

/**
 * The objects of the given kinds, page by page: `GET /targets/{target}/schema/objects`.
 * No search term is needed; a name filter is sent as `q`, a schema as `schema`.
 * A cursor belongs to the snapshot it came from, so a page read after the
 * schema changed is answered 409 `SCHEMA_FINGERPRINT_MISMATCH`.
 */
export function objectsQuery(
  client: ApiClient,
  path: string,
  filter: ObjectFilter,
  enabled = true,
) {
  return infiniteQueryOptions({
    queryKey: schemaKeys.objects(path, filter.kinds, filter.schema ?? '', filter.q),
    queryFn: ({ signal, pageParam }) =>
      client.operation('listSchemaObjects', {
        params: { target: path },
        query: {
          kinds: filter.kinds,
          ...(filter.schema === null ? {} : { schema: filter.schema }),
          ...(filter.q === '' ? {} : { q: filter.q }),
          limit: LIST_PAGE_LIMIT,
          ...(pageParam === '' ? {} : { cursor: pageParam }),
        },
        signal,
      }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: enabled && isTargetPath(path) && filter.q.length <= SEARCH_MAX_LENGTH,
    // Like the overview and the fingerprint beside it: the snapshot a list shows is as old as its
    // `observedAt`, so an open list is read again and does not turn stale under the person's eyes.
    // A read again takes the cursors of the fresh pages, never the old ones.
    refetchInterval: SCHEMA_POLL_MS,
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

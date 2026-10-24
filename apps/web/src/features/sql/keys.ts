import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import type { ApiClient } from '../../lib/api/client.ts'
import { isTargetPath } from '../target/params.ts'
import { CLASSIFY_MAX_BYTES, utf8Bytes } from './sql-model.ts'

/**
 * Query keys and options of the SQL workspace. Keys hold the validated target
 * path and what the person typed; nothing here runs a data read (a data read
 * is an audited action the person starts with Run, never a cached query).
 */
export const sqlKeys = {
  all: ['sql'] as const,
  classify: (major: number | undefined, sql: string) =>
    ['sql', 'classify', major ?? 'default', sql] as const,
  history: (path: string) => ['sql', 'history', path] as const,
  saved: (path: string) => ['sql', 'saved', path] as const,
  completion: (path: string, kinds: readonly string[], q: string, limit: number) =>
    ['sql', 'completion', path, kinds, q, limit] as const,
  completionObject: (path: string, kind: string, qualifiedName: string) =>
    ['sql', 'completion-object', path, kind, qualifiedName] as const,
}

export const HISTORY_PAGE_LIMIT = 50
export const SAVED_PAGE_LIMIT = 50
export const COMPLETION_LIMIT = 50
/**
 * The page of an exact-name lookup (the relation behind an alias): the search
 * matches substrings, so a short name needs a larger page to hold the exact one.
 */
export const RELATION_LOOKUP_LIMIT = 200
/** The longest name search the server takes (`q` is 1 to 128 characters). */
export const COMPLETION_MAX_Q = 128

/** Whether the classification endpoint takes this text at all (64 KiB of UTF-8; 200 statements is the server's to count). */
export function classifiable(sql: string): boolean {
  return sql.trim().length > 0 && utf8Bytes(sql) <= CLASSIFY_MAX_BYTES
}

/**
 * The server's classification of a text (a pure parse: nothing runs, nothing
 * is stored or audited). Never retried silently and kept for the text it was
 * asked for only.
 */
export function classifyQuery(client: ApiClient, major: 16 | 17 | 18 | undefined, sql: string) {
  return queryOptions({
    queryKey: sqlKeys.classify(major, sql),
    queryFn: ({ signal }) =>
      client.operation('classifySql', {
        body: major === undefined ? { sql } : { sql, postgresMajor: major },
        signal,
      }),
    enabled: classifiable(sql),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 120_000,
  })
}

/** The caller's own reads of this target, newest first (`source: audit`). */
export function historyQuery(client: ApiClient, path: string) {
  return infiniteQueryOptions({
    queryKey: sqlKeys.history(path),
    queryFn: ({ signal, pageParam }) =>
      client.operation('listQueryHistory', {
        params: { target: path },
        query: { limit: HISTORY_PAGE_LIMIT, ...(pageParam === '' ? {} : { cursor: pageParam }) },
        signal,
      }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: isTargetPath(path),
  })
}

/** The saved queries of this target and its project the caller may read. */
export function savedQuery(client: ApiClient, path: string) {
  return infiniteQueryOptions({
    queryKey: sqlKeys.saved(path),
    queryFn: ({ signal, pageParam }) =>
      client.operation('listSavedQueries', {
        query: {
          target: path,
          limit: SAVED_PAGE_LIMIT,
          ...(pageParam === '' ? {} : { cursor: pageParam }),
        },
        signal,
      }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: isTargetPath(path),
  })
}

/** One page of a name search for completion (asked on demand, never the whole catalog). */
export function completionQuery(
  client: ApiClient,
  path: string,
  kinds: readonly string[],
  q: string,
  limit: number = COMPLETION_LIMIT,
) {
  return queryOptions({
    queryKey: sqlKeys.completion(path, kinds, q, limit),
    queryFn: ({ signal }) =>
      client.operation('searchSchema', {
        params: { target: path },
        query: { q, kinds, limit },
        signal,
      }),
    staleTime: 60_000,
    gcTime: 120_000,
    retry: false,
  })
}

/**
 * One relation, read for the columns completion offers after `alias.`. Cached
 * for a minute like the name search and shared by every keystroke that asks
 * for the same relation, so a burst of typing is one read, not one per key.
 */
export function completionObjectQuery(
  client: ApiClient,
  path: string,
  kind: string,
  qualifiedName: string,
) {
  return queryOptions({
    queryKey: sqlKeys.completionObject(path, kind, qualifiedName),
    queryFn: ({ signal }) =>
      client.operation('getSchemaObject', {
        params: { target: path, kind, qualifiedName },
        signal,
      }),
    staleTime: 60_000,
    gcTime: 120_000,
    retry: false,
  })
}

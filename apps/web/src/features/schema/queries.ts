import type { SchemaObject, SchemaObjectRef } from '@exponetdb/sdk/operations'
import type { Readable } from '@exponetdb/ui-patterns'
import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import type { ResponseOf } from '../../lib/api/client.ts'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import { type QueryLike, toReadable } from '../../lib/query/readable.ts'
import {
  driftFindingsQuery,
  ERD_MAX_TABLES,
  fingerprintQuery,
  objectQuery,
  overviewQuery,
  schemaKeys,
  searchQuery,
} from './keys.ts'
import { type ObjectKey, qualifiedName } from './schema-model.ts'

export type SchemaOverviewRead = ResponseOf<'getSchemaOverview'>
export type FingerprintRead = ResponseOf<'getSchemaFingerprint'>
export type DriftFindings = ResponseOf<'listTargetFindings'>

/** A read of the schema browser: the truthful state, a way to read again, and whether a read is running. */
export interface SchemaRead<T> {
  readonly readable: Readable<T>
  readonly refetch: () => void
  readonly fetching: boolean
}

type Q<T> = QueryLike<T> & { readonly isFetching: boolean; readonly refetch: () => unknown }

function read<T>(
  query: Q<T>,
  missing?: (value: T) => readonly string[] | undefined,
): SchemaRead<T> {
  return {
    readable: toReadable(query, missing === undefined ? {} : { missing }),
    refetch: () => void query.refetch(),
    fetching: query.isFetching,
  }
}

/** Schemas with their object counts. Partial when the role the observer uses cannot see everything. */
export function useSchemaOverview(
  path: string,
  missing: (value: SchemaOverviewRead) => readonly string[] | undefined,
): SchemaRead<SchemaOverviewRead> {
  const { client } = useApi()
  return read(useQuery(overviewQuery(client, path)), missing)
}

export function useSchemaFingerprint(
  path: string,
  missing: (value: FingerprintRead) => readonly string[] | undefined,
): SchemaRead<FingerprintRead> {
  const { client } = useApi()
  return read(useQuery(fingerprintQuery(client, path)), missing)
}

export function useDriftFindings(
  path: string,
  missing: (value: DriftFindings) => readonly string[] | undefined,
): SchemaRead<DriftFindings> {
  const { client } = useApi()
  return read(useQuery(driftFindingsQuery(client, path)), missing)
}

/** The objects of the given kinds whose name contains `q`, page by page. Nothing is asked for an empty `q`. */
export interface ObjectSearch {
  readonly items: readonly SchemaObjectRef[]
  readonly hasMore: boolean
}

export interface SearchRead extends SchemaRead<ObjectSearch> {
  /** No search was made: `q` is empty. Not a read, so no state of one. */
  readonly idle: boolean
  readonly loadMore: () => void
  readonly loadingMore: boolean
}

export function useObjectSearch(
  path: string,
  kinds: readonly string[],
  q: string,
  missing: (value: ObjectSearch) => readonly string[] | undefined,
): SearchRead {
  const { client } = useApi()
  const query = useInfiniteQuery({
    ...searchQuery(client, path, kinds, q),
    select: (data): ObjectSearch => ({
      items: data.pages.flatMap((page) => page.items),
      hasMore: data.pages[data.pages.length - 1]?.nextCursor != null,
    }),
  })
  return {
    ...read(query, missing),
    idle: q.length === 0,
    loadMore: () => void query.fetchNextPage(),
    loadingMore: query.isFetchingNextPage,
  }
}

/** The detail of one object. Nothing is asked for a reference without a key. */
export function useSchemaObject(
  path: string,
  ref: ObjectKey | undefined,
): SchemaRead<SchemaObject> {
  const { client } = useApi()
  const name = ref === undefined ? undefined : qualifiedName(ref)
  return read(useQuery(objectQuery(client, path, ref?.kind ?? '', name)))
}

/**
 * The details of the tables a search found, for the diagram. The state is the
 * truthful one of the whole: `loading` while a table is still being read,
 * `failed` when the search failed or every table did, `partial` with the
 * names of the tables that could not be read.
 */
export function useTableDetails(
  path: string,
  refs: readonly SchemaObjectRef[],
): Readable<readonly SchemaObject[]> {
  const { client } = useApi()
  const shown = useMemo(() => refs.slice(0, ERD_MAX_TABLES), [refs])
  const results = useQueries({
    queries: shown.map((ref) => {
      const name = qualifiedName(ref)
      return {
        ...objectQuery(client, path, ref.kind, name),
        queryKey: schemaKeys.object(path, ref.kind, name ?? ''),
      }
    }),
  })
  return useMemo((): Readable<readonly SchemaObject[]> => {
    if (shown.length === 0)
      return { state: 'ready', value: [], source: 'live', observedAt: new Date().toISOString() }
    if (results.some((result) => result.data === undefined && !result.isError)) {
      return { state: 'loading' }
    }
    const loaded = results.flatMap((result) => (result.data === undefined ? [] : [result.data]))
    const failed = results.flatMap((result, index) =>
      result.isError && result.data === undefined ? [index] : [],
    )
    if (loaded.length === 0) {
      const first = results.find((result) => result.isError)
      const failure = classifyFailure(first?.error)
      return { state: 'failed', error: { code: failure.code, message: failure.message } }
    }
    const oldest = loaded.reduce(
      (earliest, object) => (object.observedAt < earliest ? object.observedAt : earliest),
      loaded[0]?.observedAt ?? new Date().toISOString(),
    )
    const sourceOf = loaded[0]?.source
    const source = (['live', 'sampled', 'cached', 'agent_reported', 'inferred'] as const).find(
      (candidate) => candidate === sourceOf,
    )
    if (failed.length > 0) {
      return {
        state: 'partial',
        value: loaded,
        source: source ?? 'cached',
        observedAt: oldest,
        missing: [t('schema.erd.unread', { count: failed.length, total: shown.length })],
      }
    }
    return { state: 'ready', value: loaded, source: source ?? 'cached', observedAt: oldest }
  }, [results, shown])
}

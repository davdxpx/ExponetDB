import type { SchemaObject, SchemaObjectRef } from '@exponetdb/sdk/operations'
import type { Readable, ReadFailure } from '@exponetdb/ui-patterns'
import { useInfiniteQuery, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import type { ResponseOf } from '../../lib/api/client.ts'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import { type QueryLike, toReadable } from '../../lib/query/readable.ts'
import {
  driftFindingsQuery,
  ERD_MAX_TABLES,
  fingerprintQuery,
  type ObjectFilter,
  objectQuery,
  objectsQuery,
  overviewQuery,
  SNAPSHOT_CHANGED,
  schemaKeys,
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

/**
 * The objects a list has read so far, with what the last page said about the
 * whole: how many match in all (exact), whether more pages follow, and
 * whether the snapshot was complete. `source` and `observedAt` are the
 * snapshot's, the same for every page of one list.
 */
export interface ObjectList {
  readonly items: readonly SchemaObjectRef[]
  /** How many objects match the filters before paging (exact, from the server). */
  readonly total: number
  readonly hasMore: boolean
  /** False when something in the managed scope could not be read: the list may miss objects. */
  readonly complete: boolean
  readonly source: string
  readonly observedAt: string
}

export interface ListRead extends SchemaRead<ObjectList> {
  /** The list was not asked for (the caller turned it off): not a read, so no state of one. */
  readonly idle: boolean
  readonly loadMore: () => void
  readonly loadingMore: boolean
  /** Why the page after the ones above could not be read; the pages above are still the ones that were. */
  readonly loadMoreFailure: ReadFailure | undefined
  /**
   * A page was asked for with a cursor of an older snapshot (409
   * `SCHEMA_FINGERPRINT_MISMATCH`): the schema changed between two pages, so
   * the list started again from the first page.
   */
  readonly restarted: boolean
}

function listMissing(value: ObjectList): readonly string[] | undefined {
  return value.complete ? undefined : [t('schema.list.incomplete')]
}

/**
 * The objects of the given kinds, with or without a name filter, 100 at a
 * time. The state is the truthful one of the read: `partial` when the
 * snapshot was incomplete, `stale` for an old snapshot, `failed` for a
 * failure on the first page. A failure on a later page keeps the pages read
 * and is told separately (`loadMoreFailure`), and a cursor the schema outgrew
 * restarts the list from its first page (`restarted`).
 */
export function useObjectList(path: string, filter: ObjectFilter, enabled = true): ListRead {
  const { client } = useApi()
  const queryClient = useQueryClient()
  const options = objectsQuery(client, path, filter, enabled)
  const identity = JSON.stringify(options.queryKey)
  const [restartedFor, setRestartedFor] = useState<string | null>(null)
  const query = useInfiniteQuery({
    ...options,
    select: (data): ObjectList => {
      const first = data.pages[0]
      const last = data.pages[data.pages.length - 1]
      return {
        items: data.pages.flatMap((page) => page.items),
        total: last?.total ?? 0,
        hasMore: last?.nextCursor != null,
        complete: data.pages.every((page) => page.complete),
        source: first?.source ?? 'cached',
        observedAt: first?.observedAt ?? new Date().toISOString(),
      }
    },
  })
  const nextPageFailed = query.isFetchNextPageError
  const loadMore = (): void => {
    setRestartedFor(null)
    void query.fetchNextPage().then(async (result) => {
      if (result.isError && classifyFailure(result.error).code === SNAPSHOT_CHANGED) {
        await queryClient.resetQueries({ queryKey: options.queryKey, exact: true })
        setRestartedFor(identity)
      }
    })
  }
  return {
    // A failure on a later page is not a failure of the read: the pages read are still the answer.
    ...read(
      {
        data: query.data,
        error: query.error,
        isError: query.isError && !nextPageFailed,
        dataUpdatedAt: query.dataUpdatedAt,
        isFetching: query.isFetching,
        refetch: query.refetch,
      },
      listMissing,
    ),
    idle: !enabled,
    loadMore,
    loadingMore: query.isFetchingNextPage,
    loadMoreFailure:
      nextPageFailed && classifyFailure(query.error).code !== SNAPSHOT_CHANGED
        ? failureOf(query.error)
        : undefined,
    restarted: restartedFor === identity,
  }
}

function failureOf(error: unknown): ReadFailure {
  const failure = classifyFailure(error)
  return { code: failure.code, message: failure.message }
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

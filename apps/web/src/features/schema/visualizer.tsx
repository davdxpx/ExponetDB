import type { SchemaObject } from '@exponetdb/sdk/operations'
import type { SchemaErdData } from '@exponetdb/ui-data'
import { LoadingState, type Readable } from '@exponetdb/ui-patterns'
import { lazy, type ReactNode, Suspense, useMemo, useState } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { nounPhrase } from '../target/phrases.ts'
import { ERD_MAX_TABLES } from './keys.ts'
import { visibilityMissing } from './object-list.tsx'
import { type SearchRead, useObjectSearch, useSchemaOverview, useTableDetails } from './queries.ts'
import { buildErdData } from './schema-model.ts'
import { SchemaSelector, SearchForm } from './search-controls.tsx'

/**
 * The diagram loads on demand: `@xyflow/react` and `dagre` are a separate
 * chunk that is fetched only when the visualizer page opens, never with the
 * app's entry chunk. Its "Show as table" switch is the text alternative.
 */
const SchemaErd = lazy(async () => {
  const module = await import('@exponetdb/ui-data/erd/schema-erd')
  return { default: module.SchemaErd }
})

/** The state of a read with its value mapped; a state without a value stays as it is. */
export function mapReadable<T, U>(readable: Readable<T>, map: (value: T) => U): Readable<U> {
  switch (readable.state) {
    case 'loading':
    case 'failed':
      return readable
    case 'stale':
      return { ...readable, value: map(readable.value) }
    case 'partial':
      return { ...readable, value: map(readable.value) }
    case 'ready':
      return { ...readable, value: map(readable.value) }
  }
}

/**
 * The tables that match a name filter (at most 30 are read), drawn with their
 * foreign keys. A table that could not be read is counted in a partial state;
 * a foreign key to a table outside the filter is counted as not drawn.
 */
export function Visualizer(props: { readonly path: string }): ReactNode {
  const [term, setTerm] = useState('')
  const [schema, setSchema] = useState<string | null>(null)
  const overview = useSchemaOverview(props.path, visibilityMissing)
  const search = useObjectSearch(props.path, ['table'], term, (value) =>
    value.hasMore ? [t('schema.list.more')] : undefined,
  )
  const schemas =
    overview.readable.state === 'loading' || overview.readable.state === 'failed'
      ? []
      : overview.readable.value.schemas.map((entry) => entry.name)
  return (
    <div className="flex flex-col gap-4" data-slot="visualizer">
      <SearchForm applied={term} onApply={setTerm} label={t('schema.erd.filter')} />
      {schemas.length > 1 ? (
        <SchemaSelector schemas={schemas} value={schema} onChange={setSchema} />
      ) : null}
      {search.idle ? (
        <p className="text-sm" data-slot="erd-idle">
          {t('schema.erd.idle')}
        </p>
      ) : (
        <Diagram path={props.path} search={search} schema={schema} />
      )}
    </div>
  )
}

function Diagram(props: {
  readonly path: string
  readonly search: SearchRead
  readonly schema: string | null
}): ReactNode {
  const { search } = props
  const refs = useMemo(() => {
    const value =
      search.readable.state === 'failed' || search.readable.state === 'loading'
        ? []
        : search.readable.value.items
    return props.schema === null ? value : value.filter((ref) => ref.schema === props.schema)
  }, [search.readable, props.schema])
  const details = useTableDetails(props.path, search.readable.state === 'failed' ? [] : refs)
  const built = useMemo(
    () => mapReadable(details, (tables: readonly SchemaObject[]) => buildErdData(tables)),
    [details],
  )
  const searchBad = search.readable.state === 'failed' || search.readable.state === 'loading'
  // The diagram's own states carry the search's failure and the tables' reads, never an empty drawing.
  const readable: Readable<SchemaErdData> = searchBad
    ? mapSearchState(search)
    : mapReadable(built, (value) => value.data)
  const undrawn = built.state === 'loading' || built.state === 'failed' ? 0 : built.value.undrawn
  const total =
    search.readable.state === 'failed' || search.readable.state === 'loading' ? 0 : refs.length
  return (
    <div className="flex flex-col gap-2">
      {total > ERD_MAX_TABLES ? (
        <p role="note" className="text-sm" data-slot="erd-capped">
          {t('schema.erd.capped', { shown: ERD_MAX_TABLES, total })}
        </p>
      ) : null}
      {search.readable.state === 'partial' ? (
        <p role="note" className="text-sm" data-slot="erd-more">
          {t('schema.erd.moreMatch')}
        </p>
      ) : null}
      {search.readable.state === 'stale' ? (
        <p role="note" className="text-sm" data-slot="erd-stale">
          {t('schema.erd.stale')}
        </p>
      ) : null}
      {undrawn > 0 ? (
        <p role="note" className="text-sm" data-slot="erd-undrawn">
          {t('schema.erd.undrawn', { count: undrawn })}
        </p>
      ) : null}
      <Suspense fallback={<LoadingState what={nounPhrase('schema.erd.what')} />}>
        <SchemaErd
          readable={readable}
          what={nounPhrase('schema.erd.what')}
          onRetry={search.refetch}
          onRefresh={search.refetch}
          busy={search.fetching}
          headingLevel={3}
        />
      </Suspense>
    </div>
  )
}

/** The search's own failure or loading, as a diagram state. */
function mapSearchState(search: SearchRead): Readable<SchemaErdData> {
  const state = search.readable
  if (state.state === 'failed') return state
  return { state: 'loading' }
}

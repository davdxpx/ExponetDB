import {
  Button,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import { ReadableView, UntrustedName, UntrustedText } from '@exponetdb/ui-patterns'
import { type ReactNode, useMemo } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import type { TargetRoute } from '../target/params.ts'
import { ObjectDetail } from './object-detail.tsx'
import {
  type ObjectSearch,
  type SchemaOverviewRead,
  type SearchRead,
  useObjectSearch,
  useSchemaOverview,
} from './queries.ts'
import { type ObjectKey, objectKeyOfRef, refKey } from './schema-model.ts'
import {
  DEFAULT_PANEL_STATE,
  objectKeyOf,
  objectParam,
  panelStateOf,
  type SchemaSearch,
  withPanelState,
} from './search.ts'
import { useSchemaSearch } from './search-context.tsx'
import { SchemaSelector, SearchForm } from './search-controls.tsx'

const HEADING = 3

/** Words for the schemas the observer role could not see (counts only; names are untrusted text). */
export function visibilityMissing(value: SchemaOverviewRead): readonly string[] | undefined {
  if (value.visibility.complete && value.complete) return undefined
  return [
    t('schema.visibility.gaps', {
      gaps: value.visibility.gapCount,
      schemas: value.visibility.missingSchemas.length,
    }),
  ]
}

/** The search with a new object selected (or none): what belongs to the old object leaves with it. */
function selecting(search: SchemaSearch, key: ObjectKey | undefined): SchemaSearch {
  return withPanelState(
    { ...search, object: key === undefined ? undefined : objectParam(key) },
    DEFAULT_PANEL_STATE,
  )
}

/**
 * The objects of one kind: a name filter, a schema selector, the matches and,
 * on request, the detail of one match. A list is read when a filter is applied;
 * `hasMore` is said as a partial read, so the first page is never the whole list.
 * The filter, the schema, the selected object and its tab live in the validated
 * search of the page, so a link carries them. The selected object is read by
 * its key, so a link to an object works without the list that found it.
 */
export function ObjectList(props: {
  readonly target: TargetRoute
  readonly kinds: readonly string[]
  readonly what: string
}): ReactNode {
  const { search: current, setSearch } = useSchemaSearch()
  const term = current.q ?? ''
  const schema = current.schema ?? null
  const selected = objectKeyOf(current)
  const panel = panelStateOf(current)
  const overview = useSchemaOverview(props.target.path, visibilityMissing)
  const found = useObjectSearch(props.target.path, props.kinds, term, (value) =>
    value.hasMore ? [t('schema.list.more')] : undefined,
  )
  return (
    <div className="flex flex-col gap-4" data-slot="object-list">
      <SearchForm
        applied={term}
        onApply={(next) =>
          setSearch(selecting({ ...current, q: next === '' ? undefined : next }, undefined), {
            replace: true,
          })
        }
      />
      <SchemaFilter
        overview={overview.readable}
        value={schema}
        onChange={(next) => setSearch({ ...current, schema: next ?? undefined }, { replace: true })}
      />
      <ListView
        search={found}
        what={props.what}
        schema={schema}
        selected={selected === undefined ? null : refKey(selected)}
        onSelect={(key) => setSearch(selecting(current, key))}
      />
      {selected === undefined ? null : (
        <section
          aria-label={t('schema.object.what')}
          className="rounded-md border border-default p-4"
          data-slot="object-panel"
        >
          <ObjectDetail
            // Another object is another panel.
            key={refKey(selected)}
            target={props.target}
            object={selected}
            state={panel}
            onState={(next, options) =>
              setSearch(withPanelState(current, next), { replace: options?.replace ?? true })
            }
          />
        </section>
      )}
    </div>
  )
}

/**
 * The schema selector over the schemas of the overview. A failed overview read
 * says so (the selector is off, the name filter still works), and a loading
 * one shows nothing yet: a missing selector is never the answer "one schema".
 */
export function SchemaFilter(props: {
  readonly overview: ReturnType<typeof useSchemaOverview>['readable']
  readonly value: string | null
  readonly onChange: (schema: string | null) => void
}): ReactNode {
  const { overview } = props
  if (overview.state === 'loading') return null
  if (overview.state === 'failed') {
    return (
      <p role="note" className="text-xs text-foreground-light" data-slot="schema-selector-failed">
        {t('schema.selector.failed')}
      </p>
    )
  }
  const schemas = overview.value.schemas.map((entry) => ({
    name: entry.name,
    managed: entry.managed,
  }))
  if (schemas.length < 2 && props.value === null) return null
  return <SchemaSelector schemas={schemas} value={props.value} onChange={props.onChange} />
}

export function ListView(props: {
  readonly search: SearchRead
  readonly what: string
  readonly schema: string | null
  readonly selected: string | null
  readonly onSelect: (key: ObjectKey | undefined) => void
}): ReactNode {
  const { search } = props
  if (search.idle) {
    return (
      <p className="text-sm" data-slot="list-idle">
        {t('schema.list.idle')}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <ReadableView
        readable={search.readable}
        what={props.what}
        onRetry={search.refetch}
        onRefresh={search.refetch}
        busy={search.fetching}
        headingLevel={HEADING}
        empty={{
          isEmpty: (value) => value.items.length === 0,
          content: <p className="text-sm">{t('schema.list.empty')}</p>,
        }}
        ready={(value) => (
          <Rows
            value={value}
            schema={props.schema}
            selected={props.selected}
            onSelect={props.onSelect}
          />
        )}
      />
      {search.readable.state !== 'loading' &&
      search.readable.state !== 'failed' &&
      search.readable.value.hasMore ? (
        <div>
          <Button
            type="button"
            size="tiny"
            variant="outline"
            disabled={search.loadingMore}
            onClick={search.loadMore}
          >
            {t('schema.list.loadMore')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function Rows(props: {
  readonly value: ObjectSearch
  readonly schema: string | null
  readonly selected: string | null
  readonly onSelect: (key: ObjectKey | undefined) => void
}): ReactNode {
  const items = useMemo(
    () =>
      props.schema === null
        ? props.value.items
        : props.value.items.filter((ref) => ref.schema === props.schema),
    [props.value.items, props.schema],
  )
  if (items.length === 0) {
    return <p className="text-sm">{t('schema.list.noneInSchema')}</p>
  }
  return (
    <Table>
      <TableCaption className="sr-only">{t('schema.list.caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t('schema.list.name')}</TableHead>
          <TableHead scope="col">{t('schema.list.schema')}</TableHead>
          <TableHead scope="col">{t('schema.list.parent')}</TableHead>
          <TableHead scope="col">{t('schema.list.kind')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((ref) => {
          const key = refKey(ref)
          const open = props.selected === key
          return (
            <TableRow key={key} data-object={key} data-selected={open}>
              <TableCell>
                <Button
                  type="button"
                  variant="link"
                  size="tiny"
                  aria-pressed={open}
                  onClick={() => props.onSelect(open ? undefined : objectKeyOfRef(ref))}
                >
                  <UntrustedName name={ref.name} mono label={t('schema.list.name')} />
                </Button>
                {ref.signature === null ? null : (
                  <UntrustedText
                    text={`(${ref.signature})`}
                    mono
                    maxCodePoints={160}
                    maxLines={2}
                    label={t('schema.list.signature')}
                    className="text-xs"
                  />
                )}
              </TableCell>
              <TableCell>
                <UntrustedName name={ref.schema} mono label={t('schema.list.schema')} />
              </TableCell>
              <TableCell>
                {ref.parent === null ? (
                  t('schema.none')
                ) : (
                  <UntrustedName name={ref.parent} mono label={t('schema.list.parent')} />
                )}
              </TableCell>
              <TableCell>
                <UntrustedName name={ref.kind} mono label={t('schema.list.kind')} />
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

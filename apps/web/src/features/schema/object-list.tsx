import type { SchemaObjectRef } from '@exponetdb/sdk/operations'
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
import {
  ObservedTime,
  ReadableView,
  type ReadMeta,
  SourceLabel,
  UntrustedName,
  UntrustedText,
} from '@exponetdb/ui-patterns'
import { type ReactNode, useMemo } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { readSourceOf } from '../target/gate.ts'
import type { TargetRoute } from '../target/params.ts'
import { ObjectDetail } from './object-detail.tsx'
import {
  type ListRead,
  type ObjectList as ObjectListRead,
  type SchemaOverviewRead,
  useObjectList,
  useSchemaOverview,
} from './queries.ts'
import {
  groupByParent,
  type ObjectKey,
  objectKeyOfRef,
  type ParentGroup,
  refKey,
} from './schema-model.ts'
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
 * The objects of one kind: a name filter, a schema selector, the objects and,
 * on request, the detail of one of them. The list is read when the page opens,
 * without a filter: the objects of the kind (of the chosen schema, whose name
 * contains the filter) come 100 at a time with "N of total" and a "Load more"
 * by cursor. The filter, the schema, the selected object and its tab live in
 * the validated search of the page, so a link carries them. The selected
 * object is read by its key, so a link to an object works without the list
 * that found it.
 */
export function ObjectList(props: {
  readonly target: TargetRoute
  readonly kinds: readonly string[]
  readonly what: string
  /** `parent` lists the objects under the relation they belong to (policies under their table). */
  readonly groupBy?: 'parent' | undefined
}): ReactNode {
  const { search: current, setSearch } = useSchemaSearch()
  const term = current.q ?? ''
  const schema = current.schema ?? null
  const selected = objectKeyOf(current)
  const panel = panelStateOf(current)
  const overview = useSchemaOverview(props.target.path, visibilityMissing)
  const list = useObjectList(props.target.path, { kinds: props.kinds, schema, q: term })
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
        list={list}
        what={props.what}
        term={term}
        schema={schema}
        groupBy={props.groupBy}
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
  readonly list: ListRead
  readonly what: string
  readonly term: string
  readonly schema: string | null
  readonly groupBy: 'parent' | undefined
  readonly selected: string | null
  readonly onSelect: (key: ObjectKey | undefined) => void
}): ReactNode {
  const { list } = props
  const loaded = list.readable.state !== 'loading' && list.readable.state !== 'failed'
  return (
    <div className="flex flex-col gap-2">
      {list.restarted ? (
        <p role="note" className="text-sm" data-slot="list-restarted">
          {t('schema.list.restarted')}
        </p>
      ) : null}
      <ReadableView
        readable={list.readable}
        what={props.what}
        onRetry={list.refetch}
        onRefresh={list.refetch}
        busy={list.fetching}
        headingLevel={HEADING}
        empty={{
          isEmpty: (value) => value.items.length === 0,
          content: (
            <p className="text-sm" data-slot="list-empty">
              {props.term !== '' ? t('schema.list.empty') : t('schema.list.emptyAll')}
            </p>
          ),
        }}
        ready={(value, meta) => (
          <Rows
            value={value}
            meta={meta}
            groupBy={props.groupBy}
            selected={props.selected}
            onSelect={props.onSelect}
          />
        )}
      />
      {list.loadMoreFailure === undefined ? null : (
        <p role="alert" className="text-sm" data-slot="list-more-failed">
          {t('schema.list.loadMoreFailed', {
            message: list.loadMoreFailure.message,
            code: list.loadMoreFailure.code,
          })}
        </p>
      )}
      {loaded && list.readable.value.hasMore ? (
        <div>
          <Button
            type="button"
            size="tiny"
            variant="outline"
            disabled={list.loadingMore}
            onClick={list.loadMore}
          >
            {t('schema.list.loadMore')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/** "Showing 100 of 342 objects", where they were read from and how long ago. */
function Summary(props: { readonly value: ObjectListRead; readonly meta: ReadMeta }): ReactNode {
  const { value, meta } = props
  const shown = value.items.length
  const known = readSourceOf(meta.source)
  return (
    <p
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-foreground-light"
      data-slot="list-count"
      data-shown={shown}
      data-total={value.total}
    >
      <span>
        {value.hasMore
          ? t('schema.list.showing', { shown, total: value.total })
          : t('schema.list.showingAll', { total: value.total })}
      </span>
      {known === undefined ? null : <SourceLabel source={known} />}
      <ObservedTime observedAt={meta.observedAt} />
    </p>
  )
}

function Rows(props: {
  readonly value: ObjectListRead
  readonly meta: ReadMeta
  readonly groupBy: 'parent' | undefined
  readonly selected: string | null
  readonly onSelect: (key: ObjectKey | undefined) => void
}): ReactNode {
  const { value } = props
  const groups = useMemo(
    () => (props.groupBy === 'parent' ? groupByParent(value.items) : undefined),
    [props.groupBy, value.items],
  )
  if (value.items.length === 0) {
    // Only a partial read gets here: a complete empty read is the empty content of the view.
    return (
      <p className="text-sm" data-slot="list-none-read">
        {t('schema.list.noneRead')}
      </p>
    )
  }
  const row = (ref: SchemaObjectRef): ReactNode => {
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
        {groups === undefined ? (
          <TableCell>
            {ref.parent === null ? (
              t('schema.none')
            ) : (
              <UntrustedName name={ref.parent} mono label={t('schema.list.parent')} />
            )}
          </TableCell>
        ) : null}
        <TableCell>
          <UntrustedName name={ref.kind} mono label={t('schema.list.kind')} />
        </TableCell>
      </TableRow>
    )
  }
  const columns = groups === undefined ? 4 : 3
  return (
    <div className="flex flex-col gap-2">
      <Summary value={value} meta={props.meta} />
      {groups === undefined ? null : (
        <p className="text-xs text-foreground-light" data-slot="list-group-note">
          {t('schema.list.groupNote')}
        </p>
      )}
      <Table>
        <TableCaption className="sr-only">{t('schema.list.caption')}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t('schema.list.name')}</TableHead>
            <TableHead scope="col">{t('schema.list.schema')}</TableHead>
            {groups === undefined ? (
              <TableHead scope="col">{t('schema.list.parent')}</TableHead>
            ) : null}
            <TableHead scope="col">{t('schema.list.kind')}</TableHead>
          </TableRow>
        </TableHeader>
        {groups === undefined ? (
          <TableBody>{value.items.map(row)}</TableBody>
        ) : (
          groups.map((group) => (
            <TableBody key={group.key} data-group={group.key}>
              <TableRow>
                <TableHead scope="rowgroup" colSpan={columns} className="font-normal">
                  <GroupTitle group={group} />
                </TableHead>
              </TableRow>
              {group.items.map(row)}
            </TableBody>
          ))
        )}
      </Table>
    </div>
  )
}

/** "Table public.orders, 3 policies read": the relation the objects belong to, as untrusted text. */
function GroupTitle(props: { readonly group: ParentGroup }): ReactNode {
  const { group } = props
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2">
      <span>{t('schema.list.group.table')}</span>
      {group.parent === null ? (
        <span>{t('schema.none')}</span>
      ) : (
        <UntrustedName
          name={`${group.schema}.${group.parent}`}
          mono
          label={t('schema.list.parent')}
        />
      )}
      <span className="text-foreground-light">
        {t('schema.list.group.count', { count: group.items.length })}
      </span>
    </span>
  )
}

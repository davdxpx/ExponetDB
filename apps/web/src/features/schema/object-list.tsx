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
import { ReadableView, UntrustedName, UntrustedText } from '@exponetdb/ui-patterns'
import { type ReactNode, useMemo, useState } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { ObjectDetail } from './object-detail.tsx'
import {
  type ObjectSearch,
  type SchemaOverviewRead,
  type SearchRead,
  useObjectSearch,
  useSchemaOverview,
} from './queries.ts'
import { refKey } from './schema-model.ts'
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

/**
 * The objects of one kind: a name filter, a schema selector, the matches and,
 * on request, the detail of one match. A list is read when a filter is applied;
 * `hasMore` is said as a partial read, so the first page is never the whole list.
 */
export function ObjectList(props: {
  readonly path: string
  readonly kinds: readonly string[]
  readonly what: string
}): ReactNode {
  const [term, setTerm] = useState('')
  const [schema, setSchema] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const overview = useSchemaOverview(props.path, visibilityMissing)
  const search = useObjectSearch(props.path, props.kinds, term, (value) =>
    value.hasMore ? [t('schema.list.more')] : undefined,
  )
  const schemas =
    overview.readable.state === 'loading' || overview.readable.state === 'failed'
      ? []
      : overview.readable.value.schemas.map((entry) => entry.name)
  const found = selectedRef(search, selected)
  return (
    <div className="flex flex-col gap-4" data-slot="object-list">
      <SearchForm
        applied={term}
        onApply={(next) => {
          setTerm(next)
          setSelected(null)
        }}
      />
      {schemas.length > 1 ? (
        <SchemaSelector schemas={schemas} value={schema} onChange={setSchema} />
      ) : null}
      <ListView
        search={search}
        what={props.what}
        schema={schema}
        selected={selected}
        onSelect={setSelected}
      />
      {found === undefined ? null : (
        <section
          aria-label={t('schema.object.what')}
          className="rounded-md border border-default p-4"
          data-slot="object-panel"
        >
          <ObjectDetail path={props.path} object={found} />
        </section>
      )}
    </div>
  )
}

function selectedRef(search: SearchRead, key: string | null): SchemaObjectRef | undefined {
  if (key === null) return undefined
  const state = search.readable
  if (state.state === 'loading' || state.state === 'failed') return undefined
  return state.value.items.find((ref) => refKey(ref) === key)
}

export function ListView(props: {
  readonly search: SearchRead
  readonly what: string
  readonly schema: string | null
  readonly selected: string | null
  readonly onSelect: (key: string | null) => void
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
  readonly onSelect: (key: string | null) => void
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
                  onClick={() => props.onSelect(open ? null : key)}
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

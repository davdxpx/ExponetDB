import type { SchemaObject } from '@exponetdb/sdk/operations'
import {
  Button,
  ComboboxTrigger,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  copyToClipboard,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@exponetdb/ui'
import type { SchemaErdData } from '@exponetdb/ui-data'
import { LoadingState, type Readable, readableValue } from '@exponetdb/ui-patterns'
import { lazy, type ReactNode, Suspense, useId, useMemo, useState } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { saveFile } from '../audit/download.ts'
import { nounPhrase } from '../target/phrases.ts'
import { diagramMarkdown, diagramSvg, type ExportMeta, exportFileName } from './erd-export.ts'
import { ERD_MAX_TABLES } from './keys.ts'
import { SchemaFilter, visibilityMissing } from './object-list.tsx'
import { PlainName } from './plain-name.tsx'
import { type SearchRead, useObjectSearch, useSchemaOverview, useTableDetails } from './queries.ts'
import { buildErdData, type ErdBuild, neighborhood } from './schema-model.ts'
import { useSchemaSearch } from './search-context.tsx'
import { SearchForm } from './search-controls.tsx'

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
 * a foreign key to a table outside the filter is counted as not drawn. The
 * filter and the schema live in the search of the page, so a link carries them.
 */
export function Visualizer(props: { readonly path: string }): ReactNode {
  const { search: current, setSearch } = useSchemaSearch()
  const term = current.q ?? ''
  const schema = current.schema ?? null
  const overview = useSchemaOverview(props.path, visibilityMissing)
  const search = useObjectSearch(props.path, ['table'], term, (value) =>
    value.hasMore ? [t('schema.list.more')] : undefined,
  )
  return (
    <div className="flex flex-col gap-4" data-slot="visualizer">
      <SearchForm
        applied={term}
        onApply={(next) =>
          setSearch({ ...current, q: next === '' ? undefined : next }, { replace: true })
        }
        label={t('schema.erd.filter')}
      />
      <SchemaFilter
        overview={overview.readable}
        value={schema}
        onChange={(next) => setSearch({ ...current, schema: next ?? undefined }, { replace: true })}
      />
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
  const [focus, setFocus] = useState<string | null>(null)
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
  const whole = readableValue(built)?.data
  // A table that left the read (another filter) is no longer the focus.
  const focused =
    focus !== null && whole?.tables.some((table) => table.id === focus) === true ? focus : null
  const shown =
    whole === undefined ? undefined : focused === null ? whole : neighborhood(whole, focused)
  // The diagram's own states carry the search's failure and the tables' reads, never an empty drawing.
  const readable: Readable<SchemaErdData> = searchBad
    ? mapSearchState(search)
    : mapReadable(built, (value) =>
        focused === null ? value.data : neighborhood(value.data, focused),
      )
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
      {whole === undefined ||
      shown === undefined ||
      searchBad ||
      built.state === 'loading' ? null : (
        <ErdTools
          path={props.path}
          whole={whole}
          shown={shown}
          focus={focused}
          onFocus={setFocus}
          meta={exportMeta(props.path, built, undrawn)}
        />
      )}
      <Suspense fallback={<LoadingState what={nounPhrase('schema.erd.what')} />}>
        <SchemaErd
          // Another focus is another drawing: fit to its tables.
          key={focused ?? 'all'}
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

/** What the exports say about the read they come from: when, from where, and what they leave out. */
function exportMeta(path: string, built: Readable<ErdBuild>, undrawn: number): ExportMeta {
  const value = built.state === 'loading' || built.state === 'failed' ? undefined : built
  return {
    target: path,
    observedAt: value?.observedAt ?? '',
    source: value?.source ?? 'unknown',
    undrawn,
    tablesRead: value?.value.data.tables.length ?? 0,
  }
}

const FIND_LIMIT = 100

type ExportStatus = 'idle' | 'exported' | 'copied' | 'failed'

/**
 * The tools above the diagram: find a table (the diagram then shows that
 * table with the tables it references and that reference it, which is how a
 * table is focused without moving a view), download the drawing as an SVG
 * file, or copy its tables, columns and relations as Markdown. The exports
 * hold what is drawn and say when it was read and what it leaves out; nothing
 * is fetched for them.
 */
function ErdTools(props: {
  readonly path: string
  readonly whole: SchemaErdData
  readonly shown: SchemaErdData
  readonly focus: string | null
  readonly onFocus: (id: string | null) => void
  readonly meta: ExportMeta
}): ReactNode {
  const labelId = useId()
  const valueId = useId()
  const [open, setOpen] = useState(false)
  const [term, setTerm] = useState('')
  const [status, setStatus] = useState<ExportStatus>('idle')
  const needle = term.trim().toLowerCase()
  const matches = useMemo(
    () =>
      props.whole.tables.filter(
        (table) => needle === '' || `${table.schema}.${table.name}`.toLowerCase().includes(needle),
      ),
    [props.whole.tables, needle],
  )
  const listed = matches.slice(0, FIND_LIMIT)
  const focusedTable = props.whole.tables.find((table) => table.id === props.focus)
  const near = focusedTable === undefined ? 0 : props.shown.tables.length - 1
  const tables = props.shown.tables.length

  const download = (): void => {
    saveFile(
      diagramSvg(props.shown, props.meta),
      exportFileName(props.path, 'svg'),
      'image/svg+xml',
    )
    setStatus('exported')
  }
  const copy = async (): Promise<void> => {
    setStatus(
      (await copyToClipboard(diagramMarkdown(props.shown, props.meta))) ? 'copied' : 'failed',
    )
  }

  return (
    <div className="flex flex-col gap-2" data-slot="erd-tools">
      <div
        role="toolbar"
        aria-label={t('schema.erd.tools')}
        className="flex flex-wrap items-end gap-2"
      >
        <div className="flex flex-col gap-1.5">
          <span id={labelId} className="text-sm font-medium">
            {t('schema.erd.find')}
          </span>
          <Popover
            open={open}
            onOpenChange={(next) => {
              setOpen(next)
              if (!next) setTerm('')
            }}
          >
            <PopoverTrigger asChild>
              <ComboboxTrigger
                className="w-72"
                aria-labelledby={`${labelId} ${valueId}`}
                aria-expanded={open}
              >
                <span id={valueId}>
                  {focusedTable === undefined ? (
                    t('schema.erd.find.search')
                  ) : (
                    <PlainName text={`${focusedTable.schema}.${focusedTable.name}`} mono max={40} />
                  )}
                </span>
              </ComboboxTrigger>
            </PopoverTrigger>
            <PopoverContent className="w-72 p-0" align="start">
              <Command label={t('schema.erd.find.search')} shouldFilter={false}>
                <CommandInput
                  value={term}
                  onValueChange={setTerm}
                  placeholder={t('schema.erd.find.search')}
                />
                <CommandList>
                  <CommandEmpty>{t('schema.erd.find.empty')}</CommandEmpty>
                  <CommandGroup>
                    {listed.map((table) => (
                      <CommandItem
                        key={table.id}
                        value={`table:${props.whole.tables.indexOf(table)}`}
                        onSelect={() => {
                          props.onFocus(table.id)
                          setOpen(false)
                          setTerm('')
                        }}
                      >
                        <PlainName text={`${table.schema}.${table.name}`} mono max={60} />
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
              {matches.length > listed.length ? (
                <p className="border-t border-default px-3 py-2 text-xs text-foreground-light">
                  {t('schema.erd.find.shown', { shown: listed.length, total: matches.length })}
                </p>
              ) : null}
            </PopoverContent>
          </Popover>
        </div>
        {props.focus === null ? null : (
          <Button type="button" size="tiny" variant="outline" onClick={() => props.onFocus(null)}>
            {t('schema.erd.focus.clear')}
          </Button>
        )}
        <Button type="button" size="tiny" variant="outline" onClick={download}>
          {t('schema.erd.exportSvg')}
        </Button>
        <Button type="button" size="tiny" variant="outline" onClick={() => void copy()}>
          {t('schema.erd.copyMarkdown')}
        </Button>
      </div>
      {focusedTable === undefined ? null : (
        <p className="text-sm" data-slot="erd-focus">
          {t('schema.erd.focus.prefix')}{' '}
          <PlainName text={`${focusedTable.schema}.${focusedTable.name}`} mono max={60} />
          {'. '}
          {t('schema.erd.focus.suffix', { count: near })}
        </p>
      )}
      <p role="status" className="min-h-4 text-xs text-foreground-light">
        {status === 'exported'
          ? t('schema.erd.exported', { tables })
          : status === 'copied'
            ? t('schema.erd.copiedMarkdown', { tables })
            : status === 'failed'
              ? t('schema.erd.copyFailed')
              : ''}
      </p>
      <p className="text-xs text-foreground-light">{t('schema.erd.exportNote')}</p>
    </div>
  )
}

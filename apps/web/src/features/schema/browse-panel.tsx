import type { QueryResult, SchemaObject } from '@exponetdb/sdk/operations'
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exponetdb/ui'
import { type CellValue, cellFromWire, type GridColumn } from '@exponetdb/ui-data'
import {
  Admonition,
  ErrorDisplay,
  FailedReadState,
  formatCount,
  LoadingState,
  NotPermittedState,
  type Readable,
  type ReadFailure,
  readableValue,
  TierChip,
  UntrustedName,
  UntrustedText,
  useLinkComponent,
  useResolvedNow,
} from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import {
  type Dispatch,
  lazy,
  type MutableRefObject,
  type ReactNode,
  type SetStateAction,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { ApiError } from '../../lib/api/errors.ts'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import { useMe } from '../../lib/session/guard.tsx'
import { targetHref } from '../../shell/navigation.ts'
import { actionError } from '../plans/failure.ts'
import { newUlid } from '../sql/sql-model.ts'
import type { TargetRoute } from '../target/params.ts'
import { nounPhrase } from '../target/phrases.ts'
import type { Target } from '../target/queries.ts'
import { useTargetScope } from '../target/scope.tsx'
import { policySettingsQuery } from '../target-ops/keys.ts'
import { type BrowseGate, browseGate, dataReadFor } from './browse-gate.ts'
import {
  type BrowseCursor,
  type BrowsePlan,
  type BrowseRefusal,
  type BrowseRequest,
  buildBrowse,
  editorSql,
  type IgnoredFilter,
  isTextType,
  MAX_LOADED_ROWS,
  nextCursor,
  PAGE_SIZE,
} from './browse-sql.ts'
import { sqlHref } from './links.ts'
import { PlainName } from './plain-name.tsx'
import { primaryKeyOf } from './schema-model.ts'
import {
  FILTER_OPS,
  FILTER_VALUE_MAX,
  type FilterOp,
  isNullOp,
  MAX_FILTERS,
  type PanelState,
  type UrlFilter,
} from './search.ts'

/**
 * The row browser: one page of rows of a table, view or materialized view,
 * read with the one read-only `SELECT` of `browse-sql.ts` through the
 * data-read endpoint, which admits it as a `data.read` (permission and tier,
 * the target's data-read setting, the parser), audits it, masks sensitive
 * columns and caps it. Nothing here decides what is safe, and nothing here
 * writes: there is no cell editing, no insert, no delete.
 *
 * Every page is an audited read, so every page is the person's press:
 * opening the tab or a link reads nothing (the panel opens idle, with the
 * statement it would send), "Read rows" reads the first page, and "Load more
 * rows" the next one. A sort or a filter that changes after a first read
 * reads the first page again, because the person pressed it to see the rows.
 * A refusal or a failure is shown as that, with the server's message and
 * code, never as an empty table; rows already read stay while a later page
 * fails.
 */
const DataGrid = lazy(async () => {
  const module = await import('@exponetdb/ui-data/grid/data-grid')
  return { default: module.DataGrid }
})

/** Rows read this long ago are shown as an earlier read, with a refresh. */
export const BROWSE_STALE_MS = 5 * 60_000
const HEADING = 5

interface Failure {
  readonly failure: ReadFailure
  /** The server answered "no" (a 4xx with its code), as opposed to a read that failed. */
  readonly refused: boolean
}

interface ResultColumn {
  readonly name: string
  readonly type: string
  readonly masked: boolean
}

interface Loaded {
  readonly plan: BrowsePlan
  readonly columns: readonly ResultColumn[]
  readonly rows: readonly (readonly CellValue[])[]
  /** When the first page was read: the age of the rows is measured from it. */
  readonly loadedAt: string
  readonly hasMore: boolean
  readonly cursor: BrowseCursor
  readonly fellBack: boolean
  /** Why the server cut the last page short, in words, when it did. */
  readonly truncated: string | undefined
  readonly rlsRelations: readonly string[]
  readonly durationMs: number
  readonly lastPage: number
}

type More =
  | { readonly kind: 'idle' }
  | { readonly kind: 'reading' }
  | { readonly kind: 'failed'; readonly failure: Failure }

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'reading' }
  | { readonly kind: 'failed'; readonly failure: Failure }
  | { readonly kind: 'loaded'; readonly data: Loaded; readonly more: More }

function failureOf(error: unknown): Failure {
  const shown = actionError(error)
  const kind = classifyFailure(error).kind
  const refused =
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    kind !== 'session' &&
    kind !== 'rate_limited' &&
    kind !== 'not_found'
  return { failure: { code: shown.code, message: shown.message }, refused }
}

function refusalFailure(reason: BrowseRefusal): Failure {
  return {
    failure: { code: 'BROWSE_NOT_BUILT', message: t(`schema.browse.refusal.${reason}`) },
    refused: false,
  }
}

function requestOf(object: SchemaObject, state: PanelState, cursor?: BrowseCursor): BrowseRequest {
  return {
    schema: object.ref.schema,
    name: object.ref.name,
    columns: (object.columns ?? []).map((column) => ({ name: column.name, type: column.type })),
    primaryKey: primaryKeyOf(object),
    sort:
      state.sort === undefined ? undefined : { column: state.sort, direction: state.dir ?? 'asc' },
    filters: state.filter.map(([column, op, value]) => ({ column, op, value })),
    cursor,
  }
}

// ----- the session -----

/**
 * What the row browser has read, kept above the object's read state. A read of
 * the object that turns old is shown under a banner, which is another place in
 * the tree: whatever sat below it is built again. The rows already read, the
 * press that started them and the read in flight must survive that, so they
 * live in the component that owns the object's read (`ObjectDetail`) and the
 * browser below only uses them.
 */
export interface BrowseSession {
  readonly phase: Phase
  readonly setPhase: Dispatch<SetStateAction<Phase>>
  /** The person pressed "Read rows" at least once. */
  readonly started: MutableRefObject<boolean>
  /** Counts the first-page reads; an answer of an older one is dropped. */
  readonly generation: MutableRefObject<number>
  /** A page is being read. */
  readonly inFlight: MutableRefObject<boolean>
  /** The sort and filters the rows (or the idle statement) are for; unset until the panel first shows. */
  readonly signature: MutableRefObject<string | undefined>
}

export function useBrowseSession(): BrowseSession {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const started = useRef(false)
  const generation = useRef(0)
  const inFlight = useRef(false)
  const signature = useRef<string | undefined>(undefined)
  return { phase, setPhase, started, generation, inFlight, signature }
}

// ----- the gate -----

function useBrowseGate(target: Target): {
  readonly gate: BrowseGate
  /** The data-read setting could not be read; the server decides. */
  readonly settingUnread: ReadFailure | undefined
} {
  const me = useMe()
  const { client } = useApi()
  const canReadPolicy = me.effectivePermissions.some((entry) => entry.permission === 'access.read')
  // The setting is read once, not polled: it only decides whether to offer the panel.
  const policy = useQuery({
    ...policySettingsQuery(client),
    enabled: canReadPolicy,
    refetchInterval: false,
  })
  const model = policy.data === undefined ? undefined : dataReadFor(policy.data, target)
  const gate = browseGate({ permissions: me.effectivePermissions, target, policy: model })
  const failure =
    canReadPolicy && policy.isError && policy.data === undefined
      ? classifyFailure(policy.error)
      : undefined
  return {
    gate,
    settingUnread:
      failure === undefined ? undefined : { code: failure.code, message: failure.message },
  }
}

/**
 * The row browser of an object, behind its gate: a person without `data.read`
 * for the target and a target whose data reads are off each get a named state
 * that says so (and not that the object has no rows).
 */
export function BrowsePanel(props: {
  readonly route: TargetRoute
  readonly object: SchemaObject
  readonly session: BrowseSession
  readonly state: PanelState
  readonly onState: (next: PanelState, options?: { readonly replace?: boolean }) => void
}): ReactNode {
  const scope = useTargetScope()
  const target = readableValue(scope.read)
  if (target === undefined) return null
  return <GatedBrowse {...props} target={target} />
}

function GatedBrowse(props: {
  readonly route: TargetRoute
  readonly target: Target
  readonly object: SchemaObject
  readonly session: BrowseSession
  readonly state: PanelState
  readonly onState: (next: PanelState, options?: { readonly replace?: boolean }) => void
}): ReactNode {
  const Link = useLinkComponent()
  const { gate, settingUnread } = useBrowseGate(props.target)
  switch (gate.kind) {
    case 'not_permitted':
      return (
        <NotPermittedState
          what={nounPhrase('schema.browse.gate.what')}
          permission={gate.permission}
          scope={gate.scope}
          headingLevel={HEADING}
        />
      )
    case 'reads_off':
      return (
        <Admonition
          type="warning"
          title={t('schema.browse.off.title')}
          description={
            <span data-state="reads-off">
              {t('schema.browse.off.body')}{' '}
              <Link
                href={`${targetHref(props.route, '/configuration')}#data-read`}
                className="underline"
              >
                {t('schema.browse.off.link')}
              </Link>
            </span>
          }
        />
      )
    case 'open':
      return (
        <div className="flex flex-col gap-3" data-slot="browse" data-tier={props.target.tier}>
          {props.target.tier === 'prod' ? (
            <p className="flex flex-wrap items-center gap-2 text-sm" data-production-cue="true">
              <TierChip tier="prod" />
              <span>{t('schema.browse.production')}</span>
            </p>
          ) : null}
          {settingUnread === undefined ? null : (
            <p role="note" className="text-xs text-foreground-light" data-slot="policy-unread">
              {t('schema.browse.policyUnread', {
                reason: `${settingUnread.message} (${settingUnread.code})`,
              })}
            </p>
          )}
          <BrowseBody
            route={props.route}
            object={props.object}
            session={props.session}
            state={props.state}
            onState={props.onState}
          />
        </div>
      )
  }
}

// ----- the body -----

const OP_LABEL: Readonly<Record<FilterOp, MessageKey>> = {
  '=': 'schema.op.eq',
  '<>': 'schema.op.ne',
  '<': 'schema.op.lt',
  '<=': 'schema.op.le',
  '>': 'schema.op.gt',
  '>=': 'schema.op.ge',
  'IS NULL': 'schema.op.isNull',
  'IS NOT NULL': 'schema.op.isNotNull',
  ILIKE: 'schema.op.ilike',
}

function BrowseBody(props: {
  readonly route: TargetRoute
  readonly object: SchemaObject
  readonly session: BrowseSession
  readonly state: PanelState
  readonly onState: (next: PanelState, options?: { readonly replace?: boolean }) => void
}): ReactNode {
  const { route, object, state, onState } = props
  const { client } = useApi()
  const Link = useLinkComponent()
  const { phase, setPhase, started, generation, inFlight, signature: lastSignature } = props.session

  const columns = object.columns ?? []
  const preview = useMemo(() => buildBrowse(requestOf(object, state)), [object, state])
  const editor = useMemo(() => editorSql(requestOf(object, state)), [object, state])
  const editorLink = editor === undefined ? undefined : sqlHref(route, editor)

  const readPage = useCallback(
    async (cursor: BrowseCursor | undefined, previous: Loaded | undefined): Promise<void> => {
      if (inFlight.current) return
      const built = buildBrowse(requestOf(object, state, cursor))
      const mine = generation.current
      if (!built.ok) {
        const failure = refusalFailure(built.reason)
        if (previous === undefined) setPhase({ kind: 'failed', failure })
        else setPhase({ kind: 'loaded', data: previous, more: { kind: 'failed', failure } })
        return
      }
      const { plan } = built
      inFlight.current = true
      if (previous === undefined) setPhase({ kind: 'reading' })
      else setPhase({ kind: 'loaded', data: previous, more: { kind: 'reading' } })
      try {
        const result = await client.operation('runQuery', {
          params: { target: route.path },
          body: { sql: plan.sql, params: [...plan.params], queryId: `qry_${newUlid()}` },
        })
        // A sort, a filter or another object arrived while this was read: the answer is not for the page any more.
        if (generation.current !== mine) return
        const page = result.rows.slice(0, PAGE_SIZE)
        const shown = page.map((row) =>
          row.map((value, index) => cellFromWire(result.columns[index]?.type ?? 'text', value)),
        )
        const rows = [...(previous?.rows ?? []), ...shown]
        const next = nextCursor(plan, result.columns, page, rows.length)
        setPhase({
          kind: 'loaded',
          more: { kind: 'idle' },
          data: {
            plan: previous?.plan ?? plan,
            columns: result.columns,
            rows,
            loadedAt: previous?.loadedAt ?? new Date().toISOString(),
            hasMore: result.rows.length > PAGE_SIZE || result.truncated,
            cursor: next.cursor,
            fellBack: previous?.fellBack === true || next.fellBack,
            truncated: result.truncated ? truncationText(result.truncation) : undefined,
            rlsRelations: result.rlsRelations,
            durationMs: result.durationMs,
            lastPage: page.length,
          },
        })
      } catch (error) {
        if (generation.current !== mine) return
        const failure = failureOf(error)
        if (previous === undefined) setPhase({ kind: 'failed', failure })
        else setPhase({ kind: 'loaded', data: previous, more: { kind: 'failed', failure } })
      } finally {
        // Only the read that is current gives the slot back; a stale answer must not free it.
        if (generation.current === mine) inFlight.current = false
      }
    },
    [client, object, route.path, state, setPhase, generation, inFlight],
  )

  const readFirst = useCallback((): void => {
    started.current = true
    generation.current += 1
    inFlight.current = false
    void readPage(undefined, undefined)
  }, [readPage, started, generation, inFlight])

  const loadMore = (): void => {
    if (phase.kind !== 'loaded' || phase.more.kind === 'reading') return
    void readPage(phase.data.cursor, phase.data)
  }

  // A sort or filter that changes after rows were read reads the first page again;
  // before the first press it only changes the statement the panel shows.
  const signature = JSON.stringify([state.sort, state.dir, state.filter])
  const readFirstRef = useRef(readFirst)
  readFirstRef.current = readFirst
  useEffect(() => {
    if (lastSignature.current === signature) return
    const first = lastSignature.current === undefined
    lastSignature.current = signature
    if (first) return
    if (started.current) readFirstRef.current()
    else setPhase({ kind: 'idle' })
  }, [signature, setPhase, started, lastSignature])

  const reading = phase.kind === 'reading'
  const loaded = phase.kind === 'loaded' ? phase.data : undefined
  const ignored = preview.ok ? preview.plan.ignoredFilters : []

  if (columns.length === 0) {
    return (
      <p role="note" className="text-sm" data-state="no-columns">
        {t('schema.browse.noColumns')}
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-foreground-light">{t('schema.browse.intro')}</p>
      <FilterEditor object={object} state={state} onState={onState} ignored={ignored} />
      <SortChip state={state} columns={columns.map((column) => column.name)} onState={onState} />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="primary"
          size="tiny"
          disabled={reading || !preview.ok}
          onClick={readFirst}
        >
          {loaded === undefined ? t('schema.browse.read') : t('schema.browse.readAgain')}
        </Button>
        {editorLink === undefined ? null : (
          <Link href={editorLink} className="text-sm underline">
            {t('schema.browse.openSql')}
          </Link>
        )}
      </div>
      <p className="text-xs text-foreground-light">{t('schema.browse.openSqlNote')}</p>
      {preview.ok ? (
        <details className="rounded-md border border-default p-3" data-slot="statement">
          <summary className="cursor-pointer text-sm">{t('schema.browse.statement')}</summary>
          <div className="flex flex-col gap-2 pt-2">
            <UntrustedText
              text={preview.plan.sql}
              mono
              maxCodePoints={4000}
              maxLines={20}
              label={t('schema.browse.statement')}
              className="text-xs"
            />
            <p className="text-xs text-foreground-light">{t('schema.browse.statementNote')}</p>
          </div>
        </details>
      ) : (
        <p role="alert" className="text-sm" data-state="not-built">
          {t(`schema.browse.refusal.${preview.reason}`)}
        </p>
      )}
      {preview.ok && preview.plan.sortIgnored ? (
        <p role="note" className="text-xs text-foreground-light" data-slot="sort-ignored">
          {t('schema.browse.sort.ignored')}
        </p>
      ) : null}
      <section aria-label={t('schema.browse.title')} className="flex min-w-0 flex-col gap-3">
        {phase.kind === 'idle' ? null : (
          <Results
            phase={phase}
            state={state}
            onState={onState}
            onRefresh={readFirst}
            onMore={loadMore}
          />
        )}
      </section>
    </div>
  )
}

// ----- sort and filters -----

function SortChip(props: {
  readonly state: PanelState
  readonly columns: readonly string[]
  readonly onState: (next: PanelState, options?: { readonly replace?: boolean }) => void
}): ReactNode {
  const { state } = props
  if (state.sort === undefined || !props.columns.includes(state.sort)) return null
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm" data-slot="sort">
      <span>{t('schema.browse.sort.by')}</span>
      <UntrustedName name={state.sort} mono maxCodePoints={48} label={t('schema.browse.sort.by')} />
      <span>
        {state.dir === 'desc'
          ? nounPhrase('schema.browse.sort.desc')
          : nounPhrase('schema.browse.sort.asc')}
      </span>
      <Button
        type="button"
        size="tiny"
        variant="outline"
        onClick={() =>
          props.onState({ ...state, sort: undefined, dir: undefined }, { replace: true })
        }
      >
        {t('schema.browse.sort.clear')}
      </Button>
    </p>
  )
}

function FilterEditor(props: {
  readonly object: SchemaObject
  readonly state: PanelState
  readonly onState: (next: PanelState, options?: { readonly replace?: boolean }) => void
  readonly ignored: readonly IgnoredFilter[]
}): ReactNode {
  const { object, state, onState } = props
  const base = useId()
  const columns = object.columns ?? []
  const [column, setColumn] = useState('')
  const [op, setOp] = useState<FilterOp>('=')
  const [value, setValue] = useState('')
  const chosen = column === '' ? undefined : columns[Number(column)]
  const operators = FILTER_OPS.filter(
    (candidate) => candidate !== 'ILIKE' || isTextType(chosen?.type ?? ''),
  )
  const full = state.filter.length >= MAX_FILTERS
  const needsValue = !isNullOp(op)
  const ready = chosen !== undefined && !full && (!needsValue || value.length > 0)

  const add = (event: { preventDefault(): void }): void => {
    event.preventDefault()
    if (chosen === undefined || !ready) return
    const entry: UrlFilter = [chosen.name, op, needsValue ? value : '']
    onState({ ...state, filter: [...state.filter, entry] }, { replace: true })
    setValue('')
  }
  const remove = (index: number): void =>
    onState({ ...state, filter: state.filter.filter((_, i) => i !== index) }, { replace: true })

  return (
    <fieldset
      className="flex flex-col gap-2 rounded-md border border-default p-3"
      data-slot="filters"
    >
      <legend className="px-1 text-sm font-medium">{t('schema.browse.filter.title')}</legend>
      <form className="flex flex-wrap items-end gap-2" onSubmit={add}>
        <div className="flex min-w-40 flex-col gap-1.5">
          <Label htmlFor={`${base}-column`}>{t('schema.browse.filter.column')}</Label>
          <Select
            value={column}
            onValueChange={(next) => {
              setColumn(next)
              const type = columns[Number(next)]?.type ?? ''
              if (op === 'ILIKE' && !isTextType(type)) setOp('=')
            }}
          >
            <SelectTrigger id={`${base}-column`} className="w-48">
              <SelectValue placeholder={t('schema.browse.filter.choose')} />
            </SelectTrigger>
            <SelectContent>
              {columns.map((entry, index) => (
                <SelectItem key={entry.name} value={String(index)}>
                  <PlainName text={entry.name} mono max={48} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex min-w-40 flex-col gap-1.5">
          <Label htmlFor={`${base}-op`}>{t('schema.browse.filter.operator')}</Label>
          <Select
            value={op}
            onValueChange={(next) => setOp(operators.find((o) => o === next) ?? '=')}
          >
            <SelectTrigger id={`${base}-op`} className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {operators.map((candidate) => (
                <SelectItem key={candidate} value={candidate}>
                  {t(OP_LABEL[candidate])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {needsValue ? (
          <div className="flex min-w-40 flex-1 flex-col gap-1.5">
            <Label htmlFor={`${base}-value`}>{t('schema.browse.filter.value')}</Label>
            <Input
              id={`${base}-value`}
              value={value}
              maxLength={FILTER_VALUE_MAX}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setValue(event.target.value)}
            />
          </div>
        ) : null}
        <Button type="submit" variant="default" size="tiny" disabled={!ready}>
          {t('schema.browse.filter.add')}
        </Button>
      </form>
      {op === 'ILIKE' ? (
        <p className="text-xs text-foreground-light">{t('schema.browse.filter.ilikeHint')}</p>
      ) : null}
      {full ? (
        <p className="text-xs text-foreground-light">
          {t('schema.browse.filter.max', { max: MAX_FILTERS })}
        </p>
      ) : null}
      {state.filter.length === 0 ? (
        <p className="text-xs text-foreground-light">{t('schema.browse.filter.none')}</p>
      ) : (
        <ul
          aria-label={t('schema.browse.filter.list')}
          className="m-0 flex list-none flex-col gap-1 p-0"
        >
          {state.filter.map(([name, operator, filterValue], index) => {
            const dropped = props.ignored.find(
              (entry) =>
                entry.filter.column === name &&
                entry.filter.op === operator &&
                entry.filter.value === filterValue,
            )
            return (
              <li
                // The same filter can stand twice in a link; the position tells them apart.
                // biome-ignore lint/suspicious/noArrayIndexKey: filters have no identity of their own
                key={index}
                className="flex flex-wrap items-center gap-2 text-sm"
                data-ignored={dropped === undefined ? undefined : 'true'}
              >
                <UntrustedName
                  name={name}
                  mono
                  maxCodePoints={48}
                  label={t('schema.browse.filter.column')}
                />
                <span>{nounPhrase(OP_LABEL[operator])}</span>
                {isNullOp(operator) ? null : (
                  <UntrustedName
                    name={filterValue}
                    mono
                    maxCodePoints={80}
                    label={t('schema.browse.filter.value')}
                  />
                )}
                {dropped === undefined ? null : (
                  <span className="text-xs text-foreground-light">
                    {t('schema.browse.filter.ignoredTag')}
                    <span className="sr-only">
                      {': '}
                      {t(`schema.browse.filter.ignored.${dropped.reason}` as MessageKey)}
                    </span>
                  </span>
                )}
                <Button type="button" size="tiny" variant="outline" onClick={() => remove(index)}>
                  {t('schema.browse.filter.remove')}
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </fieldset>
  )
}

// ----- the result -----

function truncationText(truncation: QueryResult['truncation']): string {
  if (truncation === null) return t('schema.browse.truncation.unknown')
  return truncation.reason === 'rows'
    ? t('schema.browse.truncation.rows', { cap: formatCount(truncation.cap) })
    : t('schema.browse.truncation.bytes', { cap: formatCount(truncation.cap) })
}

function Results(props: {
  readonly phase: Exclude<Phase, { kind: 'idle' }>
  readonly state: PanelState
  readonly onState: (next: PanelState, options?: { readonly replace?: boolean }) => void
  readonly onRefresh: () => void
  readonly onMore: () => void
}): ReactNode {
  const { phase } = props
  switch (phase.kind) {
    case 'reading':
      return <LoadingState what={nounPhrase('schema.browse.what')} lines={4} />
    case 'failed':
      return <FailureView failure={phase.failure} onRetry={props.onRefresh} />
    case 'loaded':
      return (
        <LoadedRows
          data={phase.data}
          more={phase.more}
          state={props.state}
          onState={props.onState}
          onRefresh={props.onRefresh}
          onMore={props.onMore}
        />
      )
  }
}

function FailureView(props: {
  readonly failure: Failure
  readonly onRetry: () => void
}): ReactNode {
  const { failure } = props
  if (!failure.refused) {
    return (
      <FailedReadState
        what={nounPhrase('schema.browse.what')}
        error={failure.failure}
        onRetry={props.onRetry}
        headingLevel={HEADING}
      />
    )
  }
  return (
    <ErrorDisplay
      data-state="refused"
      title={t('schema.browse.refused.title')}
      message={failure.failure.message}
      code={failure.failure.code}
      headingLevel={HEADING}
    >
      <p className="px-4 py-3 text-sm text-foreground-light">{t('schema.browse.refused.body')}</p>
    </ErrorDisplay>
  )
}

function LoadedRows(props: {
  readonly data: Loaded
  readonly more: More
  readonly state: PanelState
  readonly onState: (next: PanelState, options?: { readonly replace?: boolean }) => void
  readonly onRefresh: () => void
  readonly onMore: () => void
}): ReactNode {
  const { data, more, state, onState } = props
  const now = useResolvedNow()
  const gridColumns = useMemo<GridColumn[]>(
    () =>
      data.columns.map((column) => ({
        name: column.name,
        type: column.type,
        masked: column.masked,
      })),
    [data.columns],
  )
  const loadedCount = data.rows.length
  const capped = loadedCount >= MAX_LOADED_ROWS
  const canLoadMore = data.hasMore && !capped
  const age = now - Date.parse(data.loadedAt)
  const stale = Number.isFinite(age) && age > BROWSE_STALE_MS
  const rows: Readable<readonly (readonly CellValue[])[]> = stale
    ? { state: 'stale', value: data.rows, source: 'live', observedAt: data.loadedAt }
    : data.hasMore
      ? {
          state: 'partial',
          value: data.rows,
          source: 'live',
          observedAt: data.loadedAt,
          missing: [t('schema.browse.partialMissing', { count: formatCount(loadedCount) })],
        }
      : { state: 'ready', value: data.rows, source: 'live', observedAt: data.loadedAt }
  const masked = data.columns.filter((column) => column.masked).length
  const sortIndex = data.columns.findIndex((column) => column.name === state.sort)
  const ordered = data.plan.order

  return (
    <div className="flex min-w-0 flex-col gap-3" data-slot="rows" data-rows={loadedCount}>
      <p className="text-sm" data-result-meta="true">
        {t('schema.browse.meta', {
          rows: formatCount(data.lastPage),
          ms: formatCount(data.durationMs),
          total: formatCount(loadedCount),
        })}
      </p>
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs text-foreground-light">
        <li data-note="order">{t(`schema.browse.order.${ordered}`)}</li>
        {data.hasMore ? (
          <li data-note="paging">
            {data.fellBack
              ? t('schema.browse.paging.fellBack')
              : data.cursor.kind === 'keyset'
                ? t('schema.browse.paging.keyset')
                : t('schema.browse.paging.offset')}
          </li>
        ) : null}
      </ul>
      {masked === 0 ? null : (
        <p className="text-sm text-foreground-light" data-note="masked">
          {t('schema.browse.masked', { count: masked })}
        </p>
      )}
      {data.rlsRelations.length === 0 ? null : (
        <div className="flex flex-col gap-1 text-sm text-foreground-light" data-note="rls">
          <p>{t('schema.browse.rls', { count: data.rlsRelations.length })}</p>
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
            {data.rlsRelations.slice(0, 20).map((relation) => (
              <li key={relation}>
                <UntrustedName name={relation} maxCodePoints={80} label="relation" />
              </li>
            ))}
          </ul>
        </div>
      )}
      <Suspense fallback={<LoadingState what={nounPhrase('schema.browse.what')} lines={4} />}>
        <DataGrid
          label={t('schema.browse.gridLabel')}
          columns={gridColumns}
          rows={rows}
          {...(data.truncated === undefined ? {} : { truncated: { reason: data.truncated } })}
          page={{
            hasMore: canLoadMore,
            loading: more.kind === 'reading',
            onLoadMore: props.onMore,
          }}
          sort={{
            column: sortIndex < 0 ? null : sortIndex,
            direction: state.dir ?? 'asc',
            onSortChange: (next) =>
              onState(
                next === null
                  ? { ...state, sort: undefined, dir: undefined }
                  : {
                      ...state,
                      sort: data.columns[next.column]?.name,
                      dir: next.direction,
                    },
                { replace: true },
              ),
          }}
          fileName="table-rows"
          what={nounPhrase('schema.browse.what')}
          onRefresh={props.onRefresh}
          busy={more.kind === 'reading'}
          maxHeight={480}
        />
      </Suspense>
      {capped && data.hasMore ? (
        <p role="note" className="text-sm font-medium" data-note="limit">
          {t('schema.browse.limit', { max: formatCount(MAX_LOADED_ROWS) })}
        </p>
      ) : null}
      {more.kind === 'failed' ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 text-sm"
          data-state="more-failed"
        >
          <p>
            {t('schema.browse.loadMoreFailed', {
              message: more.failure.failure.message,
              code: more.failure.failure.code,
            })}
          </p>
          <Button type="button" size="tiny" variant="outline" onClick={props.onMore}>
            {t('schema.browse.retryMore')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

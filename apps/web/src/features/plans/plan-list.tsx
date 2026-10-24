import type { OperationRead, PlanRead } from '@exponetdb/sdk/operations'
import {
  Button,
  cn,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import {
  EmptyState,
  ObservedTime,
  PageContainer,
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
  ReadableView,
  TierChip,
  UntrustedName,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import {
  type InfiniteData,
  type UseInfiniteQueryResult,
  useInfiniteQuery,
} from '@tanstack/react-query'
import { type ReactNode, useId, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { TOOLBAR_CONTROL, ToolbarField } from '../../lib/ui/toolbar.tsx'
import { operationPath } from '../changes/model.ts'
import { awaitingPlansQuery, planListQuery } from './keys.ts'
import {
  isPlanKind,
  isPlanListFiltered,
  PLAN_KIND_MAX_LENGTH,
  PLAN_STATES,
  type PlanListSearch,
} from './list-model.ts'
import { planPath } from './plan-model.ts'

const STATE_TEXT: Readonly<Record<string, MessageKey>> = {
  active: 'plans.state.active',
  consumed: 'plans.state.consumed',
  expired: 'plans.state.expired',
  invalidated: 'plans.state.invalidated',
  denied: 'plans.state.denied',
  withdrawn: 'plans.state.withdrawn',
}

interface Page<T> {
  readonly items: readonly T[]
  readonly nextCursor: string | null
}

/** The pages read so far as one list; the last page's cursor says whether more exist. */
function flatten<T>(data: InfiniteData<Page<T>> | undefined): Page<T> | undefined {
  if (data === undefined) return undefined
  return {
    items: data.pages.flatMap((page) => page.items),
    nextCursor: data.pages.at(-1)?.nextCursor ?? null,
  }
}

/**
 * The plans the person may read (`/changes/plans`), newest first: filters
 * by state, kind, creator and target kept in the address (validated by the
 * route), the quick filters "My plans" and "Awaiting approval", and cursor
 * paging with "Load more". A list longer than the pages read says so (a
 * partial read), never presents itself as the whole list; a failed read is
 * an error, never an empty list. "Awaiting approval" lists the plans of the
 * operations that wait for an approval (a plan has no such state).
 */
export function PlanListPage(props: {
  readonly search: PlanListSearch
  readonly onSearch: (next: PlanListSearch) => void
}): ReactNode {
  const { search, onSearch } = props
  return (
    <>
      <PageHeader size="large">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{t('plans.list.title')}</PageHeaderTitle>
            <PageHeaderDescription>{t('plans.list.description')}</PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="large" className="flex flex-col gap-4 py-6">
        <QuickFilters search={search} onSearch={onSearch} />
        <Toolbar search={search} onSearch={onSearch} />
        {search.awaiting === 'approval' ? (
          <AwaitingList search={search} onSearch={onSearch} />
        ) : (
          <PlanList search={search} onSearch={onSearch} />
        )}
      </PageContainer>
    </>
  )
}

function QuickFilters({
  search,
  onSearch,
}: {
  readonly search: PlanListSearch
  readonly onSearch: (next: PlanListSearch) => void
}): ReactNode {
  const mine = search.actor === 'self'
  const awaiting = search.awaiting === 'approval'
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons, not a form field set
    <div role="group" aria-label={t('plans.list.quick')} className="flex flex-wrap gap-2">
      <Button
        type="button"
        size="small"
        variant={isPlanListFiltered(search) ? 'outline' : 'default'}
        aria-pressed={!isPlanListFiltered(search)}
        onClick={() => onSearch({})}
      >
        {t('plans.list.quick.all')}
      </Button>
      <Button
        type="button"
        size="small"
        variant={mine ? 'default' : 'outline'}
        aria-pressed={mine}
        onClick={() => onSearch({ ...search, actor: mine ? undefined : 'self' })}
      >
        {t('plans.list.quick.mine')}
      </Button>
      <Button
        type="button"
        size="small"
        variant={awaiting ? 'default' : 'outline'}
        aria-pressed={awaiting}
        onClick={() =>
          onSearch({ ...search, state: undefined, awaiting: awaiting ? undefined : 'approval' })
        }
      >
        {t('plans.list.quick.awaiting')}
      </Button>
    </div>
  )
}

function Toolbar({
  search,
  onSearch,
}: {
  readonly search: PlanListSearch
  readonly onSearch: (next: PlanListSearch) => void
}): ReactNode {
  const ids = useId()
  const [kind, setKind] = useState(search.kind ?? '')
  const kindInvalid = kind !== '' && !isPlanKind(kind)
  const change = (next: Partial<PlanListSearch>) => onSearch({ ...search, ...next })
  const awaiting = search.awaiting === 'approval'
  return (
    <search className="flex flex-wrap items-start gap-2">
      <div className="flex flex-col gap-1">
        <ToolbarField id={`${ids}-state`} label={t('plans.filter.state')}>
          <select
            id={`${ids}-state`}
            className={TOOLBAR_CONTROL}
            value={search.state ?? ''}
            disabled={awaiting}
            aria-describedby={awaiting ? `${ids}-state-hint` : undefined}
            onChange={(event) =>
              change({ state: PLAN_STATES.find((state) => state === event.target.value) })
            }
          >
            <option value="">{t('plans.filter.state.all')}</option>
            {PLAN_STATES.map((state) => {
              const key = STATE_TEXT[state]
              return (
                <option key={state} value={state}>
                  {key === undefined ? state : t(key)}
                </option>
              )
            })}
          </select>
        </ToolbarField>
        {awaiting ? (
          <span id={`${ids}-state-hint`} className="text-xs text-foreground-light">
            {t('plans.filter.state.awaiting')}
          </span>
        ) : null}
      </div>
      <form
        className="flex flex-col gap-1"
        onSubmit={(event) => {
          event.preventDefault()
          if (kindInvalid) return
          change({ kind: kind === '' ? undefined : kind })
        }}
      >
        <div className="flex items-center gap-1">
          <ToolbarField id={`${ids}-kind`} label={t('plans.filter.kind')}>
            <input
              id={`${ids}-kind`}
              className={cn(TOOLBAR_CONTROL, 'w-40 font-mono')}
              value={kind}
              maxLength={PLAN_KIND_MAX_LENGTH}
              placeholder="migration.apply"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={kindInvalid}
              aria-describedby={kindInvalid ? `${ids}-kind-error` : undefined}
              onChange={(event) => setKind(event.target.value)}
            />
          </ToolbarField>
          <Button type="submit" size="tiny" variant="outline" disabled={kindInvalid}>
            {t('plans.filter.kind.apply')}
          </Button>
        </div>
        {kindInvalid ? (
          <span id={`${ids}-kind-error`} className="text-xs text-destructive">
            {t('plans.filter.kind.invalid')}
          </span>
        ) : null}
      </form>
      <div className="flex flex-col gap-1">
        <ToolbarField id={`${ids}-actor`} label={t('plans.filter.actor')}>
          <select
            id={`${ids}-actor`}
            className={TOOLBAR_CONTROL}
            value={search.actor ?? 'any'}
            onChange={(event) =>
              change({ actor: event.target.value === 'self' ? 'self' : undefined })
            }
          >
            <option value="any">{t('plans.filter.actor.any')}</option>
            <option value="self">{t('plans.filter.actor.self')}</option>
          </select>
        </ToolbarField>
      </div>
      {search.target === undefined ? null : (
        <p className="m-0 flex flex-wrap items-center gap-2 text-sm" data-filter-target>
          <span>{t('plans.filter.target')}</span>
          <span className="font-mono text-xs">{search.target}</span>
          <Button
            type="button"
            size="tiny"
            variant="outline"
            onClick={() => change({ target: undefined })}
          >
            {t('plans.filter.target.clear')}
          </Button>
        </p>
      )}
      {isPlanListFiltered(search) ? (
        <Button
          type="button"
          size="small"
          variant="outline"
          onClick={() => {
            setKind('')
            onSearch({})
          }}
        >
          {t('plans.filter.clear')}
        </Button>
      ) : null}
    </search>
  )
}

/** One row of the list: a plan, or the plan of an operation that waits for an approval. */
interface Row {
  /** `null` for an operation that names no plan. */
  readonly planId: string | null
  readonly kind: string
  readonly planClass: string | null
  readonly targetPath: string | null
  readonly tier: 'prod' | 'nonprod' | null
  readonly state: ReactNode
  readonly createdAt: string
  /** The row's identity: the plan id, or the id of the operation the row stands for. */
  readonly key: string
}

function planRow(plan: PlanRead): Row {
  const key = Object.hasOwn(STATE_TEXT, plan.state) ? STATE_TEXT[plan.state] : undefined
  return {
    key: plan.id,
    planId: plan.id,
    kind: plan.kind,
    planClass: plan.class,
    targetPath: plan.subject.targetPath,
    tier: plan.subject.tier,
    state:
      key === undefined ? (
        <UntrustedName name={plan.state} mono label={t('plans.list.column.state')} />
      ) : (
        <span data-plan-state={plan.state}>{t(key)}</span>
      ),
    createdAt: plan.createdAt,
  }
}

function AwaitingState({ operation }: { readonly operation: OperationRead }): ReactNode {
  const Link = useLinkComponent()
  const href = operationPath(operation.id)
  return (
    <span className="flex flex-col gap-0.5" data-plan-state="awaiting_approval">
      <span>{t('plans.list.awaiting.state')}</span>
      {href === undefined ? null : (
        <Link href={href} className="text-xs text-primary underline focus-ring">
          {t('plans.list.awaiting.operation')}
        </Link>
      )}
    </span>
  )
}

function ListView<T>({
  query,
  rowOf,
  search,
  onSearch,
  what,
  caption,
}: {
  readonly query: UseInfiniteQueryResult<InfiniteData<Page<T>>>
  readonly rowOf: (item: T) => Row
  readonly search: PlanListSearch
  readonly onSearch: (next: PlanListSearch) => void
  readonly what: string
  readonly caption: string
}): ReactNode {
  const list = flatten(query.data)
  const filtered = isPlanListFiltered(search)
  const readable = toReadable(
    { data: list, error: query.error, isError: query.isError, dataUpdatedAt: query.dataUpdatedAt },
    { missing: (value) => (value.nextCursor === null ? undefined : [t('plans.list.more')]) },
  )
  return (
    <ReadableView
      readable={readable}
      what={what}
      onRetry={() => void query.refetch()}
      onRefresh={() => void query.refetch()}
      busy={query.isFetching}
      headingLevel={2}
      empty={{
        isEmpty: (value) => value.items.length === 0,
        ...(filtered
          ? {
              content: (
                <EmptyState
                  title={t('plans.list.noMatch.title')}
                  description={t('plans.list.noMatch.body')}
                  headingLevel={2}
                >
                  <Button type="button" size="small" variant="outline" onClick={() => onSearch({})}>
                    {t('plans.filter.clear')}
                  </Button>
                </EmptyState>
              ),
            }
          : {}),
      }}
      ready={(value) => (
        <div className="flex flex-col gap-3">
          <PlanTable rows={value.items.map(rowOf)} caption={caption} />
          {value.nextCursor === null ? (
            <p className="m-0 text-xs text-foreground-light">
              {t('plans.list.all', { count: value.items.length })}
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                size="small"
                variant="default"
                loading={query.isFetchingNextPage}
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {t('plans.list.loadMore')}
              </Button>
              <span className="text-xs text-foreground-light">
                {t('plans.list.shown', { count: value.items.length })}
              </span>
            </div>
          )}
          {query.isFetchNextPageError ? (
            <p role="alert" className="m-0 text-sm text-destructive">
              {t('plans.list.moreFailed')}
            </p>
          ) : null}
        </div>
      )}
    />
  )
}

function PlanList({
  search,
  onSearch,
}: {
  readonly search: PlanListSearch
  readonly onSearch: (next: PlanListSearch) => void
}): ReactNode {
  const { client } = useApi()
  const query = useInfiniteQuery(planListQuery(client, search))
  return (
    <ListView
      query={query}
      rowOf={planRow}
      search={search}
      onSearch={onSearch}
      what={t('plans.list.what')}
      caption={t('plans.list.caption')}
    />
  )
}

function AwaitingList({
  search,
  onSearch,
}: {
  readonly search: PlanListSearch
  readonly onSearch: (next: PlanListSearch) => void
}): ReactNode {
  const { client } = useApi()
  const query = useInfiniteQuery(awaitingPlansQuery(client, search))
  return (
    <div className="flex flex-col gap-2" data-plan-view="awaiting">
      <p className="m-0 text-sm text-foreground-light">{t('plans.list.awaiting.description')}</p>
      <ListView
        query={query}
        rowOf={(operation: OperationRead) => ({
          key: operation.id,
          planId: operation.planId,
          kind: operation.kind,
          planClass: null,
          targetPath: operation.subject.targetPath,
          tier: operation.subject.tier,
          state: <AwaitingState operation={operation} />,
          createdAt: operation.createdAt,
        })}
        search={search}
        onSearch={onSearch}
        what={t('plans.list.awaiting.what')}
        caption={t('plans.list.awaiting.caption')}
      />
    </div>
  )
}

function PlanTable({
  rows,
  caption,
}: {
  readonly rows: readonly Row[]
  readonly caption: string
}): ReactNode {
  const Link = useLinkComponent()
  return (
    <Table>
      <TableCaption className="sr-only">{caption}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t('plans.list.column.plan')}</TableHead>
          <TableHead scope="col">{t('plans.list.column.change')}</TableHead>
          <TableHead scope="col">{t('plans.list.column.target')}</TableHead>
          <TableHead scope="col">{t('plans.list.column.state')}</TableHead>
          <TableHead scope="col">{t('plans.list.column.created')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const href = planPath(row.planId)
          return (
            <TableRow key={row.key} data-plan={row.planId ?? undefined}>
              <TableCell className="font-mono text-xs">
                {row.planId === null ? (
                  <span className="font-sans">{t('plans.list.noPlan')}</span>
                ) : href === undefined ? (
                  <UntrustedName name={row.planId} mono label={t('plans.list.column.plan')} />
                ) : (
                  <Link href={href} className="text-primary underline focus-ring">
                    {row.planId}
                  </Link>
                )}
              </TableCell>
              <TableCell>
                <UntrustedName name={row.kind} mono label={t('plans.list.column.change')} />
                {row.planClass === null ? null : (
                  <>
                    {' '}
                    <span className="text-xs text-foreground-light">
                      {t('approvals.item.class', { class: row.planClass })}
                    </span>
                  </>
                )}
              </TableCell>
              <TableCell>
                <span className="inline-flex flex-wrap items-center gap-2">
                  {row.targetPath === null ? (
                    t('approvals.item.noTarget')
                  ) : (
                    <UntrustedName
                      name={row.targetPath}
                      mono
                      label={t('plans.list.column.target')}
                    />
                  )}
                  {row.tier === null ? null : <TierChip tier={row.tier} />}
                </span>
              </TableCell>
              <TableCell>{row.state}</TableCell>
              <TableCell>
                <ObservedTime observedAt={row.createdAt} withDate />
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

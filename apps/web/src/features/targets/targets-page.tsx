import { ChevronDown, Plus, Search } from '@exponetdb/icons'
import type { TargetSummary } from '@exponetdb/sdk/operations'
import {
  Button,
  Card,
  CardContent,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  inputVariants,
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
  PageContainer,
  PageHeader,
  PageHeaderAside,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
  ReadableView,
  TierChip,
  UntrustedName,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import { type ChangeEvent, type ReactNode, useId, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { readTargetsPreferences, writeTargetsPreferences } from '../../lib/preferences/targets.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { HEALTH_STATES, HealthCell } from '../fleet/health.tsx'
import { copyText } from './copy.tsx'
import {
  productsQuery,
  projectsQuery,
  TARGET_MAX_PAGES,
  TARGET_PAGE_LIMIT,
  targetListQuery,
} from './keys.ts'
import {
  type Defaults,
  defaultsOf,
  filterTargets,
  type HealthFilter,
  isFiltered,
  SEARCH_MAX_LENGTH,
  SORTS,
  type Sort,
  STATE_FILTERS,
  type StateFilter,
  shownSort,
  shownView,
  sortTargets,
  type TargetsSearch,
  TIERS,
  type TierFilter,
  targetHrefOf,
  targetPathParts,
  withSearch,
} from './model.ts'
import { phrase } from './phrase.ts'

export const REGISTER_PATH = '/targets/register'

const SELECT = (extra?: string): string => cn(inputVariants({ size: 'small' }), 'w-auto', extra)

/**
 * All targets (`/targets`, labelled "Databases"): search, filters and sort
 * kept in the URL (the parent validates them), a table and a grid. The
 * product and project filters are sent to the server, which lists only those
 * targets; the other filters apply to the targets read. The sort and the view
 * a person chose are remembered by this browser and apply when the address
 * says nothing (the address always wins). The list read follows the cursor to
 * a bound and says so when more exist. The health of a row is the one the list
 * carries with its source and age; the page makes no request per row. A failed
 * read is an error, never an empty list; "no result" is said only about a
 * list that was read.
 */
export function TargetsPage(props: {
  readonly search: TargetsSearch
  readonly onSearch: (next: TargetsSearch) => void
}): ReactNode {
  const { client } = useApi()
  const { search, onSearch } = props
  const list = useQuery(
    targetListQuery(client, { product: search.product, project: search.project }),
  )
  const Link = useLinkComponent()
  const serverFiltered = search.product !== undefined || search.project !== undefined
  // What this browser remembered when the page opened, and after each choice.
  const [defaults, setDefaults] = useState<Defaults>(() => defaultsOf(readTargetsPreferences()))
  // A choice of sort or view is remembered; the address then names it only when it differs
  // from what the browser now holds (read back, so a refused write is still named).
  const change = (next: Partial<TargetsSearch>): void => {
    let kept = defaults
    if ('sort' in next || 'view' in next) {
      kept = defaultsOf(
        writeTargetsPreferences({
          ...('sort' in next ? { sort: next.sort } : {}),
          ...('view' in next ? { view: next.view } : {}),
        }),
      )
      setDefaults(kept)
    }
    onSearch(withSearch(search, next, kept))
  }
  const sort = shownSort(search, defaults)
  const view = shownView(search, defaults)
  return (
    <>
      <PageHeader size="large">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{t('targets.title')}</PageHeaderTitle>
            <PageHeaderDescription>{t('targets.description')}</PageHeaderDescription>
          </PageHeaderSummary>
          <PageHeaderAside>
            <Button asChild size="small" variant="default" icon={<Plus aria-hidden="true" />}>
              <Link href={REGISTER_PATH}>{t('targets.register.action')}</Link>
            </Button>
          </PageHeaderAside>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="large" className="flex flex-col gap-4 py-6">
        <InfrastructureEntries />
        {/* The toolbar stays while the list is read again (a new product filter reads again), so
            the control that was just used keeps keyboard focus. */}
        <Toolbar search={search} sort={sort} view={view} change={change} />
        <ReadableView
          readable={toReadable(list, {
            missing: (value) =>
              value.more
                ? [t('targets.more', { count: TARGET_PAGE_LIMIT * TARGET_MAX_PAGES })]
                : undefined,
          })}
          what={t('targets.read.what')}
          onRetry={() => void list.refetch()}
          onRefresh={() => void list.refetch()}
          busy={list.isFetching}
          headingLevel={2}
          empty={{
            // A list the server filtered by product or project is "no match", not "nothing registered".
            isEmpty: (value) => value.items.length === 0 && !serverFiltered,
            content: (
              <EmptyState
                title={t('targets.empty.title')}
                description={t('targets.empty.body')}
                headingLevel={2}
              >
                <Button asChild size="small" variant="default">
                  <Link href={REGISTER_PATH}>{t('targets.register.action')}</Link>
                </Button>
              </EmptyState>
            ),
          }}
          ready={(value) => (
            <TargetsView
              targets={value.items}
              search={search}
              sort={sort}
              view={view}
              change={change}
              serverFiltered={serverFiltered}
            />
          )}
        />
      </PageContainer>
    </>
  )
}

/**
 * The entry points for servers, clusters and node enrollment: their forms are
 * on the infrastructure pages (a plan each), so this page links to them.
 */
function InfrastructureEntries(): ReactNode {
  const Link = useLinkComponent()
  return (
    <nav aria-label={t('targets.entry.title')} className="text-sm">
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <li>
          <Link href="/infrastructure/servers" className="underline focus-ring">
            {t('targets.entry.server')}
          </Link>
        </li>
        <li>
          <Link href="/infrastructure/clusters" className="underline focus-ring">
            {t('targets.entry.cluster')}
          </Link>
        </li>
        <li>
          <Link href="/infrastructure/nodes" className="underline focus-ring">
            {t('targets.entry.node')}
          </Link>
        </li>
      </ul>
    </nav>
  )
}

const STATE_LABEL: Readonly<Record<StateFilter, MessageKey>> = {
  all: 'targets.filter.state.all',
  registered: 'targets.filter.state.registered',
  active: 'targets.filter.state.active',
  suspended: 'targets.filter.state.suspended',
  decommissioned: 'targets.filter.state.decommissioned',
}

const SORT_LABEL: Readonly<Record<Sort, MessageKey>> = {
  path: 'targets.sort.path',
  tier: 'targets.sort.tier',
  health: 'targets.sort.health',
}

const HEALTH_LABEL: Readonly<Record<string, MessageKey>> = {
  healthy: 'health.healthy',
  degraded: 'health.degraded',
  unhealthy: 'health.unhealthy',
  unreachable: 'health.unreachable',
  unknown: 'health.unknown',
  suspended: 'health.suspended',
  none: 'targets.filter.health.none',
}

function TargetsView(props: {
  readonly targets: readonly TargetSummary[]
  readonly search: TargetsSearch
  readonly sort: Sort
  readonly view: 'table' | 'grid'
  readonly change: (next: Partial<TargetsSearch>) => void
  readonly serverFiltered: boolean
}): ReactNode {
  const { search, change, view } = props
  const shown = sortTargets(filterTargets(props.targets, search), props.sort)
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-foreground-light">{t('targets.healthNote')}</p>
      <p role="status" className="text-sm text-foreground-light">
        {t('targets.count', { shown: shown.length, total: props.targets.length })}
      </p>
      {shown.length === 0 ? (
        <EmptyState
          title={t('targets.noResults.title')}
          description={
            props.targets.length === 0 && props.serverFiltered
              ? t('targets.noResults.filtered')
              : t('targets.noResults.body', { total: props.targets.length })
          }
          headingLevel={2}
        >
          {isFiltered(search) ? (
            <Button
              type="button"
              size="small"
              variant="outline"
              onClick={() =>
                change({
                  product: undefined,
                  project: undefined,
                  q: undefined,
                  tier: undefined,
                  state: undefined,
                  health: undefined,
                })
              }
            >
              {t('targets.filter.clear')}
            </Button>
          ) : null}
        </EmptyState>
      ) : view === 'grid' ? (
        <TargetGrid targets={shown} />
      ) : (
        <TargetTable targets={shown} />
      )}
    </div>
  )
}

function Toolbar(props: {
  readonly search: TargetsSearch
  readonly sort: Sort
  readonly view: 'table' | 'grid'
  readonly change: (next: Partial<TargetsSearch>) => void
}): ReactNode {
  const { search, change } = props
  const ids = useId()
  return (
    <search className="flex flex-wrap items-end gap-3">
      <div className="flex min-w-60 flex-1 flex-col gap-1">
        <label htmlFor={`${ids}-q`} className="text-xs text-foreground-light">
          {t('targets.search.label')}
        </label>
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-foreground-light"
          />
          <Input
            id={`${ids}-q`}
            type="search"
            className="pl-8"
            value={search.q ?? ''}
            maxLength={SEARCH_MAX_LENGTH}
            placeholder={t('targets.search.placeholder')}
            autoComplete="off"
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              change({ q: event.target.value === '' ? undefined : event.target.value })
            }
          />
        </div>
      </div>
      <RegistryFilters search={search} change={change} />
      <Field id={`${ids}-tier`} label={t('targets.filter.tier')}>
        <select
          id={`${ids}-tier`}
          className={SELECT()}
          value={search.tier ?? ''}
          onChange={(event) =>
            change({
              tier: TIERS.find((tier) => tier === event.target.value) as TierFilter | undefined,
            })
          }
        >
          <option value="">{t('targets.filter.tier.all')}</option>
          <option value="prod">{t('targets.filter.tier.prod')}</option>
          <option value="nonprod">{t('targets.filter.tier.nonprod')}</option>
        </select>
      </Field>
      <Field id={`${ids}-state`} label={t('targets.filter.state')}>
        <select
          id={`${ids}-state`}
          className={SELECT()}
          value={search.state ?? ''}
          onChange={(event) =>
            change({ state: STATE_FILTERS.find((state) => state === event.target.value) })
          }
        >
          <option value="">{t('targets.filter.state.live')}</option>
          {STATE_FILTERS.map((state) => (
            <option key={state} value={state}>
              {t(STATE_LABEL[state])}
            </option>
          ))}
        </select>
      </Field>
      <Field id={`${ids}-health`} label={t('targets.filter.health')}>
        <select
          id={`${ids}-health`}
          className={SELECT()}
          value={search.health ?? ''}
          onChange={(event) => {
            const value = [...HEALTH_STATES, 'none' as const].find((h) => h === event.target.value)
            change({ health: value as HealthFilter | undefined })
          }}
        >
          <option value="">{t('targets.filter.health.all')}</option>
          {[...HEALTH_STATES, 'none' as const].map((health) => (
            <option key={health} value={health}>
              {t(HEALTH_LABEL[health] ?? 'health.unknown')}
            </option>
          ))}
        </select>
      </Field>
      <Field id={`${ids}-sort`} label={t('targets.sort.label')}>
        <select
          id={`${ids}-sort`}
          className={SELECT()}
          value={props.sort}
          onChange={(event) => {
            const sort = SORTS.find((candidate) => candidate === event.target.value)
            if (sort !== undefined) change({ sort })
          }}
        >
          {SORTS.map((sort) => (
            <option key={sort} value={sort}>
              {t(SORT_LABEL[sort])}
            </option>
          ))}
        </select>
      </Field>
      <fieldset className="m-0 flex min-w-0 gap-1 border-0 p-0">
        <legend className="sr-only">{t('targets.view.label')}</legend>
        {(['table', 'grid'] as const).map((view) => (
          <Button
            key={view}
            type="button"
            size="small"
            variant={props.view === view ? 'default' : 'outline'}
            aria-pressed={props.view === view}
            onClick={() => change({ view })}
          >
            {t(view === 'table' ? 'targets.view.table' : 'targets.view.grid')}
          </Button>
        ))}
      </fieldset>
    </search>
  )
}

/**
 * The product and project filters: the choices come from the registry reads,
 * each read shown for what it is (loading, failed with its code and a retry,
 * an earlier read, a list cut off, nothing registered after a successful read).
 * A product or project the address names that the read does not list is still
 * shown, marked as not in the list, so the filter never lies about the address.
 */
function RegistryFilters(props: {
  readonly search: TargetsSearch
  readonly change: (next: Partial<TargetsSearch>) => void
}): ReactNode {
  const { client } = useApi()
  const { search, change } = props
  const ids = useId()
  const products = useQuery(productsQuery(client))
  const projects = useQuery(projectsQuery(client))
  const productRead = toReadable(products, {
    missing: (value) =>
      value.more
        ? [t('targets.filter.more', { what: phrase('targets.filter.product.plural') })]
        : undefined,
  })
  const projectRead = toReadable(projects, {
    missing: (value) =>
      value.more
        ? [t('targets.filter.more', { what: phrase('targets.filter.project.plural') })]
        : undefined,
  })
  const productOptions =
    productRead.state === 'loading' || productRead.state === 'failed'
      ? []
      : productRead.value.items.map((product) => product.slug)
  // A project belongs to the product its path starts with (`product/project`).
  const projectOptions =
    search.product === undefined ||
    projectRead.state === 'loading' ||
    projectRead.state === 'failed'
      ? []
      : projectRead.value.items.flatMap((project) => {
          const [product, slug] = project.path.split('/')
          return product === search.product && slug !== undefined ? [slug] : []
        })
  return (
    <>
      <RegistryFilter
        id={`${ids}-product`}
        label={t('targets.filter.product')}
        allLabel={t('targets.filter.product.all')}
        what="products"
        value={search.product}
        options={productOptions}
        readable={productRead}
        busy={products.isFetching}
        onRetry={() => void products.refetch()}
        onChange={(product) => change({ product })}
      />
      <RegistryFilter
        id={`${ids}-project`}
        label={t('targets.filter.project')}
        allLabel={
          search.product === undefined
            ? t('targets.filter.project.choose')
            : t('targets.filter.project.all')
        }
        what="projects"
        value={search.project}
        options={projectOptions}
        readable={projectRead}
        busy={projects.isFetching}
        disabled={search.product === undefined}
        onRetry={() => void projects.refetch()}
        onChange={(project) => change({ project })}
      />
    </>
  )
}

function RegistryFilter(props: {
  readonly id: string
  readonly label: string
  readonly allLabel: string
  readonly what: 'products' | 'projects'
  readonly value: string | undefined
  readonly options: readonly string[]
  readonly readable: ReturnType<typeof toReadable>
  readonly busy: boolean
  readonly disabled?: boolean
  readonly onRetry: () => void
  readonly onChange: (value: string | undefined) => void
}): ReactNode {
  const { readable } = props
  const noun = phrase(
    props.what === 'products' ? 'targets.filter.product.plural' : 'targets.filter.project.plural',
  )
  const unread = readable.state === 'loading' || readable.state === 'failed'
  const listed = props.value !== undefined && props.options.includes(props.value)
  const noteId = `${props.id}-note`
  let note: ReactNode = null
  if (readable.state === 'loading') {
    note = <span>{t('targets.filter.loading', { what: noun })}</span>
  } else if (readable.state === 'failed') {
    note = (
      <span className="flex flex-wrap items-center gap-1">
        {t('targets.filter.failed', {
          what: noun,
          reason: `${readable.error.message} (${readable.error.code})`,
        })}
        <Button
          type="button"
          variant="text"
          size="tiny"
          loading={props.busy}
          onClick={props.onRetry}
        >
          {t('state.retry')}
        </Button>
      </span>
    )
  } else if (readable.state === 'stale') {
    note = (
      <span className="flex flex-wrap items-center gap-1">
        {t('targets.filter.stale', { what: noun })}
        <Button
          type="button"
          variant="text"
          size="tiny"
          loading={props.busy}
          onClick={props.onRetry}
        >
          {t('state.refresh')}
        </Button>
      </span>
    )
  } else if (readable.state === 'partial') {
    note = <span>{readable.missing.join(' ')}</span>
  } else if (props.options.length === 0 && props.disabled !== true) {
    note = (
      <span>
        {t(
          props.what === 'products'
            ? 'targets.filter.none.products'
            : 'targets.filter.none.projects',
        )}
      </span>
    )
  }
  return (
    <div className="flex flex-col gap-1" data-filter={props.what}>
      <label htmlFor={props.id} className="text-xs text-foreground-light">
        {props.label}
      </label>
      <select
        id={props.id}
        className={SELECT()}
        value={props.value ?? ''}
        disabled={props.disabled === true || readable.state === 'loading'}
        aria-describedby={note === null ? undefined : noteId}
        onChange={(event) =>
          props.onChange(event.target.value === '' ? undefined : event.target.value)
        }
      >
        <option value="">{props.allLabel}</option>
        {props.value !== undefined && !listed ? (
          <option value={props.value}>
            {unread ? props.value : t('targets.filter.notListed', { slug: props.value })}
          </option>
        ) : null}
        {props.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      {note === null ? null : (
        <p id={noteId} className="m-0 max-w-60 text-xs text-foreground-light">
          {note}
        </p>
      )}
    </div>
  )
}

function Field(props: {
  readonly id: string
  readonly label: string
  readonly children: ReactNode
}): ReactNode {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={props.id} className="text-xs text-foreground-light">
        {props.label}
      </label>
      {props.children}
    </div>
  )
}

/** `product / project / environment`, each segment as marked text; a path that is not three slugs whole. */
function PathName({ path }: { readonly path: string }): ReactNode {
  const parts = targetPathParts(path)
  if (parts === undefined) {
    return <UntrustedName name={path} mono label={t('targets.column.path')} />
  }
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1">
      <UntrustedName name={parts.product} mono label="product" />
      <span aria-hidden="true">/</span>
      <UntrustedName name={parts.project} mono label="project" />
      <span aria-hidden="true">/</span>
      <UntrustedName name={parts.environment} mono label="environment" />
    </span>
  )
}

function PathLink({ target }: { readonly target: TargetSummary }): ReactNode {
  const Link = useLinkComponent()
  const href = targetHrefOf(target.path)
  if (href === undefined) {
    return (
      <span className="flex flex-col gap-0.5">
        <PathName path={target.path} />
        <span className="text-xs text-foreground-light">{t('targets.badPath')}</span>
      </span>
    )
  }
  return (
    <Link
      href={href}
      className="underline focus-ring"
      aria-label={t('targets.open', { target: target.path })}
    >
      <PathName path={target.path} />
    </Link>
  )
}

/** The per-row menu: copy the path or the id of the target (the text is copied as it is, shown nowhere new). */
function RowActions({ target }: { readonly target: TargetSummary }): ReactNode {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="text"
          size="tiny"
          iconRight={<ChevronDown aria-hidden="true" className="size-3" />}
          aria-label={t('targets.actions.label', { target: target.path })}
        >
          {t('targets.actions')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => void copyText(t('configuration.copy.path'), target.path)}>
          {t('targets.actions.copyPath')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void copyText(t('configuration.copy.id'), target.id)}>
          {t('targets.actions.copyId')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const STATE_TEXT: Readonly<Record<string, MessageKey>> = {
  registered: 'targets.state.registered',
  active: 'targets.state.active',
  suspended: 'targets.state.suspended',
  decommissioned: 'targets.state.decommissioned',
}

function stateText(state: string): string {
  const key = STATE_TEXT[state]
  return key === undefined ? state : t(key)
}

function TargetTable({ targets }: { readonly targets: readonly TargetSummary[] }): ReactNode {
  return (
    <Table>
      <TableCaption className="sr-only">{t('targets.caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t('targets.column.path')}</TableHead>
          <TableHead scope="col">{t('targets.column.tier')}</TableHead>
          <TableHead scope="col">{t('targets.column.state')}</TableHead>
          <TableHead scope="col">{t('targets.column.health')}</TableHead>
          <TableHead scope="col">
            <span className="sr-only">{t('targets.actions')}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {targets.map((target) => (
          <TableRow key={target.id} data-target={target.id} data-tier={target.tier}>
            <TableCell>
              <PathLink target={target} />
            </TableCell>
            <TableCell>
              <TierChip tier={target.tier} />
            </TableCell>
            <TableCell>{stateText(target.state)}</TableCell>
            <TableCell>
              <HealthCell health={target.health} />
            </TableCell>
            <TableCell>
              <RowActions target={target} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function TargetGrid({ targets }: { readonly targets: readonly TargetSummary[] }): ReactNode {
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {targets.map((target) => (
        <li key={target.id} data-target={target.id} data-tier={target.tier}>
          <Card className="h-full">
            <CardContent className="flex h-full flex-col items-start gap-2 p-card">
              <PathLink target={target} />
              <div className="flex flex-wrap items-center gap-2">
                <TierChip tier={target.tier} />
                <span className="text-xs text-foreground-light">{stateText(target.state)}</span>
              </div>
              <HealthCell health={target.health} />
              <RowActions target={target} />
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  )
}

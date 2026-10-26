import { LayoutGrid, List, Search, Settings2 } from '@exponetdb/icons'
import {
  Button,
  cn,
  Input,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import {
  Admonition,
  formatCount,
  LinkCard,
  type LinkCardTone,
  PageContainer,
  PageHeader,
  PageHeaderAside,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
  Pager,
  pageSlice,
  ReadableView,
  TierChip,
  UntrustedName,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import { type ChangeEvent, type ReactNode, useId } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { describeError, t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { pagerText } from '../../lib/ui/pager-text.ts'
import { TOOLBAR_CONTROL, ToolbarField } from '../../lib/ui/toolbar.tsx'
import { projectHref } from '../../shell/navigation.ts'
import { HealthChip } from '../fleet/health.tsx'
import {
  productsQuery,
  projectsQuery,
  TARGET_MAX_PAGES,
  TARGET_PAGE_LIMIT,
  targetListQuery,
} from '../targets/keys.ts'
import { healthOf } from '../targets/model.ts'
import {
  filterProjects,
  PROJECT_PAGE_SIZE,
  PROJECT_SEARCH_MAX_LENGTH,
  type ProjectRow,
  type ProjectsSearch,
  type ProjectView,
  productChoices,
  projectRows,
} from './model.ts'

/** Projects a card names environments of before "+N more". */
const CARD_ENVIRONMENTS = 5

/**
 * `/projects`: the portfolio. Every project the person may see, as cards or a table, searchable
 * by name and path and filterable by product, with the URL holding the search, the product, the
 * view and the page. Three bounded reads stand behind it, the same the Databases page and the
 * registry forms make (projects, products, targets), so nothing is read per project. A project is
 * not a cluster: its card shows its environments (each one database) with their tier and health,
 * never a capacity. The pages divide what was read; the page says so.
 */
export function ProjectsPage({
  search,
  onSearch,
}: {
  readonly search: ProjectsSearch
  readonly onSearch: (next: ProjectsSearch) => void
}): ReactNode {
  const { client } = useApi()
  const Link = useLinkComponent()
  const projects = useQuery(projectsQuery(client))
  const products = useQuery(productsQuery(client))
  const targets = useQuery(targetListQuery(client))
  const view: ProjectView = search.view ?? 'grid'
  const change = (next: Partial<ProjectsSearch>) => {
    // Any change but the page itself starts at the first page; an unset value leaves the URL.
    const merged = { ...search, ...(next.page === undefined ? { page: undefined } : {}), ...next }
    onSearch(
      Object.fromEntries(
        Object.entries(merged).filter(([, value]) => value !== undefined),
      ) as ProjectsSearch,
    )
  }
  return (
    <>
      <PageHeader size="large">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{t('projects.title')}</PageHeaderTitle>
            <PageHeaderDescription>{t('projects.description')}</PageHeaderDescription>
          </PageHeaderSummary>
          <PageHeaderAside>
            <Button
              asChild
              size="small"
              variant="default"
              icon={<Settings2 aria-hidden="true" strokeWidth={1.5} />}
            >
              <Link href="/settings/projects">{t('projects.manage')}</Link>
            </Button>
          </PageHeaderAside>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="large" className="flex flex-col gap-4 py-6">
        <ReadableView
          readable={toReadable(projects, {
            missing: (value) =>
              value.more ? [t('projects.more', { count: formatCount(1000) })] : undefined,
          })}
          what={t('projects.what')}
          onRetry={() => void projects.refetch()}
          onRefresh={() => void projects.refetch()}
          busy={projects.isFetching}
          headingLevel={2}
          empty={{
            isEmpty: (value) => value.items.length === 0,
            content: <p className="m-0 text-sm text-foreground-light">{t('projects.empty')}</p>,
          }}
          ready={(value) => {
            const rows = projectRows(
              value.items,
              products.data?.items,
              targets.data?.items,
              targets.data?.more === true,
            )
            return (
              <Portfolio
                rows={rows}
                search={search}
                view={view}
                change={change}
                targetsFailed={targets.isError && targets.data === undefined ? targets.error : null}
                targetsMore={targets.data?.more === true}
              />
            )
          }}
        />
      </PageContainer>
    </>
  )
}

function Portfolio(props: {
  readonly rows: readonly ProjectRow[]
  readonly search: ProjectsSearch
  readonly view: ProjectView
  readonly change: (next: Partial<ProjectsSearch>) => void
  readonly targetsFailed: unknown
  readonly targetsMore: boolean
}): ReactNode {
  const { rows, search, view, change } = props
  const shown = filterProjects(rows, search)
  const size = PROJECT_PAGE_SIZE[view]
  const page = pageSlice(shown, search.page ?? 1, size)
  return (
    <div className="flex flex-col gap-4">
      <Toolbar rows={rows} search={search} view={view} change={change} />
      {props.targetsFailed === null ? null : (
        <Admonition
          type="warning"
          title={t('projects.targets.failed', { reason: describeError(props.targetsFailed) })}
        />
      )}
      {props.targetsMore ? (
        <p className="m-0 text-xs text-foreground-light" role="status">
          {t('projects.targets.more', {
            count: formatCount(TARGET_PAGE_LIMIT * TARGET_MAX_PAGES),
          })}
        </p>
      ) : null}
      {shown.length === 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed p-6">
          <p className="m-0 text-sm text-foreground-light">{t('projects.empty.filtered')}</p>
          <Button
            type="button"
            size="tiny"
            variant="default"
            onClick={() => change({ q: undefined, product: undefined })}
          >
            {t('projects.reset')}
          </Button>
        </div>
      ) : view === 'grid' ? (
        <ProjectGrid rows={page.items} />
      ) : (
        <ProjectTable rows={page.items} />
      )}
      {shown.length > size ? (
        <Pager
          label={t('projects.pager.label')}
          page={page.page}
          pageSize={size}
          total={shown.length}
          onPage={(next) => change({ page: next })}
          text={pagerText()}
          note={t('pager.note.client', { total: formatCount(shown.length) })}
        />
      ) : null}
    </div>
  )
}

function Toolbar(props: {
  readonly rows: readonly ProjectRow[]
  readonly search: ProjectsSearch
  readonly view: ProjectView
  readonly change: (next: Partial<ProjectsSearch>) => void
}): ReactNode {
  const { search, change } = props
  const ids = useId()
  const choices = productChoices(props.rows)
  return (
    <search className="flex flex-wrap items-start gap-2">
      <div className="relative w-full sm:w-64">
        <label htmlFor={`${ids}-q`} className="sr-only">
          {t('projects.search.label')}
        </label>
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-foreground-lighter"
        />
        <Input
          id={`${ids}-q`}
          type="search"
          size="tiny"
          className="pl-7"
          value={search.q ?? ''}
          maxLength={PROJECT_SEARCH_MAX_LENGTH}
          placeholder={t('projects.search.placeholder')}
          autoComplete="off"
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            change({ q: event.target.value === '' ? undefined : event.target.value })
          }
        />
      </div>
      <ToolbarField id={`${ids}-product`} label={t('projects.filter.product')}>
        <select
          id={`${ids}-product`}
          className={TOOLBAR_CONTROL}
          value={search.product ?? ''}
          onChange={(event) =>
            change({
              product: choices.find((choice) => choice.slug === event.target.value)?.slug,
            })
          }
        >
          <option value="">{t('projects.filter.product.all')}</option>
          {choices.map((choice) => (
            <option key={choice.slug} value={choice.slug}>
              {choice.name === null ? choice.slug : `${choice.name} (${choice.slug})`}
            </option>
          ))}
        </select>
      </ToolbarField>
      <fieldset className="m-0 ml-auto flex min-w-0 border-0 p-0">
        <legend className="sr-only">{t('projects.view.label')}</legend>
        {(['grid', 'table'] as const).map((view) => {
          const Icon = view === 'table' ? List : LayoutGrid
          const label = t(view === 'table' ? 'projects.view.table' : 'projects.view.grid')
          return (
            <Button
              key={view}
              type="button"
              size="tiny"
              variant={props.view === view ? 'default' : 'outline'}
              aria-pressed={props.view === view}
              aria-label={label}
              onClick={() => change({ view })}
              className={cn(
                'px-1.5',
                view === 'grid' ? 'rounded-r-none' : '-ml-px rounded-l-none',
                props.view === view ? 'bg-background-selection' : 'text-foreground-lighter',
              )}
              icon={<Icon aria-hidden="true" strokeWidth={1.5} />}
            />
          )
        })}
      </fieldset>
    </search>
  )
}

function toneOf(row: ProjectRow): LinkCardTone {
  if (row.worst === 'unhealthy' || row.worst === 'unreachable') return 'critical'
  return row.attention > 0 ? 'warning' : 'neutral'
}

function attentionText(row: ProjectRow): string {
  if (row.environmentsRead === 'unread') return t('projects.card.notRead')
  const cut = row.environmentsRead === 'partial'
  if (row.environments.length === 0) {
    return cut ? t('projects.card.noEnvironmentRead') : t('projects.card.noEnvironment')
  }
  if (row.attention === 0)
    return cut ? t('projects.card.allClearRead') : t('projects.card.allClear')
  const count = formatCount(row.attention)
  if (cut) {
    return row.attention === 1
      ? t('projects.card.attentionAtLeastOne')
      : t('projects.card.attentionAtLeast', { count })
  }
  return row.attention === 1
    ? t('projects.card.attentionOne')
    : t('projects.card.attention', { count })
}

/** Nothing when the environments were not read (the attention line says so). */
function environmentCount(row: ProjectRow): string | null {
  if (row.environmentsRead === 'unread') return null
  const count = formatCount(row.environments.length)
  if (row.environmentsRead === 'partial') {
    return row.environments.length === 1
      ? t('projects.card.environmentAtLeast')
      : t('projects.card.environmentsAtLeast', { count })
  }
  return row.environments.length === 1
    ? t('projects.card.environment')
    : t('projects.card.environments', { count })
}

function ProjectGrid({ rows }: { readonly rows: readonly ProjectRow[] }): ReactNode {
  return (
    <ul
      aria-label={t('projects.list.label')}
      className="m-0 grid list-none grid-cols-1 gap-3 p-0 md:grid-cols-2 2xl:grid-cols-3"
    >
      {rows.map((row) => (
        <li key={row.project.id} className="min-w-0" data-project={row.project.path}>
          <LinkCard
            href={projectHref(row.productSlug, row.projectSlug)}
            tone={toneOf(row)}
            className="h-full gap-3 p-4"
          >
            <span className="flex min-w-0 flex-col gap-0.5 pr-6">
              <span className="eyebrow truncate text-xs text-foreground-lighter">
                {row.productName === null ? (
                  row.productSlug
                ) : (
                  <UntrustedName name={row.productName} expandable={false} maxCodePoints={48} />
                )}
              </span>
              <UntrustedName
                name={row.project.displayName}
                expandable={false}
                maxCodePoints={64}
                className="text-base font-medium"
                label={t('projects.column.project')}
              />
              <span className="font-mono text-xs text-foreground-light">{row.project.path}</span>
            </span>
            <EnvironmentChips row={row} />
            <span className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs text-foreground-light">
              <span>{environmentCount(row)}</span>
              <span className={cn(row.attention > 0 && 'text-foreground')}>
                {attentionText(row)}
              </span>
            </span>
          </LinkCard>
        </li>
      ))}
    </ul>
  )
}

/** The environments of a card as small chips: slug, the production mark and the health glyph. */
function EnvironmentChips({ row }: { readonly row: ProjectRow }): ReactNode {
  if (row.environments.length === 0) return null
  const first = row.environments.slice(0, CARD_ENVIRONMENTS)
  const rest = row.environments.length - first.length
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {first.map((environment) => (
        <span
          key={environment.target.id}
          data-environment={environment.slug}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md border bg-surface-200 py-0.5 pr-1 pl-2 text-xs',
            environment.target.state === 'decommissioned' && 'border-dashed bg-transparent',
          )}
        >
          <span className="font-mono">{environment.slug}</span>
          {environment.target.state === 'decommissioned' ? (
            <span className="text-foreground-light">{t('target.lifecycle.decommissioned')}</span>
          ) : null}
          {environment.target.tier === 'nonprod' ? null : (
            <TierChip tier={environment.target.tier} />
          )}
          <HealthChip
            state={healthOf(environment.target) === 'none' ? null : healthOf(environment.target)}
            className="px-1 py-0"
          />
        </span>
      ))}
      {rest > 0 ? (
        <span className="text-xs text-foreground-lighter">
          {t('projects.card.moreEnvironments', { count: formatCount(rest) })}
        </span>
      ) : null}
    </span>
  )
}

function ProjectTable({ rows }: { readonly rows: readonly ProjectRow[] }): ReactNode {
  const Link = useLinkComponent()
  return (
    <Table>
      <TableCaption className="sr-only">{t('projects.caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t('projects.column.project')}</TableHead>
          <TableHead scope="col">{t('projects.column.product')}</TableHead>
          <TableHead scope="col">{t('projects.column.environments')}</TableHead>
          <TableHead scope="col">{t('projects.column.attention')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.project.id} data-project={row.project.path}>
            <TableCell>
              <Link
                href={projectHref(row.productSlug, row.projectSlug)}
                className="flex flex-col rounded-sm focus-ring hover:underline"
              >
                <UntrustedName
                  name={row.project.displayName}
                  expandable={false}
                  maxCodePoints={64}
                  className="font-medium"
                />
                <span className="font-mono text-xs text-foreground-light">{row.project.path}</span>
              </Link>
            </TableCell>
            <TableCell className="text-sm">
              {row.productName === null ? (
                <span className="font-mono">{row.productSlug}</span>
              ) : (
                <UntrustedName name={row.productName} />
              )}
            </TableCell>
            <TableCell>
              <EnvironmentChips row={row} />
              {row.environments.length === 0 ? (
                <span className="text-xs text-foreground-lighter">{attentionText(row)}</span>
              ) : null}
            </TableCell>
            <TableCell className="text-sm">{attentionText(row)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

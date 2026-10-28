import type { FleetFinding } from '@exponetdb/sdk/operations'
import {
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
  PageContainer,
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
  UntrustedName,
  useLinkComponent,
  useNavigate,
} from '@exponetdb/ui-patterns'
import { useInfiniteQuery } from '@tanstack/react-query'
import { type ChangeEvent, type ReactNode, useId } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { targetHref } from '../../shell/navigation.ts'
import { splitTargetPath } from '../target/params.ts'
import { nounPhrase } from '../target/phrases.ts'
import { LoadMore, pagedQuery, SeverityBadge } from '../target-ops/paged.tsx'
import { ReadSection } from '../target-ops/read-section.tsx'
import { globalFindingsQuery } from './keys.ts'
import {
  filtersOf,
  type GlobalFindingsSearch,
  KINDS,
  SEVERITIES,
  STATES,
  searchString,
} from './search.ts'

const STATE_LABELS: Readonly<Record<(typeof STATES)[number], MessageKey>> = {
  open: 'globalFindings.state.open',
  resolved: 'globalFindings.state.resolved',
  all: 'globalFindings.state.all',
}
const SEVERITY_LABELS: Readonly<Record<(typeof SEVERITIES)[number], MessageKey>> = {
  info: 'globalFindings.severity.info',
  warning: 'globalFindings.severity.warning',
  critical: 'globalFindings.severity.critical',
}
const KIND_LABELS: Readonly<Record<(typeof KINDS)[number], MessageKey>> = {
  drift: 'globalFindings.kind.drift',
  health: 'globalFindings.kind.health',
  advisor: 'globalFindings.kind.advisor',
  statements: 'globalFindings.kind.statements',
}

const LINK = 'text-xs text-primary underline focus-ring'

/**
 * `/findings`: what ExponetDB found out about every database the person may
 * read (`GET /findings`, which needs `diagnostics.read`), newest first,
 * filtered by severity, state, kind and, from a link, one target. The filters
 * live in the address as allowlist values (a target as a path that passed the
 * slug grammar), and "Load more" follows the server's keyset cursor. A read
 * that failed is a failure with its code, never an empty list; a refused read
 * names the permission. A finding's text and object are untrusted; its target
 * is linked only when its path is three slugs.
 */
export function GlobalFindingsPage({
  search,
}: {
  readonly search: GlobalFindingsSearch
}): ReactNode {
  const { client } = useApi()
  const navigate = useNavigate()
  const filters = filtersOf(search)
  const query = useInfiniteQuery(globalFindingsQuery(client, filters))
  const go = (next: GlobalFindingsSearch): void =>
    navigate(`/findings${searchString(next)}`, { replace: true })
  const unfiltered =
    filters.state === 'open' &&
    filters.severity === undefined &&
    filters.kind === undefined &&
    filters.target === undefined
  return (
    <>
      <PageHeader size="large">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{t('globalFindings.title')}</PageHeaderTitle>
            <PageHeaderDescription>{t('globalFindings.description')}</PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="large" className="flex flex-col gap-4 py-6">
        <form
          className="flex flex-wrap items-end gap-4"
          aria-label={t('globalFindings.filters.label')}
          onSubmit={(event) => event.preventDefault()}
        >
          <Filter
            label={t('globalFindings.filters.severity')}
            value={search.severity ?? ''}
            anyLabel={t('globalFindings.filters.any')}
            options={SEVERITIES.map((value) => [value, t(SEVERITY_LABELS[value])] as const)}
            onChange={(value) =>
              go({ ...search, severity: SEVERITIES.find((candidate) => candidate === value) })
            }
          />
          <Filter
            label={t('globalFindings.filters.state')}
            value={filters.state}
            options={STATES.map((value) => [value, t(STATE_LABELS[value])] as const)}
            onChange={(value) =>
              go({ ...search, state: STATES.find((candidate) => candidate === value) })
            }
          />
          <Filter
            label={t('globalFindings.filters.kind')}
            value={search.kind ?? ''}
            anyLabel={t('globalFindings.filters.any')}
            options={KINDS.map((value) => [value, t(KIND_LABELS[value])] as const)}
            onChange={(value) =>
              go({ ...search, kind: KINDS.find((candidate) => candidate === value) })
            }
          />
        </form>
        <TargetFilter search={search} />
        <ReadSection
          query={pagedQuery(query)}
          what={nounPhrase('globalFindings.what')}
          permission="diagnostics.read"
          missing={(value) => (value.more ? [t('globalFindings.more')] : undefined)}
          empty={{
            isEmpty: (value) => value.items.length === 0,
            content: (
              <p className="m-0 text-sm text-foreground-light" data-empty="findings">
                {unfiltered ? t('globalFindings.empty') : t('globalFindings.emptyFiltered')}
              </p>
            ),
          }}
          ready={(value) => (
            <div className="flex flex-col gap-3">
              <FindingsTable findings={value.items} search={search} />
              <LoadMore
                more={value.more}
                loading={query.isFetchingNextPage}
                onLoad={() => void query.fetchNextPage()}
                label={t('globalFindings.loadMore')}
              />
            </div>
          )}
        />
      </PageContainer>
    </>
  )
}

/** The one target the list is limited to (from the address), with the way back to every database. */
function TargetFilter({ search }: { readonly search: GlobalFindingsSearch }): ReactNode {
  const Link = useLinkComponent()
  if (search.target === undefined) return null
  return (
    <p className="m-0 flex flex-wrap items-center gap-2 text-sm" data-filter="target">
      <span>{t('globalFindings.target.only', { target: search.target })}</span>
      <Link href={`/findings${searchString({ ...search, target: undefined })}`} className={LINK}>
        {t('globalFindings.target.clear')}
      </Link>
    </p>
  )
}

function Filter({
  label,
  value,
  options,
  anyLabel,
  onChange,
}: {
  readonly label: string
  readonly value: string
  readonly options: readonly (readonly [string, string])[]
  /** The label of "no filter"; absent when the filter always has a value. */
  readonly anyLabel?: string
  readonly onChange: (value: string) => void
}): ReactNode {
  const id = useId()
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value)}
        className="h-8 rounded-md border border-default bg-surface-100 px-2 text-sm focus-ring"
      >
        {anyLabel === undefined ? null : <option value="">{anyLabel}</option>}
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </div>
  )
}

/** The database of a finding: linked to its findings only when the path is three slugs, else text. */
function TargetCell({
  finding,
  search,
}: {
  readonly finding: FleetFinding
  readonly search: GlobalFindingsSearch
}): ReactNode {
  const Link = useLinkComponent()
  const route = splitTargetPath(finding.targetPath)
  if (route === undefined) {
    return (
      <div className="flex flex-col gap-1">
        <UntrustedName name={finding.targetPath} mono label={t('globalFindings.column.target')} />
        <span className="text-xs text-foreground-light">{t('globalFindings.target.badPath')}</span>
      </div>
    )
  }
  return (
    <div className="flex flex-col items-start gap-1">
      <Link
        href={targetHref(route, '/findings')}
        className="font-mono text-xs text-primary underline focus-ring wrap-anywhere"
        aria-label={t('globalFindings.target.open', { target: route.path })}
      >
        {route.path}
      </Link>
      {search.target === route.path ? null : (
        <Link href={`/findings${searchString({ ...search, target: route.path })}`} className={LINK}>
          {t('globalFindings.target.filter')}
        </Link>
      )}
    </div>
  )
}

function FindingsTable({
  findings,
  search,
}: {
  readonly findings: readonly FleetFinding[]
  readonly search: GlobalFindingsSearch
}): ReactNode {
  return (
    <Table>
      <TableCaption className="sr-only">{t('globalFindings.caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t('globalFindings.column.severity')}</TableHead>
          <TableHead scope="col">{t('globalFindings.column.finding')}</TableHead>
          <TableHead scope="col">{t('globalFindings.column.target')}</TableHead>
          <TableHead scope="col">{t('globalFindings.column.seen')}</TableHead>
          <TableHead scope="col">{t('globalFindings.column.state')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {findings.map((finding) => (
          <TableRow key={finding.id} data-finding={finding.id}>
            <TableCell>
              <SeverityBadge severity={finding.severity} />
              {finding.securityRelevant ? (
                <div className="text-xs text-foreground-light">
                  {t('globalFindings.securityRelevant')}
                </div>
              ) : null}
            </TableCell>
            <TableCell>
              <div className="text-xs text-foreground-light">
                <UntrustedName name={finding.kind} label={t('globalFindings.column.kind')} />{' '}
                <UntrustedName name={finding.code} mono label={t('globalFindings.column.code')} />
              </div>
              <UntrustedName
                name={finding.summary}
                maxCodePoints={200}
                label={t('globalFindings.column.finding')}
              />
              <div className="text-xs text-foreground-light">
                {finding.object === null ? (
                  t('globalFindings.noObject')
                ) : (
                  <UntrustedName
                    name={finding.object}
                    mono
                    label={t('globalFindings.column.object')}
                  />
                )}
              </div>
            </TableCell>
            <TableCell>
              <TargetCell finding={finding} search={search} />
            </TableCell>
            <TableCell className="text-xs">
              <div>
                {t('globalFindings.firstSeen')} <ObservedTime observedAt={finding.firstSeenAt} />
              </div>
              <div>
                {t('globalFindings.lastSeen')} <ObservedTime observedAt={finding.lastSeenAt} />
              </div>
              <div>{t('globalFindings.occurrences', { count: finding.occurrences })}</div>
            </TableCell>
            <TableCell>
              <div>
                {finding.state === 'open'
                  ? t('globalFindings.state.open')
                  : t('globalFindings.state.resolved')}
              </div>
              {finding.resolution === null ? null : (
                <div className="text-xs text-foreground-light">
                  <UntrustedName
                    name={finding.resolution}
                    label={t('globalFindings.column.state')}
                  />
                </div>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

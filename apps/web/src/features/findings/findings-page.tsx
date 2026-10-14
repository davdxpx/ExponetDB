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
import { ObservedTime, UntrustedName, useLinkComponent, useNavigate } from '@exponetdb/ui-patterns'
import { useInfiniteQuery } from '@tanstack/react-query'
import { type ChangeEvent, type ReactNode, useId } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { AcceptDrift } from '../drift/accept-drift.tsx'
import { nounPhrase } from '../target/phrases.ts'
import type { Target } from '../target/queries.ts'
import { findingsQuery } from '../target-ops/keys.ts'
import { useTargetHref, useTargetPath } from '../target-ops/links.ts'
import { LoadMore, pagedQuery, SeverityBadge } from '../target-ops/paged.tsx'
import { ReadSection } from '../target-ops/read-section.tsx'
import { TargetPage } from '../target-ops/target-page.tsx'
import {
  type FindingsSearch,
  filtersOf,
  KINDS,
  SEVERITIES,
  STATES,
  searchString,
} from './search.ts'

const STATE_LABELS: Readonly<Record<(typeof STATES)[number], MessageKey>> = {
  open: 'findings.state.open',
  resolved: 'findings.state.resolved',
  all: 'findings.state.all',
}
const SEVERITY_LABELS: Readonly<Record<(typeof SEVERITIES)[number], MessageKey>> = {
  info: 'findings.severity.info',
  warning: 'findings.severity.warning',
  critical: 'findings.severity.critical',
}
const KIND_LABELS: Readonly<Record<(typeof KINDS)[number], MessageKey>> = {
  drift: 'findings.kind.drift',
  health: 'findings.kind.health',
}

/**
 * `/t/<product>/<project>/<environment>/findings`: what ExponetDB found out
 * about the target (drift and health), newest first, filtered by severity,
 * state and kind from the address (validated values only), with keyset
 * "load more". A finding's text and object are untrusted. A drift finding
 * links to the Drift page and offers "Accept drift".
 */
export function FindingsPage({ search }: { readonly search: FindingsSearch }): ReactNode {
  return (
    <TargetPage section="findings" description={t('findings.description')}>
      {(target) => <FindingsBody target={target} search={search} />}
    </TargetPage>
  )
}

function FindingsBody({
  target,
  search,
}: {
  readonly target: Target
  readonly search: FindingsSearch
}): ReactNode {
  const { client } = useApi()
  const navigate = useNavigate()
  const path = useTargetPath()
  const href = useTargetHref()
  const filters = filtersOf(search)
  const query = useInfiniteQuery(findingsQuery(client, path, filters))
  const go = (next: FindingsSearch): void =>
    navigate(href(`/findings${searchString(next)}`), { replace: true })
  const unfiltered =
    filters.state === 'open' && filters.severity === undefined && filters.kind === undefined
  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-wrap items-end gap-4"
        aria-label={t('findings.filters.label')}
        onSubmit={(event) => event.preventDefault()}
      >
        <Filter
          label={t('findings.filters.severity')}
          value={search.severity ?? ''}
          anyLabel={t('findings.filters.any')}
          options={SEVERITIES.map((value) => [value, t(SEVERITY_LABELS[value])] as const)}
          onChange={(value) =>
            go({ ...search, severity: SEVERITIES.find((candidate) => candidate === value) })
          }
        />
        <Filter
          label={t('findings.filters.state')}
          value={filters.state}
          options={STATES.map((value) => [value, t(STATE_LABELS[value])] as const)}
          onChange={(value) =>
            go({ ...search, state: STATES.find((candidate) => candidate === value) })
          }
        />
        <Filter
          label={t('findings.filters.kind')}
          value={search.kind ?? ''}
          anyLabel={t('findings.filters.any')}
          options={KINDS.map((value) => [value, t(KIND_LABELS[value])] as const)}
          onChange={(value) =>
            go({ ...search, kind: KINDS.find((candidate) => candidate === value) })
          }
        />
      </form>
      <ReadSection
        query={pagedQuery(query)}
        what={nounPhrase('findings.what')}
        permission="diagnostics.read"
        missing={(value) => (value.more ? [t('findings.more')] : undefined)}
        empty={{
          isEmpty: (value) => value.items.length === 0,
          content: (
            <p className="m-0 text-sm text-foreground-light" data-empty="findings">
              {unfiltered ? t('findings.empty') : t('findings.emptyFiltered')}
            </p>
          ),
        }}
        ready={(value) => (
          <div className="flex flex-col gap-3">
            <FindingsTable findings={value.items} target={target} />
            <LoadMore
              more={value.more}
              loading={query.isFetchingNextPage}
              onLoad={() => void query.fetchNextPage()}
              label={t('findings.loadMore')}
            />
          </div>
        )}
      />
    </div>
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

function FindingsTable({
  findings,
  target,
}: {
  readonly findings: readonly FleetFinding[]
  readonly target: Target
}): ReactNode {
  const Link = useLinkComponent()
  const href = useTargetHref()
  return (
    <Table>
      <TableCaption className="sr-only">{t('findings.caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t('findings.column.severity')}</TableHead>
          <TableHead scope="col">{t('findings.column.finding')}</TableHead>
          <TableHead scope="col">{t('findings.column.object')}</TableHead>
          <TableHead scope="col">{t('findings.column.seen')}</TableHead>
          <TableHead scope="col">{t('findings.column.state')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {findings.map((finding) => {
          const driftOpen = finding.kind === 'drift' && finding.state === 'open'
          return (
            <TableRow key={finding.id} data-finding={finding.id}>
              <TableCell>
                <SeverityBadge severity={finding.severity} />
                {finding.securityRelevant ? (
                  <div className="text-xs text-foreground-light">
                    {t('findings.securityRelevant')}
                  </div>
                ) : null}
              </TableCell>
              <TableCell>
                <div className="text-xs text-foreground-light">
                  <UntrustedName name={finding.kind} label={t('findings.column.kind')} />{' '}
                  <UntrustedName name={finding.code} mono label={t('findings.column.code')} />
                </div>
                <UntrustedName
                  name={finding.summary}
                  maxCodePoints={200}
                  label={t('findings.column.finding')}
                />
              </TableCell>
              <TableCell>
                {finding.object === null ? (
                  <span className="text-foreground-light">{t('findings.noObject')}</span>
                ) : (
                  <UntrustedName name={finding.object} mono label={t('findings.column.object')} />
                )}
              </TableCell>
              <TableCell className="text-xs">
                <div>
                  {t('findings.firstSeen')} <ObservedTime observedAt={finding.firstSeenAt} />
                </div>
                <div>
                  {t('findings.lastSeen')} <ObservedTime observedAt={finding.lastSeenAt} />
                </div>
                <div>{t('findings.occurrences', { count: finding.occurrences })}</div>
              </TableCell>
              <TableCell>
                <div>
                  {finding.state === 'open'
                    ? t('findings.state.open')
                    : t('findings.state.resolved')}
                </div>
                {finding.resolution === null ? null : (
                  <div className="text-xs text-foreground-light">
                    <UntrustedName name={finding.resolution} label={t('findings.column.state')} />
                  </div>
                )}
                {finding.kind === 'drift' ? (
                  <div className="mt-1 flex flex-col items-start gap-1">
                    <Link
                      href={href('/drift')}
                      className="text-xs text-primary underline focus-ring"
                    >
                      {t('findings.openDrift')}
                    </Link>
                    {driftOpen ? (
                      <AcceptDrift
                        findingId={finding.id}
                        reasonExpected={finding.severity === 'critical' || finding.securityRelevant}
                        tier={target.tier}
                      />
                    ) : null}
                  </div>
                ) : null}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

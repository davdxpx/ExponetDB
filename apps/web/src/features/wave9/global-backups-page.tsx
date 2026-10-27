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
  formatCount,
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
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { Observation } from '../connections/live-read.tsx'
import { nounPhrase } from '../target/phrases.ts'
import { clusterPath } from '../target-ops/ids.ts'
import { LoadMore } from '../target-ops/paged.tsx'
import { ReadSection } from '../target-ops/read-section.tsx'
import { overviewQuery } from './keys.ts'
import {
  type BackupOverview,
  backupsHref,
  DRILL_STATE_KEYS,
  formatSeconds,
  type GlobalBackupsSearch,
  type OverviewItem,
  PROTECTION_KEYS,
  PROTECTION_STATES,
  type ProtectionState,
  reasonKey,
} from './model.ts'
import { flatPages, Missing, ProtectionBadge, SelectField } from './parts.tsx'

const COUNT_KEYS = {
  protected: 'protected',
  at_risk: 'atRisk',
  unprotected: 'unprotected',
  unproven: 'unproven',
  unknown: 'unknown',
} as const satisfies Record<ProtectionState, keyof BackupOverview['counts']>

/**
 * `/backups`: the protection of every cluster the person may read, computed
 * from the catalog mirror (`getBackupOverview`, source `inferred`). Counts
 * cover every readable cluster; the list is the server's page, filtered by
 * state from the address. Each row links to the cluster's page; only
 * `protected` is drawn as good, and a failed read is a named failure.
 */
export function GlobalBackupsPage({ search }: { readonly search: GlobalBackupsSearch }): ReactNode {
  const { client } = useApi()
  const navigate = useNavigate()
  const Link = useLinkComponent()
  const query = useInfiniteQuery(overviewQuery(client, search.state))
  const section = flatPages(query, (page) => page.clusters)
  return (
    <>
      <PageHeader size="large">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{t('wave9.global.title')}</PageHeaderTitle>
            <PageHeaderDescription>{t('wave9.global.description')}</PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="large" className="flex flex-col gap-6 py-6">
        <form
          className="flex flex-wrap items-end gap-4"
          aria-label={t('wave9.global.filters')}
          onSubmit={(event) => event.preventDefault()}
        >
          <SelectField
            label={t('wave9.global.filter.state')}
            value={search.state ?? 'any'}
            options={[
              { value: 'any', label: t('wave9.global.filter.any') },
              ...PROTECTION_STATES.map((value) => ({ value, label: t(PROTECTION_KEYS[value]) })),
            ]}
            onChange={(value) =>
              navigate(backupsHref(PROTECTION_STATES.find((s) => s === value)), { replace: true })
            }
          />
        </form>
        <ReadSection
          query={section}
          what={nounPhrase('wave9.global.what')}
          permission="backups.read"
          headingLevel={2}
          missing={(value) => (value.more ? [t('wave9.list.more')] : undefined)}
          ready={(value) => (
            <div className="flex flex-col gap-4">
              <Observation source={value.first.source} observedAt={value.first.observedAt} />
              <ul className="m-0 flex flex-wrap gap-2 pl-0" aria-label={t('wave9.global.counts')}>
                {PROTECTION_STATES.map((state) => (
                  <li key={state} className="list-none" data-count={state}>
                    <Link
                      href={backupsHref(state)}
                      aria-current={search.state === state ? 'true' : undefined}
                      className="flex items-center gap-2 rounded-md border px-2 py-1 text-sm hover:bg-surface-200 focus-ring"
                    >
                      <ProtectionBadge state={state} />
                      <span className="tabular-nums">
                        {formatCount(value.first.counts[COUNT_KEYS[state]])}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              {value.items.length === 0 ? (
                <p className="m-0 text-sm text-foreground-light" data-empty="clusters">
                  {search.state === undefined
                    ? t('wave9.global.empty')
                    : t('wave9.global.emptyFiltered', { state: t(PROTECTION_KEYS[search.state]) })}
                </p>
              ) : (
                <OverviewTable clusters={value.items} />
              )}
              <LoadMore
                more={value.more}
                loading={query.isFetchingNextPage}
                onLoad={() => void query.fetchNextPage()}
                label={t('wave9.list.loadMore')}
              />
            </div>
          )}
        />
      </PageContainer>
    </>
  )
}

function OverviewTable({ clusters }: { readonly clusters: readonly OverviewItem[] }): ReactNode {
  const Link = useLinkComponent()
  return (
    <div className="min-w-0 overflow-x-auto">
      <Table>
        <TableCaption className="sr-only">{t('wave9.global.caption')}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t('wave9.global.column.cluster')}</TableHead>
            <TableHead scope="col">{t('wave9.global.column.protection')}</TableHead>
            <TableHead scope="col">{t('wave9.protection.rpo')}</TableHead>
            <TableHead scope="col">{t('wave9.protection.lastVerified')}</TableHead>
            <TableHead scope="col">{t('wave9.protection.drill')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {clusters.map((item) => {
            const href = clusterPath(item.clusterId)
            const { protection } = item
            return (
              <TableRow key={item.clusterId} data-cluster={item.clusterId}>
                <TableCell className="align-top text-sm">
                  {href === undefined ? (
                    <UntrustedName name={item.displayName} />
                  ) : (
                    <Link href={href} className="text-primary underline focus-ring">
                      <UntrustedName name={item.displayName} expandable={false} />
                    </Link>
                  )}
                  <div className="text-xs text-foreground-light">
                    {t(
                      item.managementMode === 'agent'
                        ? 'project.infra.mode.agent'
                        : 'project.infra.mode.external',
                    )}{' '}
                    {t('wave9.global.repositories', { count: item.repositories })}
                  </div>
                </TableCell>
                <TableCell className="align-top text-xs">
                  <ProtectionBadge state={protection.state} />
                  {protection.reasons.length === 0 ? null : (
                    <ul className="m-0 mt-1 flex flex-col gap-0.5 pl-0 text-foreground-light">
                      {protection.reasons.map((code) => {
                        const key = reasonKey(code)
                        return (
                          <li key={code} className="list-none" data-reason-code={code}>
                            {key === undefined ? <UntrustedName name={code} mono /> : t(key)}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </TableCell>
                <TableCell className="align-top text-xs">
                  {protection.rpo.achievableSeconds === null ? (
                    <Missing>{t('wave9.protection.rpo.unknown')}</Missing>
                  ) : (
                    formatSeconds(protection.rpo.achievableSeconds)
                  )}
                  <div className="text-foreground-light">
                    {protection.rpo.objectiveSeconds === null
                      ? t('wave9.protection.objective.none')
                      : t('wave9.protection.objective', {
                          value: formatSeconds(protection.rpo.objectiveSeconds),
                        })}
                  </div>
                </TableCell>
                <TableCell className="align-top text-xs">
                  {protection.lastVerifiedBackupAt === null ? (
                    <Missing>{t('wave9.protection.lastVerified.none')}</Missing>
                  ) : (
                    <ObservedTime observedAt={protection.lastVerifiedBackupAt} />
                  )}
                </TableCell>
                <TableCell className="align-top text-xs">
                  {t(DRILL_STATE_KEYS[protection.drill.state])}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

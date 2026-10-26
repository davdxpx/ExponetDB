import { Button } from '@exponetdb/ui'
import {
  PageContainer,
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
  PageSection,
  PageSectionContent,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
  useNavigate,
} from '@exponetdb/ui-patterns'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { useMe } from '../../lib/session/guard.tsx'
import { holds } from '../access/fields.tsx'
import { ListView } from '../access/list-view.tsx'
import { NoMatch } from '../access/no-match.tsx'
import { ChainPanel } from './chain-panel.tsx'
import { EventDetails, EventTable } from './event-list.tsx'
import { ExportSection } from './export-section.tsx'
import { FilterForm } from './filter-form.tsx'
import { type AuditEvent, auditChainQuery, auditEventsQuery } from './keys.ts'
import { type AuditSearch, auditHref, hasFilters } from './search.ts'

/**
 * `/audit` (information-architecture.md §2.1): the chain verification
 * indicator, the search over `GET /audit-events` with its filters in the
 * address, the details of one event, and the export for owners and admins.
 * Reading needs `audit.read` (or a target binding for that target's events);
 * the export needs `policy.manage`. A failed read is never an empty log.
 */
export function AuditPage({ search }: { readonly search: AuditSearch }): ReactNode {
  const { client } = useApi()
  const navigate = useNavigate()
  const me = useMe()
  const canExport = holds(me, 'policy.manage')
  const chain = useQuery(auditChainQuery(client))
  const events = useInfiniteQuery(auditEventsQuery(client, search))
  const [selected, setSelected] = useState<string | undefined>()
  const pages = events.data?.pages
  const readable = toReadable({
    data:
      pages === undefined
        ? undefined
        : {
            items: pages.flatMap((page) => page.items),
            nextCursor: pages.at(-1)?.nextCursor ?? null,
          },
    error: events.error,
    isError: events.isError,
    dataUpdatedAt: events.dataUpdatedAt,
  })

  return (
    <>
      <PageHeader>
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{t('audit.title')}</PageHeaderTitle>
            <PageHeaderDescription>{t('audit.description')}</PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer>
        <div className="flex flex-col gap-6 pt-6">
          <ChainPanel
            read={toReadable(chain)}
            error={chain.error}
            onRecheck={() => void chain.refetch()}
            busy={chain.isFetching}
          />
          <FilterForm key={auditHref(search)} search={search} />
        </div>
        <section aria-label={t('audit.events.title')} className="flex flex-col gap-4 pt-8 pb-8">
          <ListView
            readable={readable}
            error={events.error}
            what={t('audit.events.what')}
            permission="audit.read"
            // A filtered search that finds nothing is "No match" (below), not an empty log.
            // A page can come back empty with a cursor (the server scans a bounded window for a
            // caller limited to some targets): that is not an empty log, older events may match.
            isEmpty={(value) =>
              !hasFilters(search) && value.items.length === 0 && value.nextCursor === null
            }
            emptyTitle={t('audit.events.empty.title')}
            emptyDescription={t('audit.events.empty.body')}
            onRetry={() => void events.refetch()}
            busy={events.isFetching && !events.isFetchingNextPage}
          >
            {(value) =>
              value.items.length === 0 ? (
                value.nextCursor !== null ? (
                  <div className="flex flex-col items-start gap-3" data-state="partial">
                    <p className="m-0 text-sm text-foreground-light">{t('audit.events.noneYet')}</p>
                    <Button
                      type="button"
                      variant="outline"
                      size="small"
                      loading={events.isFetchingNextPage}
                      onClick={() => void events.fetchNextPage()}
                    >
                      {t('audit.events.older')}
                    </Button>
                  </div>
                ) : hasFilters(search) ? (
                  <NoMatch onReset={() => navigate('/audit')} />
                ) : null
              ) : (
                <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                  <div className="flex min-w-0 flex-col gap-3">
                    <EventTable events={value.items} selected={selected} onSelect={setSelected} />
                    <p className="text-sm text-foreground-light">
                      {value.nextCursor === null
                        ? t('audit.events.all', { count: value.items.length })
                        : t('audit.events.some', { count: value.items.length })}
                    </p>
                    {value.nextCursor === null ? null : (
                      <div>
                        <Button
                          type="button"
                          variant="outline"
                          size="small"
                          loading={events.isFetchingNextPage}
                          onClick={() => void events.fetchNextPage()}
                        >
                          {t('audit.events.older')}
                        </Button>
                      </div>
                    )}
                  </div>
                  <EventDetails
                    event={findEvent(value.items, selected)}
                    onClose={() => setSelected(undefined)}
                  />
                </div>
              )
            }
          </ListView>
        </section>
        <PageSection>
          <PageSectionMeta>
            <PageSectionSummary>
              <PageSectionTitle>{t('audit.export.section')}</PageSectionTitle>
            </PageSectionSummary>
          </PageSectionMeta>
          <PageSectionContent className="pb-12">
            {canExport ? (
              <ExportSection />
            ) : (
              <p className="text-sm text-foreground-light">{t('audit.export.notPermitted')}</p>
            )}
          </PageSectionContent>
        </PageSection>
      </PageContainer>
    </>
  )
}

function findEvent(events: readonly AuditEvent[], id: string | undefined): AuditEvent | undefined {
  return id === undefined ? undefined : events.find((event) => event.id === id)
}

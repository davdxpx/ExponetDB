import {
  Admonition,
  PageContainer,
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
  PageSection,
  PageSectionContent,
  PageSectionDescription,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
} from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { useMe } from '../../lib/session/guard.tsx'
import { CimdForm } from './cimd-form.tsx'
import { ClientCard } from './client-card.tsx'
import { ACCESS_PAGE_LIMIT, oauthClientsQuery } from './keys.ts'
import { ListView } from './list-view.tsx'
import { canManageAccess } from './model.ts'
import { StatusLines, useStatusLine } from './status.tsx'

/**
 * `/access/oauth-clients` (was `/admin/clients`): the OAuth clients of the
 * installation, with their review (OD-5 as revised on 2026-10-13: open
 * registration is the default and a person still consents). No read says
 * which mode this installation runs (`EXPONETDB_OAUTH_CLIENT_REGISTRATION`
 * is server configuration), so the page states both rules and never guesses. Reading needs
 * `access.read`; every change needs `access.manage`, a confirmation and a
 * fresh proof of identity, and the server decides each again.
 */
export function OAuthClientsPage(): ReactNode {
  const { client } = useApi()
  const me = useMe()
  const canManage = canManageAccess(me)
  const line = useStatusLine()
  const query = useQuery(oauthClientsQuery(client))
  const readable = toReadable(query, {
    missing: (page) =>
      page.nextCursor === null
        ? undefined
        : [t('access.clients.more', { count: ACCESS_PAGE_LIMIT })],
  })

  return (
    <>
      <PageHeader>
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{t('access.clients.title')}</PageHeaderTitle>
            <PageHeaderDescription>{t('access.clients.description')}</PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer>
        <div className="flex flex-col gap-4 pt-6">
          <Admonition
            type="info"
            title={t('access.clients.registration.title')}
            description={
              <div id="registration-modes" className="flex flex-col gap-2">
                <p>{t('oauthRegistration.open')}</p>
                <p>{t('oauthRegistration.review')}</p>
                <p>{t('oauthRegistration.setting')}</p>
              </div>
            }
          />
          <StatusLines line={line} />
        </div>
        {canManage ? (
          <PageSection>
            <PageSectionMeta>
              <PageSectionSummary>
                <PageSectionTitle>{t('access.cimd.title')}</PageSectionTitle>
                <PageSectionDescription>{t('access.cimd.description')}</PageSectionDescription>
              </PageSectionSummary>
            </PageSectionMeta>
            <PageSectionContent>
              <CimdForm line={line} />
            </PageSectionContent>
          </PageSection>
        ) : (
          <p className="pt-6 text-sm text-foreground-light">{t('access.manage.missing')}</p>
        )}
        <section aria-label={t('access.clients.list')} className="flex flex-col gap-4 pt-12 pb-12">
          <ListView
            readable={readable}
            error={query.error}
            what={t('access.clients.what')}
            permission="access.read"
            isEmpty={(page) => page.items.length === 0}
            emptyTitle={t('access.clients.empty.title')}
            emptyDescription={t('access.clients.empty.body')}
            onRetry={() => void query.refetch()}
            busy={query.isFetching}
          >
            {(page) => (
              <ul id="client-list" className="cards flex flex-col gap-4">
                {page.items.map((item) => (
                  <ClientCard key={item.id} client={item} line={line} canManage={canManage} />
                ))}
              </ul>
            )}
          </ListView>
        </section>
      </PageContainer>
    </>
  )
}

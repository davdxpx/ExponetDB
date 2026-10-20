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
  readableValue,
} from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { useMe } from '../../lib/session/guard.tsx'
import type { RevealedKey } from './api-key-secret.tsx'
import { ApiKeysOverview } from './api-keys-overview.tsx'
import { ACCESS_PAGE_LIMIT, serviceAccountsQuery } from './keys.ts'
import { ListView } from './list-view.tsx'
import { canManageAccess } from './model.ts'
import { identitiesQuery } from './people-keys.ts'
import { identityIndex } from './people-model.ts'
import { ServiceAccountCard } from './service-account-card.tsx'
import { ServiceCreateForm } from './service-create-form.tsx'
import { StatusLines, useStatusLine } from './status.tsx'

/**
 * `/access/service-accounts` (was `/admin/service-accounts`): service
 * accounts with their client, public keys, machine grant and API keys
 * (identity.md §5). A new API key's secret is held here, in this page's
 * state, so it is shown once in its card and ends when it is hidden, when
 * its key is revoked or when the page is left; it is never in the query
 * cache, so no refresh and no return to the page shows it again.
 */
export function ServiceAccountsPage(): ReactNode {
  const { client } = useApi()
  const me = useMe()
  const canManage = canManageAccess(me)
  const line = useStatusLine()
  const [revealed, setRevealed] = useState<RevealedKey | null>(null)
  const query = useQuery(serviceAccountsQuery(client))
  const readable = toReadable(query, {
    missing: (page) =>
      page.nextCursor === null
        ? undefined
        : [t('access.services.more', { count: ACCESS_PAGE_LIMIT })],
  })
  // The responsible person is shown by name when the people read gave it, else by ID.
  const people = useQuery(identitiesQuery(client))
  const index = identityIndex(readableValue(toReadable(people))?.items ?? [])
  const accounts = readableValue(readable)?.items

  return (
    <>
      <PageHeader>
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{t('access.services.title')}</PageHeaderTitle>
            <PageHeaderDescription>{t('access.services.description')}</PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer>
        <div className="flex flex-col gap-4 pt-6">
          <Admonition
            type="info"
            title={t('access.services.ceiling.title')}
            description={t('access.services.ceiling.body')}
          />
          <StatusLines line={line} />
        </div>
        {canManage ? (
          <PageSection>
            <PageSectionMeta>
              <PageSectionSummary>
                <PageSectionTitle>{t('access.services.create.title')}</PageSectionTitle>
                <PageSectionDescription>
                  {t('access.services.create.description')}
                </PageSectionDescription>
              </PageSectionSummary>
            </PageSectionMeta>
            <PageSectionContent>
              <ServiceCreateForm line={line} />
            </PageSectionContent>
          </PageSection>
        ) : (
          <p className="pt-6 text-sm text-foreground-light">{t('access.manage.missing')}</p>
        )}
        <section aria-label={t('access.services.overview')} className="pt-8">
          <ApiKeysOverview accounts={accounts} />
        </section>
        <section aria-label={t('access.services.list')} className="flex flex-col gap-4 pt-8 pb-12">
          <ListView
            readable={readable}
            error={query.error}
            what={t('access.services.what')}
            permission="access.read"
            isEmpty={(page) => page.items.length === 0}
            emptyTitle={t('access.services.empty.title')}
            emptyDescription={t('access.services.empty.body')}
            onRetry={() => void query.refetch()}
            busy={query.isFetching}
          >
            {(page) => (
              <ul id="service-list" className="cards flex flex-col gap-4">
                {page.items.map((account) => (
                  <ServiceAccountCard
                    key={account.id}
                    account={account}
                    responsible={index.get(account.responsibleIdentityId)}
                    line={line}
                    canManage={canManage}
                    revealed={revealed}
                    onCreated={setRevealed}
                    onHideSecret={() => setRevealed(null)}
                    onRevoked={(keyId) =>
                      setRevealed((current) => (current?.keyId === keyId ? null : current))
                    }
                  />
                ))}
              </ul>
            )}
          </ListView>
        </section>
      </PageContainer>
    </>
  )
}

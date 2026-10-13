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
import { describeError, t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { useMe } from '../../lib/session/guard.tsx'
import { holds } from './fields.tsx'
import { InvitationLink, type RevealedInvitation } from './invitation-link.tsx'
import { InviteForm } from './invite-form.tsx'
import { ACCESS_PAGE_LIMIT } from './keys.ts'
import { ListView } from './list-view.tsx'
import { bindingsQuery, identitiesQuery } from './people-keys.ts'
import { bindingsOf } from './people-model.ts'
import { PersonCard } from './person-card.tsx'
import { StatusLines, useStatusLine } from './status.tsx'

/**
 * `/access/people`: the people of the installation (identities of kind
 * `human`; service accounts have their own page) with their role bindings,
 * the invitation of a new person and what an administrator can do to one.
 * Reading needs `access.read`; every change needs `access.manage`, and the
 * server decides each again. An invitation link is held in this page's state
 * only, shown once in the person's card.
 */
export function PeoplePage(): ReactNode {
  const { client } = useApi()
  const me = useMe()
  const canManage = holds(me, 'access.manage')
  const line = useStatusLine()
  const [revealed, setRevealed] = useState<RevealedInvitation | null>(null)
  const identities = useQuery(identitiesQuery(client))
  const bindings = useQuery(bindingsQuery(client))
  const readable = toReadable(identities, {
    missing: (page) =>
      page.nextCursor === null ? undefined : [t('people.more', { count: ACCESS_PAGE_LIMIT })],
  })
  const bindingValue = readableValue(toReadable(bindings))

  return (
    <>
      <PageHeader>
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{t('people.title')}</PageHeaderTitle>
            <PageHeaderDescription>{t('people.description')}</PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer>
        <div className="flex flex-col gap-4 pt-6">
          {bindings.isError && bindingValue === undefined ? (
            <Admonition
              type="warning"
              title={t('people.bindings.failed.title')}
              description={t('people.bindings.failed.body', {
                reason: describeError(bindings.error),
              })}
            />
          ) : null}
          {bindingValue !== undefined && bindingValue.nextCursor !== null ? (
            <Admonition
              type="warning"
              title={t('people.bindings.partial.title')}
              description={t('people.bindings.partial.body', { count: ACCESS_PAGE_LIMIT })}
            />
          ) : null}
          <StatusLines line={line} />
          {revealed === null ? null : (
            <InvitationLink revealed={revealed} onHide={() => setRevealed(null)} />
          )}
        </div>
        {canManage ? (
          <PageSection>
            <PageSectionMeta>
              <PageSectionSummary>
                <PageSectionTitle>{t('people.invite.title')}</PageSectionTitle>
                <PageSectionDescription>{t('people.invite.description')}</PageSectionDescription>
              </PageSectionSummary>
            </PageSectionMeta>
            <PageSectionContent>
              <InviteForm line={line} onRevealed={setRevealed} />
            </PageSectionContent>
          </PageSection>
        ) : (
          <p className="pt-6 text-sm text-foreground-light">{t('access.manage.missing')}</p>
        )}
        <section aria-label={t('people.list')} className="flex flex-col gap-4 pt-12 pb-12">
          <ListView
            readable={readable}
            error={identities.error}
            what={t('people.what')}
            permission="access.read"
            isEmpty={(page) => page.items.every((item) => item.kind !== 'human')}
            emptyTitle={t('people.empty.title')}
            emptyDescription={t('people.empty.body')}
            onRetry={() => void identities.refetch()}
            busy={identities.isFetching}
          >
            {(page) => (
              <ul id="people-list" className="cards flex flex-col gap-4">
                {page.items
                  .filter((identity) => identity.kind === 'human')
                  .map((identity) => (
                    <PersonCard
                      key={identity.id}
                      identity={identity}
                      bindings={
                        bindingValue === undefined
                          ? undefined
                          : bindingsOf(identity.id, bindingValue.items)
                      }
                      line={line}
                      canManage={canManage}
                      onRevealed={setRevealed}
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

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
import { type ReactNode, useId, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { useMe } from '../../lib/session/guard.tsx'
import { installationQuery } from '../settings/keys.ts'
import { CimdForm } from './cimd-form.tsx'
import { ClientCard } from './client-card.tsx'
import { Field, NativeSelect } from './fields.tsx'
import { ACCESS_PAGE_LIMIT, type ClientStateFilter, oauthClientsQuery } from './keys.ts'
import { ListView } from './list-view.tsx'
import { canManageAccess, clientStateLabel } from './model.ts'
import { NoMatch } from './no-match.tsx'
import { StatusLines, useStatusLine } from './status.tsx'

const STATE_FILTERS: readonly ClientStateFilter[] = [
  'all',
  'pending',
  'active',
  'rejected',
  'disabled',
]

function isStateFilter(value: string): value is ClientStateFilter {
  return (STATE_FILTERS as readonly string[]).includes(value)
}

function stateFilterLabel(filter: ClientStateFilter): string {
  return filter === 'all' ? t('access.clients.filter.all') : clientStateLabel(filter)
}

/**
 * `/access/oauth-clients` (was `/admin/clients`): the OAuth clients of the
 * installation, with their review (OD-5 as revised on 2026-10-13: open
 * registration is the default and a person still consents). The page states
 * both rules and the mode this installation runs, read from
 * `GET /installation` (`oauthClientRegistration`, set on the server by
 * `EXPONETDB_OAUTH_CLIENT_REGISTRATION`); a failed or missing read says so
 * and never guesses a mode. Reading needs
 * `access.read`; every change needs `access.manage`, a confirmation and a
 * fresh proof of identity, and the server decides each again.
 *
 * The list can be limited to one state (the API's `state` filter); when the
 * read shows clients waiting for review the page says how many. A client's
 * last use and its active grants are part of the client (`lastUsedAt`,
 * `activeGrantCount`); a server that does not send them is said not to report
 * them, and no use is ever turned into "never used".
 */
export function OAuthClientsPage(): ReactNode {
  const { client } = useApi()
  const me = useMe()
  const canManage = canManageAccess(me)
  const line = useStatusLine()
  const filterId = useId()
  const [filter, setFilter] = useState<ClientStateFilter>('all')
  const query = useQuery(oauthClientsQuery(client, filter))
  const readable = toReadable(query, {
    missing: (page) =>
      page.nextCursor === null
        ? undefined
        : [t('access.clients.more', { count: ACCESS_PAGE_LIMIT })],
  })
  const shown =
    readable.state === 'loading' || readable.state === 'failed' ? undefined : readable.value
  const pending = shown?.items.filter((item) => item.state === 'pending').length ?? 0

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
                <RegistrationMode />
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
          <div className="flex flex-col gap-2">
            <div className="max-w-xs">
              <Field id={filterId} label={t('access.clients.filter')}>
                <NativeSelect
                  id={filterId}
                  value={filter}
                  options={STATE_FILTERS.map((value) => ({
                    value,
                    label: stateFilterLabel(value),
                  }))}
                  onChange={(event) => {
                    if (isStateFilter(event.target.value)) setFilter(event.target.value)
                  }}
                />
              </Field>
            </div>
            {pending === 0 ? null : (
              <p id="clients-pending" role="status" className="text-sm text-foreground">
                {pendingText(pending, readable.state === 'partial')}
              </p>
            )}
          </div>
          <ListView
            readable={readable}
            error={query.error}
            what={t('access.clients.what')}
            permission="access.read"
            // A state filter that leaves nothing is "No match" (below), not an empty list.
            isEmpty={(page) => filter === 'all' && page.items.length === 0}
            emptyTitle={t('access.clients.empty.title')}
            emptyDescription={t('access.clients.empty.body')}
            onRetry={() => void query.refetch()}
            busy={query.isFetching}
          >
            {(page) =>
              page.items.length === 0 ? (
                filter === 'all' ? null : (
                  <NoMatch onReset={() => setFilter('all')} />
                )
              ) : (
                <ul id="client-list" className="cards flex flex-col gap-4">
                  {page.items.map((item) => (
                    <ClientCard key={item.id} client={item} line={line} canManage={canManage} />
                  ))}
                </ul>
              )
            }
          </ListView>
        </section>
      </PageContainer>
    </>
  )
}

/** The mode this installation runs, from `GET /installation`; never a guess. */
function RegistrationMode(): ReactNode {
  const { client } = useApi()
  const query = useQuery(installationQuery(client))
  let text: string
  if (query.isPending) {
    text = t('oauthRegistration.current.loading')
  } else if (query.isError) {
    const failure = classifyFailure(query.error)
    text = t('oauthRegistration.current.failed', {
      reason: `${failure.message} (${failure.code})`,
    })
  } else {
    const mode = query.data.oauthClientRegistration
    text =
      mode === 'open'
        ? t('oauthRegistration.current.open')
        : mode === 'review'
          ? t('oauthRegistration.current.review')
          : t('oauthRegistration.current.unreported')
  }
  return (
    <p id="registration-current" className="font-medium text-foreground" aria-live="polite">
      {text}
    </p>
  )
}

/** "2 clients wait for review", or "At least 2" when the list is cut and more may wait. */
function pendingText(count: number, partial: boolean): string {
  if (partial) return t('access.clients.pending.atLeast', { count })
  return count === 1 ? t('access.clients.pending.one') : t('access.clients.pending.many', { count })
}

import { Badge, Button } from '@exponetdb/ui'
import {
  ConfirmDialog,
  type KeyValueItem,
  KeyValueList,
  PageContainer,
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
  readableValue,
  TimestampInfo,
  UntrustedName,
} from '@exponetdb/ui-patterns'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { type ReactNode, useId, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { useMe } from '../../lib/session/guard.tsx'
import { LoadMore } from '../target-ops/paged.tsx'
import { useAccessAction } from './actions.ts'
import { Field, holds, NativeSelect } from './fields.tsx'
import { ACCESS_PAGE_LIMIT } from './keys.ts'
import { ListView } from './list-view.tsx'
import { tiersLabel } from './model.ts'
import { loadedPages } from './paged-list.ts'
import { type GrantFilter, grantsQuery, identitiesQuery, peopleKeys } from './people-keys.ts'
import {
  type Grant,
  grantStateLabel,
  type Identity,
  identityIndex,
  identityName,
  lastUseLabel,
  reasonBody,
} from './people-model.ts'
import { ReasonField } from './reason-field.tsx'
import { actionFailed, type StatusLine, StatusLines, useStatusLine } from './status.tsx'

/**
 * `/access/connected-apps` for administrators: the grants of every person
 * and service account (`GET /grants`): which client acts for whom, on which
 * resource, with which scopes and tiers, until when, and its last recorded
 * use (`lastUsedAt` and `lastUseClass`; none recorded is not "never used").
 * A client's name is its own claim: untrusted text, marked "name not
 * verified" unless the client is first party. Revoking ends every token of
 * the grant at once; it needs `access.manage`, a confirmation and a fresh
 * proof of identity. A person's own grants are on the account page.
 */
const FILTERS: readonly GrantFilter[] = ['active', 'revoked', 'expired', 'all']

function filterLabel(filter: GrantFilter): string {
  switch (filter) {
    case 'active':
      return t('connectedApps.filter.active')
    case 'revoked':
      return t('connectedApps.filter.revoked')
    case 'expired':
      return t('connectedApps.filter.expired')
    case 'all':
      return t('connectedApps.filter.all')
  }
}

function isFilter(value: string): value is GrantFilter {
  return (FILTERS as readonly string[]).includes(value)
}

export function ConnectedAppsPage(): ReactNode {
  const { client } = useApi()
  const me = useMe()
  const canManage = holds(me, 'access.manage')
  const line = useStatusLine()
  const filterId = useId()
  const [filter, setFilter] = useState<GrantFilter>('active')
  const grants = useInfiniteQuery(grantsQuery(client, filter))
  const identities = useQuery(identitiesQuery(client))
  const readable = toReadable(loadedPages(grants), {
    missing: (page) =>
      page.nextCursor === null
        ? undefined
        : [t('connectedApps.more', { count: ACCESS_PAGE_LIMIT })],
  })
  const index = identityIndex(readableValue(toReadable(identities))?.items ?? [])

  return (
    <>
      <PageHeader>
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{t('connectedApps.title')}</PageHeaderTitle>
            <PageHeaderDescription>{t('connectedApps.description')}</PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer>
        <div className="flex flex-col gap-4 pt-6">
          <div className="max-w-xs">
            <Field id={filterId} label={t('connectedApps.filter')}>
              <NativeSelect
                id={filterId}
                value={filter}
                options={FILTERS.map((value) => ({ value, label: filterLabel(value) }))}
                onChange={(event) => {
                  if (isFilter(event.target.value)) setFilter(event.target.value)
                }}
              />
            </Field>
          </div>
          {canManage ? null : (
            <p className="text-sm text-foreground-light">{t('access.manage.missing')}</p>
          )}
          <StatusLines line={line} />
        </div>
        <section aria-label={t('connectedApps.list')} className="flex flex-col gap-4 pt-8 pb-12">
          <ListView
            readable={readable}
            error={grants.error}
            what={t('connectedApps.what')}
            permission="access.read"
            isEmpty={(page) => page.items.length === 0}
            emptyTitle={t('connectedApps.empty.title')}
            emptyDescription={t('connectedApps.empty.body')}
            onRetry={() => void grants.refetch()}
            busy={grants.isFetching && !grants.isFetchingNextPage}
          >
            {(page) => (
              <>
                <ul id="grant-admin-list" className="cards flex flex-col gap-4">
                  {page.items.map((grant) => (
                    <GrantCard
                      key={grant.id}
                      grant={grant}
                      person={index.get(grant.identityId)}
                      line={line}
                      canManage={canManage}
                    />
                  ))}
                </ul>
                <LoadMore
                  more={page.nextCursor !== null}
                  loading={grants.isFetchingNextPage}
                  onLoad={() => void grants.fetchNextPage()}
                  label={t('connectedApps.loadMore')}
                />
              </>
            )}
          </ListView>
        </section>
      </PageContainer>
    </>
  )
}

function GrantCard({
  grant,
  person,
  line,
  canManage,
}: {
  readonly grant: Grant
  readonly person: Identity | undefined
  readonly line: StatusLine
  readonly canManage: boolean
}): ReactNode {
  const action = useAccessAction()
  const reasonId = useId()
  const [reason, setReason] = useState('')
  const lastUsedAt = grant.lastUsedAt ?? null
  const lastUseClass = grant.lastUseClass ?? null
  const facts: KeyValueItem[] = [
    {
      id: 'person',
      label: t('connectedApps.person'),
      value:
        person === undefined ? (
          <code className="font-mono text-xs">{grant.identityId}</code>
        ) : (
          <UntrustedName name={identityName(person)} label={t('connectedApps.person')} />
        ),
    },
    {
      id: 'client-id',
      label: t('connectedApps.clientId'),
      value: (
        <UntrustedName
          name={grant.client.clientId}
          mono
          maxCodePoints={512}
          label={t('connectedApps.clientId')}
        />
      ),
    },
    {
      id: 'kind',
      label: t('connectedApps.kind'),
      value:
        grant.kind === 'delegated'
          ? t('connectedApps.kind.delegated')
          : t('connectedApps.kind.machine'),
    },
    {
      id: 'resource',
      label: t('connectedApps.resource'),
      value:
        grant.resource === 'mcp'
          ? t('connectedApps.resource.mcp')
          : t('connectedApps.resource.api'),
    },
    {
      id: 'scopes',
      label: t('connectedApps.scopes'),
      value: <span className="font-mono text-xs">{grant.scopes.join(' ')}</span>,
    },
    {
      id: 'tiers',
      label: t('connectedApps.tiers'),
      value: tiersLabel(grant.restrictions.tiers),
    },
    {
      id: 'targets',
      label: t('connectedApps.targets'),
      value:
        grant.restrictions.targets.kind === 'all' ? (
          t('connectedApps.targets.all')
        ) : (
          <span className="font-mono text-xs">
            {grant.restrictions.targets.targetIds.join(', ')}
          </span>
        ),
    },
    {
      id: 'consent',
      label: t('connectedApps.consent'),
      value:
        grant.consentAt === null ? (
          <span className="text-foreground-lighter">{t('connectedApps.consent.none')}</span>
        ) : (
          <TimestampInfo timestamp={grant.consentAt} />
        ),
    },
    {
      id: 'expires',
      label: t('connectedApps.expires'),
      value: <TimestampInfo timestamp={grant.expiresAt} />,
    },
    {
      id: 'last-used',
      label: t('connectedApps.lastUsed'),
      value:
        lastUsedAt === null ? (
          <span className="text-foreground-lighter">{t('connectedApps.lastUsed.none')}</span>
        ) : (
          <span className="inline-flex flex-wrap items-baseline gap-x-2">
            <TimestampInfo timestamp={lastUsedAt} />
            {lastUseClass === null ? null : (
              <span className="text-foreground-light">{lastUseLabel(lastUseClass)}</span>
            )}
          </span>
        ),
    },
    ...(grant.revokedAt === null
      ? []
      : [
          {
            id: 'revoked',
            label: t('connectedApps.revoked'),
            value: <TimestampInfo timestamp={grant.revokedAt} />,
          },
        ]),
  ]

  return (
    <li
      className={`card state-${grant.state} flex flex-col gap-4 rounded-lg border border-default bg-surface-100 p-5`}
      data-grant={grant.id}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="min-w-0 text-base font-medium text-foreground">
          <UntrustedName
            name={grant.client.name}
            unverified={!grant.client.firstParty}
            label={t('connectedApps.client')}
          />
        </h2>
        <Badge variant={grant.state === 'active' ? 'success' : 'default'} data-state={grant.state}>
          {grantStateLabel(grant.state)}
        </Badge>
      </div>
      <KeyValueList items={facts} />
      {canManage && grant.state === 'active' ? (
        <div>
          <ConfirmDialog
            trigger={
              <Button type="button" variant="danger" size="small">
                {t('connectedApps.revoke')}
              </Button>
            }
            title={t('connectedApps.revoke.title')}
            description={t('connectedApps.revoke.body')}
            actionLabel={t('connectedApps.revoke.action')}
            destructive
            onOpenChange={(open) => {
              if (!open) setReason('')
            }}
            onConfirm={async () => {
              line.clear()
              try {
                await action.run(
                  () =>
                    action.client.operation('revokeGrant', {
                      params: { grantId: grant.id },
                      body: reasonBody(reason),
                    }),
                  peopleKeys.grantsAll,
                )
              } catch (error) {
                throw actionFailed(error)
              }
              setReason('')
              line.say(t('connectedApps.revoke.done'))
            }}
          >
            <ReasonField id={reasonId} value={reason} onChange={setReason} maxLength={500} />
          </ConfirmDialog>
        </div>
      ) : null}
    </li>
  )
}

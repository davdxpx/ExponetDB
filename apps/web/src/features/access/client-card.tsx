import { Badge, Button } from '@exponetdb/ui'
import {
  ConfirmDialog,
  type KeyValueItem,
  KeyValueList,
  TimestampInfo,
  UntrustedName,
} from '@exponetdb/ui-patterns'
import { type ReactNode, useState } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { useAccessAction } from './actions.ts'
import { type ClientUse, type ClientUseRead, lastUseClassText } from './client-use.ts'
import { ACCESS_PAGE_LIMIT, accessKeys } from './keys.ts'
import {
  approvedAutomatically,
  authMethodLabel,
  clientDecisions,
  clientKindLabel,
  clientStateLabel,
  type OAuthClient,
  redirectHosts,
  registrationLabel,
} from './model.ts'
import { actionFailed, type StatusLine } from './status.tsx'

/**
 * One OAuth client (`li.card.state-<state>`, oauth.md §3). Everything the
 * client declared about itself (its name, redirect URIs) is untrusted text:
 * shown through the untrusted-text patterns, never a link, never a logo; the
 * name carries "name not verified" unless the client is first party. Each
 * decision goes through a confirmation that states its consequence, then
 * through re-authentication when the server asks for a fresh proof; the
 * outcome is said in the page's status line. The last use and the active
 * grants come from the grants the page read (`use`), never from the client,
 * and are labeled so; a read that failed says that and nothing about use.
 */
/**
 * A client_id or a redirect URI is shown whole, up to the contract's limit:
 * an approval binds the exact value, so it is never cut for review.
 */
const IDENTIFIER_MAX = 512

export function ClientCard({
  client,
  line,
  canManage,
  use,
}: {
  readonly client: OAuthClient
  readonly line: StatusLine
  readonly canManage: boolean
  readonly use: ClientUseRead
}): ReactNode {
  const decisions = clientDecisions(client)
  const hosts = redirectHosts(client.redirectUris)
  const facts: KeyValueItem[] = [
    {
      id: 'client-id',
      label: t('access.client.clientId'),
      value: (
        <UntrustedName
          name={client.clientId}
          mono
          maxCodePoints={IDENTIFIER_MAX}
          label={t('access.client.clientId')}
        />
      ),
      copyText: client.clientId,
    },
    {
      id: 'kind',
      label: t('access.client.kind'),
      value: t('access.client.kind.value', {
        registration: registrationLabel(client.registration),
        kind: clientKindLabel(client.kind),
        auth: authMethodLabel(client.tokenEndpointAuthMethod),
      }),
    },
    {
      id: 'redirect-hosts',
      label: t('access.client.redirectHosts'),
      value: <NameList names={hosts} label={t('access.client.redirectHosts')} />,
    },
    {
      id: 'redirect-uris',
      label: t('access.client.redirectUris'),
      value: <NameList names={client.redirectUris} label={t('access.client.redirectUris')} />,
    },
    {
      id: 'fingerprint',
      label: t('access.client.fingerprint'),
      value: <code className="hash break-all font-mono text-xs">{client.metadataFingerprint}</code>,
      copyText: client.metadataFingerprint,
    },
    ...(client.requesterHash === null
      ? []
      : [
          {
            id: 'requester',
            label: t('access.client.requester'),
            value: <code className="hash break-all font-mono text-xs">{client.requesterHash}</code>,
          },
        ]),
    ...(client.state === 'active' && !client.firstParty
      ? [
          {
            id: 'approved',
            label: t('access.client.approved'),
            value: approvedAutomatically(client) ? (
              t('access.client.approvedAutomatically')
            ) : (
              <span className="inline-flex flex-wrap items-baseline gap-x-2">
                <code className="font-mono text-xs">{client.approvedBy}</code>
                {client.approvedAt === null ? null : (
                  <TimestampInfo timestamp={client.approvedAt} />
                )}
              </span>
            ),
          },
        ]
      : []),
    ...(client.pendingExpiresAt === null
      ? []
      : [
          {
            id: 'pending-expires',
            label: t('access.client.pendingExpires'),
            value: <TimestampInfo timestamp={client.pendingExpiresAt} />,
          },
        ]),
    ...(client.metadataFetchedAt === null
      ? []
      : [
          {
            id: 'metadata-fetched',
            label: t('access.client.metadataFetched'),
            value: <TimestampInfo timestamp={client.metadataFetchedAt} />,
          },
        ]),
    {
      id: 'registered',
      label: t('access.client.registered'),
      value: <TimestampInfo timestamp={client.createdAt} />,
    },
    {
      id: 'state-since',
      label: t('access.client.stateSince'),
      value: <TimestampInfo timestamp={client.stateChangedAt} />,
    },
    {
      id: 'last-used',
      label: t('access.client.lastUsed'),
      value: <UseSummary client={client} use={use} />,
    },
  ]

  return (
    <li
      className={`card state-${client.state} flex flex-col gap-4 rounded-lg border border-default bg-surface-100 p-5`}
      data-client={client.id}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="min-w-0 text-base font-medium text-foreground">
          <UntrustedName
            name={client.name}
            unverified={!client.firstParty}
            label={t('access.client.name')}
          />
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {client.firstParty ? <Badge>{t('access.client.firstParty')}</Badge> : null}
          <Badge variant={stateVariant(client.state)} data-state={client.state}>
            {clientStateLabel(client.state)}
          </Badge>
        </div>
      </div>
      <KeyValueList items={facts} />
      {canManage ? (
        <ClientActions client={client} decisions={decisions} line={line} hosts={hosts} />
      ) : null}
    </li>
  )
}

/**
 * The last use and the active grants of a client from the grants that were
 * read: said as what that read could see. A client with no grant in the read
 * has no use in it; a recorded use is a minute and a class, and no recorded
 * use is never turned into "never used".
 */
function UseSummary({
  client,
  use,
}: {
  readonly client: OAuthClient
  readonly use: ClientUseRead
}): ReactNode {
  if (use.state === 'loading') {
    return <span className="text-foreground-lighter">{t('access.client.lastUsed.loading')}</span>
  }
  if (use.state === 'failed') {
    return (
      <span className="text-foreground-lighter" data-use="failed">
        {t('access.client.lastUsed.failed', { reason: use.reason })}
      </span>
    )
  }
  const found: ClientUse | undefined = use.byClient.get(client.id)
  const lastUsedAt = found?.lastUsedAt ?? null
  const activeGrants = found?.activeGrants ?? 0
  const how = found === undefined ? undefined : lastUseClassText(found)
  return (
    <span className="flex flex-col gap-0.5" data-use="ready">
      <span>
        {lastUsedAt === null ? (
          <span className="text-foreground-lighter">{t('access.client.lastUsed.none')}</span>
        ) : (
          <span className="inline-flex flex-wrap items-baseline gap-x-2">
            <TimestampInfo timestamp={lastUsedAt} />
            {how === undefined ? null : <span className="text-foreground-light">{how}</span>}
          </span>
        )}
      </span>
      <span>
        {use.partial
          ? t('access.client.use.activeGrants.atLeast', { count: activeGrants })
          : t('access.client.use.activeGrants', { count: activeGrants })}
      </span>
      <span className="text-xs text-foreground-lighter">
        {t('access.client.use.source')}
        {use.partial ? ` ${t('access.client.use.partial', { count: ACCESS_PAGE_LIMIT })}` : ''}
        {use.stale ? ` ${t('access.client.use.stale')}` : ''}
      </span>
    </span>
  )
}

function stateVariant(
  state: OAuthClient['state'],
): 'success' | 'warning' | 'destructive' | 'default' {
  switch (state) {
    case 'active':
      return 'success'
    case 'pending':
      return 'warning'
    case 'rejected':
    case 'disabled':
      return 'destructive'
  }
}

/** A list of untrusted single-line values (hosts, URIs), or "None". */
function NameList({
  names,
  label,
}: {
  readonly names: readonly string[]
  readonly label: string
}): ReactNode {
  if (names.length === 0) {
    return <span className="text-foreground-lighter">{t('access.client.none')}</span>
  }
  return (
    <ul className="flex flex-col gap-1">
      {keyed(names).map(({ key, name }) => (
        <li key={key}>
          <UntrustedName
            name={name}
            mono
            maxCodePoints={IDENTIFIER_MAX}
            label={label}
            className="text-xs"
          />
        </li>
      ))}
    </ul>
  )
}

/** Stable keys for values that may repeat: the value and how often it came before. */
function keyed(names: readonly string[]): { key: string; name: string }[] {
  const seen = new Map<string, number>()
  return names.map((name) => {
    const count = seen.get(name) ?? 0
    seen.set(name, count + 1)
    return { key: `${count}:${name}`, name }
  })
}

function ClientActions({
  client,
  decisions,
  line,
  hosts,
}: {
  readonly client: OAuthClient
  readonly decisions: ReturnType<typeof clientDecisions>
  readonly line: StatusLine
  readonly hosts: readonly string[]
}): ReactNode {
  const action = useAccessAction()
  const [refreshing, setRefreshing] = useState(false)
  const params = { oauthClientId: client.id }

  /** Runs a decision from a confirmation: the dialog shows a failure, the page says the outcome. */
  const decide = async (change: () => Promise<unknown>, done: string): Promise<void> => {
    line.clear()
    try {
      await action.run(change, accessKeys.oauthClients)
    } catch (error) {
      throw actionFailed(error)
    }
    line.say(done)
  }

  const refresh = async (): Promise<void> => {
    if (refreshing) return
    setRefreshing(true)
    line.clear()
    try {
      await action.run(
        () => action.client.operation('refreshOAuthClientMetadata', { params, body: {} }),
        accessKeys.oauthClients,
      )
      line.say(t('access.client.refresh.done'))
    } catch (error) {
      line.fail(error)
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {decisions.approve ? (
        <ConfirmDialog
          trigger={
            <Button type="button" variant="primary" size="small">
              {t('access.client.approve')}
            </Button>
          }
          title={t('access.client.approve.title')}
          description={t('access.client.approve.body')}
          actionLabel={t('access.client.approve')}
          onConfirm={() =>
            decide(
              () =>
                action.client.operation('approveOAuthClient', {
                  params,
                  // The exact metadata this card shows: a different current fingerprint is PLAN_STALE.
                  body: { fingerprint: client.metadataFingerprint },
                }),
              t('access.client.approve.done'),
            )
          }
        >
          <KeyValueList
            layout="stacked"
            items={[
              {
                id: 'client-id',
                label: t('access.client.clientId'),
                value: (
                  <UntrustedName
                    name={client.clientId}
                    mono
                    maxCodePoints={IDENTIFIER_MAX}
                    label={t('access.client.clientId')}
                  />
                ),
              },
              {
                id: 'redirect-hosts',
                label: t('access.client.redirectHosts'),
                value: <NameList names={hosts} label={t('access.client.redirectHosts')} />,
              },
              {
                id: 'fingerprint',
                label: t('access.client.fingerprint'),
                value: (
                  <code className="break-all font-mono text-xs">{client.metadataFingerprint}</code>
                ),
              },
            ]}
          />
        </ConfirmDialog>
      ) : null}
      {decisions.reject ? (
        <ConfirmDialog
          trigger={
            <Button type="button" variant="default" size="small">
              {t('access.client.reject')}
            </Button>
          }
          title={t('access.client.reject.title')}
          description={t('access.client.reject.body')}
          actionLabel={t('access.client.reject.action')}
          destructive
          onConfirm={() =>
            decide(
              () => action.client.operation('rejectOAuthClient', { params, body: {} }),
              t('access.client.reject.done'),
            )
          }
        />
      ) : null}
      {decisions.disable ? (
        <ConfirmDialog
          trigger={
            <Button type="button" variant="danger" size="small">
              {t('access.client.disable')}
            </Button>
          }
          title={t('access.client.disable.title')}
          description={t('access.client.disable.body')}
          actionLabel={t('access.client.disable.action')}
          destructive
          onConfirm={() =>
            decide(
              () => action.client.operation('disableOAuthClient', { params, body: {} }),
              t('access.client.disable.done'),
            )
          }
        />
      ) : null}
      {decisions.refresh ? (
        <Button
          type="button"
          variant="text"
          size="small"
          loading={refreshing}
          onClick={() => void refresh()}
        >
          {t('access.client.refresh')}
        </Button>
      ) : null}
    </div>
  )
}

import { Badge, Button } from '@exponetdb/ui'
import {
  ConfirmDialog,
  type KeyValueItem,
  KeyValueList,
  TimestampInfo,
  UntrustedName,
} from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { useAccessAction } from './actions.ts'
import { ApiKeySecret, type RevealedKey } from './api-key-secret.tsx'
import { toApiKeyRequest, toGrantRequest } from './authority.ts'
import { AuthorityForm } from './authority-form.tsx'
import { accessKeys } from './keys.ts'
import {
  type ApiKey,
  apiKeyLine,
  grantLine,
  keySummary,
  type ServiceAccount,
  serviceStateLabel,
} from './model.ts'
import { PublicKeysForm } from './public-keys-form.tsx'
import { actionFailed, type StatusLine } from './status.tsx'

/**
 * One service account (`li[data-service]`, identity.md §5): its client and
 * public keys, its machine grant and its API keys. Every change needs
 * `access.manage` and a fresh proof; a new API key's secret is shown once in
 * this card (`#api-key-secret`) and held by the page, not here, so a refresh
 * of the list cannot drop or repeat it.
 */
export interface ServiceAccountCardProps {
  readonly account: ServiceAccount
  readonly line: StatusLine
  readonly canManage: boolean
  /** The secret to show once, when it belongs to this account. */
  readonly revealed: RevealedKey | null
  readonly onCreated: (revealed: RevealedKey) => void
  readonly onHideSecret: () => void
  readonly onRevoked: (keyId: string) => void
}

export function ServiceAccountCard({
  account,
  line,
  canManage,
  revealed,
  onCreated,
  onHideSecret,
  onRevoked,
}: ServiceAccountCardProps): ReactNode {
  const action = useAccessAction()
  const params = { identityId: account.id }
  const active = account.state === 'active'
  const activeGrant = account.grants.some((grant) => grant.state === 'active')
  const name = account.displayName ?? account.label
  const facts: KeyValueItem[] = [
    {
      id: 'label',
      label: t('access.service.label'),
      value: <UntrustedName name={account.label} mono label={t('access.service.label')} />,
    },
    {
      id: 'responsible',
      label: t('access.service.responsible'),
      value: <code className="font-mono text-xs">{account.responsibleIdentityId}</code>,
    },
    {
      id: 'created',
      label: t('access.service.created'),
      value: <TimestampInfo timestamp={account.createdAt} />,
    },
    {
      id: 'client',
      label: t('access.service.client'),
      value:
        account.client === null ? (
          <span className="text-foreground-lighter">{t('access.service.client.none')}</span>
        ) : (
          <code className="font-mono text-xs">{account.client.clientId}</code>
        ),
    },
    {
      id: 'keys',
      label: t('access.service.keys'),
      value:
        account.client === null || account.client.keys.length === 0 ? (
          <span className="text-foreground-lighter">{t('access.service.keys.none')}</span>
        ) : (
          <span className="font-mono text-xs">
            {account.client.keys.map(keySummary).join(', ')}
          </span>
        ),
    },
  ]

  return (
    <li
      className={`card state-${account.state} flex flex-col gap-5 rounded-lg border border-default bg-surface-100 p-5`}
      data-service={account.id}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="min-w-0 text-base font-medium text-foreground">
          <UntrustedName name={name} label={t('access.service.name')} />
        </h2>
        <Badge
          variant={account.state === 'active' ? 'success' : 'default'}
          data-state={account.state}
        >
          {serviceStateLabel(account.state)}
        </Badge>
      </div>
      <KeyValueList items={facts} />

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-foreground">{t('access.service.keys.title')}</h3>
        <p className="text-sm text-foreground-light">{t('access.service.keys.description')}</p>
        {canManage && active ? <PublicKeysForm account={account} line={line} /> : null}
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-foreground">{t('access.service.grants.title')}</h3>
        <p className="text-sm text-foreground-light">{t('access.service.grants.description')}</p>
        {account.grants.length === 0 ? (
          <p className="text-sm text-foreground-lighter">{t('access.service.grants.none')}</p>
        ) : (
          <ul className="list flex flex-col gap-1 text-sm">
            {account.grants.map((grant) => (
              <li key={grant.id} className="font-mono text-xs text-foreground">
                {grantLine(grant)}
              </li>
            ))}
          </ul>
        )}
        {canManage && active ? (
          account.client === null ? (
            <p className="text-sm text-foreground-lighter">
              {t('access.service.grants.needsClient')}
            </p>
          ) : (
            <AuthorityForm
              kind="grant"
              submitLabel={t('access.service.grant.submit')}
              confirm={
                activeGrant
                  ? {
                      title: t('access.service.grant.replace.title'),
                      description: t('access.service.grant.replace.body'),
                      actionLabel: t('access.service.grant.replace.action'),
                    }
                  : undefined
              }
              onSend={async (values) => {
                line.clear()
                await action.run(
                  () =>
                    action.client.operation('createMachineGrant', {
                      params,
                      body: toGrantRequest(values),
                    }),
                  accessKeys.serviceAccounts,
                )
                line.say(t('access.service.grant.done'))
              }}
              onError={line.fail}
              toFailure={actionFailed}
            />
          )
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-foreground">{t('access.service.apiKeys.title')}</h3>
        <p className="text-sm text-foreground-light">{t('access.service.apiKeys.description')}</p>
        {account.apiKeys.length === 0 ? (
          <p className="text-sm text-foreground-lighter">{t('access.service.apiKeys.none')}</p>
        ) : (
          <ul className="list flex flex-col gap-2">
            {account.apiKeys.map((key) => (
              <ApiKeyRow
                key={key.id}
                apiKey={key}
                canManage={canManage}
                onRevoke={async () => {
                  line.clear()
                  try {
                    await action.run(
                      () =>
                        action.client.operation('revokeApiKey', {
                          params: { keyId: key.id },
                          body: {},
                        }),
                      accessKeys.serviceAccounts,
                    )
                  } catch (error) {
                    throw actionFailed(error)
                  }
                  onRevoked(key.id)
                  line.say(t('access.service.apiKey.revoke.done'))
                }}
              />
            ))}
          </ul>
        )}
        {canManage && active ? (
          <AuthorityForm
            kind="apiKey"
            submitLabel={t('access.service.apiKey.submit')}
            onSend={async (values) => {
              line.clear()
              const created = await action.change(() =>
                action.client.operation('createApiKey', {
                  params,
                  body: toApiKeyRequest(values),
                }),
              )
              // The secret goes to the page's state only, at once; the list holds the key without it.
              onCreated({ accountId: account.id, keyId: created.apiKey.id, secret: created.secret })
              line.say(t('access.service.apiKey.done'))
              void action.refresh(accessKeys.serviceAccounts)
            }}
            onError={line.fail}
          />
        ) : null}
        {revealed !== null && revealed.accountId === account.id ? (
          <ApiKeySecret revealed={revealed} onHide={onHideSecret} />
        ) : null}
      </section>
    </li>
  )
}

function ApiKeyRow({
  apiKey,
  canManage,
  onRevoke,
}: {
  readonly apiKey: ApiKey
  readonly canManage: boolean
  readonly onRevoke: () => Promise<void>
}): ReactNode {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm text-foreground">
          {apiKey.label === null ? (
            <code className="font-mono text-xs">{apiKey.id}</code>
          ) : (
            <UntrustedName name={apiKey.label} label={t('access.service.apiKey.name')} />
          )}
        </span>
        <span className="meta font-mono text-xs text-foreground-light">{apiKeyLine(apiKey)}</span>
      </span>
      {canManage && apiKey.state === 'active' ? (
        <ConfirmDialog
          trigger={
            <Button
              type="button"
              variant="text"
              size="tiny"
              aria-label={t('access.service.apiKey.revoke.label', { key: apiKey.id })}
            >
              {t('access.service.apiKey.revoke')}
            </Button>
          }
          title={t('access.service.apiKey.revoke.title')}
          description={t('access.service.apiKey.revoke.body')}
          actionLabel={t('access.service.apiKey.revoke.action')}
          destructive
          onConfirm={onRevoke}
        />
      ) : null}
    </li>
  )
}

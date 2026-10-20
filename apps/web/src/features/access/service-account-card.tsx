import { Badge, Button } from '@exponetdb/ui'
import {
  ConfirmDialog,
  type KeyValueItem,
  KeyValueList,
  TimestampInfo,
  TypedConfirmDialog,
  UntrustedName,
} from '@exponetdb/ui-patterns'
import { type ReactNode, useId, useState } from 'react'
import { usePlanAction } from '../../lib/api/plan-action.ts'
import { t } from '../../lib/i18n/i18n.ts'
import { nounPhrase } from '../target/phrases.ts'
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
  type MachineGrant,
  restrictionsLine,
  type ServiceAccount,
  serviceStateLabel,
  targetsText,
} from './model.ts'
import { peopleKeys } from './people-keys.ts'
import { type Identity, identityName, reasonBody } from './people-model.ts'
import { PublicKeysForm } from './public-keys-form.tsx'
import { ReasonField } from './reason-field.tsx'
import { actionFailed, type StatusLine } from './status.tsx'

/**
 * One service account (`li[data-service]`, identity.md §5): its client and
 * public keys, its machine grant and its API keys, and the lifecycle of the
 * account itself. Every change needs `access.manage` and a fresh proof; a new
 * API key's secret is shown once in this card (`#api-key-secret`) and held by
 * the page, not here, so a refresh of the list cannot drop or repeat it.
 *
 * Disabling is inline (a confirmation with an optional audit reason and a
 * fresh proof); enabling again and erasing are plans, and erasing asks for
 * the account's name to be typed. The responsible person is shown by name
 * when the people read gave one, else by ID.
 */
export interface ServiceAccountCardProps {
  readonly account: ServiceAccount
  /** The responsible person, when the identities read has them. */
  readonly responsible: Identity | undefined
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
  responsible,
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
      value:
        responsible === undefined ? (
          <code className="font-mono text-xs">{account.responsibleIdentityId}</code>
        ) : (
          <UntrustedName name={identityName(responsible)} label={t('access.service.responsible')} />
        ),
      copyText: account.responsibleIdentityId,
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
          <ul className="list flex flex-col gap-2 text-sm">
            {account.grants.map((grant) => (
              <GrantRow key={grant.id} grant={grant} canManage={canManage} line={line} />
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

      {canManage && account.state !== 'erased' ? (
        <AccountActions account={account} line={line} />
      ) : null}
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
        <span className="restriction text-xs text-foreground-light">
          {restrictionsLine(apiKey.restrictions)}
        </span>
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

/**
 * A machine grant of the account: its scopes, tiers and expiry, where it may
 * act, and, while it is active, the way to end it at once (an optional
 * reason is kept in the audit, permanently). Revoking ends every token of the
 * grant, as on the Connected applications page.
 */
function GrantRow({
  grant,
  canManage,
  line,
}: {
  readonly grant: MachineGrant
  readonly canManage: boolean
  readonly line: StatusLine
}): ReactNode {
  const action = useAccessAction()
  const reasonId = useId()
  const [reason, setReason] = useState('')
  return (
    <li
      className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"
      data-machine-grant={grant.id}
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-mono text-xs text-foreground">{grantLine(grant)}</span>
        <span className="restriction text-xs text-foreground-light">
          {targetsText(grant.restrictions)}
        </span>
      </span>
      {canManage && grant.state === 'active' ? (
        <ConfirmDialog
          trigger={
            <Button
              type="button"
              variant="text"
              size="tiny"
              aria-label={t('access.service.grant.revoke.label', { id: grant.id })}
            >
              {t('access.service.grant.revoke')}
            </Button>
          }
          title={t('access.service.grant.revoke.title')}
          description={t('access.service.grant.revoke.body')}
          actionLabel={t('access.service.grant.revoke.action')}
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
                accessKeys.serviceAccounts,
              )
            } catch (error) {
              throw actionFailed(error)
            }
            setReason('')
            // The same grant is on the Connected applications page: that list is read again too.
            void action.refresh(peopleKeys.grantsAll)
            line.say(t('access.service.grant.revoke.done'))
          }}
        >
          <ReasonField id={reasonId} value={reason} onChange={setReason} maxLength={500} />
        </ConfirmDialog>
      ) : null}
    </li>
  )
}

/**
 * The lifecycle of the account, as the People page has it for a person:
 * disable at once (confirmation, optional reason, fresh proof), plan enabling
 * again, plan erasing with the account's name typed. Plans open their review
 * page; nothing changes until a plan is approved and applied there.
 */
function AccountActions({
  account,
  line,
}: {
  readonly account: ServiceAccount
  readonly line: StatusLine
}): ReactNode {
  const action = useAccessAction()
  const createPlan = usePlanAction()
  const reasonId = useId()
  const [reason, setReason] = useState('')
  const params = { identityId: account.id }
  // An empty name cannot be typed: the audit label stands in for it.
  const typedName =
    account.displayName !== null && account.displayName !== '' ? account.displayName : account.label

  const plan = async (create: () => Promise<{ readonly id: string }>): Promise<void> => {
    line.clear()
    try {
      await createPlan(create)
    } catch (error) {
      throw actionFailed(error)
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">{t('access.service.lifecycle.title')}</h3>
      <p className="text-sm text-foreground-light">{t('access.service.lifecycle.description')}</p>
      <div className="flex flex-wrap items-center gap-2">
        {account.state === 'active' || account.state === 'invited' ? (
          <ConfirmDialog
            trigger={
              <Button type="button" variant="danger" size="small">
                {t('access.service.disable')}
              </Button>
            }
            title={t('access.service.disable.title')}
            description={t('access.service.disable.body')}
            actionLabel={t('access.service.disable.action')}
            destructive
            onOpenChange={(open) => {
              if (!open) setReason('')
            }}
            onConfirm={async () => {
              line.clear()
              try {
                await action.run(
                  () =>
                    action.client.operation('disableIdentity', {
                      params,
                      body: reasonBody(reason),
                    }),
                  accessKeys.serviceAccounts,
                )
              } catch (error) {
                throw actionFailed(error)
              }
              setReason('')
              void action.refresh(peopleKeys.identities)
              line.say(t('access.service.disable.done'))
            }}
          >
            <ReasonField id={reasonId} value={reason} onChange={setReason} maxLength={1000} />
          </ConfirmDialog>
        ) : null}
        {account.state === 'disabled' ? (
          <ConfirmDialog
            trigger={
              <Button type="button" variant="default" size="small">
                {t('access.service.enable')}
              </Button>
            }
            title={t('access.service.enable.title')}
            description={t('access.service.enable.body')}
            actionLabel={t('access.service.enable.action')}
            onConfirm={() =>
              plan(() => action.client.operation('planIdentityEnable', { params, body: {} }))
            }
          />
        ) : null}
        <TypedConfirmDialog
          trigger={
            <Button type="button" variant="text" size="small">
              {t('access.service.erase')}
            </Button>
          }
          title={t('access.service.erase.title')}
          description={t('access.service.erase.body')}
          actionLabel={t('access.service.erase.action')}
          destructive
          expectedText={typedName}
          expectedTextName={nounPhrase('access.service.erase.typed')}
          resetKey={account.id}
          onConfirm={() =>
            plan(() => action.client.operation('planIdentityErasure', { params, body: {} }))
          }
        />
      </div>
    </section>
  )
}

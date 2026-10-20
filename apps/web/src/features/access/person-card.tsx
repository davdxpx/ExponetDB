import { Badge, Button } from '@exponetdb/ui'
import {
  ConfirmDialog,
  type KeyValueItem,
  KeyValueList,
  TimestampInfo,
  UntrustedName,
} from '@exponetdb/ui-patterns'
import { type ReactNode, useId, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { usePlanAction } from '../../lib/api/plan-action.ts'
import { t } from '../../lib/i18n/i18n.ts'
import { ProfileAvatar } from '../account/avatar.tsx'
import { useAccessAction } from './actions.ts'
import { BindingForm } from './binding-form.tsx'
import { type RevealedInvitation, revealedOf } from './invitation-link.tsx'
import { peopleKeys } from './people-keys.ts'
import {
  factorLine,
  type Identity,
  identityName,
  identityStateLabel,
  type RoleBinding,
  reasonBody,
  roleLabel,
  scopeText,
} from './people-model.ts'
import { ReasonField } from './reason-field.tsx'
import { actionFailed, type StatusLine } from './status.tsx'

/**
 * One person (`li[data-identity]`): name and address as untrusted text, state,
 * factors, the active role bindings with their scope, and what an
 * administrator can do, with their picture when they have set one and a
 * "You" mark on the signed-in person's own card. Binding, unbinding, enabling and erasing are plans
 * (the review page opens); disabling and a new invitation link are inline
 * changes with a confirmation and re-authentication, as the API defines them.
 */
export interface PersonCardProps {
  readonly identity: Identity
  /** The person's active bindings, or undefined when the binding read failed or is loading. */
  readonly bindings: readonly RoleBinding[] | undefined
  readonly line: StatusLine
  readonly canManage: boolean
  /** The card is the signed-in person's own. */
  readonly isYou: boolean
  readonly onRevealed: (revealed: RevealedInvitation) => void
}

export function PersonCard({
  identity,
  bindings,
  line,
  canManage,
  isYou,
  onRevealed,
}: PersonCardProps): ReactNode {
  const facts: KeyValueItem[] = [
    {
      id: 'email',
      label: t('people.email'),
      value:
        identity.email === null ? (
          <span className="text-foreground-lighter">{t('people.email.none')}</span>
        ) : (
          <UntrustedName name={identity.email} mono label={t('people.email')} />
        ),
    },
    {
      id: 'id',
      label: t('people.id'),
      value: <code className="font-mono text-xs">{identity.id}</code>,
      copyText: identity.id,
    },
    { id: 'factors', label: t('people.factors'), value: factorLine(identity.factors) },
    {
      id: 'created',
      label: t('people.created'),
      value: <TimestampInfo timestamp={identity.createdAt} />,
    },
    {
      id: 'activated',
      label: t('people.activated'),
      value:
        identity.activatedAt === null ? (
          <span className="text-foreground-lighter">{t('people.activated.never')}</span>
        ) : (
          <TimestampInfo timestamp={identity.activatedAt} />
        ),
    },
  ]
  const live = identity.state !== 'erased'

  return (
    <li
      className={`card state-${identity.state} flex flex-col gap-4 rounded-lg border border-default bg-surface-100 p-5`}
      data-identity={identity.id}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <ProfileAvatar avatar={identity.avatar} name={identityName(identity)} />
          <h2 className="min-w-0 text-base font-medium text-foreground">
            <UntrustedName name={identityName(identity)} label={t('people.name')} />
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isYou ? <Badge variant="default">{t('people.you')}</Badge> : null}
          {identity.recoveryRequired ? (
            <Badge variant="warning">{t('people.recoveryRequired')}</Badge>
          ) : null}
          <Badge
            variant={identity.state === 'active' ? 'success' : 'default'}
            data-state={identity.state}
          >
            {identityStateLabel(identity.state)}
          </Badge>
        </div>
      </div>
      <KeyValueList items={facts} />

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-foreground">{t('people.bindings.title')}</h3>
        <Bindings bindings={bindings} line={line} canManage={canManage && live} />
        {canManage && (identity.state === 'active' || identity.state === 'invited') ? (
          <BindingForm identityId={identity.id} line={line} />
        ) : null}
      </section>

      {canManage && live ? (
        <PersonActions identity={identity} line={line} onRevealed={onRevealed} />
      ) : null}
    </li>
  )
}

function Bindings({
  bindings,
  line,
  canManage,
}: {
  readonly bindings: readonly RoleBinding[] | undefined
  readonly line: StatusLine
  readonly canManage: boolean
}): ReactNode {
  if (bindings === undefined) {
    return <p className="text-sm text-foreground-lighter">{t('people.bindings.unknown')}</p>
  }
  if (bindings.length === 0) {
    return <p className="text-sm text-foreground-lighter">{t('people.bindings.none')}</p>
  }
  return (
    <ul className="bindings flex flex-col gap-1">
      {bindings.map((binding) => (
        <BindingRow key={binding.id} binding={binding} line={line} canManage={canManage} />
      ))}
    </ul>
  )
}

export function BindingRow({
  binding,
  line,
  canManage,
  who,
}: {
  readonly binding: RoleBinding
  readonly line: StatusLine
  readonly canManage: boolean
  /** The person, when the row stands outside their card (the Roles page). */
  readonly who?: ReactNode
}): ReactNode {
  const { client } = useApi()
  const createPlan = usePlanAction()
  return (
    <li
      className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"
      data-binding={binding.id}
    >
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm text-foreground">
        {who}
        <span className="font-medium">{roleLabel(binding.roleId)}</span>
        <span className="font-mono text-xs text-foreground-light">{scopeText(binding.scope)}</span>
      </span>
      {canManage ? (
        <ConfirmDialog
          trigger={
            <Button
              type="button"
              variant="text"
              size="tiny"
              aria-label={t('people.binding.remove.label', {
                role: roleLabel(binding.roleId),
                scope: scopeText(binding.scope),
              })}
            >
              {t('people.binding.remove')}
            </Button>
          }
          title={t('people.binding.remove.title')}
          description={t('people.binding.remove.body')}
          actionLabel={t('people.binding.remove.action')}
          onConfirm={async () => {
            line.clear()
            try {
              await createPlan(() =>
                client.operation('planRoleBindingRemoval', { params: { bindingId: binding.id } }),
              )
            } catch (error) {
              throw actionFailed(error)
            }
          }}
        />
      ) : null}
    </li>
  )
}

function PersonActions({
  identity,
  line,
  onRevealed,
}: {
  readonly identity: Identity
  readonly line: StatusLine
  readonly onRevealed: (revealed: RevealedInvitation) => void
}): ReactNode {
  const action = useAccessAction()
  const createPlan = usePlanAction()
  const reasonId = useId()
  const [reason, setReason] = useState('')
  const params = { identityId: identity.id }

  const plan = async (create: () => Promise<{ readonly id: string }>): Promise<void> => {
    line.clear()
    try {
      await createPlan(create)
    } catch (error) {
      throw actionFailed(error)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {identity.state === 'invited' ? (
        <ConfirmDialog
          trigger={
            <Button type="button" variant="default" size="small">
              {t('people.reissue')}
            </Button>
          }
          title={t('people.reissue.title')}
          description={t('people.reissue.body')}
          actionLabel={t('people.reissue.action')}
          onConfirm={async () => {
            line.clear()
            try {
              const invitation = await action.change(() =>
                action.client.operation('reissueInvitation', { params, body: {} }),
              )
              onRevealed(revealedOf(invitation))
            } catch (error) {
              throw actionFailed(error)
            }
            line.say(t('people.reissue.done'))
            void action.refresh(peopleKeys.identities)
          }}
        />
      ) : null}
      {identity.state === 'active' || identity.state === 'invited' ? (
        <ConfirmDialog
          trigger={
            <Button type="button" variant="danger" size="small">
              {t('people.disable')}
            </Button>
          }
          title={t('people.disable.title')}
          description={t('people.disable.body')}
          actionLabel={t('people.disable.action')}
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
                peopleKeys.identities,
              )
            } catch (error) {
              throw actionFailed(error)
            }
            setReason('')
            line.say(t('people.disable.done'))
          }}
        >
          <ReasonField id={reasonId} value={reason} onChange={setReason} maxLength={1000} />
        </ConfirmDialog>
      ) : null}
      {identity.state === 'disabled' ? (
        <ConfirmDialog
          trigger={
            <Button type="button" variant="default" size="small">
              {t('people.enable')}
            </Button>
          }
          title={t('people.enable.title')}
          description={t('people.enable.body')}
          actionLabel={t('people.enable.action')}
          onConfirm={() =>
            plan(() => action.client.operation('planIdentityEnable', { params, body: {} }))
          }
        />
      ) : null}
      <ConfirmDialog
        trigger={
          <Button type="button" variant="text" size="small">
            {t('people.erase')}
          </Button>
        }
        title={t('people.erase.title')}
        description={t('people.erase.body')}
        actionLabel={t('people.erase.action')}
        destructive
        onConfirm={() =>
          plan(() => action.client.operation('planIdentityErasure', { params, body: {} }))
        }
      />
    </div>
  )
}

import type { CreationOptions } from '@exponetdb/contracts'
import { Button, Input } from '@exponetdb/ui'
import { type Readable, ReadableView, UntrustedName } from '@exponetdb/ui-patterns'
import { type ReactNode, useId, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { createPasskey } from '../../lib/auth/webauthn.ts'
import { t } from '../../lib/i18n/i18n.ts'
import { TimeText } from '../sign-in/time-text.tsx'
import { type Factor, type Passkey, passkeysOf, removePasskeyPath } from './account-model.ts'
import { AccountCard, AccountSection, CardRow } from './section.tsx'
import type { AccountWriter } from './writer.ts'

/**
 * The person's passkeys (`#passkey-list`): name, when it was added and last
 * used, and "Remove"; below, a name and "Add a passkey" (`#add-passkey`).
 * Names are text the person chose, shown through the untrusted-name
 * pattern. Both changes go through the writer (re-authentication included);
 * the server refuses to remove the last passkey.
 */
export function PasskeysSection({
  factors,
  writer,
  onRetry,
}: {
  readonly factors: Readable<{ readonly items: readonly Factor[] }>
  readonly writer: AccountWriter
  readonly onRetry: () => void
}): ReactNode {
  const { client } = useApi()
  const labelId = useId()
  const [label, setLabel] = useState(() => t('account.passkey.newDefault'))
  const locked = writer.busy !== undefined

  const add = (): void =>
    writer.write('add-passkey', async (reauth) => {
      await reauth(async () => {
        const options = await client.ceremony<CreationOptions>('/auth/passkeys/options')
        const credential = await createPasskey(options)
        const name = label.trim()
        await client.ceremony('/auth/passkeys', {
          credential,
          ...(name === '' ? {} : { label: name }),
        })
      })
      return t('account.passkey.addedStatus')
    })

  const remove = (passkey: Passkey): void => {
    const path = removePasskeyPath(passkey.id)
    if (path === undefined) return
    writer.write(`remove-passkey:${passkey.id}`, async (reauth) => {
      await reauth(() => client.ceremony(path))
      return t('account.passkey.removed')
    })
  }

  return (
    <AccountSection title={t('account.passkeys')}>
      <ReadableView
        readable={factors}
        what={t('account.passkeys.what')}
        headingLevel={3}
        onRetry={onRetry}
        onRefresh={onRetry}
        empty={{
          isEmpty: (value) => passkeysOf(value.items).length === 0,
          content: <p className="text-sm text-foreground-light">{t('account.passkeys.none')}</p>,
        }}
        ready={(value) => (
          <ul
            id="passkey-list"
            className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-default bg-surface-100 shadow-xs"
          >
            {passkeysOf(value.items).map((passkey) => (
              <PasskeyRow
                key={passkey.id}
                passkey={passkey}
                busy={writer.busy === `remove-passkey:${passkey.id}`}
                disabled={locked}
                onRemove={() => remove(passkey)}
              />
            ))}
          </ul>
        )}
      />
      <AccountCard
        footer={
          <Button
            id="add-passkey"
            type="button"
            variant="primary"
            size="small"
            loading={writer.busy === 'add-passkey'}
            disabled={locked && writer.busy !== 'add-passkey'}
            onClick={add}
          >
            {t('account.passkey.add')}
          </Button>
        }
      >
        <CardRow label={t('account.passkey.newLabel')} htmlFor={labelId}>
          <Input
            id={labelId}
            name="label"
            maxLength={64}
            autoComplete="off"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </CardRow>
      </AccountCard>
    </AccountSection>
  )
}

function PasskeyRow({
  passkey,
  busy,
  disabled,
  onRemove,
}: {
  readonly passkey: Passkey
  readonly busy: boolean
  readonly disabled: boolean
  readonly onRemove: () => void
}): ReactNode {
  const nameId = useId()
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <UntrustedName id={nameId} name={passkey.label} className="text-sm text-foreground" />
        <p className="flex flex-wrap gap-x-3 text-xs text-foreground-lighter">
          <span>
            {t('account.passkey.added')} <TimeText value={passkey.createdAt} />
          </span>
          {passkey.lastUsedAt === null ? null : (
            <span>
              {t('account.passkey.lastUsed')} <TimeText value={passkey.lastUsedAt} />
            </span>
          )}
        </p>
      </div>
      <Button
        type="button"
        variant="default"
        size="tiny"
        aria-describedby={nameId}
        loading={busy}
        disabled={disabled && !busy}
        onClick={onRemove}
      >
        {t('account.passkey.remove')}
      </Button>
    </li>
  )
}

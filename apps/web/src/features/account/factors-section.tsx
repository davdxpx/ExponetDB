import type { RecoveryCodesView, TotpSetup } from '@exponetdb/contracts'
import { Button, Input, Label } from '@exponetdb/ui'
import { type Readable, readableValue } from '@exponetdb/ui-patterns'
import { type FormEvent, type ReactNode, useId, useState } from 'react'
import { flushSync } from 'react-dom'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { TotpSetupPanel } from '../enrollment/totp-setup.tsx'
import type { Feedback } from '../sign-in/feedback.tsx'
import { type Factor, hasTotp, recoveryCodesLeft } from './account-model.ts'
import { SectionHeading } from './section.tsx'
import type { AccountWriter } from './writer.ts'

/**
 * The password, the authenticator app and the recovery codes. A new
 * password leaves both fields before it is sent; a new authenticator app is
 * set up with a QR code drawn locally and confirmed with one code
 * (`#replace-totp`); new recovery codes (`#regenerate-codes`) are handed to
 * the page, which shows them once. Every change goes through the writer.
 */
export function FactorsSection({
  factors,
  writer,
  feedback,
  onCodes,
}: {
  readonly factors: Readable<{ readonly items: readonly Factor[] }>
  readonly writer: AccountWriter
  readonly feedback: Feedback
  /** New recovery codes: the page shows them once. */
  readonly onCodes: (codes: readonly string[]) => void
}): ReactNode {
  const { client } = useApi()
  const headingId = useId()
  const ids = { password: useId(), confirm: useId() }
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [totp, setTotp] = useState<TotpSetup | undefined>(undefined)
  const items = readableValue(factors)?.items
  const replacing = items === undefined || hasTotp(items)
  const left = items === undefined ? undefined : recoveryCodesLeft(items)
  const locked = writer.busy !== undefined

  const changePassword = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const sent = password
    const same = password === confirm
    // Both fields are empty before anything is sent; a mismatch sends nothing.
    flushSync(() => {
      setPassword('')
      setConfirm('')
    })
    if (!same) {
      feedback.warn(t('enrollment.password.differ'))
      return
    }
    writer.write('password', async (reauth) => {
      await reauth(() => client.ceremony('/auth/password', { password: sent }))
      return t('account.password.changed')
    })
  }

  const startTotp = (): void =>
    writer.write('totp', async (reauth) => {
      setTotp(await reauth(() => client.ceremony<TotpSetup>('/auth/totp/options')))
      return undefined
    })

  const confirmTotp = (code: string): void =>
    writer.write('totp-confirm', async (reauth) => {
      await reauth(() => client.ceremony('/auth/totp', { code }))
      // The secret is not needed any more: it leaves the page's state.
      setTotp(undefined)
      return t('account.totp.replaced')
    })

  const regenerate = (): void =>
    writer.write('codes', async (reauth) => {
      const view = await reauth(() => client.ceremony<RecoveryCodesView>('/auth/recovery-codes'))
      onCodes(view.recoveryCodes)
      return undefined
    })

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <SectionHeading id={headingId}>{t('account.factors')}</SectionHeading>
      <form
        id="change-password"
        className="flex flex-col gap-3 sm:max-w-md"
        onSubmit={changePassword}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor={ids.password}>{t('enrollment.password.new')}</Label>
          <Input
            id={ids.password}
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={14}
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={ids.confirm}>{t('enrollment.password.repeat')}</Label>
          <Input
            id={ids.confirm}
            name="confirm"
            type="password"
            autoComplete="new-password"
            minLength={14}
            required
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </div>
        <div>
          <Button
            type="submit"
            variant="default"
            size="small"
            loading={writer.busy === 'password'}
            disabled={locked && writer.busy !== 'password'}
          >
            {t('account.password.change')}
          </Button>
        </div>
      </form>
      <div className="flex flex-col gap-3">
        <div>
          <Button
            id="replace-totp"
            type="button"
            variant="default"
            size="small"
            loading={writer.busy === 'totp'}
            disabled={locked && writer.busy !== 'totp'}
            onClick={startTotp}
          >
            {replacing ? t('account.totp.replace') : t('account.totp.setup')}
          </Button>
        </div>
        {totp === undefined ? null : (
          <TotpSetupPanel
            setup={totp}
            busy={writer.busy === 'totp-confirm'}
            disabled={locked}
            onConfirm={confirmTotp}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          id="regenerate-codes"
          type="button"
          variant="default"
          size="small"
          loading={writer.busy === 'codes'}
          disabled={locked && writer.busy !== 'codes'}
          onClick={regenerate}
        >
          {t('account.codes.regenerate')}
        </Button>
        {left === undefined ? null : (
          <span className="text-xs text-foreground-lighter">
            {t('account.codes.remaining', { count: left })}
          </span>
        )}
      </div>
    </section>
  )
}

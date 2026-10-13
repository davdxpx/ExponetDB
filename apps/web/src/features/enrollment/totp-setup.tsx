import type { TotpSetup } from '@exponetdb/contracts'
import { Button, Input, Label } from '@exponetdb/ui'
import { type FormEvent, type ReactNode, useId, useState } from 'react'
import { flushSync } from 'react-dom'
import { t } from '../../lib/i18n/i18n.ts'
import { groupSecret } from '../../lib/navigation/links.ts'
import { QrCode } from './qr-code.tsx'

/**
 * A new authenticator app: the QR code drawn locally from the server's
 * matrix, the key grouped in fours for typing, and one code to confirm it
 * (`#confirm-totp`). The setup (secret and URI) lives only in the state of
 * the page that asked for it and is dropped once the app is confirmed; the
 * code leaves its field as it is sent.
 */
export function TotpSetupPanel({
  setup,
  busy,
  disabled = false,
  onConfirm,
}: {
  readonly setup: TotpSetup
  readonly busy: boolean
  readonly disabled?: boolean
  readonly onConfirm: (code: string) => void
}): ReactNode {
  const [code, setCode] = useState('')
  const codeId = useId()
  const hintId = useId()
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const sent = code.trim()
    flushSync(() => setCode(''))
    onConfirm(sent)
  }
  return (
    <div className="totp flex flex-col gap-4 rounded-lg border border-default bg-surface-100 p-4">
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
        <QrCode rows={setup.qr.rows} size={setup.qr.size} label={t('enrollment.totp.qr')} />
        <div className="flex min-w-0 flex-col gap-2">
          <p id={hintId} className="text-sm text-foreground-light">
            {t('enrollment.totp.scan')}
          </p>
          <code
            id="totp-secret"
            aria-describedby={hintId}
            className="secret break-all rounded-md bg-surface-200 px-2 py-1 font-mono text-sm"
          >
            {groupSecret(setup.secret)}
          </code>
        </div>
      </div>
      <form id="confirm-totp" className="flex flex-col gap-2" onSubmit={submit}>
        <Label htmlFor={codeId}>{t('enrollment.totp.code.label')}</Label>
        <div className="flex gap-2">
          <Input
            id={codeId}
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            className="max-w-40"
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <Button
            type="submit"
            variant="primary"
            size="medium"
            loading={busy}
            disabled={disabled && !busy}
          >
            {t('enrollment.totp.code.submit')}
          </Button>
        </div>
      </form>
    </div>
  )
}

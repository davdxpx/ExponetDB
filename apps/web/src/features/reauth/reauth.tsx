import type { ReauthResult, RequestOptions } from '@exponetdb/contracts'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@exponetdb/ui'
import { type FormEvent, type ReactNode, useId, useState, useSyncExternalStore } from 'react'
import type { ApiClient } from '../../lib/api/client.ts'
import type { ConfirmIdentity } from '../../lib/api/reauth.ts'
import { assertWithPasskey, passkeysSupported } from '../../lib/auth/webauthn.ts'
import { describeError, t } from '../../lib/i18n/i18n.ts'

/**
 * The re-authentication dialog (identity.md §8, ADR-0032 §3): `withReauth`
 * calls `confirmIdentity` while the request gate is closed; the dialog asks
 * for a fresh passkey or authenticator proof and settles `true` once the
 * server accepted it, or `false` when the person cancels. Its own requests
 * bypass the closed gate (`ceremonyBypassingGate`); every other request
 * waits. Only one confirmation is open at a time (the gate is exclusive). The
 * window is decided and checked by the server only; the page never assumes
 * it is still open.
 */
interface OpenRequest {
  readonly client: ApiClient
  readonly settle: (confirmed: boolean) => void
}

export interface ReauthBridge {
  readonly confirmIdentity: ConfirmIdentity
  readonly subscribe: (listener: () => void) => () => void
  readonly current: () => OpenRequest | undefined
}

export function createReauthBridge(): ReauthBridge {
  let open: OpenRequest | undefined
  const listeners = new Set<() => void>()
  const emit = (): void => {
    for (const listener of listeners) listener()
  }
  return {
    confirmIdentity: (client) =>
      new Promise<boolean>((resolve) => {
        // A second request while one is open cannot happen behind the exclusive gate; if it
        // ever did, the earlier one is settled as canceled so no promise is left hanging.
        open?.settle(false)
        const request: OpenRequest = {
          client,
          settle: (confirmed) => {
            if (open === request) {
              open = undefined
              emit()
            }
            resolve(confirmed)
          },
        }
        open = request
        emit()
      }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    current: () => open,
  }
}

/** Renders the dialog of the bridge's open request, if any. Mounted once, near the root. */
export function ReauthHost({ bridge }: { readonly bridge: ReauthBridge }): ReactNode {
  const request = useSyncExternalStore(bridge.subscribe, bridge.current, bridge.current)
  if (request === undefined) return null
  // A new request gets a fresh dialog (no message or code left from an earlier one).
  return <ReauthDialog key={nextKey(request)} request={request} />
}

const keys = new WeakMap<OpenRequest, number>()
let counter = 0
function nextKey(request: OpenRequest): number {
  let key = keys.get(request)
  if (key === undefined) {
    counter += 1
    key = counter
    keys.set(request, key)
  }
  return key
}

function ReauthDialog({ request }: { readonly request: OpenRequest }): ReactNode {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [code, setCode] = useState('')
  const codeId = useId()
  const canUsePasskey = passkeysSupported()

  const attempt = (step: () => Promise<unknown>): void => {
    if (busy) return
    setBusy(true)
    setMessage('')
    step().then(
      () => request.settle(true),
      (error: unknown) => {
        setBusy(false)
        setMessage(describeError(error))
      },
    )
  }

  const withPasskey = (): void =>
    attempt(async () => {
      const options = await request.client.ceremonyBypassingGate<RequestOptions>(
        '/auth/reauth/passkey/options',
      )
      const credential = await assertWithPasskey(options)
      await request.client.ceremonyBypassingGate<ReauthResult>('/auth/reauth/passkey', {
        credential,
      })
    })

  const withCode = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const value = code.trim()
    attempt(async () => {
      try {
        await request.client.ceremonyBypassingGate<ReauthResult>('/auth/reauth/totp', {
          code: value,
        })
      } finally {
        setCode('')
      }
    })
  }

  return (
    <Dialog
      open
      // Escape, the overlay and the close button cancel, except while a proof is being checked.
      onRequestClose={() => {
        if (busy) return false
        request.settle(false)
        return undefined
      }}
    >
      <DialogContent data-reauth="" aria-busy={busy}>
        <DialogHeader>
          <DialogTitle>{t('reauth.title')}</DialogTitle>
          <DialogDescription>{t('reauth.description')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 px-5 pb-2">
          <p role="alert" className="text-sm text-destructive empty:hidden">
            {message}
          </p>
          {canUsePasskey ? (
            <Button
              id="reauth-passkey"
              type="button"
              variant="primary"
              size="medium"
              loading={busy}
              focusableWhenDisabled
              onClick={withPasskey}
            >
              {t('reauth.passkey')}
            </Button>
          ) : null}
          <form id="reauth-totp" className="flex flex-col gap-2" onSubmit={withCode}>
            <Label htmlFor={codeId}>{t('reauth.code.label')}</Label>
            <div className="flex gap-2">
              <Input
                id={codeId}
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={code}
                onChange={(event) => setCode(event.target.value)}
                disabled={busy}
              />
              <Button type="submit" variant="default" size="medium" disabled={busy}>
                {t('reauth.code.submit')}
              </Button>
            </div>
          </form>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="text"
            size="medium"
            disabled={busy}
            onClick={() => request.settle(false)}
          >
            {t('reauth.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

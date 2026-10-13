import type {
  CreationOptions,
  EnrollmentComplete,
  EnrollmentState,
  TotpSetup,
} from '@exponetdb/contracts'
import { Badge, Button, cn, Input, Label } from '@exponetdb/ui'
import { LoadingState, UntrustedName } from '@exponetdb/ui-patterns'
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react'
import { flushSync } from 'react-dom'
import { SignInLayout } from '../../layouts/sign-in-layout.tsx'
import type { ApiClient } from '../../lib/api/client.ts'
import { useApi } from '../../lib/api/context.tsx'
import { createPasskey } from '../../lib/auth/webauthn.ts'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import type { LinkPage } from '../../lib/navigation/links.ts'
import { type Feedback, FeedbackLines, useFeedback } from '../sign-in/feedback.tsx'
import { pageLoad } from '../sign-in/page-load.ts'
import { TimeText } from '../sign-in/time-text.tsx'
import { clearProgress, loadProgress, saveProgress } from './enrollment-storage.ts'
import { holdOneTimeLink, redeemHeldLink } from './link.ts'
import { RecoveryCodesPanel } from './recovery-codes.tsx'
import { TotpSetupPanel } from './totp-setup.tsx'

/**
 * Setup, invitation and recovery links (`/setup#token=exsu_…`,
 * `/invite#token=exiv_…`, `/recover#token=exrc_…`; identity.md §9). The
 * token was taken from the fragment and the fragment removed from the
 * address bar and the history by `main.tsx` before the router or any request
 * ran; the page redeems it once, from memory. The server keeps the ceremony
 * in the `__Host-exdb_ceremony` cookie; this tab keeps only the progress
 * (`sessionStorage['exdb.enrollment']`, never the token) so a reload shows
 * the steps already done. A person creates a passkey, sets a password and
 * confirms an authenticator app; nothing is active until "Finish setup",
 * which signs them in and shows the recovery codes once.
 */
type Phase =
  | { readonly kind: 'opening' }
  | { readonly kind: 'invalid'; readonly reason?: string }
  | { readonly kind: 'steps'; readonly state: EnrollmentState }
  | { readonly kind: 'codes'; readonly codes: readonly string[] }

const TITLE: Readonly<Record<LinkPage, MessageKey>> = {
  '/setup': 'enrollment.title.setup',
  '/invite': 'enrollment.title.invite',
  '/recover': 'enrollment.title.recover',
}

const INTRO: Readonly<Record<EnrollmentState['kind'], MessageKey>> = {
  setup: 'enrollment.intro.setup',
  invitation: 'enrollment.intro.invitation',
  recovery: 'enrollment.intro.recovery',
}

type Busy = 'passkey' | 'password' | 'totp' | 'totp-confirm' | 'finish'

export function EnrollmentPage({ page }: { readonly page: LinkPage }): ReactNode {
  const { client } = useApi()
  const feedback = useFeedback()
  const { clear, fail } = feedback
  const [phase, setPhase] = useState<Phase>({ kind: 'opening' })

  useEffect(() => {
    let live = true
    /** Redeems the token held for this page, if there is one; true when it started. */
    const redeem = (): boolean => {
      const redeeming = redeemHeldLink(page, (token) =>
        client.ceremony<EnrollmentState>('/auth/enrollment/redeem', { token }),
      )
      if (redeeming === undefined) return false
      setPhase({ kind: 'opening' })
      clear()
      redeeming.then(
        (state) => {
          if (!live) return
          saveProgress(state)
          setPhase({ kind: 'steps', state })
        },
        (error: unknown) => {
          if (!live) return
          // The progress of an earlier link stays (shown only; the server holds the ceremony).
          setPhase({ kind: 'invalid' })
          fail(error)
        },
      )
      return true
    }
    // A fragment the start-up did not take (a path the router matched loosely) leaves now.
    holdOneTimeLink(window.location, window.history)
    if (!redeem()) {
      const remembered = loadProgress(page)
      setPhase(
        remembered === undefined ? { kind: 'invalid' } : { kind: 'steps', state: remembered },
      )
    }
    // A second link opened in this tab changes only the fragment: it is taken and redeemed too.
    const onHashChange = (): void => {
      if (holdOneTimeLink(window.location, window.history)) redeem()
    }
    window.addEventListener('hashchange', onHashChange)
    return () => {
      live = false
      window.removeEventListener('hashchange', onHashChange)
    }
  }, [client, page, clear, fail])

  const heading = t(TITLE[page])
  const subheading = phase.kind === 'steps' ? t(INTRO[phase.state.kind]) : undefined

  return (
    <SignInLayout heading={heading} {...(subheading === undefined ? {} : { subheading })}>
      <div className="flex flex-col gap-6">
        <FeedbackLines feedback={feedback} />
        {phase.kind === 'opening' ? <LoadingState what={t('enrollment.opening')} /> : null}
        {phase.kind === 'invalid' ? (
          <p id="link-invalid" className="text-sm text-foreground">
            {t('enrollment.invalid')}
          </p>
        ) : null}
        {phase.kind === 'steps' ? (
          <Steps
            state={phase.state}
            feedback={feedback}
            onState={(state, message) => {
              saveProgress(state)
              setPhase({ kind: 'steps', state })
              feedback.say(t(message))
            }}
            onComplete={(done) => {
              clearProgress()
              setPhase({ kind: 'codes', codes: done.recoveryCodes })
            }}
            client={client}
          />
        ) : null}
        {phase.kind === 'codes' ? (
          <RecoveryCodesPanel codes={phase.codes} onContinue={() => pageLoad.assign('/account')} />
        ) : null}
      </div>
    </SignInLayout>
  )
}

function Steps({
  state,
  feedback,
  onState,
  onComplete,
  client,
}: {
  readonly state: EnrollmentState
  readonly feedback: Feedback
  readonly onState: (state: EnrollmentState, message: MessageKey) => void
  readonly onComplete: (done: EnrollmentComplete) => void
  readonly client: ApiClient
}): ReactNode {
  const [busy, setBusy] = useState<Busy | undefined>(undefined)
  const [label, setLabel] = useState(() => t('enrollment.passkey.default'))
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [totp, setTotp] = useState<TotpSetup | undefined>(undefined)
  const ids = { label: useId(), password: useId(), confirm: useId(), finishHint: useId() }

  const run = (kind: Busy, action: () => Promise<void>): void => {
    if (busy !== undefined) return
    setBusy(kind)
    feedback.clear()
    action().then(
      () => setBusy(undefined),
      (error: unknown) => {
        setBusy(undefined)
        feedback.fail(error)
      },
    )
  }

  const createKey = (): void =>
    run('passkey', async () => {
      const options = await client.ceremony<CreationOptions>('/auth/enrollment/passkey/options')
      const credential = await createPasskey(options)
      const name = label.trim()
      onState(
        await client.ceremony<EnrollmentState>('/auth/enrollment/passkey', {
          credential,
          ...(name === '' ? {} : { label: name }),
        }),
        'enrollment.passkey.created',
      )
    })

  const submitPassword = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const sent = password
    const same = password === confirm
    // Both fields are cleared before anything is sent; a mismatch sends nothing.
    flushSync(() => {
      setPassword('')
      setConfirm('')
    })
    if (!same) {
      feedback.warn(t('enrollment.password.differ'))
      return
    }
    run('password', async () => {
      onState(
        await client.ceremony<EnrollmentState>('/auth/enrollment/password', { password: sent }),
        'enrollment.password.saved',
      )
    })
  }

  const startTotp = (): void =>
    run('totp', async () => {
      setTotp(await client.ceremony<TotpSetup>('/auth/enrollment/totp/options'))
    })

  const confirmTotp = (code: string): void =>
    run('totp-confirm', async () => {
      const next = await client.ceremony<EnrollmentState>('/auth/enrollment/totp', { code })
      // The secret is not needed any more: it leaves the page's state.
      setTotp(undefined)
      onState(next, 'enrollment.totp.saved')
    })

  const finish = (): void =>
    run('finish', async () => {
      onComplete(await client.ceremony<EnrollmentComplete>('/auth/enrollment/complete'))
    })

  const ready = state.steps.passkey && state.steps.password && state.steps.totp
  const locked = busy !== undefined

  return (
    <div className="flex flex-col gap-6">
      <dl className="flex flex-col gap-1 text-sm">
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-foreground-lighter">{t('enrollment.account')}</dt>
          <dd className="m-0 min-w-0">
            <UntrustedName id="enrollment-email" name={state.email} />
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-foreground-lighter">{t('enrollment.validUntil')}</dt>
          <dd className="m-0">
            <TimeText value={state.expiresAt} />
          </dd>
        </div>
      </dl>
      <ol className="steps flex flex-col gap-3" aria-label={t('enrollment.steps')}>
        <Step
          title={t('enrollment.passkey.title')}
          hint={t('enrollment.passkey.hint')}
          done={state.steps.passkey}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor={ids.label}>{t('enrollment.passkey.label')}</Label>
            <Input
              id={ids.label}
              name="label"
              maxLength={64}
              autoComplete="off"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </div>
          <div>
            <Button
              id="create-passkey"
              type="button"
              variant="primary"
              size="medium"
              loading={busy === 'passkey'}
              disabled={locked && busy !== 'passkey'}
              onClick={createKey}
            >
              {t('enrollment.passkey.create')}
            </Button>
          </div>
        </Step>
        <Step
          title={t('enrollment.password.title')}
          hint={t('enrollment.password.hint')}
          done={state.steps.password}
        >
          <form id="set-password" className="flex flex-col gap-3" onSubmit={submitPassword}>
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
                variant="primary"
                size="medium"
                loading={busy === 'password'}
                disabled={locked && busy !== 'password'}
              >
                {t('enrollment.password.set')}
              </Button>
            </div>
          </form>
        </Step>
        <Step
          title={t('enrollment.totp.title')}
          hint={t('enrollment.totp.hint')}
          done={state.steps.totp}
        >
          {totp === undefined ? (
            <div>
              <Button
                id="setup-totp"
                type="button"
                variant="primary"
                size="medium"
                loading={busy === 'totp'}
                disabled={locked && busy !== 'totp'}
                onClick={startTotp}
              >
                {t('enrollment.totp.setup')}
              </Button>
            </div>
          ) : (
            <TotpSetupPanel
              setup={totp}
              busy={busy === 'totp-confirm'}
              disabled={locked}
              onConfirm={confirmTotp}
            />
          )}
        </Step>
      </ol>
      <div className="flex flex-col gap-2">
        <p id={ids.finishHint} className="text-xs text-foreground-lighter">
          {t('enrollment.finish.hint')}
        </p>
        <Button
          id="finish"
          type="button"
          variant="primary"
          size="large"
          block
          aria-describedby={ids.finishHint}
          loading={busy === 'finish'}
          disabled={!ready || (locked && busy !== 'finish')}
          onClick={finish}
        >
          {t('enrollment.finish')}
        </Button>
      </div>
    </div>
  )
}

/** One step of the enrollment; a finished step shows its title and "Done" only. */
function Step({
  title,
  hint,
  done,
  children,
}: {
  readonly title: string
  readonly hint: string
  readonly done: boolean
  readonly children: ReactNode
}): ReactNode {
  const headingId = useId()
  return (
    <li
      aria-labelledby={headingId}
      className={cn(
        'step flex flex-col gap-3 rounded-lg border border-default bg-surface-100 p-4',
        done && 'done',
      )}
    >
      <h2 id={headingId} className="flex items-center gap-2 text-base font-medium text-foreground">
        {title}
        {done ? <Badge variant="success">{t('enrollment.step.done')}</Badge> : null}
      </h2>
      <p className="text-sm text-foreground-light">{hint}</p>
      {done ? null : children}
    </li>
  )
}

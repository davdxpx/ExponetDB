import type { RequestOptions, SecondFactorStep, SignedIn } from '@exponetdb/contracts'
import { Button, Input, Label } from '@exponetdb/ui'
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { SignInLayout } from '../../layouts/sign-in-layout.tsx'
import { useApi } from '../../lib/api/context.tsx'
import { assertWithPasskey, passkeysSupported } from '../../lib/auth/webauthn.ts'
import { t } from '../../lib/i18n/i18n.ts'
import { FeedbackLines, useFeedback } from './feedback.tsx'
import { pageLoad } from './page-load.ts'
import { probeSession } from './session-probe.ts'
import { afterSignIn, secondFactorForms } from './sign-in-model.ts'

/**
 * Sign-in (`/login`, identity.md §8 and §9): a passkey first (discoverable,
 * nothing to type, nothing to enumerate), the password with a second factor
 * as the fallback, and a recovery code instead of the second factor. The
 * password step answers the same whatever was wrong, so the page shows the
 * same second step for an unknown address and a wrong password, and every
 * failure of the second step reads the same (`AUTHENTICATION_FAILED`). A
 * password or code leaves its field as it is sent. After signing in the
 * browser loads `returnTo` when it is on the exact allowlist, else the
 * account page; a recovery session always goes to the account page.
 */
type Busy = 'passkey' | 'password' | 'totp' | 'recovery' | 'leaving'

export function SignInPage({ returnTo }: { readonly returnTo: string | null }): ReactNode {
  const { client } = useApi()
  const feedback = useFeedback()
  const [busy, setBusy] = useState<Busy | undefined>(undefined)
  const [step, setStep] = useState<SecondFactorStep | undefined>(undefined)
  const [withRecoveryCode, setWithRecoveryCode] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [recoveryCode, setRecoveryCode] = useState('')
  const ids = {
    email: useId(),
    password: useId(),
    code: useId(),
    recovery: useId(),
    recoveryHint: useId(),
    heading: useId(),
  }
  const canUsePasskey = passkeysSupported()

  // The latest returnTo for the probe's answer (the router may write the query back in its
  // canonical form after the first render).
  const target = useRef(returnTo)
  useEffect(() => {
    target.current = returnTo
  }, [returnTo])

  // A person who is signed in already goes on at once (the probe never leaves for this page).
  useEffect(() => {
    const controller = new AbortController()
    void probeSession(client, controller.signal).then((me) => {
      if (me === undefined || controller.signal.aborted) return
      setBusy('leaving')
      pageLoad.assign(
        afterSignIn(
          { assurance: me.session.assurance, recoveryRequired: me.identity.recoveryRequired },
          target.current,
        ),
      )
    })
    return () => controller.abort()
  }, [client])

  const enter = (signedIn: SignedIn): void => {
    setBusy('leaving')
    feedback.say(t('signIn.done'))
    pageLoad.assign(afterSignIn(signedIn, returnTo))
  }

  /** Runs one ceremony at a time; a failure shows its catalog text and frees the page. */
  const run = (kind: Busy, ceremony: () => Promise<void>): void => {
    if (busy !== undefined) return
    setBusy(kind)
    feedback.clear()
    ceremony().then(
      () => setBusy((current) => (current === 'leaving' ? current : undefined)),
      (error: unknown) => {
        setBusy(undefined)
        feedback.fail(error)
      },
    )
  }

  const signInWithPasskey = (): void =>
    run('passkey', async () => {
      const options = await client.ceremony<RequestOptions>('/auth/login/passkey/options')
      const credential = await assertWithPasskey(options)
      enter(await client.ceremony<SignedIn>('/auth/login/passkey', { credential }))
    })

  const submitPassword = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const sent = { email, password }
    // The password leaves the field (and the page's state) before it is sent.
    flushSync(() => setPassword(''))
    run('password', async () => {
      const next = await client.ceremony<SecondFactorStep>('/auth/login/password', sent)
      setStep(next)
      setWithRecoveryCode(false)
      feedback.say(t('signIn.totp.prompt'))
    })
  }

  const submitCode = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const sent = code.trim()
    flushSync(() => setCode(''))
    run('totp', async () => {
      enter(await client.ceremony<SignedIn>('/auth/login/totp', { code: sent }))
    })
  }

  const submitRecoveryCode = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const sent = recoveryCode.trim()
    flushSync(() => setRecoveryCode(''))
    run('recovery', async () => {
      enter(await client.ceremony<SignedIn>('/auth/login/recovery-code', { code: sent }))
    })
  }

  const startOver = (): void => {
    setStep(undefined)
    setWithRecoveryCode(false)
    setCode('')
    setRecoveryCode('')
    feedback.clear()
  }

  const locked = busy !== undefined
  const forms = step === undefined ? undefined : secondFactorForms(step)

  return (
    <SignInLayout heading={t('signIn.title')} subheading={t('signIn.subtitle')}>
      <div className="flex flex-col gap-6">
        <FeedbackLines feedback={feedback} />
        {canUsePasskey ? (
          <Button
            id="passkey-sign-in"
            type="button"
            variant="primary"
            size="large"
            block
            loading={busy === 'passkey'}
            disabled={locked && busy !== 'passkey'}
            onClick={signInWithPasskey}
          >
            {t('signIn.passkey')}
          </Button>
        ) : (
          <p className="text-sm text-foreground-light">{t('signIn.passkey.unsupported')}</p>
        )}
        <section aria-labelledby={ids.heading} className="flex flex-col gap-4">
          <h2 id={ids.heading} className="text-sm font-medium text-foreground-light">
            {step === undefined ? t('signIn.password.heading') : t('signIn.secondFactor.heading')}
          </h2>
          {step === undefined || forms === undefined ? (
            <form id="password-sign-in" className="flex flex-col gap-4" onSubmit={submitPassword}>
              <div className="flex flex-col gap-2">
                <Label htmlFor={ids.email}>{t('signIn.email')}</Label>
                <Input
                  id={ids.email}
                  name="email"
                  type="email"
                  autoComplete="username"
                  inputMode="email"
                  spellCheck={false}
                  autoCapitalize="none"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor={ids.password}>{t('signIn.password')}</Label>
                <Input
                  id={ids.password}
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
              <Button
                type="submit"
                variant="default"
                size="medium"
                block
                loading={busy === 'password'}
                disabled={locked && busy !== 'password'}
              >
                {t('signIn.password.submit')}
              </Button>
            </form>
          ) : (
            <div id="second-factor" className="flex flex-col gap-4">
              {forms.totp && !withRecoveryCode ? (
                <form id="totp-sign-in" className="flex flex-col gap-4" onSubmit={submitCode}>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={ids.code}>{t('signIn.totp.label')}</Label>
                    <Input
                      id={ids.code}
                      name="code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern="[0-9]{6}"
                      maxLength={6}
                      required
                      value={code}
                      onChange={(event) => setCode(event.target.value)}
                    />
                  </div>
                  <Button
                    type="submit"
                    variant="primary"
                    size="medium"
                    block
                    loading={busy === 'totp'}
                    disabled={locked && busy !== 'totp'}
                  >
                    {t('signIn.totp.submit')}
                  </Button>
                </form>
              ) : null}
              {forms.recoveryCode && withRecoveryCode ? (
                <form
                  id="recovery-sign-in"
                  className="flex flex-col gap-4"
                  onSubmit={submitRecoveryCode}
                >
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={ids.recovery}>{t('signIn.recovery.label')}</Label>
                    <Input
                      id={ids.recovery}
                      name="code"
                      autoComplete="off"
                      autoCapitalize="characters"
                      spellCheck={false}
                      required
                      aria-describedby={ids.recoveryHint}
                      value={recoveryCode}
                      onChange={(event) => setRecoveryCode(event.target.value)}
                    />
                    <p id={ids.recoveryHint} className="text-xs text-foreground-lighter">
                      {t('signIn.recovery.hint')}
                    </p>
                  </div>
                  <Button
                    type="submit"
                    variant="primary"
                    size="medium"
                    block
                    loading={busy === 'recovery'}
                    disabled={locked && busy !== 'recovery'}
                  >
                    {t('signIn.recovery.submit')}
                  </Button>
                </form>
              ) : null}
              <div className="flex flex-col items-start gap-1">
                {forms.recoveryCode && !withRecoveryCode ? (
                  <Button
                    id="use-recovery-code"
                    type="button"
                    variant="link"
                    size="small"
                    disabled={locked}
                    onClick={() => {
                      setCode('')
                      setWithRecoveryCode(true)
                    }}
                  >
                    {t('signIn.recovery.toggle')}
                  </Button>
                ) : null}
                {forms.totp && withRecoveryCode ? (
                  <Button
                    id="use-totp"
                    type="button"
                    variant="link"
                    size="small"
                    disabled={locked}
                    onClick={() => {
                      setRecoveryCode('')
                      setWithRecoveryCode(false)
                    }}
                  >
                    {t('signIn.totp.toggle')}
                  </Button>
                ) : null}
                <Button
                  id="restart-sign-in"
                  type="button"
                  variant="link"
                  size="small"
                  disabled={locked}
                  onClick={startOver}
                >
                  {t('signIn.restart')}
                </Button>
              </div>
            </div>
          )}
        </section>
      </div>
    </SignInLayout>
  )
}

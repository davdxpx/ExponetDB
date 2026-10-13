import type { ConsentView } from '@exponetdb/contracts'
import { Button, Label } from '@exponetdb/ui'
import { Admonition } from '@exponetdb/ui-patterns'
import { type FormEvent, type ReactNode, useId, useState } from 'react'
import { InterstitialLayout, ProductTile } from '../../layouts/interstitial-layout.tsx'
import { useApi } from '../../lib/api/context.tsx'
import { withReauth } from '../../lib/api/reauth.ts'
import { describeError, t } from '../../lib/i18n/i18n.ts'
import { useMe } from '../../lib/session/guard.tsx'
import type { ConsentDecision } from '../consent/consent-model.ts'
import { DetailRows, signedInRow } from '../consent/consent-parts.tsx'
import { ConsentScreen, DecisionScreen } from '../consent/consent-screens.tsx'
import { CodeInput } from './code-input.tsx'
import { codeLetters, formatUserCode, isCompleteCode } from './user-code.ts'

/**
 * `/oauth/device` (oauth.md §5, threat model "device-code phishing"): the
 * person types the code their CLI shows (never taken from a link: there is
 * no `verification_uri_complete` and the page reads no query or fragment),
 * reads what the device asks for with `POST /auth/oauth/device/view`, and
 * decides with `POST /auth/oauth/device` on the same consent screen as a
 * browser request, behind a warning that a code someone sent is an attempt
 * to get access. The code stays in this component's memory only; every try
 * counts against the person on the server.
 */
type Step =
  | { readonly kind: 'entry' }
  | { readonly kind: 'consent'; readonly code: string; readonly view: ConsentView }
  | {
      readonly kind: 'done'
      readonly view: ConsentView
      readonly decision: ConsentDecision
      readonly status: 'approved' | 'denied'
    }

export function DevicePage(): ReactNode {
  const { client, confirmIdentity } = useApi()
  const me = useMe()
  const [step, setStep] = useState<Step>({ kind: 'entry' })

  if (step.kind === 'entry') {
    return (
      <CodeEntry
        onView={(code, view) => setStep({ kind: 'consent', code, view })}
        readView={(code) =>
          client.ceremony<ConsentView>('/auth/oauth/device/view', { userCode: code })
        }
      />
    )
  }

  if (step.kind === 'done') {
    const approved = step.status === 'approved'
    return (
      <DecisionScreen
        view={step.view}
        me={me}
        decision={step.decision}
        title={t(approved ? 'device.approved.title' : 'device.denied.title')}
      >
        <p id="device-done" role="status" className="text-center text-sm text-foreground">
          {t(approved ? 'device.approved' : 'device.denied')}
        </p>
        <Button
          type="button"
          variant="default"
          size="medium"
          block
          onClick={() => setStep({ kind: 'entry' })}
        >
          {t('device.another')}
        </Button>
      </DecisionScreen>
    )
  }

  const { code, view } = step
  const decide = async (decision: ConsentDecision): Promise<void> => {
    const result = await withReauth(client, confirmIdentity, () =>
      client.ceremony<{ readonly status: 'approved' | 'denied' }>('/auth/oauth/device', {
        userCode: code,
        ...decision,
      }),
    )
    setStep({ kind: 'done', view, decision, status: result.status })
  }
  return (
    <ConsentScreen
      view={view}
      me={me}
      onDecide={decide}
      preface={
        <>
          <div className="flex flex-col items-center gap-1 text-center">
            <p className="text-xs text-foreground-light">{t('device.check')}</p>
            <strong className="font-mono text-xl tracking-widest text-foreground">{code}</strong>
          </div>
          <Admonition
            id="device-warning"
            role="note"
            type="warning"
            title={t('device.warning.title')}
            description={t('device.warning')}
          />
        </>
      }
    />
  )
}

function CodeEntry({
  readView,
  onView,
}: {
  readonly readView: (code: string) => Promise<ConsentView>
  readonly onView: (code: string, view: ConsentView) => void
}): ReactNode {
  const me = useMe()
  const [letters, setLetters] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const ids = { input: useId(), hint: useId(), error: useId() }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (busy) return
    const typed = codeLetters(letters)
    if (!isCompleteCode(typed)) {
      setError(t('device.code.incomplete'))
      return
    }
    const code = formatUserCode(typed)
    setBusy(true)
    setError(undefined)
    try {
      onView(code, await readView(code))
    } catch (failure) {
      setError(describeError(failure))
      setBusy(false)
    }
  }

  return (
    <InterstitialLayout
      logo={<ProductTile />}
      title={t('device.title')}
      description={t('device.description')}
    >
      <div className="flex flex-col gap-5 px-6 pb-6">
        <form
          id="device-code"
          className="flex flex-col gap-3"
          noValidate
          onSubmit={(event) => void submit(event)}
        >
          <Label htmlFor={ids.input}>{t('device.code.label')}</Label>
          <CodeInput
            id={ids.input}
            value={letters}
            disabled={busy}
            invalid={error !== undefined}
            describedBy={error === undefined ? ids.hint : `${ids.hint} ${ids.error}`}
            onChange={(next) => {
              setLetters(next)
              setError(undefined)
            }}
          />
          <p id={ids.hint} className="text-xs text-foreground-lighter">
            {t('device.code.hint')}
          </p>
          {error === undefined ? null : (
            <p id={ids.error} role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" size="medium" block loading={busy}>
            {t('device.continue')}
          </Button>
        </form>
        <DetailRows rows={[signedInRow(me)]} />
      </div>
    </InterstitialLayout>
  )
}

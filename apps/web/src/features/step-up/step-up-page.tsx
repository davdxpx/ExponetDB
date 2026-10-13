import { Button, Input, Label } from '@exponetdb/ui'
import {
  FailedReadState,
  formatUtc,
  KeyValueList,
  LoadingState,
  MarkedCode,
  UntrustedName,
} from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react'
import {
  InitialTile,
  InterstitialLayout,
  LogoPair,
  ProductTile,
} from '../../layouts/interstitial-layout.tsx'
import { useApi } from '../../lib/api/context.tsx'
import { withReauth } from '../../lib/api/reauth.ts'
import { describeError, type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { stepUpOf } from '../../lib/navigation/links.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import { useFragmentBinding } from '../approvals/fragment-binding.ts'
import { type StepUpView, stepUpQuery } from './keys.ts'

/**
 * Confirming a CLI step-up (`/step-up#id=stu_…`, ADR-0026 §2): the person
 * signed in here is the person whose CLI asked; the page shows which client,
 * which action and which plan hash, and asks for the code the terminal shows.
 * The confirmation needs a fresh passkey or authenticator proof (the server
 * decides the window; `withReauth` asks for it). A step-up of anybody else
 * reads as not found. The code field is emptied when the code is sent, and
 * the page never shows or caches the code. Another fragment reloads the page.
 */
export function StepUpPage(): ReactNode {
  const fragment = useFragmentBinding()
  const [id] = useState(() => stepUpOf(fragment))
  if (id === undefined) {
    return (
      <InterstitialLayout title={t('stepUp.title')}>
        <p id="step-up-missing" className="px-6 pb-6 text-center text-sm">
          {t('stepUp.missing')}
        </p>
      </InterstitialLayout>
    )
  }
  return <StepUpFor id={id} />
}

const ACTIONS: Readonly<Record<string, MessageKey>> = {
  'plan.apply': 'stepUp.action.planApply',
  'node.enrollment_token.reveal': 'stepUp.action.enrollmentReveal',
}

type Outcome =
  | { readonly kind: 'confirmed'; readonly receiptExpiresAt: string | null }
  | { readonly kind: 'canceled' }

function StepUpFor({ id }: { readonly id: string }): ReactNode {
  const { client } = useApi()
  const read = useQuery(stepUpQuery(client, id))
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  let body: ReactNode
  if (outcome?.kind === 'confirmed') {
    const until =
      outcome.receiptExpiresAt === null ? undefined : formatUtc(outcome.receiptExpiresAt)
    body = (
      <p id="step-up-done" role="status" className="px-6 pb-6 text-center text-sm">
        {until === undefined ? t('stepUp.doneSoon') : t('stepUp.done', { time: until })}
      </p>
    )
  } else if (outcome?.kind === 'canceled') {
    body = (
      <p id="step-up-canceled" role="status" className="px-6 pb-6 text-center text-sm">
        {t('stepUp.canceled')}
      </p>
    )
  } else if (read.data !== undefined) {
    body =
      read.data.state === 'pending' ? (
        <PendingStepUp view={read.data} onOutcome={setOutcome} />
      ) : (
        <p id="step-up-state" className="px-6 pb-6 text-center text-sm">
          {t('stepUp.state', { state: read.data.state })}
        </p>
      )
  } else if (read.isError) {
    const failure = classifyFailure(read.error)
    body = (
      <div className="px-6 pb-6">
        <FailedReadState
          what={t('stepUp.read.what')}
          error={{ code: failure.code, message: failure.message }}
          onRetry={() => void read.refetch()}
          busy={read.isFetching}
          headingLevel={2}
        />
      </div>
    )
  } else {
    body = (
      <div className="px-6 pb-6">
        <LoadingState what={t('stepUp.read.what')} />
      </div>
    )
  }

  const clientName = read.data?.clientName ?? null
  return (
    <InterstitialLayout
      title={t('stepUp.title')}
      description={t('stepUp.description')}
      logo={
        clientName === null ? undefined : (
          <LogoPair left={<InitialTile name={clientName} />} right={<ProductTile />} />
        )
      }
    >
      {body}
    </InterstitialLayout>
  )
}

function PendingStepUp({
  view,
  onOutcome,
}: {
  readonly view: StepUpView
  readonly onOutcome: (outcome: Outcome) => void
}): ReactNode {
  const { client, confirmIdentity } = useApi()
  const codeRef = useRef<HTMLInputElement>(null)
  const inFlight = useRef(false)
  const [busy, setBusy] = useState<'confirm' | 'cancel' | null>(null)
  const [error, setError] = useState('')
  const codeId = 'step-up-code'
  const hintId = useId()
  const action = Object.hasOwn(ACTIONS, view.action) ? ACTIONS[view.action] : undefined
  const expires = formatUtc(view.expiresAt)

  const run = async (which: 'confirm' | 'cancel', step: () => Promise<Outcome>) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(which)
    setError('')
    try {
      onOutcome(await step())
    } catch (failure) {
      setError(describeError(failure))
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }

  const confirm = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (inFlight.current) return
    const field = codeRef.current
    const code = (field?.value ?? '').trim()
    // The code leaves the field before anything is sent (C-20).
    if (field !== null) field.value = ''
    if (code === '') {
      setError(t('stepUp.code.empty'))
      field?.focus()
      return
    }
    void run('confirm', async () => {
      const confirmed = await withReauth(client, confirmIdentity, () =>
        client.operation('confirmStepUp', {
          params: { stepUpId: view.id },
          body: { userCode: code },
        }),
      )
      return { kind: 'confirmed', receiptExpiresAt: confirmed.receiptExpiresAt }
    })
  }

  const cancel = (): void => {
    void run('cancel', async () => {
      await client.operation('cancelStepUp', { params: { stepUpId: view.id }, body: {} })
      return { kind: 'canceled' }
    })
  }

  return (
    <section id="step-up" aria-label={t('stepUp.title')} className="flex flex-col gap-4 px-6 pb-6">
      <KeyValueList
        layout="stacked"
        items={[
          {
            id: 'client',
            label: t('stepUp.client'),
            value:
              view.clientName === null ? (
                t('stepUp.client.unknown')
              ) : (
                <span id="step-up-client">
                  <UntrustedName name={view.clientName} label={t('stepUp.client')} />
                </span>
              ),
          },
          {
            id: 'action',
            label: t('stepUp.action'),
            value: (
              <span id="step-up-action">
                {action === undefined ? (
                  <UntrustedName name={view.action} mono label={t('stepUp.action')} />
                ) : (
                  t(action)
                )}
              </span>
            ),
          },
          ...(view.planHash === null
            ? []
            : [
                {
                  id: 'plan-hash',
                  label: t('stepUp.planHash'),
                  value: <MarkedCode text={view.planHash} className="hash text-xs break-all" />,
                },
              ]),
          {
            id: 'expires',
            label: t('stepUp.expires'),
            value: expires ?? t('stepUp.expires.unknown'),
          },
        ]}
      />
      <p id={hintId} className="text-sm text-foreground-light">
        {t('stepUp.hint')}
      </p>
      <form className="flex flex-col gap-3" onSubmit={confirm} noValidate>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={codeId}>{t('stepUp.code.label')}</Label>
          <Input
            id={codeId}
            ref={codeRef}
            name="code"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            inputMode="text"
            placeholder={t('stepUp.code.placeholder')}
            maxLength={9}
            aria-describedby={hintId}
            aria-invalid={error === '' ? undefined : true}
            disabled={busy !== null}
          />
        </div>
        {/* Stays in the page while empty, so a new message is announced. */}
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            variant="primary"
            size="small"
            // The class the browser suites press the confirmation by (order Appendix C).
            className="primary"
            loading={busy === 'confirm'}
            disabled={busy !== null}
          >
            {t('stepUp.confirm')}
          </Button>
          <Button
            type="button"
            variant="default"
            size="small"
            loading={busy === 'cancel'}
            disabled={busy !== null}
            onClick={cancel}
          >
            {t('stepUp.cancel')}
          </Button>
        </div>
      </form>
    </section>
  )
}

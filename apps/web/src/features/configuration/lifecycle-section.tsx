import { Button } from '@exponetdb/ui'
import {
  ConfirmDialog,
  NotPermittedState,
  TierChip,
  TypedConfirmDialog,
  UntrustedName,
} from '@exponetdb/ui-patterns'
import { type FormEvent, type ReactNode, useId, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { useMe } from '../../lib/session/guard.tsx'
import { holds } from '../access/fields.tsx'
import type { Target } from '../target/queries.ts'
import { Section } from '../target-ops/section.tsx'
import { phrase } from '../targets/phrase.ts'
import { useGuardedPlan } from '../targets/plan-request.ts'
import { lifecycleOffers, type ReasonProblem, reasonCodeProblem } from './lifecycle-model.ts'
import { ReasonCodeField } from './reason-code-field.tsx'

/**
 * The lifecycle of a target on its configuration page: suspend (writes
 * stop, observation continues), resume (a suspended target) and, in the
 * danger zone, decommission. Each is a plan (`registry.manage`): the page
 * asks the server for the plan with the reason code the contract requires
 * and opens the plan review page; nothing is applied here. A person without
 * `registry.manage` gets a named "not permitted" state instead of controls
 * that would be refused. Decommission needs the exact target path typed and
 * says that the path is never reused.
 */
export function LifecycleSection({ target }: { readonly target: Target }): ReactNode {
  const me = useMe()
  return (
    <Section
      id="lifecycle"
      title={t('configuration.lifecycle.title')}
      description={t('configuration.lifecycle.description')}
    >
      {holds(me, 'registry.manage') ? (
        <LifecycleActions target={target} />
      ) : (
        <NotPermittedState
          what={phrase('configuration.lifecycle.notPermitted')}
          permission="registry.manage"
          headingLevel={3}
        />
      )}
    </Section>
  )
}

const STATE_WORDS: Readonly<Record<string, MessageKey>> = {
  registered: 'targets.state.registered',
  active: 'targets.state.active',
  suspended: 'targets.state.suspended',
  decommissioned: 'targets.state.decommissioned',
}

function LifecycleActions({ target }: { readonly target: Target }): ReactNode {
  const offers = lifecycleOffers(target.state)
  const key = STATE_WORDS[target.state]
  return (
    <div className="flex flex-col gap-6" data-lifecycle={target.state}>
      <p className="m-0 flex flex-wrap items-center gap-2 text-sm">
        {key === undefined ? (
          <UntrustedName name={target.state} mono label={t('configuration.target.state')} />
        ) : (
          t('configuration.lifecycle.state', { state: t(key).toLowerCase() })
        )}
        <TierChip tier={target.tier} />
      </p>
      {target.state === 'decommissioned' ? (
        <p className="m-0 text-sm text-foreground-light">
          {t('configuration.lifecycle.decommissioned')}
        </p>
      ) : null}
      {target.state === 'registered' ? (
        <p className="m-0 text-sm text-foreground-light">
          {t('configuration.lifecycle.suspend.registered')}
        </p>
      ) : null}
      {offers.suspend ? <ReasonedPlan kind="suspend" target={target} /> : null}
      {offers.resume ? <ReasonedPlan kind="resume" target={target} /> : null}
      {offers.decommission ? <ReasonedPlan kind="decommission" target={target} /> : null}
    </div>
  )
}

type Kind = 'suspend' | 'resume' | 'decommission'

const OPERATION = {
  suspend: 'planTargetSuspension',
  resume: 'planTargetResumption',
  decommission: 'planTargetDecommission',
} as const

const TEXT: Readonly<
  Record<
    Kind,
    {
      readonly title: MessageKey
      readonly body: MessageKey
      readonly submit: MessageKey
      readonly confirmTitle: MessageKey
      readonly confirmBody: MessageKey
      readonly confirmAction: MessageKey
    }
  >
> = {
  suspend: {
    title: 'configuration.lifecycle.suspend.title',
    body: 'configuration.lifecycle.suspend.body',
    submit: 'configuration.lifecycle.suspend.submit',
    confirmTitle: 'configuration.lifecycle.suspend.confirm.title',
    confirmBody: 'configuration.lifecycle.suspend.confirm.body',
    confirmAction: 'configuration.lifecycle.suspend.confirm.action',
  },
  resume: {
    title: 'configuration.lifecycle.resume.title',
    body: 'configuration.lifecycle.resume.body',
    submit: 'configuration.lifecycle.resume.submit',
    confirmTitle: 'configuration.lifecycle.resume.confirm.title',
    confirmBody: 'configuration.lifecycle.resume.confirm.body',
    confirmAction: 'configuration.lifecycle.resume.confirm.action',
  },
  decommission: {
    title: 'configuration.lifecycle.decommission.title',
    body: 'configuration.lifecycle.decommission.body',
    submit: 'configuration.lifecycle.decommission.submit',
    confirmTitle: 'configuration.lifecycle.decommission.confirm.title',
    confirmBody: 'configuration.lifecycle.decommission.confirm.body',
    confirmAction: 'configuration.lifecycle.decommission.confirm.action',
  },
}

/**
 * One lifecycle plan: the reason code, then a confirmation (the ladder step
 * for what the plan does), then the plan request. Suspend and resume are
 * reversible and confirm once; decommission is not, and needs the exact
 * target path typed. The confirmation names the tier, so a production target
 * is recognizable in the dialog.
 */
function ReasonedPlan({
  kind,
  target,
}: {
  readonly kind: Kind
  readonly target: Target
}): ReactNode {
  const { client } = useApi()
  const createPlan = useGuardedPlan()
  const id = useId()
  const text = TEXT[kind]
  const [reason, setReason] = useState('')
  const [problem, setProblem] = useState<ReasonProblem | undefined>(undefined)
  const [confirming, setConfirming] = useState(false)

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const found = reasonCodeProblem(reason, true)
    setProblem(found)
    if (found === undefined) setConfirming(true)
  }
  const create = async (): Promise<void> => {
    await createPlan(() =>
      client.operation(OPERATION[kind], {
        params: { target: target.id },
        body: { reason: reason.trim() },
      }),
    )
  }
  const description = t(text.confirmBody, { path: target.path })
  const common = {
    open: confirming,
    onOpenChange: setConfirming,
    title: t(text.confirmTitle),
    description,
    actionLabel: t(text.confirmAction),
    tier: target.tier,
    onConfirm: create,
  } as const

  return (
    <section
      aria-labelledby={`${id}-title`}
      data-lifecycle-plan={kind}
      className="flex max-w-2xl flex-col gap-3 rounded-md border border-default p-card"
    >
      <h3 id={`${id}-title`} className="m-0 text-base font-medium text-foreground">
        {t(text.title)}
      </h3>
      <p className="m-0 text-sm text-foreground-light">{t(text.body)}</p>
      <form noValidate className="flex flex-col gap-3" onSubmit={submit}>
        <ReasonCodeField
          id={`${id}-reason`}
          value={reason}
          problem={problem}
          onChange={(value) => {
            setReason(value)
            if (problem !== undefined) setProblem(undefined)
          }}
        />
        <div>
          <Button
            type="submit"
            variant={kind === 'decommission' ? 'danger' : 'default'}
            size="small"
          >
            {t(text.submit)}
          </Button>
        </div>
      </form>
      {kind === 'decommission' ? (
        <TypedConfirmDialog
          {...common}
          destructive
          expectedText={target.path}
          expectedTextName={phrase('configuration.lifecycle.decommission.typedName')}
          resetKey={`${target.id}:${target.generation}`}
        />
      ) : (
        <ConfirmDialog {...common} />
      )}
    </section>
  )
}

import type { Cluster, EndpointView } from '@exponetdb/sdk/operations'
import { Button } from '@exponetdb/ui'
import { UntrustedName, WarningConfirmDialog } from '@exponetdb/ui-patterns'
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { ApiError } from '../../lib/api/errors.ts'
import { describeError, t } from '../../lib/i18n/i18n.ts'
import { useMe } from '../../lib/session/guard.tsx'
import { holds } from '../access/fields.tsx'
import { type ReasonProblem, reasonCodeProblem } from '../configuration/lifecycle-model.ts'
import { ReasonCodeField } from '../configuration/reason-code-field.tsx'
import { useGuardedPlan } from '../targets/plan-request.ts'
import { EndpointFields } from './endpoint-fields.tsx'
import {
  type EndpointKind,
  emptyEndpoint,
  endpointProblems,
  endpointRequest,
} from './endpoint-model.ts'

/** The kinds a cluster takes: a local socket is for the host of a cluster a node agent manages. */
export function kindsFor(cluster: Pick<Cluster, 'managementMode'>): readonly EndpointKind[] {
  return cluster.managementMode === 'agent'
    ? ['private', 'public', 'pooler', 'local_socket']
    : ['private', 'public', 'pooler']
}

/** Whether the person is offered endpoint changes at all (the server decides again on each request). */
function useCanChange(): boolean {
  return holds(useMe(), 'registry.manage')
}

/**
 * "Add an endpoint": kind, host, port, label and TLS server name, sent as a
 * plan (`planEndpoint`, `registry.manage`, with a fresh proof when the server
 * asks). An endpoint is never edited: a changed address is a new endpoint and
 * the old one is retired afterwards. A retired cluster takes none; a person
 * without `registry.manage` gets a sentence instead of the form.
 */
export function AddEndpoint({ cluster }: { readonly cluster: Cluster }): ReactNode {
  const allowed = useCanChange()
  if (!allowed) {
    return (
      <p className="m-0 text-sm text-foreground-light" data-state="not-permitted">
        {t('infra.endpoint.manage.notPermitted')}
      </p>
    )
  }
  if (cluster.state === 'retired') {
    return <p className="m-0 text-sm text-foreground-light">{t('infra.endpoint.add.pending')}</p>
  }
  return <AddEndpointForm cluster={cluster} />
}

function AddEndpointForm({ cluster }: { readonly cluster: Cluster }): ReactNode {
  const { client } = useApi()
  const createPlan = useGuardedPlan()
  const id = useId()
  const [draft, setDraft] = useState(() => emptyEndpoint())
  const [problems, setProblems] = useState<ReturnType<typeof endpointProblems>>({})
  const [failure, setFailure] = useState('')
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const found = endpointProblems(draft)
    setProblems(found)
    setFailure('')
    if (Object.keys(found).length > 0 || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      await createPlan(() =>
        client.operation('planEndpoint', {
          params: { clusterId: cluster.id },
          body: endpointRequest(draft),
        }),
      )
    } catch (error) {
      setFailure(describeError(error))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <form
      id="add-endpoint-form"
      className="flex flex-col gap-3"
      noValidate
      onSubmit={submit}
      aria-labelledby={`${id}-title`}
    >
      <h3 id={`${id}-title`} className="m-0 text-sm font-medium text-foreground">
        {t('infra.endpoint.add.title')}
      </h3>
      <p className="m-0 max-w-3xl text-sm text-foreground-light">
        {t('infra.endpoint.add.description')}
      </p>
      <EndpointFields
        id={id}
        draft={draft}
        problems={problems}
        kinds={kindsFor(cluster)}
        disabled={busy}
        onChange={setDraft}
      />
      <p className="alert m-0 min-h-5 text-sm text-destructive" role="alert">
        {failure}
      </p>
      <div>
        <Button type="submit" variant="default" size="small" loading={busy}>
          {t('infra.endpoint.add.submit')}
        </Button>
      </div>
    </form>
  )
}

/**
 * "Retire" on an active endpoint: a warning confirmation (two statements to
 * tick, the production cue for a production cluster) and an optional reason
 * code, then a retirement plan (`planEndpointRetirement`). Nothing is retired
 * by the click: the plan is reviewed and applied on its own page. Offered to
 * `registry.manage` only, and for an active endpoint only.
 */
export function RetireEndpoint(props: {
  readonly cluster: Cluster
  readonly endpoint: EndpointView
  readonly tier: 'prod' | 'nonprod'
}): ReactNode {
  const allowed = useCanChange()
  const { client } = useApi()
  const createPlan = useGuardedPlan()
  const id = useId()
  const { endpoint } = props
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [problem, setProblem] = useState<ReasonProblem | undefined>(undefined)
  if (!allowed || endpoint.state !== 'active') return null
  const address = `${endpoint.host}:${endpoint.port}`

  const retire = async (): Promise<void> => {
    const found = reasonCodeProblem(reason, false)
    setProblem(found)
    if (found !== undefined) {
      // Shown in the dialog with its code, like a refusal of the server.
      throw new ApiError('VALIDATION_FAILED', 0, t('configuration.lifecycle.reason.invalid'))
    }
    const code = reason.trim()
    await createPlan(() =>
      client.operation('planEndpointRetirement', {
        params: { clusterId: props.cluster.id, endpointId: endpoint.id },
        body: code === '' ? {} : { reason: code },
      }),
    )
  }

  return (
    <>
      <Button
        type="button"
        variant="text"
        size="tiny"
        aria-label={t('infra.endpoint.retire.label', { endpoint: endpoint.label })}
        onClick={() => setOpen(true)}
      >
        {t('infra.endpoint.retire')}
      </Button>
      <WarningConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t('infra.endpoint.retire.title')}
        description={
          <>
            <span>{t('infra.endpoint.retire.body')}</span>{' '}
            <span className="block pt-2">
              {t('infra.cluster.endpoints.address')}:{' '}
              <UntrustedName name={address} mono label={t('infra.cluster.endpoints.address')} />
            </span>
          </>
        }
        actionLabel={t('infra.endpoint.retire.action')}
        checklistLegend={t('infra.endpoint.retire.legend')}
        checklist={[t('infra.endpoint.retire.check.use'), t('infra.endpoint.retire.check.final')]}
        resetKey={endpoint.id}
        destructive
        tier={props.tier}
        onConfirm={retire}
      >
        <ReasonCodeField
          id={`${id}-reason`}
          value={reason}
          problem={problem}
          optional
          onChange={(value) => {
            setReason(value)
            if (problem !== undefined) setProblem(undefined)
          }}
        />
      </WarningConfirmDialog>
    </>
  )
}

import { Button, Input, Textarea } from '@exponetdb/ui'
import { NotPermittedState } from '@exponetdb/ui-patterns'
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { describeError, t } from '../../lib/i18n/i18n.ts'
import { useMe } from '../../lib/session/guard.tsx'
import { Field, holds } from '../access/fields.tsx'
import { phrase } from '../targets/phrase.ts'
import { useGuardedPlan } from '../targets/plan-request.ts'
import { EndpointFields } from './endpoint-fields.tsx'
import {
  type CaBundleProblem,
  caBundleProblem,
  type EndpointDraft,
  type EndpointKind,
  type EndpointProblems,
  emptyEndpoint,
  endpointProblems,
  endpointRequest,
  isClusterName,
  MAX_CA_BUNDLE,
  MAX_ENDPOINTS,
} from './endpoint-model.ts'

/**
 * "Register an external cluster" on the clusters page: a display name, the CA
 * bundle (certificates only) and one to eight endpoints, sent as a
 * registration plan (`planClusterRegistration`, `registry.manage`, with a
 * fresh proof when the server asks). The cluster exists, pending, only once
 * the plan is applied; its role bootstrap SQL is then shown on the cluster
 * page, before the confirmation. A person without `registry.manage` gets a
 * named state instead of the form.
 */
export function RegisterClusterSection(): ReactNode {
  const me = useMe()
  if (!holds(me, 'registry.manage')) {
    return (
      <NotPermittedState
        what={phrase('infra.register.notPermitted')}
        permission="registry.manage"
        headingLevel={3}
      />
    )
  }
  return <RegisterClusterForm />
}

/** An external cluster has no node agent: no local socket. */
const EXTERNAL_KINDS: readonly EndpointKind[] = ['private', 'public', 'pooler']

interface Row {
  readonly key: string
  readonly draft: EndpointDraft
}

const CA_PROBLEM_KEYS = {
  required: 'infra.register.ca.required',
  key: 'infra.register.ca.key',
  long: 'infra.register.ca.long',
} as const satisfies Record<CaBundleProblem, string>

function RegisterClusterForm(): ReactNode {
  const { client } = useApi()
  const createPlan = useGuardedPlan()
  const id = useId()
  const counter = useRef(1)
  const [name, setName] = useState('')
  const [ca, setCa] = useState('')
  const [rows, setRows] = useState<readonly Row[]>(() => [
    { key: 'endpoint-0', draft: emptyEndpoint() },
  ])
  const [errors, setErrors] = useState<{
    name?: string
    ca?: string
    endpoints: readonly EndpointProblems[]
    form?: string
  }>({ endpoints: [] })
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const caProblem = caBundleProblem(ca)
    const found = {
      ...(isClusterName(name.trim()) ? {} : { name: t('infra.register.name.invalid') }),
      ...(caProblem === undefined ? {} : { ca: t(CA_PROBLEM_KEYS[caProblem]) }),
      endpoints: rows.map((row) => endpointProblems(row.draft)),
    }
    setErrors(found)
    const hasProblem =
      found.name !== undefined ||
      found.ca !== undefined ||
      found.endpoints.some((problems) => Object.keys(problems).length > 0)
    if (hasProblem || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      await createPlan(() =>
        client.operation('planClusterRegistration', {
          body: {
            displayName: name.trim(),
            caBundle: ca.trim(),
            endpoints: rows.map((row) => endpointRequest(row.draft)),
          },
        }),
      )
    } catch (error) {
      setErrors({ endpoints: found.endpoints, form: describeError(error) })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <form
      id="register-cluster-form"
      className="flex flex-col gap-4"
      noValidate
      onSubmit={submit}
      aria-label={t('infra.register.title')}
    >
      <p className="m-0 max-w-3xl text-sm text-foreground-light">
        {t('infra.register.description')}
      </p>
      <Field id={`${id}-name`} label={t('infra.register.name')} error={errors.name}>
        <Input
          id={`${id}-name`}
          autoComplete="off"
          maxLength={120}
          className="max-w-md"
          value={name}
          disabled={busy}
          aria-invalid={errors.name !== undefined}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field
        id={`${id}-ca`}
        label={t('infra.register.ca')}
        description={t('infra.register.ca.hint')}
        error={errors.ca}
      >
        <Textarea
          id={`${id}-ca`}
          rows={6}
          autoComplete="off"
          spellCheck={false}
          maxLength={MAX_CA_BUNDLE + 1}
          className="font-mono"
          value={ca}
          disabled={busy}
          aria-invalid={errors.ca !== undefined}
          aria-describedby={`${id}-ca-description`}
          onChange={(event) => setCa(event.target.value)}
        />
      </Field>
      <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
        <legend className="mb-1 text-sm font-medium text-foreground">
          {t('infra.register.endpoints')}
        </legend>
        <p className="m-0 text-xs text-foreground-light">{t('infra.register.endpoints.hint')}</p>
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {rows.map((row, index) => (
            <li
              key={row.key}
              data-endpoint-row={index + 1}
              className="flex flex-col gap-2 rounded-md border border-default p-3"
              aria-label={t('infra.register.endpoint.row', { row: index + 1 })}
            >
              <EndpointFields
                id={`${id}-${row.key}`}
                draft={row.draft}
                problems={errors.endpoints[index] ?? {}}
                kinds={EXTERNAL_KINDS}
                disabled={busy}
                onChange={(next) =>
                  setRows((all) =>
                    all.map((other) => (other.key === row.key ? { ...other, draft: next } : other)),
                  )
                }
              />
              {rows.length === 1 ? null : (
                <div>
                  <Button
                    type="button"
                    variant="text"
                    size="tiny"
                    disabled={busy}
                    onClick={() => setRows((all) => all.filter((other) => other.key !== row.key))}
                  >
                    {t('infra.register.endpoint.remove', { row: index + 1 })}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
        <div>
          <Button
            type="button"
            variant="default"
            size="small"
            disabled={busy || rows.length >= MAX_ENDPOINTS}
            onClick={() => {
              const key = `endpoint-${counter.current}`
              counter.current += 1
              setRows((all) => [...all, { key, draft: emptyEndpoint() }])
            }}
          >
            {t('infra.register.endpoint.add')}
          </Button>
        </div>
      </fieldset>
      {errors.form === undefined ? null : (
        <p className="m-0 text-sm text-destructive" role="alert">
          {errors.form}
        </p>
      )}
      <div>
        <Button type="submit" variant="primary" size="small" loading={busy}>
          {t('infra.register.submit')}
        </Button>
      </div>
    </form>
  )
}

import type { Cluster } from '@exponetdb/sdk/operations'
import { Button, Input } from '@exponetdb/ui'
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { describeError, t } from '../../lib/i18n/i18n.ts'
import { useMe } from '../../lib/session/guard.tsx'
import { Field, holds } from '../access/fields.tsx'
import { useGuardedPlan } from '../targets/plan-request.ts'
import { isDatabaseName } from './endpoint-model.ts'

/**
 * "Register a database" on the cluster page: the name of a database that
 * already exists on a confirmed cluster, sent as a registration plan
 * (`planDatabaseRegistration`, `registry.manage`). The plan reads the database
 * through the observer role when it is applied; nothing is created on the
 * cluster. On an external cluster the role bootstrap SQL lists every
 * registered database, so the page says to run it again afterwards. A person
 * without `registry.manage`, a cluster that is not confirmed and a retired
 * cluster each get a sentence that says why there is no form.
 */
export function RegisterDatabase({ cluster }: { readonly cluster: Cluster }): ReactNode {
  const me = useMe()
  if (cluster.state === 'retired') {
    return (
      <p className="m-0 text-sm text-foreground-light">{t('infra.database.register.retired')}</p>
    )
  }
  if (!holds(me, 'registry.manage')) {
    return (
      <p className="m-0 text-sm text-foreground-light" data-state="not-permitted">
        {t('infra.database.register.notPermitted')}
      </p>
    )
  }
  if (cluster.state === 'pending') {
    return (
      <p className="m-0 text-sm text-foreground-light">
        {t('infra.database.register.unconfirmed')}
      </p>
    )
  }
  return <RegisterDatabaseForm cluster={cluster} />
}

function RegisterDatabaseForm({ cluster }: { readonly cluster: Cluster }): ReactNode {
  const { client } = useApi()
  const createPlan = useGuardedPlan()
  const id = useId()
  const [name, setName] = useState('')
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const [failure, setFailure] = useState('')
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const text = name.trim()
    const found = isDatabaseName(text) ? undefined : t('infra.database.register.name.invalid')
    setProblem(found)
    setFailure('')
    if (found !== undefined || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      await createPlan(() =>
        client.operation('planDatabaseRegistration', {
          params: { clusterId: cluster.id },
          body: { name: text },
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
      id="register-database-form"
      className="flex max-w-xl flex-col gap-3"
      noValidate
      onSubmit={submit}
      aria-labelledby={`${id}-title`}
    >
      <h3 id={`${id}-title`} className="m-0 text-sm font-medium text-foreground">
        {t('infra.database.register.title')}
      </h3>
      <p className="m-0 text-sm text-foreground-light">
        {t('infra.database.register.description')}
        {cluster.managementMode === 'external' ? ` ${t('infra.database.register.external')}` : ''}
      </p>
      <Field
        id={`${id}-name`}
        label={t('infra.database.register.name')}
        description={t('infra.database.register.name.hint')}
        error={problem}
      >
        <Input
          id={`${id}-name`}
          autoComplete="off"
          spellCheck={false}
          maxLength={63}
          className="font-mono"
          value={name}
          disabled={busy}
          aria-invalid={problem !== undefined}
          aria-describedby={`${id}-name-description`}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <p className="alert m-0 min-h-5 text-sm text-destructive" role="alert">
        {failure}
      </p>
      <div>
        <Button type="submit" variant="default" size="small" loading={busy}>
          {t('infra.database.register.submit')}
        </Button>
      </div>
    </form>
  )
}

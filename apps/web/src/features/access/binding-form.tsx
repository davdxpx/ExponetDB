import { Button, Input } from '@exponetdb/ui'
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { usePlanAction } from '../../lib/api/plan-action.ts'
import { t } from '../../lib/i18n/i18n.ts'
import { Field, NativeSelect } from './fields.tsx'
import {
  isRoleId,
  isScopeKind,
  ROLE_IDS,
  type RoleId,
  roleLabel,
  SCOPE_KINDS,
  type ScopeKind,
  scopeKindLabel,
  scopePrefix,
  toBindingScope,
} from './people-model.ts'
import type { StatusLine } from './status.tsx'

/**
 * Binds a role to a person at a scope (`POST /role-bindings`): the answer is a
 * plan with the before, the after and the risk, and the page opens its review
 * page. Nothing changes until the plan is approved and applied there. The
 * scope id is checked for its kind's prefix and shape only; the server checks
 * that it exists and whether the person may grant the role there.
 */
export function BindingForm({
  identityId,
  line,
}: {
  readonly identityId: string
  readonly line: StatusLine
}): ReactNode {
  const { client } = useApi()
  const createPlan = usePlanAction()
  const id = useId()
  const [role, setRole] = useState<RoleId>('viewer')
  const [kind, setKind] = useState<ScopeKind>('global')
  const [scopeId, setScopeId] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const scope = toBindingScope(kind, scopeId)
    if (scope === undefined) {
      setError(
        kind === 'global'
          ? undefined
          : t('people.binding.scopeId.invalid', { prefix: scopePrefix(kind) }),
      )
      return
    }
    setError(undefined)
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    line.clear()
    try {
      await createPlan(() =>
        client.operation('planRoleBinding', { body: { identityId, roleId: role, scope } }),
      )
    } catch (failure) {
      line.fail(failure)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <form
      className="binding-form flex flex-col gap-3"
      noValidate
      onSubmit={submit}
      aria-label={t('people.binding.form')}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field id={`${id}-role`} label={t('people.binding.role')}>
          <NativeSelect
            id={`${id}-role`}
            value={role}
            options={ROLE_IDS.map((value) => ({ value, label: roleLabel(value) }))}
            onChange={(event) => {
              if (isRoleId(event.target.value)) setRole(event.target.value)
            }}
          />
        </Field>
        <Field id={`${id}-scope`} label={t('people.binding.scope')}>
          <NativeSelect
            id={`${id}-scope`}
            value={kind}
            options={SCOPE_KINDS.map((value) => ({ value, label: scopeKindLabel(value) }))}
            onChange={(event) => {
              if (isScopeKind(event.target.value)) setKind(event.target.value)
            }}
          />
        </Field>
        {kind === 'global' ? null : (
          <Field
            id={`${id}-scope-id`}
            label={t('people.binding.scopeId', { kind: scopeKindLabel(kind) })}
            description={t('people.binding.scopeId.hint', { prefix: scopePrefix(kind) })}
            error={error}
          >
            <Input
              id={`${id}-scope-id`}
              autoComplete="off"
              spellCheck={false}
              maxLength={64}
              className="font-mono"
              value={scopeId}
              aria-invalid={error !== undefined}
              aria-describedby={`${id}-scope-id-description`}
              onChange={(event) => setScopeId(event.target.value)}
            />
          </Field>
        )}
      </div>
      <div>
        <Button type="submit" variant="default" size="small" loading={busy}>
          {t('people.binding.submit')}
        </Button>
      </div>
    </form>
  )
}

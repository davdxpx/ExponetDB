import { Button, Input } from '@exponetdb/ui'
import { useQuery } from '@tanstack/react-query'
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { usePlanAction } from '../../lib/api/plan-action.ts'
import { t } from '../../lib/i18n/i18n.ts'
import { Field, NativeSelect } from './fields.tsx'
import { rolesQuery } from './people-keys.ts'
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
import { CoverageNote, ScopePicker } from './scope-picker.tsx'
import type { StatusLine } from './status.tsx'

/**
 * Binds a role to a person at a scope (`POST /role-bindings`): the answer is a
 * plan with the before, the after and the risk, and the page opens its review
 * page. Nothing changes until the plan is approved and applied there. The role
 * is shown with the catalog's own description of what it is for. The scope is
 * chosen by name from the registry (a product, a project, an environment, a
 * target) with a note on whether it covers production, or typed as its ID;
 * either way the value is the ID, checked for its kind's prefix and shape
 * only. The server checks that it exists and whether the person may grant the
 * role there.
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
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Field id={`${id}-role`} label={t('people.binding.role')}>
            <NativeSelect
              id={`${id}-role`}
              value={role}
              aria-describedby={`${id}-role-about`}
              options={ROLE_IDS.map((value) => ({ value, label: roleLabel(value) }))}
              onChange={(event) => {
                if (isRoleId(event.target.value)) setRole(event.target.value)
              }}
            />
          </Field>
          <RoleDescription role={role} id={`${id}-role-about`} />
        </div>
        <Field id={`${id}-scope`} label={t('people.binding.scope')}>
          <NativeSelect
            id={`${id}-scope`}
            value={kind}
            options={SCOPE_KINDS.map((value) => ({ value, label: scopeKindLabel(value) }))}
            onChange={(event) => {
              if (isScopeKind(event.target.value)) {
                setKind(event.target.value)
                // An ID belongs to one kind: a choice made for another kind is not carried over.
                setScopeId('')
                setError(undefined)
              }
            }}
          />
        </Field>
      </div>
      {kind === 'global' ? (
        <CoverageNote coverage="production" hasId />
      ) : (
        <div className="flex flex-col gap-3">
          <ScopePicker kind={kind} value={scopeId} onChange={setScopeId} idBase={id} />
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
        </div>
      )}
      <div>
        <Button type="submit" variant="default" size="small" loading={busy}>
          {t('people.binding.submit')}
        </Button>
      </div>
    </form>
  )
}

/**
 * What the role catalog says the role is for, under the role select. The
 * catalog is the server's; a read that fails says so and never leaves the
 * line blank as if the role had no purpose.
 */
function RoleDescription({ role, id }: { readonly role: RoleId; readonly id: string }): ReactNode {
  const { client } = useApi()
  const roles = useQuery(rolesQuery(client))
  const page = roles.data
  if (page === undefined) {
    return roles.isError ? (
      <p id={id} role="status" className="text-xs text-foreground-lighter">
        {t('people.binding.role.failed')}
      </p>
    ) : (
      <p id={id} className="sr-only">
        {t('people.binding.role.loading')}
      </p>
    )
  }
  const found = page.items.find((entry) => entry.id === role)
  return (
    <p id={id} className="text-xs text-foreground-lighter">
      {found === undefined ? t('people.binding.role.unlisted') : found.intendedFor}
    </p>
  )
}

import { Button, Input } from '@exponetdb/ui'
import { useNavigate } from '@exponetdb/ui-patterns'
import { type FormEvent, type ReactNode, useId, useState } from 'react'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { Field, NativeSelect } from '../access/fields.tsx'
import { type AuditSearch, auditHref, filterProblem, hasFilters } from './search.ts'

/**
 * The filters of the audit search. Submitting puts the checked values into
 * the address (`/audit?…`), so a search can be shared and the browser's back
 * button returns to the previous one; a value of the wrong shape is refused
 * here with the expected shape and never sent.
 */
type TextFilter = 'client' | 'grant' | 'action' | 'target' | 'from' | 'to'

const TEXT_FILTERS: readonly { name: TextFilter; label: MessageKey; hint: MessageKey }[] = [
  { name: 'action', label: 'audit.filter.action', hint: 'audit.filter.action.hint' },
  { name: 'target', label: 'audit.filter.target', hint: 'audit.filter.target.hint' },
  { name: 'client', label: 'audit.filter.client', hint: 'audit.filter.client.hint' },
  { name: 'grant', label: 'audit.filter.grant', hint: 'audit.filter.grant.hint' },
  { name: 'from', label: 'audit.filter.from', hint: 'audit.filter.time.hint' },
  { name: 'to', label: 'audit.filter.to', hint: 'audit.filter.time.hint' },
]

export function FilterForm({ search }: { readonly search: AuditSearch }): ReactNode {
  const navigate = useNavigate()
  const id = useId()
  const [actor, setActor] = useState<string>(search.actor ?? '')
  const [result, setResult] = useState<string>(search.result ?? '')
  const [values, setValues] = useState<Record<TextFilter, string>>({
    client: search.client ?? '',
    grant: search.grant ?? '',
    action: search.action ?? '',
    target: search.target ?? '',
    from: search.from ?? '',
    to: search.to ?? '',
  })
  const [errors, setErrors] = useState<Partial<Record<TextFilter, string>>>({})

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const next: Partial<Record<TextFilter, string>> = {}
    for (const filter of TEXT_FILTERS) {
      if (filterProblem(filter.name, values[filter.name]) !== undefined) {
        next[filter.name] = t('audit.filter.invalid', { hint: t(filter.hint) })
      }
    }
    setErrors(next)
    if (Object.keys(next).length > 0) return
    const raw: Record<string, string> = { actor, result }
    for (const filter of TEXT_FILTERS) raw[filter.name] = values[filter.name].trim()
    navigate(auditHref(raw as AuditSearch))
  }

  return (
    <form
      id="audit-filters"
      aria-label={t('audit.filter.title')}
      className="flex flex-col gap-3"
      noValidate
      onSubmit={submit}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field id={`${id}-actor`} label={t('audit.filter.actor')}>
          <NativeSelect
            id={`${id}-actor`}
            value={actor}
            options={[
              { value: '', label: t('audit.filter.actor.any') },
              { value: 'self', label: t('audit.filter.actor.self') },
            ]}
            onChange={(event) => setActor(event.target.value)}
          />
        </Field>
        <Field id={`${id}-result`} label={t('audit.filter.result')}>
          <NativeSelect
            id={`${id}-result`}
            value={result}
            options={[
              { value: '', label: t('audit.filter.result.any') },
              { value: 'succeeded', label: t('audit.outcome.succeeded') },
              { value: 'failed', label: t('audit.outcome.failed') },
              { value: 'denied', label: t('audit.outcome.denied') },
            ]}
            onChange={(event) => setResult(event.target.value)}
          />
        </Field>
        {TEXT_FILTERS.map((filter) => {
          const inputId = `${id}-${filter.name}`
          return (
            <Field
              key={filter.name}
              id={inputId}
              label={t(filter.label)}
              description={t(filter.hint)}
              error={errors[filter.name]}
            >
              <Input
                id={inputId}
                name={filter.name}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                maxLength={64}
                value={values[filter.name]}
                aria-invalid={errors[filter.name] !== undefined}
                aria-describedby={`${inputId}-description`}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [filter.name]: event.target.value }))
                }
              />
            </Field>
          )
        })}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="default" size="small">
          {t('audit.filter.submit')}
        </Button>
        {hasFilters(search) ? (
          <Button type="button" variant="text" size="small" onClick={() => navigate('/audit')}>
            {t('audit.filter.clear')}
          </Button>
        ) : null}
      </div>
    </form>
  )
}

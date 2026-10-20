import { Button, Input } from '@exponetdb/ui'
import { TierChip, UntrustedName, useNavigate } from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import { type FormEvent, type ReactNode, useId, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { ChoiceSelect } from '../access/choice-select.tsx'
import { Field, NativeSelect } from '../access/fields.tsx'
import { tierLabel } from '../access/model.ts'
import { targetChoicesQuery } from '../access/scope-reads.ts'
import { inlineName } from '../consent/inline-name.ts'
import { type AuditSearch, auditHref, filterProblem, hasFilters } from './search.ts'
import {
  localInputToUtc,
  QUICK_RANGES,
  type QuickRangeId,
  quickRangeStart,
  utcToLocalInput,
} from './time-range.ts'

/**
 * The filters of the audit search. Submitting puts the checked values into
 * the address (`/audit?…`), so a search can be shared and the browser's back
 * button returns to the previous one; a value of the wrong shape is refused
 * here with the expected shape and never sent.
 *
 * Times are entered as a quick range or as a date and time in the viewer's
 * own time zone and are sent as UTC (`…Z`); a time that came from the address
 * and was not touched is sent exactly as it was. A target is chosen by name
 * from the registry or typed as its ID; either way the value is the `tgt_`
 * ID, checked by the same rule as before.
 */
type TextFilter = 'client' | 'grant' | 'action' | 'target'
type TimeFilter = 'from' | 'to'

const TEXT_FILTERS: readonly { name: TextFilter; label: MessageKey; hint: MessageKey }[] = [
  { name: 'action', label: 'audit.filter.action', hint: 'audit.filter.action.hint' },
  { name: 'client', label: 'audit.filter.client', hint: 'audit.filter.client.hint' },
  { name: 'grant', label: 'audit.filter.grant', hint: 'audit.filter.grant.hint' },
]

const QUICK_LABEL: Readonly<Record<QuickRangeId, MessageKey>> = {
  hour: 'audit.filter.quick.hour',
  sixHours: 'audit.filter.quick.sixHours',
  day: 'audit.filter.quick.day',
  week: 'audit.filter.quick.week',
  month: 'audit.filter.quick.month',
}

export function FilterForm({ search }: { readonly search: AuditSearch }): ReactNode {
  const navigate = useNavigate()
  const { client } = useApi()
  const id = useId()
  const targets = useQuery(targetChoicesQuery(client))
  const [actor, setActor] = useState<string>(search.actor ?? '')
  const [result, setResult] = useState<string>(search.result ?? '')
  const [values, setValues] = useState<Record<TextFilter, string>>({
    client: search.client ?? '',
    grant: search.grant ?? '',
    action: search.action ?? '',
    target: search.target ?? '',
  })
  const [times, setTimes] = useState<Record<TimeFilter, string>>({
    from: utcToLocalInput(search.from),
    to: utcToLocalInput(search.to),
  })
  // A time from the address that nobody touched is sent as it came, to the second.
  const [kept, setKept] = useState<Partial<Record<TimeFilter, string>>>({
    ...(search.from === undefined ? {} : { from: search.from }),
    ...(search.to === undefined ? {} : { to: search.to }),
  })
  const [errors, setErrors] = useState<Partial<Record<TextFilter | TimeFilter, string>>>({})
  const chosenTarget = targets.data?.items.find((target) => target.id === values.target.trim())

  const setTime = (name: TimeFilter, value: string): void => {
    setTimes((current) => ({ ...current, [name]: value }))
    setKept((current) => {
      const { [name]: _dropped, ...rest } = current
      return rest
    })
  }

  const utcOf = (name: TimeFilter): string | undefined => {
    const text = times[name].trim()
    if (text === '') return undefined
    return kept[name] ?? localInputToUtc(text)
  }

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const next: Partial<Record<TextFilter | TimeFilter, string>> = {}
    for (const filter of TEXT_FILTERS) {
      if (filterProblem(filter.name, values[filter.name]) !== undefined) {
        next[filter.name] = t('audit.filter.invalid', { hint: t(filter.hint) })
      }
    }
    if (filterProblem('target', values.target) !== undefined) {
      next.target = t('audit.filter.invalid', { hint: t('audit.filter.target.hint') })
    }
    const raw: Record<string, string> = { actor, result }
    for (const name of ['from', 'to'] as const) {
      const utc = utcOf(name)
      if (times[name].trim() === '') {
        raw[name] = ''
      } else if (utc === undefined || filterProblem(name, utc) !== undefined) {
        next[name] = t('audit.filter.time.invalid')
      } else {
        raw[name] = utc
      }
    }
    const from = raw['from']
    const to = raw['to']
    if (
      next.from === undefined &&
      next.to === undefined &&
      from !== undefined &&
      from !== '' &&
      to !== undefined &&
      to !== '' &&
      Date.parse(from) >= Date.parse(to)
    ) {
      next.to = t('audit.filter.range.invalid')
    }
    setErrors(next)
    if (Object.keys(next).length > 0) return
    for (const filter of TEXT_FILTERS) raw[filter.name] = values[filter.name].trim()
    raw['target'] = values.target.trim()
    navigate(auditHref(raw as AuditSearch))
  }

  const timeField = (name: TimeFilter, label: MessageKey): ReactNode => {
    const inputId = `${id}-${name}`
    const utc = utcOf(name)
    return (
      <Field
        id={inputId}
        label={t(label)}
        description={
          utc === undefined ? t('audit.filter.time.hint') : t('audit.filter.time.sent', { utc })
        }
        error={errors[name]}
      >
        <Input
          id={inputId}
          name={name}
          type="datetime-local"
          autoComplete="off"
          value={times[name]}
          aria-invalid={errors[name] !== undefined}
          aria-describedby={`${inputId}-description`}
          onChange={(event) => setTime(name, event.target.value)}
        />
      </Field>
    )
  }

  return (
    <form
      id="audit-filters"
      aria-label={t('audit.filter.title')}
      className="flex flex-col gap-4"
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

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <ChoiceSelect
            id={`${id}-target-choice`}
            label={t('audit.filter.targetChoice')}
            what={t('choice.what.targets')}
            permission="targets.read"
            query={targets}
            choices={(page) =>
              page.items.map((target) => ({
                value: target.id,
                label: `${inlineName(target.path, 80) ?? target.id} (${tierLabel(target.tier)})`,
              }))
            }
            placeholder={t('audit.filter.targetChoice.any')}
            value={values.target.trim()}
            onChange={(value) => setValues((current) => ({ ...current, target: value }))}
          />
          {chosenTarget === undefined ? null : (
            // The option above is plain text; the whole path is shown here as untrusted text.
            <p
              className="flex flex-wrap items-center gap-2 text-xs text-foreground-light"
              data-chosen-target=""
            >
              <UntrustedName
                name={chosenTarget.path}
                mono
                maxCodePoints={200}
                label={t('audit.filter.targetChoice')}
              />
              <TierChip tier={chosenTarget.tier} />
            </p>
          )}
        </div>
        <Field
          id={`${id}-target`}
          label={t('audit.filter.target')}
          description={t('audit.filter.target.hint')}
          error={errors.target}
        >
          <Input
            id={`${id}-target`}
            name="target"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            maxLength={64}
            value={values.target}
            aria-invalid={errors.target !== undefined}
            aria-describedby={`${id}-target-description`}
            onChange={(event) =>
              setValues((current) => ({ ...current, target: event.target.value }))
            }
          />
        </Field>
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-medium text-foreground">
          {t('audit.filter.range')}
        </legend>
        <fieldset className="flex flex-wrap gap-2">
          <legend className="sr-only">{t('audit.filter.quick')}</legend>
          {QUICK_RANGES.map((range) => (
            <Button
              key={range.id}
              type="button"
              variant="outline"
              size="tiny"
              onClick={() => {
                setTime('from', quickRangeStart(range.id, new Date()))
                setTime('to', '')
              }}
            >
              {t(QUICK_LABEL[range.id])}
            </Button>
          ))}
        </fieldset>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {timeField('from', 'audit.filter.from')}
          {timeField('to', 'audit.filter.to')}
        </div>
      </fieldset>

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

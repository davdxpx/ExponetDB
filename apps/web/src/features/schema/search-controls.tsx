import { Button, Input, Label } from '@exponetdb/ui'
import { UntrustedName } from '@exponetdb/ui-patterns'
import { type FormEvent, type ReactNode, useId, useState } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { SEARCH_MAX_LENGTH } from './keys.ts'

/**
 * The name filter of the schema browser. The Control Plane lists schema
 * objects by name search only (`searchSchema` takes 1 to 128 characters), so
 * a list starts when a person applies a filter; the page says so and never
 * reads "nothing typed" as "no objects".
 */
export function SearchForm(props: {
  readonly applied: string
  readonly onApply: (term: string) => void
  readonly label?: string
}): ReactNode {
  const id = useId()
  const [draft, setDraft] = useState(props.applied)
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    props.onApply(draft.trim().slice(0, SEARCH_MAX_LENGTH))
  }
  return (
    <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
      <div className="flex min-w-60 flex-1 flex-col gap-1.5">
        <Label htmlFor={id}>{props.label ?? t('schema.search.label')}</Label>
        <Input
          id={id}
          value={draft}
          maxLength={SEARCH_MAX_LENGTH}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          aria-describedby={`${id}-hint`}
        />
      </div>
      <Button type="submit" variant="default">
        {t('schema.search.apply')}
      </Button>
      <p id={`${id}-hint`} className="basis-full text-xs text-foreground-light">
        {t('schema.search.hint')}
      </p>
    </form>
  )
}

/** Most schemas the selector lists as buttons; the rest are reached by the name filter. */
export const SCHEMA_SELECTOR_LIMIT = 24

/**
 * Chooses one schema, or all. Schema names are untrusted, so they are not the
 * text of a native `<select>` (a direction character would act there): each is
 * a toggle button with the name shown through `UntrustedName`.
 */
export function SchemaSelector(props: {
  readonly schemas: readonly string[]
  readonly value: string | null
  readonly onChange: (schema: string | null) => void
}): ReactNode {
  const shown = props.schemas.slice(0, SCHEMA_SELECTOR_LIMIT)
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-sm font-medium">{t('schema.selector.label')}</legend>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="tiny"
          variant={props.value === null ? 'default' : 'outline'}
          aria-pressed={props.value === null}
          onClick={() => props.onChange(null)}
        >
          {t('schema.selector.all')}
        </Button>
        {shown.map((schema) => (
          <Button
            key={schema}
            type="button"
            size="tiny"
            variant={props.value === schema ? 'default' : 'outline'}
            aria-pressed={props.value === schema}
            onClick={() => props.onChange(schema)}
          >
            <UntrustedName name={schema} mono label={t('schema.selector.label')} />
          </Button>
        ))}
      </div>
      {props.schemas.length > shown.length ? (
        <p className="text-xs text-foreground-light">
          {t('schema.selector.more', { count: props.schemas.length - shown.length })}
        </p>
      ) : null}
    </fieldset>
  )
}

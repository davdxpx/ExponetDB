import { Textarea } from '@exponetdb/ui'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { Field } from './fields.tsx'

/**
 * The optional reason of a change, kept in the audit (permanent): the field
 * says so and asks for no personal data (order §8 copy rules). The text is
 * sent as typed; the server limits and stores it as untrusted text.
 */
export function ReasonField({
  id,
  value,
  onChange,
  maxLength,
}: {
  readonly id: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly maxLength: number
}): ReactNode {
  return (
    <Field id={id} label={t('people.reason.label')} description={t('audit.reason.warning')}>
      <Textarea
        id={id}
        rows={2}
        maxLength={maxLength}
        value={value}
        aria-describedby={`${id}-description`}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  )
}

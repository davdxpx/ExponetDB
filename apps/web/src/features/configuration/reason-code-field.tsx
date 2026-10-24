import { Input } from '@exponetdb/ui'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { Field } from '../access/fields.tsx'
import type { ReasonProblem } from './lifecycle-model.ts'

/**
 * The `reason` of a registry plan: a short machine-readable code, not
 * prose. It is kept permanently in the audit log, so the field says so and
 * asks for no personal data (the same warning as the free-text reason of the
 * access pages). The code is sent as typed after trimming; the server limits
 * it again.
 */
export function ReasonCodeField(props: {
  readonly id: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly problem: ReasonProblem | undefined
  /** The contract takes the reason but does not require it. */
  readonly optional?: boolean
  readonly disabled?: boolean
}): ReactNode {
  const error =
    props.problem === undefined
      ? undefined
      : t(
          props.problem === 'required'
            ? 'configuration.lifecycle.reason.required'
            : 'configuration.lifecycle.reason.invalid',
        )
  return (
    <Field
      id={props.id}
      label={t(
        props.optional === true
          ? 'configuration.lifecycle.reason.labelOptional'
          : 'configuration.lifecycle.reason.label',
      )}
      description={`${t('configuration.lifecycle.reason.hint')} ${t('audit.reason.warning')}`}
      error={error}
    >
      <Input
        id={props.id}
        autoComplete="off"
        spellCheck={false}
        maxLength={64}
        className="max-w-md font-mono"
        value={props.value}
        disabled={props.disabled ?? false}
        aria-invalid={error !== undefined}
        aria-describedby={`${props.id}-description${error === undefined ? '' : ` ${props.id}-error`}`}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </Field>
  )
}

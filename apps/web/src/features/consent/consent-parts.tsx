import { cn } from '@exponetdb/ui'
import { UntrustedName } from '@exponetdb/ui-patterns'
import { Fragment, type ReactNode, useId } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import type { Me } from '../../lib/session/guard.tsx'

/**
 * The small building blocks of the interstitial OAuth pages (consent,
 * device code): a card of label and value rows, the "Signed in as" row, a
 * section heading, a native check box or radio button row (native inputs,
 * so the browser suites and assistive technology see plain form controls)
 * and a catalog sentence with nodes in its placeholders.
 */
export interface DetailRow {
  readonly id: string
  readonly label: string
  readonly value: ReactNode
  /** The DOM id of the value cell (`consent-client`, `consent-redirect`). */
  readonly valueId?: string
}

export function DetailRows({
  rows,
  className,
}: {
  readonly rows: readonly DetailRow[]
  readonly className?: string
}): ReactNode {
  return (
    <dl className={cn('divide-y divide-border rounded-md border bg-surface-75 px-4', className)}>
      {rows.map((row) => (
        <div key={row.id} className="flex items-start justify-between gap-4 py-2.5 text-xs">
          <dt className="shrink-0 text-foreground-light">{row.label}</dt>
          <dd id={row.valueId} className="m-0 min-w-0 break-words text-right text-foreground">
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** The name the signed-in person is shown by: display name, else e-mail address, else label. */
export function personName(me: Me): string {
  const identity = me.identity
  return identity.displayName ?? identity.email ?? identity.label
}

/** The "Signed in as" row (the person's own name is still foreign text: shown by code point). */
export function signedInRow(me: Me, label = t('consent.signedInAs')): DetailRow {
  return {
    id: 'signed-in-as',
    label,
    value: <UntrustedName name={personName(me)} maxCodePoints={64} label={label} />,
  }
}

export function SectionHeading({
  id,
  children,
}: {
  readonly id: string
  readonly children: ReactNode
}): ReactNode {
  return (
    <h2 id={id} className="text-xs font-medium uppercase tracking-wider text-foreground-light">
      {children}
    </h2>
  )
}

export interface ChoiceRowProps {
  readonly type: 'checkbox' | 'radio'
  readonly name: string
  readonly value: string
  readonly checked: boolean
  readonly disabled?: boolean
  readonly onChange: (checked: boolean) => void
  readonly label: ReactNode
  /** A sentence under the label, linked to the control as its description. */
  readonly hint?: string
  readonly className?: string
}

export function ChoiceRow({
  type,
  name,
  value,
  checked,
  disabled = false,
  onChange,
  label,
  hint,
  className,
}: ChoiceRowProps): ReactNode {
  const hintId = useId()
  return (
    <label
      className={cn(
        'flex items-start gap-3 px-3 py-2.5 text-sm',
        disabled ? 'cursor-not-allowed text-foreground-muted' : 'cursor-pointer',
        className,
      )}
    >
      <input
        type={type}
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        aria-describedby={hint === undefined ? undefined : hintId}
        onChange={(event) => onChange(event.currentTarget.checked)}
        className="focus-ring mt-0.5 size-4 shrink-0 cursor-[inherit] accent-foreground"
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">{label}</span>
        {hint === undefined ? null : (
          <span id={hintId} className="text-xs text-foreground-lighter">
            {hint}
          </span>
        )}
      </span>
    </label>
  )
}

/**
 * A catalog sentence whose `{name}` placeholders are filled with nodes (an
 * untrusted host, a code): the text around them stays the catalog's, the
 * nodes are rendered as they are. Placeholders without a node stay visible.
 */
export function withNodes(text: string, nodes: Readonly<Record<string, ReactNode>>): ReactNode {
  const out: ReactNode[] = []
  let offset = 0
  for (const part of text.split(/(\{[A-Za-z]+\})/)) {
    if (part === '') continue
    const name = /^\{([A-Za-z]+)\}$/.exec(part)?.[1]
    const node = name === undefined ? undefined : nodes[name]
    out.push(<Fragment key={offset}>{node === undefined ? part : node}</Fragment>)
    offset += part.length
  }
  return out
}

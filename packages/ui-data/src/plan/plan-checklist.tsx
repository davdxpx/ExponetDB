import { AlertTriangle, Check, CircleHelp, Clock, Dot, type LucideIcon, X } from '@exponetdb/icons'
import { cn } from '@exponetdb/ui'
import type { HeadingLevel } from '@exponetdb/ui-patterns'
import { type HTMLAttributes, type ReactNode, useId } from 'react'

/**
 * Where one check of a plan stands. `failed` is a read that failed (the fact
 * is not known because it could not be read, C-28), never an outcome that did
 * not pass: that is `blocked`. `neutral` is a step that happened without a
 * verdict, such as an apply before its verification (C-13: applied is never a
 * success on its own).
 */
export type PlanCheckState = 'passed' | 'waiting' | 'blocked' | 'unknown' | 'failed' | 'neutral'

interface StateLook {
  /** The state in words, for assistive technology (the line says it for everyone). */
  readonly label: string
  readonly icon: LucideIcon
  readonly className: string
}

const STATES: Readonly<Record<PlanCheckState, StateLook>> = {
  passed: { label: 'Passed', icon: Check, className: 'border-success-500 text-success-600' },
  waiting: { label: 'Waiting', icon: Clock, className: 'border-warning-500 text-warning-600' },
  blocked: { label: 'Blocked', icon: X, className: 'border-destructive-400 text-destructive' },
  unknown: {
    label: 'Not known',
    icon: CircleHelp,
    className: 'border-dashed border-strong text-foreground-light',
  },
  failed: {
    label: 'Could not be read',
    icon: AlertTriangle,
    className: 'border-destructive-400 text-destructive',
  },
  neutral: { label: 'No verdict yet', icon: Dot, className: 'border-strong text-foreground' },
}

/** One row of the checklist. */
export interface PlanCheck {
  /** A stable id of the row (`data-check`). */
  readonly id: string
  readonly state: PlanCheckState
  /** Plain text: what is checked ("Policy", "Approvals"). */
  readonly title: string
  /** One line: where it stands, in words. */
  readonly line: ReactNode
  /** A control or link at the end of the row ("Open the operation page", "Try again"). */
  readonly action?: ReactNode
  /** More, below the line: the rules that did not pass, the decisions so far, a note. */
  readonly children?: ReactNode
  /** Further hooks for the row (`data-indicator`, `data-outcome`). */
  readonly data?: Readonly<Record<`data-${string}`, string>>
}

export interface PlanChecklistProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** Plain text: "Before it can run". */
  readonly title: string
  /** A short line under the heading. */
  readonly description?: ReactNode
  readonly checks: readonly PlanCheck[]
  /** The level of the heading in the page outline. Default 2. */
  readonly headingLevel?: HeadingLevel
}

function CheckRow({ check }: { readonly check: PlanCheck }): ReactNode {
  const look = STATES[check.state]
  const Icon = look.icon
  return (
    <li
      data-check={check.id}
      data-check-state={check.state}
      {...check.data}
      className="flex min-w-0 gap-3 px-4 py-3"
    >
      <span
        aria-hidden="true"
        className={cn(
          'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border bg-surface-75',
          look.className,
        )}
      >
        <Icon className="size-3" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex min-w-0 flex-col gap-x-4 gap-y-0.5 text-sm sm:flex-row sm:items-baseline">
          <span className="shrink-0 font-medium text-foreground sm:w-28">
            {check.title}
            <span className="sr-only">{` (${look.label})`}</span>
          </span>
          <span className="min-w-0 flex-1 break-words text-foreground-light">{check.line}</span>
          {check.action === undefined ? null : (
            <span className="shrink-0 text-sm">{check.action}</span>
          )}
        </div>
        {check.children === undefined || check.children === null ? null : (
          <div className="flex min-w-0 flex-col gap-2 text-sm sm:pl-32">{check.children}</div>
        )}
      </div>
    </li>
  )
}

/**
 * What stands between a plan and its effect, as one compact card of rows:
 * each row an icon of its own shape for its state (passed, waiting, blocked,
 * not known, could not be read, no verdict yet) and one line that says the
 * state in words, so color is never the only signal. The rows come from the
 * page; the card decides nothing (C-10) and never turns a row it was not
 * given into a passed one.
 */
export function PlanChecklist({
  title,
  description,
  checks,
  headingLevel = 2,
  className,
  ...rest
}: PlanChecklistProps): ReactNode {
  const headingId = useId()
  const Heading = `h${headingLevel}` as const
  return (
    <section
      aria-labelledby={headingId}
      data-plan-checklist=""
      className={cn('min-w-0 rounded-lg border border-default bg-surface-100', className)}
      {...rest}
    >
      <div className="flex flex-col gap-0.5 border-b border-default px-4 py-3">
        <Heading id={headingId} className="text-base font-medium text-foreground">
          {title}
        </Heading>
        {description === undefined ? null : (
          <div className="text-sm text-foreground-light">{description}</div>
        )}
      </div>
      <ul className="m-0 flex list-none flex-col divide-y divide-border p-0">
        {checks.map((check) => (
          <CheckRow key={check.id} check={check} />
        ))}
      </ul>
    </section>
  )
}

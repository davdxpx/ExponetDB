import { Check, CircleHelp, Clock, Dot, Loader2, type LucideIcon, X } from '@exponetdb/icons'
import { cn } from '@exponetdb/ui'
import { type HeadingLevel, UntrustedName } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'

import { PlanBlock } from './plan-frame.tsx'
import { INLINE_ICON, Marked, NotKnown, Words, withKeys } from './shared.tsx'

/** One step of a plan, in the order the plan runs it. */
export interface PlanStep {
  /** A stable key: the migration id, or the step index the server gave. */
  readonly key: string
  /** What the step does, in ExponetDB's words (page copy, such as "Apply migration"). */
  readonly label: string
  /** Untrusted: a foreign name the step works on, such as the bundle's own name. */
  readonly name?: string | null
  /** A server identifier of what the step works on, such as the migration id. */
  readonly reference?: string | null
  /** A server fact about the step, such as "in one transaction" or "not in a transaction, runs alone". */
  readonly detail?: string | null
  /** The step's state on an operation: `pending`, `running`, `succeeded`, `failed`, `skipped`. */
  readonly state?: string | null
}

export interface PlanStepsBlockProps {
  /**
   * The steps in the order the plan runs them: for a migration plan the
   * migrations of `change.content.migrations` in plan order; on an operation
   * `OperationView.steps` (index, name, state). `null` is "not known".
   */
  readonly steps: readonly PlanStep[] | null
  readonly headingLevel?: HeadingLevel
}

const STEP_STATES: Readonly<
  Record<string, { readonly label: string; readonly icon: LucideIcon; readonly tone: string }>
> = {
  pending: { label: 'Pending', icon: Clock, tone: 'text-foreground-light' },
  running: { label: 'Running', icon: Loader2, tone: 'text-foreground' },
  succeeded: { label: 'Succeeded', icon: Check, tone: 'text-foreground' },
  failed: { label: 'Failed', icon: X, tone: 'text-destructive' },
  skipped: { label: 'Skipped', icon: Dot, tone: 'text-foreground-light' },
}

function StepState({ state }: { readonly state: string }): ReactNode {
  const known = Object.hasOwn(STEP_STATES, state) ? STEP_STATES[state] : undefined
  if (known === undefined) {
    return (
      <Words data-step-state={state} className="text-xs">
        <CircleHelp aria-hidden="true" className={INLINE_ICON} />
        <Marked text={state} mono />
        <span className="text-foreground-light">(not a known state)</span>
      </Words>
    )
  }
  const Icon = known.icon
  return (
    <span
      data-step-state={state}
      className={cn('inline-flex items-center gap-1 text-xs font-medium', known.tone)}
    >
      <Icon
        aria-hidden="true"
        className={cn('size-3', state === 'running' && 'animate-spin motion-reduce:animate-none')}
      />
      {known.label}
    </span>
  )
}

/** The steps of the plan in order, numbered; foreign names marked as untrusted text. */
export function PlanStepsBlock({ steps, headingLevel }: PlanStepsBlockProps): ReactNode {
  return (
    <PlanBlock title="Steps" headingLevel={headingLevel} data-plan-block="steps">
      {steps === null ? (
        <p className="text-sm">
          The steps of this plan are <NotKnown />.
        </p>
      ) : steps.length === 0 ? (
        <p className="text-sm text-foreground-light">The server listed no steps for this plan.</p>
      ) : (
        <ol className="flex flex-col gap-2 text-sm">
          {withKeys(steps).map(({ item: step, key }, index) => (
            <li
              key={key}
              data-step={step.key}
              className="flex min-w-0 items-baseline gap-3 rounded-md border border-default px-3 py-2"
            >
              <span className="w-6 shrink-0 text-right font-mono text-xs text-foreground-lighter">
                {`${index + 1}.`}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Words className="min-w-0">
                  <span className="font-medium text-foreground">{step.label}</span>
                  {step.name === undefined || step.name === null ? null : (
                    <UntrustedName name={step.name} label="step name" />
                  )}
                  {step.reference === undefined || step.reference === null ? null : (
                    <Marked text={step.reference} mono className="text-foreground-light" />
                  )}
                  {step.state === undefined || step.state === null ? null : (
                    <StepState state={step.state} />
                  )}
                </Words>
                {step.detail === undefined || step.detail === null ? null : (
                  <Marked text={step.detail} className="text-foreground-light" />
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </PlanBlock>
  )
}

import { Check, CircleHelp, Clock } from '@exponetdb/icons'
import { Button, Card, CardContent, cn, StatusIcon } from '@exponetdb/ui'
import { ErrorDisplay, UntrustedName } from '@exponetdb/ui-patterns'
import { type ReactNode, useState } from 'react'
import type { DemoDefinition } from '../types.ts'
import { Outcome } from './support.tsx'

// ---------------------------------------------------------------------------
// The five steps, with the one rule each step keeps
// ---------------------------------------------------------------------------

const STEPS = [
  {
    name: 'Plan',
    rule: 'Created from the target as it is now. Immutable, short-lived and single-use.',
    status: 'done',
  },
  {
    name: 'Review',
    rule: 'The person reads what ExponetDB computed first, then the stored files as text.',
    status: 'done',
  },
  {
    name: 'Approve',
    rule: 'Bound to the plan hash on the page. A person approves; an agent never does.',
    status: 'done',
  },
  {
    name: 'Apply',
    rule: 'Every binding is checked again. A change since the plan ends in PLAN_STALE.',
    status: 'current',
  },
  {
    name: 'Verify',
    rule: 'Happens after the change. Applied is not verified.',
    status: 'next',
  },
] as const

const STATUS_WORDS = { done: 'Done', current: 'In progress', next: 'Not started' } as const

function Steps(): ReactNode {
  return (
    <ol aria-label="Steps of a change" className="m-0 flex list-none flex-col gap-3 p-0">
      {STEPS.map((step, index) => (
        <li
          key={step.name}
          data-status={step.status}
          aria-current={step.status === 'current' ? 'step' : undefined}
          className="flex items-start gap-3"
        >
          <span
            aria-hidden="true"
            className={cn(
              'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-xs',
              step.status === 'done' && 'border-strong bg-surface-200 text-foreground',
              step.status === 'current' && 'border-foreground text-foreground',
              step.status === 'next' && 'border-dashed border-strong text-foreground-lighter',
            )}
          >
            {step.status === 'done' ? <Check className="size-3.5" /> : index + 1}
          </span>
          <div className="flex min-w-0 flex-col">
            <p className="m-0 text-sm font-medium text-foreground">
              {step.name}
              <span className="ml-2 text-xs font-normal text-foreground-lighter">
                {STATUS_WORDS[step.status]}
              </span>
            </p>
            <p className="m-0 text-sm text-foreground-light">{step.rule}</p>
          </div>
        </li>
      ))}
    </ol>
  )
}

// ---------------------------------------------------------------------------
// Applied and verified are two indicators, never one
// ---------------------------------------------------------------------------

type Indicator = 'yes' | 'no' | 'waiting' | 'problem'

function IndicatorRow({
  label,
  value,
  detail,
  kind,
}: {
  readonly label: string
  readonly value: string
  readonly detail: string
  readonly kind: Indicator
}): ReactNode {
  return (
    <div data-indicator={label.toLowerCase()} data-kind={kind} className="flex items-start gap-3">
      <span className="mt-0.5 shrink-0">
        {kind === 'yes' ? (
          <StatusIcon variant="success" decorative />
        ) : kind === 'problem' ? (
          <StatusIcon variant="warning" decorative />
        ) : kind === 'waiting' ? (
          <Clock aria-hidden="true" className="size-4 text-foreground-light" />
        ) : (
          <CircleHelp aria-hidden="true" className="size-4 text-foreground-light" />
        )}
      </span>
      <div className="flex min-w-0 flex-col">
        <p className="m-0 text-sm text-foreground">
          <span className="text-foreground-light">{label}: </span>
          <span className="font-medium">{value}</span>
        </p>
        <p className="m-0 text-sm text-foreground-light">{detail}</p>
      </div>
    </div>
  )
}

function OperationCard({
  heading,
  children,
}: {
  readonly heading: string
  readonly children: ReactNode
}): ReactNode {
  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <p className="m-0 text-sm text-foreground-light">
          <span className="font-mono text-xs text-foreground">op_01K9D4</span> applies 2 migrations
          to <span className="font-mono text-xs text-foreground">shop/platform/staging</span>
        </p>
        <h3 className="m-0 text-sm font-medium text-foreground">{heading}</h3>
        {children}
      </CardContent>
    </Card>
  )
}

function AppliedNotVerified(): ReactNode {
  return (
    <OperationCard heading="Applied, not yet verified">
      <IndicatorRow
        label="Applied"
        value="Yes"
        detail="The ledger records both migrations as applied at 11:58 UTC."
        kind="yes"
      />
      <IndicatorRow
        label="Verified"
        value="Not yet"
        detail="Verification is running. Do not report success before it passes."
        kind="waiting"
      />
    </OperationCard>
  )
}

function NeedsAttention(): ReactNode {
  const [message, setMessage] = useState('')
  return (
    <div>
      <OperationCard heading="Needs attention">
        <IndicatorRow
          label="Applied"
          value="Yes"
          detail="The ledger records both migrations as applied at 11:58 UTC."
          kind="yes"
        />
        <IndicatorRow
          label="Verified"
          value="Not completed"
          detail="The target did not answer in time, so ExponetDB cannot tell whether the change is correct."
          kind="problem"
        />
        <div className="flex flex-col gap-2">
          <p className="m-0 text-sm text-foreground-light">
            Verify again repeats only the verification. It never applies the change a second time.
          </p>
          <div>
            <Button
              variant="default"
              onClick={() =>
                setMessage('Verification requested. The operation is verifying again.')
              }
            >
              Verify again
            </Button>
          </div>
        </div>
      </OperationCard>
      <Outcome>{message}</Outcome>
    </div>
  )
}

// ---------------------------------------------------------------------------
// PLAN_STALE: nothing ran, here is what changed, make a new plan
// ---------------------------------------------------------------------------

function PlanStale(): ReactNode {
  return (
    <ErrorDisplay
      title="The plan no longer matches the target"
      message="The plan no longer matches the target. Create a new plan."
      code="PLAN_STALE"
      headingLevel={3}
      actions={
        <Button variant="primary" size="tiny">
          Create new plan
        </Button>
      }
    >
      <div className="flex flex-col gap-3 px-4 py-3 text-sm text-foreground-light">
        <p className="m-0">Nothing was applied. What changed since the plan was created:</p>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          <li className="flex flex-col gap-0.5">
            <span className="text-foreground">Schema fingerprint</span>
            <span>
              Expected <UntrustedName name="fp1:17:ab41" mono />, found{' '}
              <UntrustedName name="fp1:17:9c07" mono />.
            </span>
          </li>
          <li className="flex flex-col gap-0.5">
            <span className="text-foreground">Ledger state</span>
            <span>Another migration was applied at 12:07 UTC.</span>
          </li>
        </ul>
      </div>
    </ErrorDisplay>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'guidance/plan-and-apply/steps',
    title: 'Plan, review, approve, apply, verify',
    render: () => <Steps />,
  },
  {
    id: 'guidance/plan-and-apply/applied-not-verified',
    title: 'Applied and verified are separate indicators',
    render: () => <AppliedNotVerified />,
  },
  {
    id: 'guidance/plan-and-apply/needs-attention',
    title: 'Verification did not complete: the change is applied, the outcome is open',
    render: () => <NeedsAttention />,
  },
  {
    id: 'guidance/plan-and-apply/plan-stale',
    title: 'PLAN_STALE: nothing ran, the plan is replaced, never refreshed',
    render: () => <PlanStale />,
  },
]

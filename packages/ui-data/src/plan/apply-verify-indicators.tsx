import {
  AlertTriangle,
  Check,
  CircleHelp,
  Clock,
  Dot,
  Loader2,
  type LucideIcon,
  X,
} from '@exponetdb/icons'
import { Button, cn } from '@exponetdb/ui'
import {
  type HeadingLevel,
  type NowInput,
  UntrustedText,
  useResolvedNow,
} from '@exponetdb/ui-patterns'
import { type ReactNode, useRef, useState } from 'react'

import { knownText } from './format.ts'
import { PlanBlock } from './plan-frame.tsx'
import { Marked, NotKnown, TimeText } from './shared.tsx'

/**
 * The tone of an indicator. Only a passed verification is `done`: an applied
 * change is never shown as a success on its own (C-13).
 */
type Tone = 'waiting' | 'progress' | 'neutral' | 'done' | 'warning' | 'failed' | 'unknown'

interface OutcomeText {
  readonly label: string
  readonly icon: LucideIcon
  readonly tone: Tone
  /** One sentence on what the outcome means. */
  readonly meaning: string
}

/**
 * Apply outcomes: the contract's `ApplyOutcome` (`not_started`, `applied`,
 * `not_applied`, `partially_applied`, `unknown`) and the words a page may use
 * for an operation that has not finished applying (`pending`, `running`,
 * `failed`).
 */
const APPLY: Readonly<Record<string, OutcomeText>> = {
  not_started: {
    label: 'Not started',
    icon: Clock,
    tone: 'waiting',
    meaning: 'Nothing has run on the target yet.',
  },
  pending: {
    label: 'Pending',
    icon: Clock,
    tone: 'waiting',
    meaning: 'Nothing has run on the target yet.',
  },
  running: {
    label: 'Applying',
    icon: Loader2,
    tone: 'progress',
    meaning: 'The change is running on the target.',
  },
  applied: {
    label: 'Applied',
    icon: Check,
    tone: 'neutral',
    meaning: 'The change ran on the target. Applied is not verified.',
  },
  partially_applied: {
    label: 'Partially applied',
    icon: AlertTriangle,
    tone: 'warning',
    meaning: 'Part of the change ran on the target; the rest did not.',
  },
  not_applied: {
    label: 'Not applied',
    icon: X,
    tone: 'failed',
    meaning: 'The change did not take effect on the target.',
  },
  failed: {
    label: 'Failed',
    icon: X,
    tone: 'failed',
    meaning: 'The apply failed.',
  },
}

/**
 * Verification outcomes: the contract's `VerificationOutcome`
 * (`not_applicable`, `pending`, `passed`, `failed`, `partial`, `error`) and
 * `verified` as another word for `passed`.
 */
const VERIFICATION: Readonly<Record<string, OutcomeText>> = {
  pending: {
    label: 'Pending',
    icon: Clock,
    tone: 'waiting',
    meaning: 'The checks have not run yet.',
  },
  running: {
    label: 'Verifying',
    icon: Loader2,
    tone: 'progress',
    meaning: 'The checks are running.',
  },
  passed: {
    label: 'Verified',
    icon: Check,
    tone: 'done',
    meaning: 'The checks passed.',
  },
  verified: {
    label: 'Verified',
    icon: Check,
    tone: 'done',
    meaning: 'The checks passed.',
  },
  partial: {
    label: 'Partly verified',
    icon: AlertTriangle,
    tone: 'warning',
    meaning: 'Some checks passed and some did not.',
  },
  failed: {
    label: 'Verification failed',
    icon: X,
    tone: 'failed',
    meaning: 'The checks ran and did not pass.',
  },
  error: {
    label: 'Verification error',
    icon: AlertTriangle,
    tone: 'failed',
    meaning: 'The checks could not run to the end; nothing is proven.',
  },
  not_applicable: {
    label: 'Not applicable',
    icon: Dot,
    tone: 'neutral',
    meaning: 'This change has no verification. That proves nothing about its effect.',
  },
}

const TONE_CLASSES: Readonly<Record<Tone, string>> = {
  waiting: 'border-default text-foreground-light',
  progress: 'border-strong text-foreground',
  neutral: 'border-strong text-foreground',
  done: 'border-success-500 text-success-600',
  warning: 'border-warning-500 text-warning-600',
  failed: 'border-destructive-400 text-destructive',
  unknown: 'border-dashed border-strong text-foreground-light',
}

function outcomeOf(
  value: string | null,
  table: Readonly<Record<string, OutcomeText>>,
  progress: boolean,
): { readonly key: string; readonly text: OutcomeText } {
  const known = knownText(value)
  if (known === undefined) {
    return {
      key: 'unknown',
      text: {
        label: 'Not known',
        icon: CircleHelp,
        tone: 'unknown',
        meaning: 'ExponetDB could not establish this outcome.',
      },
    }
  }
  // The operation is working on this phase: say so instead of "pending".
  if (progress && (known === 'pending' || known === 'not_started')) {
    const running = table['running']
    if (running !== undefined) return { key: 'running', text: running }
  }
  const text = Object.hasOwn(table, known) ? table[known] : undefined
  if (text !== undefined) return { key: known, text }
  return {
    key: known,
    text: {
      label: known,
      icon: CircleHelp,
      tone: 'unknown',
      meaning: 'This outcome is not known to this version of the Web App.',
    },
  }
}

function Indicator({
  name,
  outcome,
  at,
  now,
}: {
  readonly name: 'apply' | 'verification'
  readonly outcome: { readonly key: string; readonly text: OutcomeText }
  readonly at: string | null | undefined
  readonly now: number
}): ReactNode {
  const Icon = outcome.text.icon
  return (
    <li
      data-indicator={name}
      data-outcome={outcome.key}
      data-tone={outcome.text.tone}
      className={cn(
        'flex min-w-0 items-start gap-3 rounded-md border bg-surface-75 px-3 py-2',
        TONE_CLASSES[outcome.text.tone],
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          'mt-0.5 size-4 shrink-0',
          outcome.text.tone === 'progress' && 'animate-spin motion-reduce:animate-none',
        )}
      />
      <div className="flex min-w-0 flex-col gap-0.5 text-sm">
        <span className="text-xs text-foreground-lighter">
          {name === 'apply' ? 'Apply' : 'Verification'}
        </span>
        <strong className="font-medium">
          {outcome.text.tone === 'unknown' && outcome.key !== 'unknown' ? (
            <Marked text={outcome.text.label} mono />
          ) : (
            outcome.text.label
          )}
        </strong>
        <span className="text-foreground-light">{outcome.text.meaning}</span>
        {at === undefined ? null : (
          <span className="text-xs text-foreground-light">
            <TimeText at={at} now={now} />
          </span>
        )}
      </div>
    </li>
  )
}

/** What the server says about an operation that needs attention. */
export interface NeedsAttentionView {
  /** The next action as the server named it (catalog text); `null` when it named none. */
  readonly nextAction: string | null
  /**
   * `OperationRead.retryable`: `true` exactly when the server accepts
   * "Verify again" (`POST /operations/{id}/retry-verification`); `null` when it
   * did not evaluate it. Only `true` offers the action.
   */
  readonly retryable: boolean | null
}

export interface ApplyVerifyIndicatorsProps {
  /** `OperationView.applyOutcome`; `null` when not known. */
  readonly applyOutcome: string | null
  /** When the apply outcome was reached; leave out where no time applies, `null` for "time not known". */
  readonly appliedAt?: string | null
  /** `OperationView.verificationOutcome`; `null` when not known. */
  readonly verificationOutcome: string | null
  /** When the verification outcome was reached; leave out where no time applies. */
  readonly verifiedAt?: string | null
  /**
   * `OperationView.state`: with `running` a pending apply shows as "Applying",
   * with `verifying` a pending verification as "Verifying". Nothing else is
   * derived from it.
   */
  readonly operationState?: string | null
  /** Present when the operation needs attention (`state: needs_attention`). */
  readonly needsAttention?: NeedsAttentionView | null
  /** Starts a verification retry; offered only when `needsAttention.retryable` is `true`. */
  readonly onVerifyAgain?: () => unknown
  readonly now?: NowInput
  readonly headingLevel?: HeadingLevel
}

function VerifyAgain({ onVerifyAgain }: { readonly onVerifyAgain: () => unknown }): ReactNode {
  const inFlight = useRef(false)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        type="button"
        variant="default"
        size="tiny"
        loading={pending}
        onClick={async () => {
          // One press runs once, even when two arrive before React renders again.
          if (inFlight.current) return
          inFlight.current = true
          setPending(true)
          setFailed(false)
          try {
            await onVerifyAgain()
          } catch {
            setFailed(true)
          } finally {
            inFlight.current = false
            setPending(false)
          }
        }}
      >
        Verify again
      </Button>
      <span role="status" className="text-xs text-foreground-light">
        {failed
          ? 'Verify again did not start. Check the operation state before you try again.'
          : ''}
      </span>
    </div>
  )
}

/**
 * The apply outcome and the verification outcome of an operation as two
 * separate indicators, each with its own icon, words and time (C-13: applied
 * is not verified; there is no combined "success"). An operation that needs
 * attention shows the next action the server named, and "Verify again" only
 * when the server says a retry is accepted.
 */
export function ApplyVerifyIndicators({
  applyOutcome,
  appliedAt,
  verificationOutcome,
  verifiedAt,
  operationState,
  needsAttention,
  onVerifyAgain,
  now,
  headingLevel,
}: ApplyVerifyIndicatorsProps): ReactNode {
  const current = useResolvedNow(now)
  const apply = outcomeOf(applyOutcome, APPLY, operationState === 'running')
  const verification = outcomeOf(verificationOutcome, VERIFICATION, operationState === 'verifying')
  const attention = needsAttention ?? null
  const nextAction = attention === null ? undefined : knownText(attention.nextAction)

  return (
    <PlanBlock
      title="Apply and verification"
      headingLevel={headingLevel}
      data-plan-block="outcome"
      description="Applied is not verified: a change is done only when it is applied and verified."
    >
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Indicator name="apply" outcome={apply} at={appliedAt} now={current} />
        <Indicator name="verification" outcome={verification} at={verifiedAt} now={current} />
      </ul>
      {attention === null ? null : (
        <div
          role="note"
          data-needs-attention=""
          className="flex flex-col gap-2 rounded-md border border-warning-500 bg-warning-200 px-3 py-2 text-sm"
        >
          <p className="inline-flex items-center gap-1.5 font-medium">
            <AlertTriangle aria-hidden="true" className="size-4 text-warning-600" />
            Needs attention
          </p>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-foreground-lighter">Next action</span>
            {nextAction === undefined ? (
              <span>
                <NotKnown />. Inspect the operation before you do anything else.
              </span>
            ) : (
              <UntrustedText text={nextAction} label="next action" />
            )}
          </div>
          {attention.retryable === true && onVerifyAgain !== undefined ? (
            <VerifyAgain onVerifyAgain={onVerifyAgain} />
          ) : attention.retryable === false ? (
            <p className="text-foreground-light">
              Verification cannot be retried for this operation.
            </p>
          ) : attention.retryable === null ? (
            <p className="text-foreground-light">
              Whether verification can be retried is <NotKnown />.
            </p>
          ) : null}
        </div>
      )}
    </PlanBlock>
  )
}

import {
  ApplyOutcomeSchema,
  OperationStateSchema,
  VerificationOutcomeSchema,
} from '@exponetdb/contracts'

/**
 * The operation state machine ([operations-engine.md §4.1](../../../exponetdb-docs/02-control-plane/operations-engine.md#41-state-machine)).
 * One table, used by the transition API and mirrored by the database guard
 * (`operations.transition_allowed`, `operations.state_admits`); tests check
 * that both agree. Applied is not verified (C-13): `applyOutcome` and
 * `verificationOutcome` are separate fields, and each state admits only
 * certain pairs.
 */
export const OPERATION_STATES = OperationStateSchema.options
export type OperationState = (typeof OPERATION_STATES)[number]
export const APPLY_OUTCOMES = ApplyOutcomeSchema.options
export type ApplyOutcome = (typeof APPLY_OUTCOMES)[number]
export const VERIFICATION_OUTCOMES = VerificationOutcomeSchema.options
export type VerificationOutcome = (typeof VERIFICATION_OUTCOMES)[number]

export const INITIAL_STATES: readonly OperationState[] = ['awaiting_approval', 'queued']
export const TERMINAL_STATES: readonly OperationState[] = [
  'succeeded',
  'failed',
  'verification_failed',
  'canceled',
]
/** States a worker holds under a lease. */
export const LEASED_STATES: readonly OperationState[] = [
  'running',
  'verifying',
  'needs_reconciliation',
]

export const TRANSITIONS: Readonly<Record<OperationState, readonly OperationState[]>> = {
  awaiting_approval: ['queued', 'canceled'],
  queued: ['running', 'failed', 'canceled'],
  running: ['verifying', 'failed', 'needs_reconciliation'],
  needs_reconciliation: ['verifying', 'failed', 'needs_attention'],
  verifying: ['succeeded', 'verification_failed', 'needs_attention'],
  needs_attention: ['verifying'],
  succeeded: [],
  failed: [],
  verification_failed: [],
  canceled: [],
}

const ADMITS: Readonly<
  Record<
    OperationState,
    {
      readonly apply: readonly ApplyOutcome[]
      readonly verification: readonly VerificationOutcome[]
    }
  >
> = {
  awaiting_approval: { apply: ['not_started'], verification: ['pending', 'not_applicable'] },
  queued: { apply: ['not_started'], verification: ['pending', 'not_applicable'] },
  running: { apply: ['not_started'], verification: ['pending', 'not_applicable'] },
  verifying: { apply: ['applied', 'partially_applied'], verification: ['pending'] },
  needs_reconciliation: { apply: ['unknown'], verification: ['pending', 'not_applicable'] },
  needs_attention: {
    apply: ['applied', 'partially_applied', 'unknown'],
    verification: ['pending', 'error'],
  },
  succeeded: { apply: ['applied'], verification: ['passed', 'not_applicable'] },
  failed: { apply: ['not_started', 'not_applied'], verification: ['not_applicable'] },
  verification_failed: {
    apply: ['applied', 'partially_applied'],
    verification: ['failed', 'partial'],
  },
  canceled: { apply: ['not_started'], verification: ['not_applicable'] },
}

export function canTransition(from: OperationState, to: OperationState): boolean {
  return TRANSITIONS[from].includes(to)
}

export function admits(
  state: OperationState,
  apply: ApplyOutcome,
  verification: VerificationOutcome,
): boolean {
  const allowed = ADMITS[state]
  return allowed.apply.includes(apply) && allowed.verification.includes(verification)
}

export function isTerminal(state: OperationState): boolean {
  return TERMINAL_STATES.includes(state)
}

export function isOperationState(value: unknown): value is OperationState {
  return OPERATION_STATES.some((s) => s === value)
}

export function isApplyOutcome(value: unknown): value is ApplyOutcome {
  return APPLY_OUTCOMES.some((s) => s === value)
}

export function isVerificationOutcome(value: unknown): value is VerificationOutcome {
  return VERIFICATION_OUTCOMES.some((s) => s === value)
}

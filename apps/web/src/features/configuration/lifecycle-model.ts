/**
 * What the lifecycle section of the configuration page offers and checks
 * before it asks the server for a plan. Nothing here decides what a person
 * may do (the server does, on the `registry.manage` permission the contract
 * names); it only chooses which of the three plans make sense for the state
 * the registry reports, and validates the one field the contract takes.
 */

/** The contract's `reason`: a short machine-readable code, kept on the target and in the audit. */
export const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/

export type ReasonProblem = 'required' | 'invalid'

/** What is wrong with a typed reason code, or `undefined` when it is acceptable (or optional and empty). */
export function reasonCodeProblem(value: string, required: boolean): ReasonProblem | undefined {
  const text = value.trim()
  if (text === '') return required ? 'required' : undefined
  return REASON_CODE.test(text) ? undefined : 'invalid'
}

export interface LifecycleOffers {
  /** Stop writes (an active target). */
  readonly suspend: boolean
  /** Allow writes again (a suspended target). */
  readonly resume: boolean
  /** Retire the target for good (any target that is not decommissioned yet). */
  readonly decommission: boolean
}

/**
 * The plans worth offering for a target state. A state this page does not
 * know offers nothing (fail closed): the registry may have learned a state
 * the page cannot reason about, and a plan for it would be a guess.
 */
export function lifecycleOffers(state: string): LifecycleOffers {
  switch (state) {
    case 'active':
      return { suspend: true, resume: false, decommission: true }
    case 'suspended':
      return { suspend: false, resume: true, decommission: true }
    case 'registered':
      return { suspend: false, resume: false, decommission: true }
    default:
      return { suspend: false, resume: false, decommission: false }
  }
}

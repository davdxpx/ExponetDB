import { formatCount, type NowInput, toMillis } from '@exponetdb/ui-patterns'

/**
 * Pure helpers of the plan review blocks. They decide nothing about
 * authorization: they turn the server's values into words, and they say
 * "not known" wherever a value is missing (C-11, C-30: a missing or
 * `unknown` value is never shown as the favorable case).
 */

/** The words for a value the server did not give or could not establish. */
export const NOT_KNOWN = 'not known'

/**
 * The value when it is a real answer; `undefined` for a missing value, an
 * empty string and the server's own `unknown`, so the caller shows
 * "not known" instead of a value that looks safe.
 */
export function knownText(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined
  if (value === '' || value === 'unknown') return undefined
  return value
}

/** Whether the number is a real count or size (finite and not negative). */
export function knownNumber(value: number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

/**
 * A remaining time as the countdown shows it: `1 h 05 min`, `4 min 30 s`,
 * `45 s`. Below one second it is `less than 1 s`.
 */
export function formatRemaining(ms: number): string {
  if (!Number.isFinite(ms) || ms < SECOND) return 'less than 1 s'
  if (ms >= HOUR) {
    const hours = Math.floor(ms / HOUR)
    const minutes = Math.floor((ms % HOUR) / MINUTE)
    return `${formatCount(hours)} h ${String(minutes).padStart(2, '0')} min`
  }
  if (ms >= MINUTE) {
    const minutes = Math.floor(ms / MINUTE)
    const seconds = Math.floor((ms % MINUTE) / SECOND)
    return `${minutes} min ${String(seconds).padStart(2, '0')} s`
  }
  return `${Math.floor(ms / SECOND)} s`
}

/** A duration in seconds, in words: `5 min`, `90 s`, `2 h`. */
export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return NOT_KNOWN
  if (seconds >= 3_600 && seconds % 3_600 === 0) return `${formatCount(seconds / 3_600)} h`
  if (seconds >= 60 && seconds % 60 === 0) return `${formatCount(seconds / 60)} min`
  return `${formatCount(seconds)} s`
}

/** Where a plan stands against its expiry at a given time. */
export type ExpiryStatus =
  /** No expiry, or one that is not a date, or no usable clock: nothing is offered. */
  | { readonly kind: 'unknown' }
  | { readonly kind: 'expired'; readonly atMs: number }
  | { readonly kind: 'open'; readonly atMs: number; readonly remainingMs: number }

/**
 * The expiry of a plan at `now`. The plan is expired from the instant
 * `expiresAt` is reached (the server refuses an apply at `now >= expiresAt`,
 * `PLAN_EXPIRED`). A missing or unreadable expiry or clock is `unknown`.
 */
export function expiryStatus(expiresAt: string | null | undefined, now: NowInput): ExpiryStatus {
  if (expiresAt === null || expiresAt === undefined) return { kind: 'unknown' }
  const atMs = Date.parse(expiresAt)
  const nowMs = toMillis(now)
  if (Number.isNaN(atMs) || Number.isNaN(nowMs)) return { kind: 'unknown' }
  const remainingMs = atMs - nowMs
  return remainingMs <= 0 ? { kind: 'expired', atMs } : { kind: 'open', atMs, remainingMs }
}

/** Whether a plan hash is there to show and to send: not empty, not only white space. */
export function hashKnown(planHash: string): boolean {
  return planHash.trim() !== ''
}

/** Plan states of the contract (`PlanState`). */
export type PlanStateName =
  | 'active'
  | 'consumed'
  | 'expired'
  | 'invalidated'
  | 'denied'
  | 'withdrawn'

const PLAN_STATE_LABELS: Readonly<Record<PlanStateName, string>> = {
  active: 'Active',
  consumed: 'Accepted: an operation applies it',
  expired: 'Expired',
  invalidated: 'Invalidated: a binding changed',
  denied: 'Denied by the policy',
  withdrawn: 'Withdrawn',
}

export function isPlanStateName(value: string): value is PlanStateName {
  return Object.hasOwn(PLAN_STATE_LABELS, value)
}

/** The words for a plan state; `undefined` for a state this version does not know. */
export function planStateLabel(state: string): string | undefined {
  return isPlanStateName(state) ? PLAN_STATE_LABELS[state] : undefined
}

/** Whether the plan-level actions (apply, withdraw) are offered, and why not. */
export type ActionAvailability =
  | { readonly offered: true }
  | { readonly offered: false; readonly reason: string }

/**
 * Whether a plan's own actions are offered on the page. This is not an
 * authorization (the server checks every request again, C-10); it keeps the
 * page from offering an action on a plan that is not active, expired, of
 * unknown expiry or shown from a read that may be out of date (C-11: unknown
 * fails closed).
 */
export function planActionAvailability(input: {
  readonly state: string | null
  readonly expiry: ExpiryStatus
  readonly stale: boolean
  /** The plan hash the page shows; an empty one offers nothing. */
  readonly planHash?: string
}): ActionAvailability {
  const { state, expiry, stale, planHash } = input
  if (planHash !== undefined && !hashKnown(planHash)) {
    return {
      offered: false,
      reason: 'The plan hash is not known, so no action is offered.',
    }
  }
  if (stale) {
    return {
      offered: false,
      reason:
        'This view may be out of date, so no action is offered. Refresh it before you decide.',
    }
  }
  if (state === null || !isPlanStateName(state)) {
    return {
      offered: false,
      reason: 'The state of this plan is not known, so no action is offered.',
    }
  }
  switch (state) {
    case 'consumed':
      return {
        offered: false,
        reason: 'This plan was accepted; an operation applies it. A plan is used once.',
      }
    case 'expired':
      return {
        offered: false,
        reason: 'This plan expired. Create a new plan to make this change.',
      }
    case 'invalidated':
      return {
        offered: false,
        reason: 'This plan is stale: a binding changed after it was made. Create a new plan.',
      }
    case 'denied':
      return { offered: false, reason: 'The policy denied this plan. It cannot be applied.' }
    case 'withdrawn':
      return { offered: false, reason: 'This plan was withdrawn. It cannot be applied.' }
    case 'active':
      break
  }
  if (expiry.kind === 'unknown') {
    return {
      offered: false,
      reason: 'The expiry of this plan is not known, so no action is offered.',
    }
  }
  if (expiry.kind === 'expired') {
    return {
      offered: false,
      reason: 'This plan expired. Create a new plan to make this change.',
    }
  }
  return { offered: true }
}

/** `1 approval`, `2 approvals`. */
export function plural(count: number, noun: string): string {
  return `${formatCount(count)} ${noun}${count === 1 ? '' : 's'}`
}

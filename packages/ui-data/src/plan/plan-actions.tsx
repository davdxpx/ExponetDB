import { type NowInput, toMillis } from '@exponetdb/ui-patterns'
import { type ReactNode, useEffect, useState } from 'react'

import { expiryStatus, planActionAvailability } from './format.ts'

/**
 * What a plan action receives: the identity of the plan and the hash the page
 * shows.
 *
 * The contract of the plan review page: the plan hash a person sees on the
 * page is the hash the approve and apply requests send. The page passes one
 * value, `PlanView.planHash`, to every block that shows it, and the blocks
 * hand that same prop value to their action render props unchanged, so the
 * request carries what was shown and nothing else (the server binds an
 * approval to the hash it names and answers `PLAN_STALE` for any other;
 * operations-engine.md §6). A dialog in between (`PlanConfirmDialog`) gets the
 * value from here as well and returns the facts it showed.
 */
export interface PlanBinding {
  readonly planId: string
  /** Exactly the hash the block shows, in full. */
  readonly planHash: string
}

/**
 * The time the expiry countdown measures against: the `now` prop when given
 * (tests, a page that shows a fixed moment; no timer runs), otherwise the
 * device clock, read every second until `untilMs` (the expiry) has passed and
 * once more exactly at it. `null` for `untilMs` reads the clock once.
 */
export function usePlanClock(now: NowInput | undefined, untilMs: number | null): number {
  const [current, setCurrent] = useState(() => Date.now())
  const fixed = now !== undefined
  useEffect(() => {
    if (fixed) return undefined
    const tick = () => setCurrent(Date.now())
    tick()
    if (untilMs === null || Number.isNaN(untilMs) || Date.now() >= untilMs) return undefined
    const timer = setInterval(() => {
      tick()
      if (Date.now() >= untilMs) clearInterval(timer)
    }, 1_000)
    // The flip to "expired" happens at the expiry itself, not up to a second later (a timer
    // delay is capped at the largest one browsers accept; the interval covers anything later).
    const atExpiry = setTimeout(tick, Math.min(2_147_483_647, Math.max(0, untilMs - Date.now())))
    return () => {
      clearInterval(timer)
      clearTimeout(atExpiry)
    }
  }, [fixed, untilMs])
  return now === undefined ? current : toMillis(now)
}

/** The epoch milliseconds of an expiry while the plan is active; `null` otherwise. */
export function activeUntil(state: string | null, expiresAt: string | null): number | null {
  if (state !== 'active' || expiresAt === null) return null
  const at = Date.parse(expiresAt)
  return Number.isNaN(at) ? null : at
}

export interface PlanActionsProps {
  readonly planId: string
  /** The plan hash the page shows; `render` receives exactly this value. */
  readonly planHash: string
  /** `PlanView.state`: `active`, `consumed`, `expired`, `invalidated`, `denied`, `withdrawn`. */
  readonly state: string | null
  /** `PlanView.expiresAt` (ISO 8601). */
  readonly expiresAt: string | null
  /** The view may be out of date (a stale read): no action is offered. */
  readonly stale?: boolean
  readonly now?: NowInput
  /** The plan's actions (apply, withdraw), rendered only while they are offered. */
  readonly render: (binding: PlanBinding) => ReactNode
}

/**
 * The actions of a plan, offered only while the plan is active, before its
 * expiry, with a known expiry and from a current read; otherwise the reason
 * they are not offered. The page decides which actions to render (and the
 * server decides whether they succeed); this component never offers one on a
 * plan that is expired, used, stale or of unknown state.
 */
export function PlanActions({
  planId,
  planHash,
  state,
  expiresAt,
  stale = false,
  now,
  render,
}: PlanActionsProps): ReactNode {
  const clock = usePlanClock(now, activeUntil(state, expiresAt))
  const expiry = expiryStatus(expiresAt, clock)
  const availability = planActionAvailability({ state, expiry, stale, planHash })
  if (!availability.offered) {
    return (
      <p data-plan-actions="withheld" className="text-sm text-foreground-light">
        {availability.reason}
      </p>
    )
  }
  return (
    <div data-plan-actions="offered" className="flex flex-wrap items-center gap-2">
      {render({ planId, planHash })}
    </div>
  )
}

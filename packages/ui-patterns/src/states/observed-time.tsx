import type { ReactNode } from 'react'

import { formatAge, formatUtc, type NowInput, toIso } from './format.ts'
import { useResolvedNow } from './use-now.ts'

export interface ObservedTimeProps {
  /** ISO 8601 time of the observation. */
  observedAt: string
  /** Also show the absolute time in UTC after the age: "4 min ago (2026-10-13 14:03 UTC)". */
  withDate?: boolean
  /** Show seconds below one minute ("12 s ago"). */
  seconds?: boolean
  /** The time ages are measured against; without it the shared clock is used. */
  now?: NowInput
  className?: string
}

/**
 * When something was observed, as a `<time>` element. A value that is not a
 * date is shown as "time unknown": a wrong or missing time is never replaced by
 * a plausible one.
 */
export function ObservedTime({
  observedAt,
  withDate = false,
  seconds = false,
  now,
  className,
}: ObservedTimeProps): ReactNode {
  const current = useResolvedNow(now)
  const iso = toIso(observedAt)
  const age = formatAge(observedAt, current, { seconds })
  const utc = formatUtc(observedAt)
  if (iso === undefined || age === undefined) {
    return <span className={className}>time unknown</span>
  }
  return (
    <time dateTime={iso} className={className}>
      {withDate && utc !== undefined ? `${age} (${utc})` : age}
    </time>
  )
}

import { useEffect, useState } from 'react'

const REFRESH_MS = 30_000

/**
 * The current time for the ages a chart shows ("observed 4 minutes ago"). A
 * caller that passes `now` (milliseconds since the epoch) fixes the time, which
 * keeps tests and snapshots deterministic; without it the hook reads the clock
 * and refreshes it every 30 seconds.
 */
export function useChartNow(now?: number): number {
  const [tick, setTick] = useState(() => Date.now())
  useEffect(() => {
    if (now !== undefined) return
    const id = setInterval(() => setTick(Date.now()), REFRESH_MS)
    return () => clearInterval(id)
  }, [now])
  return now ?? tick
}

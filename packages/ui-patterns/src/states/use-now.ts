import { useSyncExternalStore } from 'react'

import { type NowInput, toMillis } from './format.ts'

/**
 * One shared clock for every age on the page ("4 min ago"): a single interval
 * runs while at least one component is subscribed, and the snapshot is the
 * current time rounded down to the tick, so it is stable between ticks and a
 * hundred badges cost one timer, not a hundred.
 */
const TICK_MS = 10_000

const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined

function snapshot(): number {
  return Math.floor(Date.now() / TICK_MS) * TICK_MS
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (timer === undefined) {
    timer = setInterval(() => {
      for (const notify of listeners) notify()
    }, TICK_MS)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

function neverChanges(): () => void {
  return () => {}
}

/**
 * The time a component measures ages against. With a `now` prop (tests, or a
 * page that shows one fixed moment) it is that value and no timer runs;
 * without, it follows the shared clock.
 */
export function useResolvedNow(now?: NowInput): number {
  const tick = useSyncExternalStore(
    now === undefined ? subscribe : neverChanges,
    snapshot,
    snapshot,
  )
  return now === undefined ? tick : toMillis(now)
}

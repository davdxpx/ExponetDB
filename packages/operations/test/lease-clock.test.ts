import type { ControlStore } from '@exponetdb/control-store'
import { systemClock } from '@exponetdb/kernel'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withLease } from '../src/driver.ts'
import { KindRegistry } from '../src/kinds.ts'

/**
 * VC-040: the worker's belief that it still holds its lease used `Date.now()`, so a wall clock
 * stepped back kept an expired lease "alive" (the step it ran could go on past its lease) and a
 * step forward aborted a healthy one. The belief is measured on the monotonic clock. The
 * renewal always fails here, so only the belief decides.
 */
const store = {
  query: async () => {
    throw new Error('the store is down')
  },
} as unknown as ControlStore
const claim = { operation: { operationId: 'op_01J00000000000000000000000' } } as never
const options = {
  workerId: 'prc_01J00000000000000000000000' as never,
  kinds: new KindRegistry([]),
  clock: systemClock,
  leaseMs: 1000,
  renewMs: 100,
}

afterEach(() => vi.useRealTimers())

describe('the lease belief of a worker (VC-040)', () => {
  it('ends a lease that ran out although the wall clock was stepped back five minutes', async () => {
    vi.useFakeTimers()
    const aborted = await withLease(store, claim, options, async (signal) => {
      vi.setSystemTime(Date.now() - 5 * 60_000)
      await vi.advanceTimersByTimeAsync(2000)
      return signal.aborted
    })
    expect(aborted).toBe(true)
  })

  it('keeps a lease that has margin although the wall clock was stepped forward an hour', async () => {
    vi.useFakeTimers()
    const aborted = await withLease(store, claim, options, async (signal) => {
      vi.setSystemTime(Date.now() + 3600_000)
      await vi.advanceTimersByTimeAsync(300)
      return signal.aborted
    })
    expect(aborted).toBe(false)
  })
})

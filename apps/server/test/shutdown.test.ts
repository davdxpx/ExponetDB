import { describe, expect, it } from 'vitest'
import { shutdown } from '../src/roles/lifecycle.ts'

/**
 * VC-043: on SIGTERM a role stops claiming and lets the running step finish within its window
 * (EXPONETDB_SHUTDOWN_TIMEOUT_MS). When the window ran out, the process exited before
 * `services.stop()`: the heartbeat row was never marked stopped. Whatever the loops do, the
 * services are stopped, each step in its own bound.
 */
describe('a role shutdown (VC-043)', () => {
  const steps = (loops: () => Promise<void>) => {
    const done: string[] = []
    return {
      done,
      run: shutdown(
        {
          markStopping: () => done.push('stopping'),
          closePublic: async () => {
            done.push('public')
          },
          stopLoops: async () => {
            await loops()
            done.push('loops')
          },
          stopServices: async () => {
            done.push('services')
          },
          closeInternal: async () => {
            done.push('internal')
          },
        },
        { drainMs: 50, afterMs: 500 },
      ),
    }
  }

  it('drains the loops, then stops the services, and reports a clean stop', async () => {
    const s = steps(async () => undefined)
    expect(await s.run).toBe(true)
    expect(s.done).toEqual(['stopping', 'public', 'loops', 'services', 'internal'])
  })

  it('stops the services also when a running step outlasts the drain window', async () => {
    const s = steps(() => new Promise<void>(() => undefined))
    expect(await s.run).toBe(false)
    // The heartbeat is marked stopped and the pool closed; the step is reconciled after restart.
    expect(s.done).toEqual(['stopping', 'public', 'services', 'internal'])
  })
})

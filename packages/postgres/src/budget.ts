import { TargetError } from './errors.ts'

/**
 * Connection budget and circuit breaker ([postgres-adapter.md §3](../../../exponetdb-docs/03-database-model/postgres-adapter.md#3-driver-and-connections)).
 *
 * The budget is a counting semaphore per cluster **in this process**. One
 * process cannot see another process's connections, so the documented
 * installation-wide limit (8 per cluster) is split between the process roles
 * by configuration (gate record G4 §5, D4: serve 3, worker 5 by default),
 * and the sum is what the installation can open. A waiter that does not get
 * a slot within its deadline fails with `TARGET_UNAVAILABLE`
 * (`budget_exhausted`): ExponetDB never queues without bound on a cluster
 * that is short of slots.
 */
export class ConnectionBudget {
  readonly #limit: number
  readonly #used = new Map<string, number>()
  readonly #waiters = new Map<string, Array<() => void>>()

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 64) {
      throw new RangeError('the connection budget is between 1 and 64 per cluster')
    }
    this.#limit = limit
  }

  get limit(): number {
    return this.#limit
  }

  inUse(clusterId: string): number {
    return this.#used.get(clusterId) ?? 0
  }

  /** Takes one slot; the returned function gives it back (idempotent). */
  async acquire(clusterId: string, deadlineMs: number): Promise<() => void> {
    if (this.inUse(clusterId) >= this.#limit) {
      await new Promise<void>((resolve, reject) => {
        const queue = this.#waiters.get(clusterId) ?? []
        const wake = () => {
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(() => {
          const list = this.#waiters.get(clusterId) ?? []
          const at = list.indexOf(wake)
          if (at >= 0) list.splice(at, 1)
          reject(new TargetError('TARGET_UNAVAILABLE', 'budget_exhausted'))
        }, deadlineMs)
        queue.push(wake)
        this.#waiters.set(clusterId, queue)
      })
    }
    this.#used.set(clusterId, this.inUse(clusterId) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const now = this.inUse(clusterId) - 1
      if (now <= 0) this.#used.delete(clusterId)
      else this.#used.set(clusterId, now)
      const next = this.#waiters.get(clusterId)?.shift()
      next?.()
    }
  }
}

/**
 * After `threshold` consecutive connection failures within `windowMs`, the
 * key (a target or cluster) is open for `openMs`: callers get
 * `TARGET_UNAVAILABLE` (`circuit_open`) at once instead of piling up
 * connection attempts. One success closes it.
 */
export class CircuitBreaker {
  readonly #threshold: number
  readonly #windowMs: number
  readonly #openMs: number
  readonly #now: () => number
  readonly #failures = new Map<string, number[]>()
  readonly #openUntil = new Map<string, number>()

  constructor(
    options: {
      readonly threshold?: number
      readonly windowMs?: number
      readonly openMs?: number
      readonly now?: () => number
    } = {},
  ) {
    this.#threshold = options.threshold ?? 3
    this.#windowMs = options.windowMs ?? 60_000
    this.#openMs = options.openMs ?? 30_000
    this.#now = options.now ?? Date.now
  }

  /** Throws `circuit_open` while the key is open. */
  check(key: string): void {
    const until = this.#openUntil.get(key)
    if (until !== undefined) {
      if (this.#now() < until) {
        throw new TargetError('TARGET_UNAVAILABLE', 'circuit_open')
      }
      this.#openUntil.delete(key)
      this.#failures.delete(key)
    }
  }

  isOpen(key: string): boolean {
    const until = this.#openUntil.get(key)
    return until !== undefined && this.#now() < until
  }

  success(key: string): void {
    this.#failures.delete(key)
    this.#openUntil.delete(key)
  }

  failure(key: string): void {
    const now = this.#now()
    const recent = (this.#failures.get(key) ?? []).filter((t) => now - t < this.#windowMs)
    recent.push(now)
    this.#failures.set(key, recent)
    if (recent.length >= this.#threshold) {
      this.#openUntil.set(key, now + this.#openMs)
    }
  }
}

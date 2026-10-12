import type { TokenBucket } from '@exponetdb/contracts'

/**
 * In-process rate limits of `/mcp` (owner decision 9 of the Wave 7 order,
 * ADR-0027 §3): token buckets per grant and per identity and tool class,
 * and concurrency gates. Nothing is stored in the Control Store; a restart
 * of `serve` resets them (deployment.md). Over a limit a request is refused
 * at once with the time after which a retry can pass, never queued.
 */
interface Bucket {
  tokens: number
  updatedMs: number
}

export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>()
  readonly #now: () => number
  #sweeps = 0

  constructor(now: () => number = () => performance.now()) {
    this.#now = now
  }

  /**
   * Takes one token from every named bucket, or from none: when any of them
   * is empty, nothing is taken and the answer is the seconds until all of
   * them hold a token again.
   */
  take(
    entries: readonly { readonly key: string; readonly limit: TokenBucket }[],
  ): { readonly ok: true } | { readonly ok: false; readonly retryAfterSeconds: number } {
    const now = this.#now()
    this.#sweep(now)
    let wait = 0
    const states = entries.map(({ key, limit }) => {
      const existing = this.#buckets.get(key)
      const elapsed = existing === undefined ? 0 : Math.max(0, now - existing.updatedMs) / 1000
      const tokens = Math.min(
        limit.burst,
        existing === undefined ? limit.burst : existing.tokens + elapsed * limit.perSecond,
      )
      if (tokens < 1) {
        wait = Math.max(wait, (1 - tokens) / limit.perSecond)
      }
      return { key, tokens }
    })
    if (wait > 0) {
      for (const s of states) {
        this.#buckets.set(s.key, { tokens: s.tokens, updatedMs: now })
      }
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(wait)) }
    }
    for (const s of states) {
      this.#buckets.set(s.key, { tokens: s.tokens - 1, updatedMs: now })
    }
    return { ok: true }
  }

  /** Drops buckets idle for ten minutes (every 1 000 calls), so memory stays bounded. */
  #sweep(now: number): void {
    this.#sweeps++
    if (this.#sweeps % 1000 !== 0) {
      return
    }
    for (const [key, bucket] of this.#buckets) {
      if (now - bucket.updatedMs > 600_000) {
        this.#buckets.delete(key)
      }
    }
  }

  get size(): number {
    return this.#buckets.size
  }
}

/** Counts concurrent holders per key; acquiring over the bound fails at once. */
export class ConcurrencyGate {
  readonly #counts = new Map<string, number>()

  acquire(
    keys: readonly { readonly key: string; readonly max: number }[],
  ): (() => void) | undefined {
    for (const { key, max } of keys) {
      if ((this.#counts.get(key) ?? 0) >= max) {
        return undefined
      }
    }
    for (const { key } of keys) {
      this.#counts.set(key, (this.#counts.get(key) ?? 0) + 1)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      for (const { key } of keys) {
        const next = (this.#counts.get(key) ?? 1) - 1
        if (next <= 0) this.#counts.delete(key)
        else this.#counts.set(key, next)
      }
    }
  }

  count(key: string): number {
    return this.#counts.get(key) ?? 0
  }
}

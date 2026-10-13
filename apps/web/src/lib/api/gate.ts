/**
 * Serializes requests around a re-authentication. The server rotates the
 * session secret and the CSRF token when a person re-authenticates; a
 * request that is still in flight with the old values when the rotation
 * lands answers `SESSION_EXPIRED`, and a query-cache SPA would bounce to the
 * sign-in page. So a re-authentication first closes the gate (new requests
 * wait), waits until the requests in flight have settled, runs the
 * ceremony, and opens the gate again; waiting requests then read the
 * rotated CSRF token. One re-authentication runs at a time; a second caller
 * shares the first one's outcome.
 */
/** How long a re-authentication waits for requests in flight before it proceeds anyway. */
export const DRAIN_TIMEOUT_MS = 15_000

export class RequestGate {
  readonly #drainTimeoutMs: number
  #inFlight = 0
  #closed: Promise<void> | undefined
  #drained: (() => void) | undefined
  #exclusive: Promise<boolean> | undefined

  constructor(drainTimeoutMs = DRAIN_TIMEOUT_MS) {
    this.#drainTimeoutMs = drainTimeoutMs
  }

  /** Runs `send` once the gate is open, counting it as in flight while it runs. */
  async run<T>(send: () => Promise<T>): Promise<T> {
    while (this.#closed !== undefined) {
      await this.#closed
    }
    this.#inFlight++
    try {
      return await send()
    } finally {
      this.#inFlight--
      if (this.#inFlight === 0) {
        this.#drained?.()
      }
    }
  }

  /** Requests currently in flight (for tests and diagnostics). */
  get inFlight(): number {
    return this.#inFlight
  }

  /** Whether a re-authentication currently holds the gate. */
  get closed(): boolean {
    return this.#closed !== undefined
  }

  /**
   * Runs `ceremony` with the gate closed and no request in flight. The
   * ceremony's own requests bypass the gate (they are sent through
   * `bypass`). Concurrent callers share one ceremony and its result.
   */
  exclusive(ceremony: () => Promise<boolean>): Promise<boolean> {
    if (this.#exclusive !== undefined) {
      return this.#exclusive
    }
    let open = (): void => {}
    this.#closed = new Promise<void>((resolve) => {
      open = resolve
    })
    const run = async (): Promise<boolean> => {
      try {
        if (this.#inFlight > 0) {
          // A request that hangs must not hold the ceremony forever; one that answers after
          // the rotation is retried once by the client (its CSRF token changed under it).
          await new Promise<void>((resolve) => {
            this.#drained = resolve
            setTimeout(resolve, this.#drainTimeoutMs)
          })
        }
        this.#drained = undefined
        return await ceremony()
      } finally {
        this.#closed = undefined
        this.#exclusive = undefined
        open()
      }
    }
    this.#exclusive = run()
    return this.#exclusive
  }
}

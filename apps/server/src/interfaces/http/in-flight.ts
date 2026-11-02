/**
 * A bound on the requests of one kind that run at the same time (VC-046, VC-078). A request that
 * takes a large body holds that body (up to 32 MiB), its parse and its validation in the serving
 * process; a handful at once is what the container's memory carries. A request past the bound is
 * answered `RATE_LIMITED` with a `Retry-After` before any byte of its body is read.
 */
export class InFlight {
  readonly #max: number
  #running = 0

  constructor(max: number) {
    this.#max = max
  }

  /** A release function, or undefined when the bound is reached. Releasing twice counts once. */
  enter(): (() => void) | undefined {
    if (this.#running >= this.#max) return undefined
    this.#running++
    let released = false
    return () => {
      if (released) return
      released = true
      this.#running--
    }
  }

  get running(): number {
    return this.#running
  }
}

/** Requests with a body over the default limit that may be read at once, per serve process. */
export const LARGE_BODIES_IN_FLIGHT = 4

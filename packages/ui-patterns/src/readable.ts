/**
 * The truthful-state union every data component takes (C-28,
 * design-system.md §4): a component receives a `Readable<T>`, never a bare
 * `T` or `T[]`, so a failed read cannot be rendered as an empty one. Phase 1
 * seed; the state components that render it arrive in Phase 4.
 */
/**
 * Where an observed state comes from (C-28; the contracts' observation
 * sources): read in this request, a periodic sample, an earlier read served
 * again, reported by a node agent, or derived from other observations.
 */
export type ReadSource = 'live' | 'sampled' | 'cached' | 'agent_reported' | 'inferred'

export interface ReadFailure {
  /** The stable error code of the catalog, or a fixed client code (`NETWORK`, `UNKNOWN`). */
  readonly code: string
  /** Text from the error catalog, never an exception message. */
  readonly message: string
}

export type Readable<T> =
  | { readonly state: 'loading' }
  | { readonly state: 'failed'; readonly error: ReadFailure }
  | {
      readonly state: 'stale'
      readonly value: T
      readonly source: ReadSource
      readonly observedAt: string
      /** Why it could not be refreshed, if a refresh failed. */
      readonly error?: ReadFailure
    }
  | {
      readonly state: 'partial'
      readonly value: T
      readonly source: ReadSource
      readonly observedAt: string
      /** What is missing and why, in words a person can act on. */
      readonly missing: readonly string[]
    }
  | {
      readonly state: 'ready'
      readonly value: T
      readonly source: ReadSource
      readonly observedAt: string
    }

/** The value of a read that produced one (`stale`, `partial`, `ready`), else `undefined`. */
export function readableValue<T>(readable: Readable<T>): T | undefined {
  return readable.state === 'loading' || readable.state === 'failed' ? undefined : readable.value
}

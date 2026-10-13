import type { Readable } from '@exponetdb/ui-patterns'

export const OBSERVED_AT = '2026-10-13T12:00:00.000Z'
export const NOW = '2026-10-13T12:05:00.000Z'

export function ready<T>(value: T): Readable<T> {
  return { state: 'ready', value, source: 'live', observedAt: OBSERVED_AT }
}

export function stale<T>(value: T): Readable<T> {
  return {
    state: 'stale',
    value,
    source: 'cached',
    observedAt: OBSERVED_AT,
    error: { code: 'TARGET_UNREACHABLE', message: 'The target did not answer.' },
  }
}

export function partial<T>(value: T, missing: readonly string[]): Readable<T> {
  return { state: 'partial', value, source: 'agent_reported', observedAt: OBSERVED_AT, missing }
}

export const FAILED: Readable<never> = {
  state: 'failed',
  error: { code: 'TARGET_UNREACHABLE', message: 'The target did not answer within 5 seconds.' },
}

/** A promise settled by the test, to hold a load open. */
export function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve: (value: T) => void = () => {}
  let reject: (reason: unknown) => void = () => {}
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

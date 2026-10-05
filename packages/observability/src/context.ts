import { AsyncLocalStorage } from 'node:async_hooks'
import { type Clock, newId, type RequestId } from '@exponetdb/kernel'

/**
 * Correlation context of the current request or worker step. The logger adds
 * these fields to every line written inside {@link withCorrelation}, so a
 * `requestId` returned in an error response finds every log line of that
 * request.
 */
export interface Correlation {
  readonly requestId?: RequestId
  readonly traceId?: string
  readonly spanId?: string
  readonly operationId?: string
}

const storage = new AsyncLocalStorage<Correlation>()

export function withCorrelation<T>(correlation: Correlation, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...correlation }, fn)
}

export function currentCorrelation(): Correlation {
  return storage.getStore() ?? {}
}

/** A new request id `req_<ULID>`; the time comes from the injected clock. */
export function newRequestId(clock: Clock): RequestId {
  return newId('req', clock.nowMs())
}

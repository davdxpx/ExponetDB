import { type ErrorCode, errorDefinition } from '@exponetdb/contracts'
import { ControlStoreError } from '@exponetdb/control-store'
import type { JsonObject } from '@exponetdb/kernel'

/**
 * Node refusals carry a catalog code; the message is the catalog's fixed
 * text, never request values, key material or database text.
 */
export class NodeError extends Error {
  override readonly name = 'NodeError'
  readonly code: ErrorCode
  readonly details: JsonObject | undefined

  constructor(code: ErrorCode, details?: JsonObject, options: { cause?: unknown } = {}) {
    super(errorDefinition(code).message, options.cause === undefined ? undefined : options)
    this.code = code
    this.details = details
  }
}

/**
 * The catalog code of a refusal by the nodes schema's gateway functions
 * (control-plane.md §5); `undefined` for any other failure, which stays
 * an internal error.
 */
const GUARD_CODES: Readonly<Record<string, ErrorCode>> = {
  EXN06: 'NODE_CERTIFICATE_REFUSED',
  EXN07: 'NODE_ENROLLMENT_REFUSED',
  EXN08: 'NODE_ALREADY_ENROLLED',
  EXN09: 'CONFLICT',
}

export function refusalOf(error: unknown): NodeError | undefined {
  if (error instanceof NodeError) {
    return error
  }
  const state = error instanceof ControlStoreError ? error.sqlstate : undefined
  const code = state === undefined ? undefined : GUARD_CODES[state]
  return code === undefined ? undefined : new NodeError(code, undefined, { cause: error })
}

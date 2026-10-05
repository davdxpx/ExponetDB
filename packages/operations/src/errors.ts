import { type ErrorCode, errorDefinition } from '@exponetdb/contracts'

/**
 * Operation errors use the stable codes of the error catalog
 * ([error-model.md](../../../exponetdb-docs/02-control-plane/error-model.md));
 * the message is the catalog's fixed text. Internal refusals that no
 * interface shows (a lost lease, a transition the state machine forbids)
 * have their own lower-case codes.
 */
export type InternalOperationCode =
  | 'operation_transition_invalid'
  | 'operation_state_changed'
  | 'operation_lease_lost'
  | 'operation_kind_unknown'
  | 'idempotency_in_progress'

export interface ChangedBinding {
  readonly binding: string
  readonly expected?: string | number | boolean | null
  readonly actual?: string | number | boolean | null
}

const INTERNAL_MESSAGES: Readonly<Record<InternalOperationCode, string>> = {
  operation_transition_invalid: 'The operation state machine does not allow this transition.',
  operation_state_changed: 'The operation changed state concurrently.',
  operation_lease_lost: 'The worker no longer holds the lease of this operation.',
  operation_kind_unknown: 'No operation kind is registered under this name.',
  idempotency_in_progress: 'A request with this idempotency key is still in progress.',
}

function isInternal(code: string): code is InternalOperationCode {
  return Object.hasOwn(INTERNAL_MESSAGES, code)
}

export class OperationError extends Error {
  override readonly name = 'OperationError'
  readonly code: ErrorCode | InternalOperationCode
  readonly changedBindings: readonly ChangedBinding[]
  readonly blockingOperationId: string | undefined

  constructor(
    code: ErrorCode | InternalOperationCode,
    options: {
      changedBindings?: readonly ChangedBinding[]
      blockingOperationId?: string
      cause?: unknown
    } = {},
  ) {
    super(
      isInternal(code) ? INTERNAL_MESSAGES[code] : errorDefinition(code).message,
      options.cause === undefined ? undefined : { cause: options.cause },
    )
    this.code = code
    this.changedBindings = options.changedBindings ?? []
    this.blockingOperationId = options.blockingOperationId
  }
}

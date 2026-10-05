/**
 * Errors that cross into logs, traces, error sinks or responses are projected
 * to a fixed, safe shape ([error-model.md §1](../../../exponetdb-docs/02-control-plane/error-model.md#1-principles)).
 *
 * Exception messages are never copied: a PostgreSQL message can carry input
 * values (`invalid input syntax for type integer: "…"`), `DETAIL` can carry
 * row values, and a thrown error from a library can carry a connection
 * string. What survives is the error class, a stable machine code (an
 * ExponetDB code or a SQLSTATE) and, for {@link SafeError}, a message written
 * as a constant by ExponetDB itself.
 */
export class SafeError extends Error {
  override readonly name: string = 'SafeError'
  /** Stable machine-readable code, `lower_snake` or `UPPER_SNAKE`. */
  readonly code: string

  /**
   * `message` must be a constant written by ExponetDB code: never input,
   * never exception text, never SQL. Specific facts belong in structured fields.
   */
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.code = code
  }
}

export interface SafeErrorDescription {
  /** The error class, when it is a plain identifier; otherwise `Error`. */
  readonly errorName: string
  /** ExponetDB code or SQLSTATE, when present and well-formed. */
  readonly errorCode?: string
  /** Only for {@link SafeError}: its constant message. */
  readonly errorMessage?: string
  /** First code found along the `cause` chain (max depth 5). */
  readonly causeCode?: string
}

const CODE = /^(?:[A-Z][A-Z0-9_]{1,63}|[a-z][a-z0-9_.]{1,63}|[0-9A-Z]{5})$/
const NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/

function codeOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('code' in value)) {
    return undefined
  }
  const code = value.code
  return typeof code === 'string' && CODE.test(code) ? code : undefined
}

function nameOf(value: unknown): string {
  if (value instanceof Error) {
    const name = value.name
    return NAME.test(name) ? name : 'Error'
  }
  return typeof value === 'string' ? 'ThrownString' : 'NonError'
}

/** Projects anything thrown to {@link SafeErrorDescription}. Never throws. */
export function describeError(error: unknown): SafeErrorDescription {
  const errorCode = codeOf(error)
  let causeCode: string | undefined
  let cause: unknown = error instanceof Error ? error.cause : undefined
  for (let depth = 0; depth < 5 && cause !== undefined && causeCode === undefined; depth++) {
    causeCode = codeOf(cause)
    cause = cause instanceof Error ? cause.cause : undefined
  }
  return {
    errorName: nameOf(error),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(error instanceof SafeError ? { errorMessage: error.message.slice(0, 200) } : {}),
    ...(causeCode === undefined ? {} : { causeCode }),
  }
}

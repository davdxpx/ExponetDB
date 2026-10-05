import type { Result } from './result.ts'

/**
 * ExponetDB distinguishes three kinds of failure:
 *
 * 1. A **programming bug** (a broken invariant): {@link InvariantError}, thrown.
 *    It is never part of a contract; interfaces map it to `INTERNAL` without
 *    exposing its message.
 * 2. An **expected domain failure**: a {@link Failure} returned in a Result,
 *    with a stable code from the contracts error catalog.
 * 3. A **boundary validation failure** (untrusted input that does not match a
 *    contract): also a returned {@link Failure}; the contracts package maps it
 *    to `VALIDATION_FAILED` or a more specific code.
 *
 * Kernel defines only the shapes. Domain error codes belong to
 * `@exponetdb/contracts`.
 */
export class InvariantError extends Error {
  override readonly name = 'InvariantError'
}

/** Throws an {@link InvariantError} when `condition` is falsy. */
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new InvariantError(message)
  }
}

/** Marks code that must be unreachable when every case of a union is handled. */
export function assertNever(value: never, context: string): never {
  throw new InvariantError(`unreachable: ${context}: ${String(value)}`)
}

/** An expected failure with a stable machine-readable code. */
export interface Failure<Code extends string = string, Details = undefined> {
  readonly code: Code
  /** English, safe to show to the caller: never secrets, never raw input. */
  readonly message: string
  readonly details?: Details
}

export function failure<Code extends string>(code: Code, message: string): Failure<Code>
export function failure<Code extends string, Details>(
  code: Code,
  message: string,
  details: Details,
): Failure<Code, Details>
export function failure<Code extends string, Details>(
  code: Code,
  message: string,
  details?: Details,
): Failure<Code, Details | undefined> {
  return details === undefined ? { code, message } : { code, message, details }
}

/**
 * Unwraps a Result that the caller has already proven to be Ok (for example a
 * value built from compile-time constants). A failure here is a bug.
 */
export function expectOk<T, E>(result: Result<T, E>, context: string): T {
  if (result.ok) {
    return result.value
  }
  throw new InvariantError(`expected success: ${context}`)
}

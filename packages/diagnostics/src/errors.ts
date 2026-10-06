import { type ErrorCode, errorDefinition } from '@exponetdb/contracts'
import type { JsonObject } from '@exponetdb/kernel'
import { TargetError } from '@exponetdb/postgres'
import { RegistryError } from '@exponetdb/registry'

/**
 * Refusals of the diagnostics reads carry a catalog code and, where the
 * catalog defines them, schema-checked details. The message is the
 * catalog's fixed text; database text and request values are never part
 * of it.
 */
export class DiagnosticsError extends Error {
  override readonly name = 'DiagnosticsError'
  readonly code: ErrorCode
  readonly details: JsonObject | undefined

  constructor(code: ErrorCode, details?: JsonObject, options: { cause?: unknown } = {}) {
    super(errorDefinition(code).message, options.cause === undefined ? undefined : options)
    this.code = code
    this.details = details
  }
}

/**
 * A stored schema document that does not verify (digest, length, entry
 * hashes or fingerprint): it is never used, and the caller reports an
 * internal error. The reason names the check that failed, never content.
 */
export class DocumentCorrupt extends Error {
  override readonly name = 'DocumentCorrupt'
  readonly fingerprint: string
  readonly reason:
    | 'missing'
    | 'encoding'
    | 'length'
    | 'inflate'
    | 'digest'
    | 'json'
    | 'entries'
    | 'fingerprint'

  constructor(fingerprint: string, reason: DocumentCorrupt['reason']) {
    super('A stored schema document did not verify.')
    this.fingerprint = fingerprint
    this.reason = reason
  }
}

/**
 * The catalog code a failed observation is recorded with (a drift check
 * that could not read, a probe that failed): the adapter's and registry's
 * codes pass through; anything unclassified is `INTERNAL`, never a message.
 */
export function failureCodeOf(error: unknown): string {
  if (error instanceof DiagnosticsError) return error.code
  if (error instanceof TargetError) {
    return error.code === 'TARGET_SQL_ERROR' ? 'INTERNAL' : error.code
  }
  if (error instanceof RegistryError) return error.code
  return 'INTERNAL'
}

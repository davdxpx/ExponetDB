import { type ErrorCode, errorDefinition } from '@exponetdb/contracts'
import type { JsonObject } from '@exponetdb/kernel'

/**
 * Migration engine refusals: a catalog code and, where the catalog defines
 * them, schema-checked details. The message is the catalog's fixed text;
 * bundle text, target catalog text and driver messages are never part of
 * it (C-26).
 */
export class MigrationError extends Error {
  override readonly name = 'MigrationError'
  readonly code: ErrorCode
  readonly details: JsonObject | undefined

  constructor(code: ErrorCode, details?: JsonObject, options: { cause?: unknown } = {}) {
    super(errorDefinition(code).message, options.cause === undefined ? undefined : options)
    this.code = code
    this.details = details
  }
}

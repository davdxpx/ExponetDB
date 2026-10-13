import type { ErrorCode } from '@exponetdb/contracts'
import type { JsonObject, JsonValue } from '@exponetdb/kernel'

/**
 * The request and outcome of one data read as they cross the lane
 * (ADR-0028 §1): what `serve` asks, what the worker answers.
 */
export interface DataReadRequest {
  readonly kind: 'query' | 'explain'
  readonly sql: string
  readonly params: readonly (string | number | boolean | null)[]
  readonly callerClass: 'agent' | 'human'
  /** Already capped for the caller class by `serve`. */
  readonly maxRows: number
  readonly maxBytes: number
  readonly statementTimeoutMs: number
  readonly analyze: boolean
  /** `schema.table.column` patterns (`*` matches a part) masked for this caller. */
  readonly sensitiveColumns: readonly string[]
  readonly requestId: string
}

export interface QueryColumn {
  readonly name: string
  readonly type: string
  readonly masked: boolean
}

export type DataReadOutcome =
  | {
      readonly kind: 'query'
      readonly columns: QueryColumn[]
      readonly rows: JsonValue[][]
      readonly rowCount: number
      readonly truncated: boolean
      readonly truncation: { readonly reason: 'rows' | 'bytes'; readonly cap: number } | null
      readonly rlsRelations: string[]
      readonly durationMs: number
    }
  | {
      readonly kind: 'explain'
      readonly plan: JsonValue
      readonly summary: {
        totalCost: number
        planRows: number
        actualRows: number | null
        sequentialScans: string[]
        misestimates: { node: string; estimated: number; actual: number }[]
      }
      readonly durationMs: number
    }
  | {
      readonly kind: 'refused'
      readonly code: ErrorCode
      /** Only what the error catalog defines for the code (a construct, a position, a SQLSTATE). */
      readonly details?: JsonObject
      /** The admission's reason (`data_modifying`, `explain_analyze`): for the audit, never shown as text. */
      readonly reason?: string
    }

export function refused(
  code: ErrorCode,
  details?: JsonObject,
  reason?: string,
): Extract<DataReadOutcome, { kind: 'refused' }> {
  return {
    kind: 'refused',
    code,
    ...(details === undefined ? {} : { details }),
    ...(reason === undefined ? {} : { reason }),
  }
}

/** What a refusal without a named construct refused, in words (the catalog requires one). */
const REFUSED_CONSTRUCT: Readonly<Record<string, string>> = {
  multiple_statements: 'more than one statement',
  statement_class: 'a statement that is not a read',
  too_many_checks: 'a statement too large to check',
}

/**
 * An admission refusal with the details its catalog code requires:
 * `QUERY_CONSTRUCT_UNSUPPORTED` names what it refused (the construct, or
 * the reason in words), `QUERY_PARSE_ERROR` a position (1 when the failure
 * has none: an empty, oversized or malformed text as a whole).
 */
export function admissionRefusal(refusal: {
  readonly code: ErrorCode
  readonly reason: string
  readonly construct?: string
  readonly position?: number
}): Extract<DataReadOutcome, { kind: 'refused' }> {
  const details =
    refusal.code === 'QUERY_CONSTRUCT_UNSUPPORTED'
      ? {
          construct: (
            refusal.construct ??
            REFUSED_CONSTRUCT[refusal.reason] ??
            refusal.reason.replaceAll('_', ' ')
          ).slice(0, 256),
        }
      : refusal.code === 'QUERY_PARSE_ERROR'
        ? {
            position:
              refusal.position !== undefined && refusal.position >= 1 ? refusal.position : 1,
          }
        : undefined
  return refused(refusal.code, details, refusal.reason)
}

/** The text the target runs: the statement, or its `EXPLAIN (FORMAT JSON)`. */
export function dataReadText(kind: 'query' | 'explain', sql: string, analyze: boolean): string {
  return kind === 'explain' ? `EXPLAIN (FORMAT JSON${analyze ? ', ANALYZE true' : ''}) ${sql}` : sql
}

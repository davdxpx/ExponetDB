import type { VerifyCheckSpec } from './parser/verify-checks.ts'

/**
 * A `verify.sql` check that may run (verification.md §4.2 to §4.4). Like a
 * reviewed statement, it exists only in a module-private registry: it is
 * created from a check the parser admitted whose catalog resolution on the
 * target passed (`admitChecks` in `verify.ts`), and only a verifier session
 * in a read-only transaction runs it (`TargetSession.runAdmittedCheck`).
 */
export interface AdmittedCheck {
  readonly kind: 'admitted_check'
  readonly index: number
  readonly name: string
  readonly text: string
}

const ADMITTED = new WeakSet<object>()

export function isAdmittedCheck(value: unknown): value is AdmittedCheck {
  return typeof value === 'object' && value !== null && ADMITTED.has(value)
}

/** Internal: `verify.ts` creates the checks after the catalog resolution passed. */
export function registerAdmittedCheck(spec: VerifyCheckSpec): AdmittedCheck {
  const check: AdmittedCheck = Object.freeze({
    kind: 'admitted_check',
    index: spec.index,
    name: spec.name,
    text: spec.text,
  })
  ADMITTED.add(check)
  return check
}

/** Rows fetched per check at most; more is a failure (`too_many_rows`). */
export const MAX_CHECK_ROWS = 1000
/** Characters of `detail` kept from the first failing row. */
export const MAX_DETAIL_CHARS = 200

export type CheckOutcome =
  | { readonly status: 'passed' }
  | {
      readonly status: 'failed'
      readonly reason: 'no_rows' | 'not_ok' | 'null_ok' | 'too_many_rows'
      readonly detail: string | null
    }
  | {
      readonly status: 'error'
      readonly reason: 'wrong_type' | 'sql_error' | 'timeout'
      readonly sqlstate: string | null
    }

const BOOL = 16
const TEXT_TYPES: ReadonlySet<number> = new Set([25, 1043])

/**
 * The detail of a failing row, as far as it may leave the engine: control
 * characters removed, values that look like personal data or secrets
 * masked (e-mail addresses, runs of eight or more digits, long token-like
 * runs with a digit, such as hex or base64), at most 200 characters. It is still untrusted text.
 */
export function redactDetail(value: string): string {
  return (
    value
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ')
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
      .replace(/(?=[A-Za-z0-9+/=_-]*\d)[A-Za-z0-9+/=_-]{24,}/g, '<redacted>')
      .replace(/\d{8,}/g, '<number>')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_DETAIL_CHARS)
  )
}

/** The result contract of one check from the rows and the output types the server reported. */
export function judgeCheck(
  rows: readonly Record<string, unknown>[],
  fields: readonly { readonly name: string; readonly dataTypeID: number }[],
  maxRows: number,
): CheckOutcome {
  const ok = fields.find((f) => f.name === 'ok')
  const detail = fields.find((f) => f.name === 'detail')
  if (
    ok === undefined ||
    ok.dataTypeID !== BOOL ||
    (detail !== undefined && !TEXT_TYPES.has(detail.dataTypeID)) ||
    fields.some((f) => f.name !== 'ok' && f.name !== 'detail')
  ) {
    return { status: 'error', reason: 'wrong_type', sqlstate: null }
  }
  if (rows.length > maxRows) {
    return { status: 'failed', reason: 'too_many_rows', detail: null }
  }
  if (rows.length === 0) {
    return { status: 'failed', reason: 'no_rows', detail: null }
  }
  for (const row of rows) {
    const value = row['ok']
    if (value === 't') continue
    const text = row['detail']
    return {
      status: 'failed',
      reason: value === null || value === undefined ? 'null_ok' : 'not_ok',
      detail: typeof text === 'string' ? redactDetail(text) : null,
    }
  }
  return { status: 'passed' }
}

import { redactText } from '@exponetdb/observability'
import type { LoadedBundle } from './bundles.ts'
import { ControlStoreError } from './errors.ts'
import type { ControlStore, ScriptStatementResult } from './store.ts'

/**
 * Verification of a Control Store bundle
 * ([verification.md §4.4](../../../exponetdb-docs/04-migrations/verification.md#44-result-contract)).
 *
 * Trust boundary: the Control Store's `verify.sql` files are ExponetDB's own
 * reviewed source, shipped in the release and bound by their verify digest;
 * they are not user input. The parser-based admission of `verify.sql`
 * (Wave 4/6) does not exist yet and is not claimed. Defense in depth anyway:
 * a separate connection that is closed afterwards, a `READ ONLY` transaction
 * that always ends in ROLLBACK, statement and lock timeouts, the bundle's
 * search path. None of this is a sandbox.
 *
 * Result contract: each statement is one check, named by its `-- check:`
 * directive. A check passes when it returns at least one row, has a boolean
 * `ok` column and every `ok` is true. Zero rows fail (`no_rows`). The
 * optional `detail` text of the first failing row is kept, truncated and
 * redacted. A statement error makes the run `error` with its SQLSTATE.
 */
export type CheckFailureReason = 'no_rows' | 'no_ok_column' | 'ok_not_boolean' | 'ok_false'

export interface CheckResult {
  readonly name: string
  readonly ok: boolean
  readonly rows: number
  readonly reason?: CheckFailureReason
  readonly detail?: string
}

export interface VerificationResult {
  readonly status: 'passed' | 'failed' | 'error'
  readonly checks: readonly CheckResult[]
  /** SQLSTATE or reason code when `status` is `error`. */
  readonly errorCode?: string
  readonly startedAt: Date
  readonly finishedAt: Date
}

const BOOL_OID = 16

function evaluate(name: string, result: ScriptStatementResult): CheckResult {
  const ok = result.columns.find((c) => c.name === 'ok')
  if (ok === undefined) {
    return { name, ok: false, rows: result.rows.length, reason: 'no_ok_column' }
  }
  if (ok.typeOid !== BOOL_OID) {
    return { name, ok: false, rows: result.rows.length, reason: 'ok_not_boolean' }
  }
  if (result.rows.length === 0) {
    return { name, ok: false, rows: 0, reason: 'no_rows' }
  }
  const failing = result.rows.find((r) => r.boolOrNull('ok') !== true)
  if (failing === undefined) {
    return { name, ok: true, rows: result.rows.length }
  }
  const hasDetail = result.columns.some((c) => c.name === 'detail')
  const detail = hasDetail ? failing.textOrNull('detail') : null
  return {
    name,
    ok: false,
    rows: result.rows.length,
    reason: 'ok_false',
    ...(detail === null ? {} : { detail: redactText(detail).slice(0, 200) }),
  }
}

export async function runVerification(
  store: ControlStore,
  bundle: LoadedBundle,
): Promise<VerificationResult> {
  const startedAt = new Date()
  try {
    const results = await store.isolated((session) =>
      session.transaction(
        'migration.verify',
        async (tx) => {
          await tx.query(
            'migration.verify.settings',
            `SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true),
                    set_config('search_path', $3, true)`,
            [
              `${Math.min(bundle.execution.statementTimeoutMs, 60_000)}ms`,
              `${Math.min(bundle.execution.lockTimeoutMs, 5_000)}ms`,
              searchPathValue(bundle.execution.searchPath),
            ],
          )
          return tx.executeScript('migration.verify.script', bundle.verifySql)
        },
        { readOnly: true, rollbackOnly: true },
      ),
    )
    const finishedAt = new Date()
    if (results.length !== bundle.checkNames.length) {
      return {
        status: 'error',
        checks: [],
        errorCode: 'check_count_mismatch',
        startedAt,
        finishedAt,
      }
    }
    const checks = results.map((r, i) => evaluate(bundle.checkNames[i] ?? `check_${i + 1}`, r))
    return {
      status: checks.every((c) => c.ok) ? 'passed' : 'failed',
      checks,
      startedAt,
      finishedAt,
    }
  } catch (error) {
    const code =
      error instanceof ControlStoreError ? (error.sqlstate ?? error.code) : 'verification_error'
    return { status: 'error', checks: [], errorCode: code, startedAt, finishedAt: new Date() }
  }
}

/** A search_path value from validated schema names, each quoted as an identifier. */
export function searchPathValue(schemas: readonly string[]): string {
  return schemas.map((s) => `"${s.replaceAll('"', '""')}"`).join(', ')
}

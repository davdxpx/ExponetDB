import { AuthError } from '@exponetdb/auth'
import {
  SQL_CLASSIFY_MAX_BYTES,
  SQL_CLASSIFY_MAX_STATEMENTS,
  type SqlClassification,
  type SqlClassificationRequest,
} from '@exponetdb/contracts'
import { classifySql } from '@exponetdb/diagnostics'
import type { Clock } from '@exponetdb/kernel'

/** The grammar used when the request names none. */
const DEFAULT_MAJOR = 17

/**
 * `sql.classify` after authorization: bounds the input (a bound is a 422
 * `VALIDATION_FAILED` that names the path and the bound, never the text) and
 * classifies it with the parser. Pure: no store, no target, no log, no audit.
 */
export async function classifySubmittedSql(
  request: SqlClassificationRequest,
  clock: Clock,
): Promise<SqlClassification> {
  if (new TextEncoder().encode(request.sql).length > SQL_CLASSIFY_MAX_BYTES) {
    throw new AuthError('VALIDATION_FAILED', {
      details: {
        errors: [{ path: '/sql', code: 'too_big', message: 'At most 64 KiB (UTF-8 bytes).' }],
      },
    })
  }
  const outcome = await classifySql(request.postgresMajor ?? DEFAULT_MAJOR, request.sql, {
    maxStatements: SQL_CLASSIFY_MAX_STATEMENTS,
  })
  if (outcome.kind === 'too_many_statements') {
    throw new AuthError('VALIDATION_FAILED', {
      details: {
        errors: [{ path: '/sql', code: 'too_many_statements', message: 'At most 200 statements.' }],
      },
    })
  }
  return { ...outcome.result, computedAt: new Date(clock.nowMs()).toISOString() }
}

import { majorOf } from '@exponetdb/postgres'
import { admitRead, redactStatement } from '@exponetdb/postgres/parser'
import { DiagnosticsError } from '../errors.ts'
import { admissionRefusal, type DataReadOutcome, dataReadText } from './outcome.ts'

/** The audit's view of a statement: constants replaced, capped, and the digest of the whole. */
export interface NormalizedStatement {
  readonly text: string
  readonly digest: string
}

/** At most what an audit change value holds (audit.md §1: strings of 256 characters). */
export const AUDIT_STATEMENT_LENGTH = 256

/**
 * `serve`'s part before a read enters the lane (ADR-0028 §1 step 2): the
 * parser admission on the target's major (nothing reaches the worker that
 * the parser refuses) and the normalized statement for the audit. The
 * worker admits again with the catalog of the target itself.
 */
export async function prepareDataRead(
  serverVersionNum: number | null,
  request: { readonly kind: 'query' | 'explain'; readonly sql: string; readonly analyze: boolean },
): Promise<
  | { readonly ok: true; readonly statement: NormalizedStatement }
  | {
      readonly ok: false
      readonly statement: NormalizedStatement
      readonly refusal: Extract<DataReadOutcome, { kind: 'refused' }>
    }
> {
  if (serverVersionNum === null) {
    // A cluster that was never confirmed has no version: nothing to read from.
    throw new DiagnosticsError('TARGET_UNAVAILABLE')
  }
  const major = majorOf(serverVersionNum)
  const redacted = await redactStatement(request.sql, {
    major,
    maxLength: AUDIT_STATEMENT_LENGTH,
  })
  const statement = { text: redacted.text, digest: redacted.digest }
  const admission = await admitRead(major, dataReadText(request.kind, request.sql, request.analyze))
  if (!admission.ok) {
    return { ok: false, statement, refusal: admissionRefusal(admission) }
  }
  if (request.kind === 'query' && admission.statementClass === 'explain') {
    return {
      ok: false,
      statement,
      refusal: {
        kind: 'refused',
        code: 'QUERY_CONSTRUCT_UNSUPPORTED',
        details: { construct: 'EXPLAIN' },
        reason: 'statement_class',
      },
    }
  }
  return { ok: true, statement }
}

/** The grammar a saved query's digest uses when its scope names no confirmed server (a project). */
export const SAVED_QUERY_DIGEST_MAJOR = 17

/**
 * The digest of a saved query's text (Wave 8): the sha256 of its redacted
 * text, constants replaced, built exactly like the digest the `data.read`
 * audit records, so a saved query and the reads made from it carry the same
 * digest on the same major. Saving never runs or admits the text; the
 * redaction parses it only to hide its constants (text that does not parse
 * is redacted lexically). The audit of a saved query records this digest
 * and never the text.
 */
export async function savedQueryDigest(
  sql: string,
  serverVersionNum: number | null,
): Promise<string> {
  const major = serverVersionNum === null ? SAVED_QUERY_DIGEST_MAJOR : majorOf(serverVersionNum)
  return (await redactStatement(sql, { major, maxLength: AUDIT_STATEMENT_LENGTH })).digest
}

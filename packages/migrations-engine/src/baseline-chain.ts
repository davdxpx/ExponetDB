import type { LedgerRecord, VerificationRecord } from '@exponetdb/postgres'

/**
 * Which schema a baseline's (re-)verification accepts as the live one (Part
 * A follow-up 4; legacy-import.md §2 step 7):
 *
 * - `reviewed`: the live schema is the one the import report reviewed.
 * - `chain`: every ledger row after the baseline is a migration of ExponetDB,
 *   not reverted, whose latest verification passed; the first one started
 *   at the reviewed schema, each next one where the one before ended, and the
 *   live schema is where the last one ended. The schema moved on only through
 *   verified migrations.
 * - `failed`: anything else (a later migration not verified, a gap in the
 *   chain, a live schema that differs from the last verified state), named.
 */
export type BaselineSchemaAcceptance =
  | { readonly kind: 'reviewed' }
  | { readonly kind: 'chain'; readonly migrations: number; readonly last: string }
  | { readonly kind: 'failed'; readonly name: string; readonly detail: string }

/** The ledger rows applied after the baseline's own row, in the order they were applied. */
export function rowsAfterBaseline(
  ledger: readonly LedgerRecord[],
  baselineId: string,
): LedgerRecord[] {
  const baseline = ledger.find((r) => r.migrationId === baselineId)
  if (baseline === undefined) return []
  const at = BigInt(baseline.appliedSeq)
  return ledger
    .filter((r) => BigInt(r.appliedSeq) > at)
    .sort((a, b) => (BigInt(a.appliedSeq) < BigInt(b.appliedSeq) ? -1 : 1))
}

const cut = (text: string, max: number) => (text.length <= max ? text : text.slice(0, max))

export function acceptBaselineSchema(input: {
  readonly reviewed: string
  readonly live: string
  /** The rows after the baseline ({@link rowsAfterBaseline}). */
  readonly later: readonly LedgerRecord[]
  readonly verifications: readonly VerificationRecord[]
}): BaselineSchemaAcceptance {
  if (input.live === input.reviewed) return { kind: 'reviewed' }
  if (input.later.length === 0) {
    return {
      kind: 'failed',
      name: 'schema fingerprint',
      detail: 'not the one the import report reviewed',
    }
  }
  const fail = (migrationId: string, detail: string): BaselineSchemaAcceptance => ({
    kind: 'failed',
    name: cut(`schema after the baseline: ${migrationId}`, 128),
    detail: cut(detail, 200),
  })
  let at = input.reviewed
  for (const row of input.later) {
    if (row.origin !== 'exponetdb') return fail(row.migrationId, 'not a migration of ExponetDB')
    if (row.revertedAt !== null) return fail(row.migrationId, 'reverted after the baseline')
    const latest = input.verifications
      .filter((v) => v.migrationId === row.migrationId)
      .sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : a.finishedAt > b.finishedAt ? -1 : 0))[0]
    if (latest?.status !== 'passed') {
      return fail(
        row.migrationId,
        latest === undefined ? 'never verified' : `its latest verification is ${latest.status}`,
      )
    }
    if (row.fingerprintBefore !== at) {
      return fail(
        row.migrationId,
        'did not start where the schema was (the reviewed one, or where the migration before ended)',
      )
    }
    if (row.fingerprintAfter === null) return fail(row.migrationId, 'recorded no schema after it')
    at = row.fingerprintAfter
  }
  const last = input.later.at(-1)?.migrationId ?? ''
  if (at !== input.live) {
    return fail(last, 'the live schema is not the one the last verified migration left')
  }
  return { kind: 'chain', migrations: input.later.length, last }
}

import type { LedgerRecord, VerificationRecord } from '@exponetdb/postgres'

/**
 * Which schema a baseline's (re-)verification accepts as the live one (Part
 * A follow-up 4; legacy-import.md §2 step 7):
 *
 * - `reviewed`: no migration after the baseline, and the live schema is the
 *   one the import report reviewed.
 * - `chain`: every ledger row after the baseline is a migration of ExponetDB,
 *   not reverted, whose latest verification passed (as the Control Store
 *   recorded it; the caller compares the target's rows with the mirror
 *   first, {@link mirrorDiffers}); the first one started
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
  /** The runs as the Control Store's mirror holds them (a target's own rows can be written by a migration). */
  readonly verifications: readonly Pick<
    VerificationRecord,
    'migrationId' | 'status' | 'finishedAt'
  >[]
}): BaselineSchemaAcceptance {
  // Without later migrations the live schema must be the reviewed one. With them, the chain
  // decides even when the live schema is the reviewed one again: their up.sql supersedes the
  // history's expectations, which only a verified chain may do (follow-up 4 review P2-1). A
  // data-only migration links the reviewed schema to itself.
  if (input.later.length === 0) {
    return input.live === input.reviewed
      ? { kind: 'reviewed' }
      : {
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

/** A mirror row of the Control Store, as {@link mirrorDiffers} compares it. */
export interface MirroredRow {
  readonly migrationId: string
  readonly checksum: string
  readonly operationId: string
  readonly fingerprintBefore: string | null
  readonly fingerprintAfter: string | null
  readonly reverted: boolean
}

/**
 * The first row after the baseline whose ledger row on the target is not the
 * one ExponetDB recorded in the Control Store's mirror (another checksum,
 * operation, schema before or after, or revert state), or that the mirror
 * holds after the baseline and the target does not, or `null`. A target's
 * ledger can be written by procedural code a migration runs (OD-55); the
 * mirror is written by the worker only.
 */
export function mirrorDiffers(
  later: readonly LedgerRecord[],
  mirror: readonly MirroredRow[],
): string | null {
  // Both ways: a mirrored row after the baseline the target no longer holds (deleted there)
  // would otherwise drop out of the chain unseen (review P3-b).
  const onTarget = new Set(later.map((r) => r.migrationId))
  const missing = mirror.find((m) => !onTarget.has(m.migrationId))
  if (missing !== undefined) return missing.migrationId
  const byId = new Map(mirror.map((m) => [m.migrationId, m]))
  for (const row of later) {
    const m = byId.get(row.migrationId)
    if (
      m === undefined ||
      m.checksum !== row.checksum ||
      m.operationId !== row.operationId ||
      m.fingerprintBefore !== row.fingerprintBefore ||
      m.fingerprintAfter !== row.fingerprintAfter ||
      m.reverted !== (row.revertedAt !== null)
    ) {
      return row.migrationId
    }
  }
  return null
}

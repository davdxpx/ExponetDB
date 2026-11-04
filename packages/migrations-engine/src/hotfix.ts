import type { Queryable } from '@exponetdb/control-store'
import { TargetError } from '@exponetdb/postgres'
import { type Connector, isObserved, RegistryError, type TargetRecord } from '@exponetdb/registry'
import { MigrationError } from './errors.ts'
import {
  type EvidenceRead,
  evidenceOf,
  evidenceTargetOf,
  evidenceTrust,
  readEvidenceTarget,
} from './evidence.ts'

/**
 * The two ledger comparisons of G6 failure cases E16 and E18 (Wave 10 W10-3, OD-65 (a);
 * [failure-and-recovery.md §1](../../../exponetdb-docs/04-migrations/failure-and-recovery.md#1-edge-case-catalog)).
 * Both read the Control Store's mirror of the target: the rows operations of this installation
 * wrote (origin `exponetdb`, not reverted). Rows of a legacy import or a baseline are no bundle of
 * the source and have no staging counterpart by id, so neither comparison counts them. A target
 * ledger that disagrees with its mirror is the ledger watch's `ledger_divergence`. Neither writes
 * to any target; the findings are recorded by the diagnostics package.
 */
interface MirrorRow {
  readonly migrationId: string
  readonly name: string
  readonly checksum: string
  readonly verifyDigest: string | null
  readonly operationId: string | null
  readonly planId: string | null
}

async function appliedRows(
  q: Queryable,
  target: Pick<TargetRecord, 'targetId' | 'generation'>,
): Promise<MirrorRow[]> {
  const { rows } = await q.query(
    'migrations.hotfix.applied_rows',
    `SELECT migration_id, name, checksum, verify_digest, operation_id, plan_id
       FROM migrations.ledger_mirror
      WHERE target_id = $1 AND generation = $2 AND origin = 'exponetdb' AND reverted_at IS NULL
      ORDER BY migration_id`,
    [target.targetId, target.generation],
  )
  return rows.map((r) => ({
    migrationId: r.text('migration_id'),
    name: r.text('name'),
    checksum: r.text('checksum'),
    verifyDigest: r.textOrNull('verify_digest'),
    operationId: r.textOrNull('operation_id'),
    planId: r.textOrNull('plan_id'),
  }))
}

export interface HotfixItem {
  readonly migrationId: string
  readonly name: string
  /** What the evidence target has of it (never `present`). */
  readonly evidence: 'missing' | 'unverified' | 'other_verify_digest' | 'checksum_differs'
  readonly operationId: string | null
  readonly planId: string | null
}

/**
 * What one comparison of a production target found (`undefined` for a target that is not
 * production: nothing is compared there):
 * - `compared`: the evidence target was read; `items` empty means staging has everything.
 *   `evidenceDivergent`: the evidence target's ledger disagrees with its mirror, so none of its
 *   rows is evidence and every item is that, not a hotfix;
 * - `not_comparable`: no evidence target to compare with (the environment names none, its target
 *   is decommissioned, or it is observed and has no ExponetDB ledger);
 * - `unreachable`: the evidence target could not be read now (as planning's `unreachable`).
 */
export type HotfixCheck =
  | {
      readonly kind: 'compared'
      readonly evidenceTargetId: string
      readonly evidenceDivergent: boolean
      readonly items: readonly HotfixItem[]
    }
  | {
      readonly kind: 'not_comparable'
      readonly reason: 'no_evidence_environment' | 'evidence_observed'
    }
  | { readonly kind: 'unreachable'; readonly evidenceTargetId: string }

/** Reads of evidence targets within one watch round, one per evidence target (L1). */
export type EvidenceReads = Map<string, Promise<EvidenceRead>>

function unreadable(error: unknown): boolean {
  return (
    error instanceof TargetError ||
    error instanceof RegistryError ||
    (error instanceof MigrationError && error.code === 'TARGET_IDENTITY_MISMATCH')
  )
}

/**
 * E16 `hotfix_without_evidence` ([staging-production-policy.md §3](../../../exponetdb-docs/04-migrations/staging-production-policy.md#3-hotfixes)):
 * every migration applied on a production target whose evidence target does not hold the same id
 * with the same checksum, applied, not reverted and verified with the same verify digest, read
 * live with the trust rules of planning (`evidenceOf`). A row without verify.sql has a null verify
 * digest on both sides and compares equal. Anything unexpected is an error, never "staging has
 * everything".
 */
export async function hotfixesWithoutEvidence(
  deps: {
    readonly store: Queryable
    readonly connector: Connector
    readonly installationId: string
    /** Shared by the targets of one round: one live read per evidence target. */
    readonly evidenceReads?: EvidenceReads
  },
  target: TargetRecord,
): Promise<HotfixCheck | undefined> {
  if (target.tier !== 'prod') return undefined
  const evidence = await evidenceTargetOf(deps.store, target)
  if (evidence === undefined) return { kind: 'not_comparable', reason: 'no_evidence_environment' }
  if (isObserved(evidence)) return { kind: 'not_comparable', reason: 'evidence_observed' }
  const rows = await appliedRows(deps.store, target)
  let pending = deps.evidenceReads?.get(evidence.targetId)
  if (pending === undefined) {
    pending = readEvidenceTarget(
      deps.connector,
      deps.installationId,
      evidence,
      `hotfix-watch/${evidence.targetId}`,
    )
    deps.evidenceReads?.set(evidence.targetId, pending)
  }
  let read: EvidenceRead
  try {
    read = await pending
  } catch (error) {
    if (unreadable(error)) return { kind: 'unreachable', evidenceTargetId: evidence.targetId }
    throw error
  }
  const trust = await evidenceTrust(deps.store, evidence.targetId, read, rows)
  const items: HotfixItem[] = []
  for (const r of rows) {
    const { status } = evidenceOf(read, trust, r)
    if (status === 'present') continue
    items.push({
      migrationId: r.migrationId,
      name: r.name,
      // `unreachable` is planning's status for a read that failed; this read succeeded.
      evidence: status === 'unreachable' ? 'missing' : status,
      operationId: r.operationId,
      planId: r.planId,
    })
  }
  return {
    kind: 'compared',
    evidenceTargetId: evidence.targetId,
    evidenceDivergent: trust.divergent,
    items,
  }
}

export interface AppliedRef {
  readonly migrationId: string
  readonly name: string
}

/**
 * E18 `applied_not_in_source` ([drift-detection.md §1](../../../exponetdb-docs/03-database-model/drift-detection.md#1-references-and-the-drift-kinds-between-them), kind A):
 * the migrations applied on the target that a whole source (validated bundle ids) lacks, split by
 * the source's newest id. Migration ids are ULIDs, ordered by creation time: one older than the
 * source's newest bundle is missing from it (deleted, or never merged where the source was cut);
 * one newer means the source is behind the target (an old clone) and proves nothing.
 */
export interface SourceComparison {
  /** The newest id of the source; `null` for an empty one. */
  readonly newestId: string | null
  readonly older: readonly AppliedRef[]
  readonly newer: readonly AppliedRef[]
}

export async function compareSource(
  q: Queryable,
  target: Pick<TargetRecord, 'targetId' | 'generation'>,
  sourceIds: readonly string[],
): Promise<SourceComparison> {
  const ids = new Set(sourceIds)
  const newestId = [...ids].sort().at(-1) ?? null
  const absent = (await appliedRows(q, target))
    .filter((r) => !ids.has(r.migrationId))
    .map((r) => ({ migrationId: r.migrationId, name: r.name }))
  return {
    newestId,
    older: absent.filter((r) => newestId !== null && r.migrationId < newestId),
    newer: absent.filter((r) => newestId === null || r.migrationId > newestId),
  }
}

/**
 * The migrations the finding names after one whole source (review of W10-3, H2), newest first:
 * every applied one older than the source's newest bundle, and those it already named that this
 * source lacks too. A source behind the target never adds one; the finding clears only when the
 * source has every migration it named that is still applied.
 */
export function sourceFindingList(c: SourceComparison, named: readonly string[]): AppliedRef[] {
  const listed = new Set(named)
  return [...c.older, ...c.newer.filter((r) => listed.has(r.migrationId))].sort((a, b) =>
    a.migrationId < b.migrationId ? 1 : a.migrationId > b.migrationId ? -1 : 0,
  )
}

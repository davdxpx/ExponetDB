import type { BundleSubmission } from '@exponetdb/contracts'
import type { Queryable } from '@exponetdb/control-store'
import type { Connector, TargetRecord } from '@exponetdb/registry'
import { evidenceOf, evidenceTargetOf, evidenceTrust, readEvidenceTarget } from './evidence.ts'

/**
 * The two ledger comparisons of G6 failure cases E16 and E18 (Wave 10 W10-3, OD-65 (a);
 * [failure-and-recovery.md §1](../../../exponetdb-docs/04-migrations/failure-and-recovery.md#1-edge-case-catalog)).
 * Both read the Control Store's mirror of the target, the rows operations of this installation
 * wrote (origin `exponetdb`, not reverted); a target ledger that disagrees with its mirror is the
 * ledger watch's `ledger_divergence`. Neither writes to any target; the findings are recorded by
 * the diagnostics package.
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
      ORDER BY applied_seq`,
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

export interface HotfixSighting {
  readonly evidenceTargetId: string
  /** Empty: staging has everything production has. */
  readonly items: readonly HotfixItem[]
}

/**
 * E16 `hotfix_without_evidence` ([staging-production-policy.md §3](../../../exponetdb-docs/04-migrations/staging-production-policy.md#3-hotfixes)):
 * every migration applied on a production target whose evidence target does not hold the same id
 * with the same checksum, applied, not reverted and verified with the same verify digest, read
 * live with the trust rules of planning (`evidenceOf`). `undefined` when nothing is compared: the
 * target is not production or its environment names no evidence environment (its plans fail
 * `migration.staging-evidence` anyway). An evidence target that cannot be read is an error,
 * never "staging has everything".
 */
export async function hotfixesWithoutEvidence(
  deps: {
    readonly store: Queryable
    readonly connector: Connector
    readonly installationId: string
  },
  target: TargetRecord,
): Promise<HotfixSighting | undefined> {
  if (target.tier !== 'prod') return undefined
  const evidence = await evidenceTargetOf(deps.store, target)
  if (evidence === undefined) return undefined
  const rows = await appliedRows(deps.store, target)
  const read = await readEvidenceTarget(
    deps.connector,
    deps.installationId,
    evidence,
    `hotfix-watch/${target.targetId}`,
  )
  const trust = await evidenceTrust(deps.store, evidence.targetId, read, rows)
  const items: HotfixItem[] = []
  for (const r of rows) {
    const { status } = evidenceOf(read, trust, r)
    if (status === 'present') continue
    items.push({
      migrationId: r.migrationId,
      name: r.name,
      evidence: status === 'unreachable' ? 'missing' : status,
      operationId: r.operationId,
      planId: r.planId,
    })
  }
  return { evidenceTargetId: evidence.targetId, items }
}

/**
 * E18 `applied_not_in_source` ([drift-detection.md §1](../../../exponetdb-docs/03-database-model/drift-detection.md#1-references-and-the-drift-kinds-between-them), kind A):
 * the migrations applied on the target that a complete source (every bundle of the project, as
 * the CLI submits it) does not contain, by id. A bundle with the id but other bytes is in the
 * source: that is E19 (`MIGRATION_CHECKSUM_MISMATCH`), not E18. The ledger row stays either way.
 */
export async function appliedNotInSource(
  q: Queryable,
  target: Pick<TargetRecord, 'targetId' | 'generation'>,
  source: readonly Pick<BundleSubmission, 'directory'>[],
): Promise<{ readonly migrationId: string; readonly name: string }[]> {
  // A bundle directory is `<ULID>_<name>` (the request contract checks it).
  const ids = new Set(source.map((b) => b.directory.slice(0, 26)))
  return (await appliedRows(q, target))
    .filter((r) => !ids.has(r.migrationId))
    .map((r) => ({ migrationId: r.migrationId, name: r.name }))
}

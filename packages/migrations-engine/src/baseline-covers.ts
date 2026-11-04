import type { Queryable } from '@exponetdb/control-store'
import { isMigrationId } from '@exponetdb/kernel'
import { normalizeSqlSource } from '@exponetdb/migrations/format'
import { type ConsumerCode, type LedgerRecord, resolveVerifyCatalog } from '@exponetdb/postgres'
import { analyzeVerifyFile, loadParser } from '@exponetdb/postgres/parser'
import type { Connector, TargetRecord } from '@exponetdb/registry'
import { MigrationError } from './errors.ts'
import { collectEvidence } from './evidence.ts'
import { revisionsOf, type StoredRevision, storedStream } from './store.ts'
import { type Layer, runtimeLayer } from './verification.ts'

const MAX_KEPT = 200

/**
 * A baseline that covers bundles applied outside ExponetDB (ADR-0040, OD-72 (a)): stream bundles
 * whose effect the imported history already holds become ledger rows of the baseline (origin
 * `legacy_import`, the bundle's own id), which planning counts as applied.
 */
export interface CoveredRow {
  readonly migrationId: string
  readonly name: string
  readonly revision: number
  readonly checksum: string
  readonly verifyDigest: string | null
  readonly sourceDigest: string
  readonly transactional: boolean
  readonly dependsOn: readonly string[]
  /** The evidence target's passed verification it rests on; null on a nonprod target. */
  readonly evidence: { readonly targetId: string; readonly verificationId: string } | null
  /**
   * The consumer code its verify.sql calls, as the target held it at planning (bound like a
   * migration plan's); absent on a plan before the review of ADR-0040.
   */
  readonly consumerCode?: readonly ConsumerCode[]
}

/** A covered bundle's ledger row: imported, under the bundle's own id (never `legacy:<stem>`). */
export function isCoveredRow(row: Pick<LedgerRecord, 'origin' | 'migrationId'>): boolean {
  return row.origin === 'legacy_import' && isMigrationId(row.migrationId)
}

/**
 * What a baseline plan covers (ADR-0040 §1): stored bundles of the project, closed under
 * `dependsOn` (down to the baseline), with staging evidence on a production target. Refuses
 * rather than covering less than asked. Their verify.sql runs with the baseline's verification
 * in the worker (§5): serve holds observer sessions only.
 */
export async function coveredRows(
  q: Queryable,
  deps: { readonly connector: Connector; readonly installationId: string },
  input: {
    readonly target: TargetRecord
    readonly baselineId: string
    readonly ids: readonly string[]
    readonly fingerprint: string
  },
): Promise<CoveredRow[]> {
  const ids = [...new Set(input.ids)]
  if (ids.length === 0) return []
  const stream = await storedStream(q, input.target.projectId)
  const unknown = ids.filter((id) => !isMigrationId(id) || !stream.has(id))
  if (unknown.length > 0) {
    throw new MigrationError('MIGRATION_DEPENDENCY_UNKNOWN', {
      migrationId: input.baselineId,
      missing: unknown.slice(0, 256),
    })
  }
  const covered = new Set(ids)
  const revisions: StoredRevision[] = []
  for (const id of ids) {
    const newest = (await revisionsOf(q, input.target.projectId, id))[0]
    if (newest === undefined) {
      throw new MigrationError('MIGRATION_DEPENDENCY_UNKNOWN', {
        migrationId: input.baselineId,
        missing: [id],
      })
    }
    // A root of a stream with a baseline is unanchored (graph `unanchored_root`): every plan on
    // the target would fail on it afterwards.
    if (newest.dependsOn.length === 0) {
      throw new MigrationError('MIGRATION_DEPENDENCY_MISSING', { missing: [id] })
    }
    // Closed under dependsOn: a covered bundle on top of an uncovered one would be applied
    // before what it depends on.
    const open = newest.dependsOn.filter((d) => d !== input.baselineId && !covered.has(d))
    if (open.length > 0) {
      throw new MigrationError('MIGRATION_DEPENDENCY_UNKNOWN', {
        migrationId: id,
        missing: open.slice(0, 256),
      })
    }
    revisions.push(newest)
  }
  const evidence = await collectEvidence(
    q,
    deps.connector,
    deps.installationId,
    input.target,
    revisions.map((r) => ({
      migrationId: r.migrationId,
      checksum: r.checksum,
      verifyDigest: r.verifyDigest,
    })),
    input.fingerprint,
  )
  if (evidence.fact === 'unreachable') throw new MigrationError('STAGING_EVIDENCE_UNREACHABLE')
  if (evidence.fact !== 'not_required' && evidence.fact !== 'present') {
    throw new MigrationError('STAGING_EVIDENCE_MISSING')
  }
  // On production a cover without verify.sql would be counted as applied with nothing checking
  // its effect there (review of ADR-0040, P2-1).
  if (input.target.tier === 'prod' && revisions.some((r) => r.files['verify.sql'] === null)) {
    throw new MigrationError('MIGRATION_BUNDLE_INVALID', {
      reason: 'missing_file',
      file: 'verify.sql',
    })
  }
  const consumer = await consumerCodeOf(deps.connector, input.target, revisions)
  const bound = evidence.binding
  return revisions.map((r) => {
    const verificationId = bound?.verifications[r.migrationId]
    return {
      migrationId: r.migrationId,
      name: r.name,
      revision: r.revision,
      checksum: r.checksum,
      verifyDigest: r.verifyDigest,
      sourceDigest: r.sourceDigest,
      transactional: r.transactional,
      dependsOn: [...r.dependsOn],
      evidence:
        bound === null || verificationId === undefined
          ? null
          : { targetId: bound.targetId, verificationId },
      consumerCode: consumer.get(r.migrationId) ?? [],
    }
  })
}

/**
 * What each covered verify.sql resolves to on the target now, read as the observer (review of
 * ADR-0040, P2-2): the consumer code its checks call is bound into the plan, so the
 * verification fails on code that changed since, as a migration plan's does. A verify.sql that
 * cannot be parsed or resolved refuses the plan.
 */
async function consumerCodeOf(
  connector: Connector,
  target: TargetRecord,
  revisions: readonly StoredRevision[],
): Promise<Map<string, readonly ConsumerCode[]>> {
  const opened = await connector.forTarget(target, 'observer', `baseline-plan/${target.targetId}`)
  try {
    const major = opened.session.facts.major
    await loadParser(major)
    const failed: { name: string; layer: 'L2'; status: 'error' }[] = []
    const found = new Map<string, readonly ConsumerCode[]>()
    await opened.session.readOnly(async (rtx) => {
      for (const r of revisions) {
        const bytes = r.files['verify.sql']
        if (bytes === null) continue
        const text = normalizeSqlSource(bytes)
        const file = text.ok ? analyzeVerifyFile(major, text.value) : undefined
        if (file === undefined || !file.ok) {
          failed.push({
            name: `${r.migrationId}: verify.sql admission`,
            layer: 'L2',
            status: 'error',
          })
          continue
        }
        const resolution = await resolveVerifyCatalog(rtx, file.checks)
        if (!resolution.ok) {
          failed.push({
            name: `${r.migrationId}: verify.sql resolution`,
            layer: 'L2',
            status: 'error',
          })
          continue
        }
        found.set(r.migrationId, [...resolution.consumer])
      }
    })
    if (failed.length > 0) {
      throw new MigrationError('VERIFICATION_FAILED', { checks: failed.slice(0, 256) })
    }
    return found
  } finally {
    await opened.session.close()
  }
}

/** One covered bundle's verify.sql on the target, read-only as the verifier. */
async function coveredLayer(
  connector: Connector,
  target: TargetRecord,
  purpose: string,
  revision: StoredRevision,
  bound: readonly ConsumerCode[] | null,
): Promise<Layer> {
  const bytes = revision.files['verify.sql']
  if (bytes === null) return runtimeLayer(connector, target, purpose, null, bound)
  const text = normalizeSqlSource(bytes)
  if (!text.ok) {
    return {
      status: 'error',
      checks: 0,
      failed: 0,
      firstFailure: { name: 'verify.sql encoding', detail: null },
    }
  }
  return runtimeLayer(connector, target, purpose, text.value, bound)
}

/**
 * The runtime layer of a baseline's verification (ADR-0040 §5): every covered bundle's
 * verify.sql, from the newest stored revision with the recorded apply checksum (a corrected
 * verify.sql is a new revision of the same checksum, so a later re-verification uses it).
 * Skipped without covers.
 */
export async function coveredRuntime(
  q: Queryable,
  connector: Connector,
  target: TargetRecord,
  projectId: string,
  operationId: string,
  rows: readonly CoveredRow[],
): Promise<Layer> {
  if (rows.length === 0) return { status: 'skipped', checks: 0, failed: 0, firstFailure: null }
  const parts: { id: string; layer: Layer }[] = []
  for (const row of rows) {
    // Newest first: the first with the recorded checksum is the newest revision of it.
    const revision = (await revisionsOf(q, projectId, row.migrationId)).find(
      (r) => r.checksum === row.checksum,
    )
    parts.push({
      id: row.migrationId,
      layer:
        revision === undefined
          ? {
              status: 'error',
              checks: 0,
              failed: 0,
              firstFailure: { name: 'covered bundle not in the bundle store', detail: null },
            }
          : await coveredLayer(
              connector,
              target,
              `verify/${operationId}`,
              revision,
              row.consumerCode ?? null,
            ),
    })
  }
  return combinedLayer(parts)
}

/**
 * Several bundles' runtime layers as one: the worst status, the counts summed, the first bad one
 * named, and one kept failure per bundle that did not hold (`file` is its id), so a read can say
 * which covered bundle failed.
 */
export function combinedLayer(parts: readonly { id: string; layer: Layer }[]): Layer {
  const bad =
    parts.find((p) => p.layer.status === 'error') ??
    parts.find((p) => p.layer.status === 'failed' || p.layer.status === 'partial')
  const status: Layer['status'] = parts.some((p) => p.layer.status === 'error')
    ? 'error'
    : bad !== undefined
      ? 'failed'
      : parts.every((p) => p.layer.status === 'skipped')
        ? 'skipped'
        : 'passed'
  const failures = parts
    .filter(
      (p) =>
        p.layer.status === 'error' || p.layer.status === 'failed' || p.layer.status === 'partial',
    )
    .map((p) => ({
      file: p.id,
      statement: null,
      kind: 'covered_verify',
      object: (p.layer.firstFailure?.name ?? 'verify.sql').slice(0, 300),
      failed: [p.layer.status],
      excused: false,
    }))
  return {
    status,
    ...(failures.length === 0
      ? {}
      : { failures: failures.slice(0, MAX_KEPT), failuresTotal: failures.length }),
    checks: parts.reduce((n, p) => n + p.layer.checks, 0),
    failed: parts.reduce((n, p) => n + p.layer.failed, 0),
    firstFailure:
      bad === undefined
        ? null
        : {
            name: `${bad.id}: ${bad.layer.firstFailure?.name ?? bad.layer.status}`.slice(0, 128),
            detail: bad.layer.firstFailure?.detail ?? null,
          },
  }
}

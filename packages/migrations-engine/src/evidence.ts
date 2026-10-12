import type { Queryable } from '@exponetdb/control-store'
import type { EvidenceFact, LineageFact } from '@exponetdb/policy'
import {
  type LedgerRecord,
  markerWithin,
  readLedgerRows,
  readVerifications,
  TargetError,
  type VerificationRecord,
} from '@exponetdb/postgres'
import {
  type Connector,
  getEnvironment,
  liveTargetOf,
  RegistryError,
  type TargetRecord,
} from '@exponetdb/registry'
import { MigrationError } from './errors.ts'

/**
 * Staging evidence ([staging-production-policy.md](../../../../exponetdb-docs/04-migrations/staging-production-policy.md),
 * G6 order §33): read **live** from the configured evidence target of the
 * production target's environment, never from a mirror and never from a
 * client's statement. Per migration: the evidence target's ledger has the
 * same id with the same apply checksum, not reverted, and its latest
 * verification passed with the same verify digest. The evidence target's
 * identity marker must name it at its current generation. Anything that
 * cannot be read is `unreachable` (fail closed). There is no override:
 * a production target without an evidence environment has no evidence.
 */
export interface EvidenceInput {
  readonly migrationId: string
  readonly checksum: string
  readonly verifyDigest: string | null
}

/** One migration's evidence (wire shape: `EvidenceItem`). */
export interface EvidenceItem {
  readonly migrationId: string
  readonly status: 'present' | 'missing' | 'unverified' | 'other_verify_digest' | 'unreachable'
  readonly evidenceTargetId: string | null
  readonly verificationId: string | null
  readonly verifiedAt: string | null
  readonly generation: number | null
  readonly lineage: 'match' | 'mismatch' | 'unknown' | null
}

export interface EvidenceResult {
  readonly fact: EvidenceFact
  readonly lineage: LineageFact
  readonly items: readonly EvidenceItem[]
  /** What the plan binds: the evidence target, its generation, the verification per migration. */
  readonly binding: {
    readonly targetId: string
    readonly generation: number
    readonly verifications: Readonly<Record<string, string>>
  } | null
}

const RANK: Readonly<Record<EvidenceFact, number>> = {
  present: 0,
  not_required: 0,
  other_verify_digest: 1,
  unverified: 2,
  missing: 3,
  unreachable: 4,
}

function latest(verifications: readonly VerificationRecord[], migrationId: string) {
  return verifications
    .filter((v) => v.migrationId === migrationId)
    .sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : a.finishedAt > b.finishedAt ? -1 : 0))[0]
}

function itemsOf(
  migrations: readonly EvidenceInput[],
  status: EvidenceItem['status'],
  evidenceTargetId: string | null,
): EvidenceItem[] {
  return migrations.map((m) => ({
    migrationId: m.migrationId,
    status,
    evidenceTargetId,
    verificationId: null,
    verifiedAt: null,
    generation: null,
    lineage: null,
  }))
}

export interface EvidenceRead {
  readonly ledger: readonly LedgerRecord[]
  readonly verifications: readonly VerificationRecord[]
  readonly generation: number
}

/** Reads the evidence target's ledger and verifications as its observer (its marker checked first). */
export async function readEvidenceTarget(
  connector: Connector,
  installationId: string,
  evidence: TargetRecord,
  purpose: string,
): Promise<EvidenceRead> {
  const opened = await connector.forTarget(evidence, 'observer', purpose)
  try {
    return await opened.session.readOnly(async (tx) => {
      const marker = await markerWithin(tx)
      if (
        marker.status !== 'present' ||
        marker.marker.installationId !== installationId ||
        marker.marker.targetId !== evidence.targetId ||
        marker.marker.generation !== evidence.generation
      ) {
        throw new MigrationError('TARGET_IDENTITY_MISMATCH')
      }
      return {
        ledger: await readLedgerRows(tx),
        verifications: await readVerifications(tx),
        generation: marker.marker.generation,
      }
    })
  } finally {
    await opened.session.close()
  }
}

/** The evidence target of a production target (its environment's `evidenceFrom`), if any. */
export async function evidenceTargetOf(
  q: Queryable,
  target: TargetRecord,
): Promise<TargetRecord | undefined> {
  const environment = await getEnvironment(q, target.environmentId)
  if (environment === undefined || environment.evidenceFrom === null) return undefined
  return liveTargetOf(q, target.projectId, environment.evidenceFrom)
}

export async function collectEvidence(
  q: Queryable,
  connector: Connector,
  installationId: string,
  target: TargetRecord,
  migrations: readonly EvidenceInput[],
  fingerprintNow: string,
): Promise<EvidenceResult> {
  if (target.tier !== 'prod') {
    return { fact: 'not_required', lineage: 'not_required', items: [], binding: null }
  }
  const evidence = await evidenceTargetOf(q, target)
  if (evidence === undefined) {
    return {
      fact: 'missing',
      lineage: 'unknown',
      items: itemsOf(migrations, 'missing', null),
      binding: null,
    }
  }
  let read: EvidenceRead
  try {
    read = await readEvidenceTarget(
      connector,
      installationId,
      evidence,
      `evidence/${target.targetId}`,
    )
  } catch (error) {
    if (
      error instanceof TargetError ||
      error instanceof RegistryError ||
      (error instanceof MigrationError && error.code === 'TARGET_IDENTITY_MISMATCH')
    ) {
      return {
        fact: 'unreachable',
        lineage: 'unknown',
        items: itemsOf(migrations, 'unreachable', evidence.targetId),
        binding: null,
      }
    }
    throw error
  }
  // Condition 3: the evidence was produced by this installation (its operation is known here).
  const operationIds = read.ledger
    .filter((r) => migrations.some((m) => m.migrationId === r.migrationId))
    .map((r) => r.operationId)
  const { rows: knownRows } = await q.query(
    'migrations.evidence.known_operations',
    `SELECT operation_id FROM operations.operations
      WHERE operation_id = ANY (ARRAY(SELECT jsonb_array_elements_text($1::jsonb)))`,
    [JSON.stringify(operationIds)],
  )
  const known = new Set(knownRows.map((r) => r.text('operation_id')))
  const items: EvidenceItem[] = []
  const verifications: Record<string, string> = {}
  let fact: EvidenceFact = 'present'
  let lineage: LineageFact = 'unknown'
  for (const [i, m] of migrations.entries()) {
    const row = read.ledger.find((r) => r.migrationId === m.migrationId)
    if (row !== undefined && row.checksum !== m.checksum) {
      throw new MigrationError('MIGRATION_CHECKSUM_MISMATCH', {
        migrationId: m.migrationId,
        knownChecksum: row.checksum,
        where: { kind: 'target_ledger', targetId: evidence.targetId },
      })
    }
    let status: EvidenceItem['status'] = 'missing'
    const v =
      row === undefined || row.revertedAt !== null
        ? undefined
        : latest(read.verifications, m.migrationId)
    if (row !== undefined && row.revertedAt === null && known.has(row.operationId)) {
      status =
        v === undefined || v.status !== 'passed'
          ? 'unverified'
          : v.verifyDigest === m.verifyDigest
            ? 'present'
            : 'other_verify_digest'
    }
    const itemLineage: 'match' | 'mismatch' | 'unknown' | null =
      i === 0 && row !== undefined
        ? row.fingerprintBefore === null
          ? 'unknown'
          : row.fingerprintBefore === fingerprintNow
            ? 'match'
            : 'mismatch'
        : null
    if (i === 0) lineage = itemLineage ?? 'unknown'
    if (status === 'present' && v !== undefined) verifications[m.migrationId] = v.verificationId
    if (RANK[status] > RANK[fact]) fact = status
    items.push({
      migrationId: m.migrationId,
      status,
      evidenceTargetId: evidence.targetId,
      verificationId: v?.status === 'passed' ? v.verificationId : null,
      verifiedAt: v?.status === 'passed' ? new Date(v.finishedAt).toISOString() : null,
      generation: read.generation,
      lineage: itemLineage,
    })
  }
  return {
    fact,
    lineage,
    items,
    binding:
      fact === 'present'
        ? { targetId: evidence.targetId, generation: read.generation, verifications }
        : null,
  }
}

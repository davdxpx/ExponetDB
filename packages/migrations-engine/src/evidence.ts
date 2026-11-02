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
import { compareWithMirror, recordedRows, recordKey } from './divergence.ts'
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

/**
 * What makes the evidence target's rows evidence (VC-079): the evidence was produced by this
 * installation, not written by hand. A ledger row counts only when an operation of the evidence
 * target listed that migration, the evidence target's ledger agrees with its mirror in the Control
 * Store (which exists to catch tampering: one divergence is no evidence at all), and the
 * verification is one the Control Store mirrored. An operation id alone proves nothing. Planning
 * and the apply-time re-check use the same function.
 */
export async function evidenceTrust(
  q: Queryable,
  evidenceTargetId: string,
  read: EvidenceRead,
  migrations: readonly { readonly migrationId: string }[],
): Promise<{
  rowTrusted(row: LedgerRecord): boolean
  verificationTrusted(v: VerificationRecord): boolean
}> {
  const concerned = read.ledger.filter((r) =>
    migrations.some((m) => m.migrationId === r.migrationId),
  )
  const recorded = await recordedRows(q, evidenceTargetId, concerned)
  const divergent =
    (await compareWithMirror(q, evidenceTargetId, read.generation, read.ledger)) !== null
  // The mirror's own copy of what evidence reads (the checksum is compared by the divergence
  // check): a live column edited by hand disagrees with it and the row is no evidence (VC-079).
  const { rows: mirroredRows } = await q.query(
    'migrations.evidence.mirrored_rows',
    `SELECT migration_id, verify_digest, fingerprint_before, reverted_at IS NOT NULL AS reverted
       FROM migrations.ledger_mirror
      WHERE target_id = $1 AND generation = $2
        AND migration_id = ANY (ARRAY(SELECT jsonb_array_elements_text($3::jsonb)))`,
    [evidenceTargetId, read.generation, JSON.stringify(concerned.map((r) => r.migrationId))],
  )
  const mirrorOf = new Map(
    mirroredRows.map((r) => [
      r.text('migration_id'),
      {
        verifyDigest: r.textOrNull('verify_digest'),
        fingerprintBefore: r.textOrNull('fingerprint_before'),
        reverted: r.bool('reverted'),
      },
    ]),
  )
  // The mirror's verifications are immutable: the live row must be the one mirrored under its id.
  const { rows } = await q.query(
    'migrations.evidence.mirrored_verifications',
    `SELECT verification_id, migration_id, verify_digest, status FROM migrations.verification_mirror
      WHERE target_id = $1 AND generation = $2
        AND verification_id = ANY (ARRAY(SELECT jsonb_array_elements_text($3::jsonb)))`,
    [
      evidenceTargetId,
      read.generation,
      JSON.stringify(read.verifications.map((v) => v.verificationId)),
    ],
  )
  const mirroredVerifications = new Map(
    rows.map((r) => [
      r.text('verification_id'),
      {
        migrationId: r.text('migration_id'),
        verifyDigest: r.textOrNull('verify_digest'),
        status: r.text('status'),
      },
    ]),
  )
  return {
    rowTrusted: (row) => {
      const mirror = mirrorOf.get(row.migrationId)
      return (
        !divergent &&
        recorded.has(recordKey(row.operationId, row.migrationId)) &&
        mirror !== undefined &&
        mirror.verifyDigest === row.verifyDigest &&
        mirror.fingerprintBefore === row.fingerprintBefore &&
        mirror.reverted === (row.revertedAt !== null)
      )
    },
    verificationTrusted: (v) => {
      const mirror = mirroredVerifications.get(v.verificationId)
      return (
        mirror !== undefined &&
        mirror.migrationId === v.migrationId &&
        mirror.verifyDigest === v.verifyDigest &&
        mirror.status === v.status
      )
    },
  }
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
  const trust = await evidenceTrust(q, evidence.targetId, read, migrations)
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
    if (row !== undefined && row.revertedAt === null && trust.rowTrusted(row)) {
      status =
        v === undefined || v.status !== 'passed' || !trust.verificationTrusted(v)
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

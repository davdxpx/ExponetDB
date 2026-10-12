import type { JsonObject, JsonValue } from '@exponetdb/kernel'
import { TargetError } from './errors.ts'
import type { TargetRow } from './rows.ts'
import type { CatalogReader, TargetSession } from './session.ts'
import { sql } from './sql.ts'

/**
 * The target ledger's history ([ledger.md §2, §3](../../../exponetdb-docs/04-migrations/ledger.md#2-schema-exponetdb-in-each-target-database)):
 * reads of `schema_migrations`, `migration_events` and
 * `migration_verifications` for status, planning and reconciliation, and
 * the migrator's writes inside a migration's own transaction. One ledger
 * (version 1, created by `stampTarget`); no second table, no duplicate
 * checksum model. Every value travels as a bind parameter.
 */

export interface LedgerMeta {
  readonly ledgerSchemaVersion: number
  readonly projectId: string
  readonly baselineId: string | null
}

export interface LedgerRecord {
  readonly migrationId: string
  readonly origin: 'exponetdb' | 'legacy_import' | 'baseline'
  readonly name: string
  readonly checksum: string
  readonly checksumProvenance: string
  readonly sourceDigest: string | null
  readonly verifyDigest: string | null
  readonly rollbackDigest: string | null
  readonly manifest: JsonValue | null
  readonly dependencies: readonly string[]
  readonly transactional: boolean | null
  readonly appliedSeq: string
  readonly appliedAt: string
  readonly planId: string | null
  readonly operationId: string
  readonly fingerprintBefore: string | null
  readonly fingerprintAfter: string | null
  readonly revertedAt: string | null
  readonly revertedByOp: string | null
}

export interface MigrationEventRecord {
  readonly seq: string
  readonly at: string
  readonly migrationId: string
  readonly operationId: string
  readonly event: string
  readonly detail: JsonObject
}

export interface VerificationRecord {
  readonly verificationId: string
  readonly migrationId: string
  readonly operationId: string
  readonly verifyDigest: string | null
  readonly startedAt: string
  readonly finishedAt: string
  readonly status: 'passed' | 'failed' | 'partial' | 'error'
  readonly structural: JsonObject
  readonly runtime: JsonObject | null
  readonly engine: JsonObject
  readonly fingerprint: string
}

const META = sql`SELECT ledger_schema_version, project_id, baseline_id FROM exponetdb.ledger_meta`

const ROWS = sql`SELECT migration_id, origin, name, checksum, checksum_provenance, source_digest, verify_digest,
       rollback_digest, manifest::text AS manifest, pg_catalog.to_jsonb(dependencies)::text AS dependencies,
       transactional, applied_seq::text AS applied_seq,
       to_char(applied_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS applied_at,
       plan_id, operation_id, fingerprint_before, fingerprint_after,
       to_char(reverted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS reverted_at, reverted_by_op
  FROM exponetdb.schema_migrations ORDER BY applied_seq`

const EVENTS = sql`SELECT event_seq::text AS seq,
       to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
       migration_id, operation_id, event, detail::text AS detail
  FROM exponetdb.migration_events
 WHERE ($1::text IS NULL OR migration_id = $1) AND ($2::text IS NULL OR operation_id = $2)
 ORDER BY event_seq`

const VERIFICATIONS = sql`SELECT verification_id, migration_id, operation_id, verify_digest,
       to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at,
       to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS finished_at,
       status, structural::text AS structural, runtime::text AS runtime, engine::text AS engine, fingerprint
  FROM exponetdb.migration_verifications
 WHERE ($1::text IS NULL OR migration_id = $1)
 ORDER BY finished_at, verification_id`

/** The identity marker, locked against change for the rest of the transaction (C-27). */
const MARKER_FOR_SHARE = sql`SELECT installation_id, target_id, generation::text AS generation, cluster_system_id
  FROM exponetdb.target_identity FOR SHARE`

const INSERT_ROW = sql`INSERT INTO exponetdb.schema_migrations
  (migration_id, origin, name, checksum, checksum_provenance, source_digest, verify_digest, rollback_digest,
   manifest, dependencies, transactional, source, applied_at, apply_duration_ms, plan_id, operation_id,
   actor_ref, client_ref, engine_version, pg_version_num, fingerprint_before, fingerprint_after)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb,
        ARRAY(SELECT pg_catalog.jsonb_array_elements_text($10::jsonb)), $11::boolean, $12::jsonb, clock_timestamp(),
        $13::int, $14, $15, $16, $17, $18, $19::int, $20, $21)`

const INSERT_EVENT = sql`INSERT INTO exponetdb.migration_events (migration_id, operation_id, event, detail)
VALUES ($1, $2, $3, $4::jsonb)`

const INSERT_VERIFICATION = sql`INSERT INTO exponetdb.migration_verifications
  (verification_id, migration_id, operation_id, verify_digest, started_at, finished_at, status, structural,
   runtime, engine, fingerprint)
VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11)`

const REVERT = sql`UPDATE exponetdb.schema_migrations SET reverted_at = clock_timestamp(), reverted_by_op = $2
 WHERE migration_id = $1 AND reverted_at IS NULL RETURNING migration_id`

function jsonOrNull(row: TargetRow, column: string): JsonValue | null {
  return row.isNull(column) ? null : row.json(column)
}

function objectOrNull(row: TargetRow, column: string): JsonObject | null {
  return row.isNull(column) ? null : (row.jsonObject(column) as JsonObject)
}

function recordOf(row: TargetRow): LedgerRecord {
  const origin = row.text('origin')
  if (origin !== 'exponetdb' && origin !== 'legacy_import' && origin !== 'baseline') {
    throw new TargetError('TARGET_SQL_ERROR', 'server_error')
  }
  return {
    migrationId: row.text('migration_id'),
    origin,
    name: row.text('name'),
    checksum: row.text('checksum'),
    checksumProvenance: row.text('checksum_provenance'),
    sourceDigest: row.textOrNull('source_digest'),
    verifyDigest: row.textOrNull('verify_digest'),
    rollbackDigest: row.textOrNull('rollback_digest'),
    manifest: jsonOrNull(row, 'manifest'),
    dependencies: row.jsonArray('dependencies').map(String),
    transactional: row.boolOrNull('transactional'),
    appliedSeq: row.text('applied_seq'),
    appliedAt: row.text('applied_at'),
    planId: row.textOrNull('plan_id'),
    operationId: row.text('operation_id'),
    fingerprintBefore: row.textOrNull('fingerprint_before'),
    fingerprintAfter: row.textOrNull('fingerprint_after'),
    revertedAt: row.textOrNull('reverted_at'),
    revertedByOp: row.textOrNull('reverted_by_op'),
  }
}

/** The ledger metadata (one row), or undefined when the ledger has none. */
export async function readLedgerMeta(reader: CatalogReader): Promise<LedgerMeta | undefined> {
  const row = (await reader.query(META))[0]
  if (row === undefined) return undefined
  return {
    ledgerSchemaVersion: row.int('ledger_schema_version'),
    projectId: row.text('project_id'),
    baselineId: row.textOrNull('baseline_id'),
  }
}

export async function readLedgerRows(reader: CatalogReader): Promise<LedgerRecord[]> {
  return (await reader.query(ROWS)).map(recordOf)
}

export async function readMigrationEvents(
  reader: CatalogReader,
  filter: { readonly migrationId?: string; readonly operationId?: string } = {},
): Promise<MigrationEventRecord[]> {
  const rows = await reader.query(EVENTS, [filter.migrationId ?? null, filter.operationId ?? null])
  return rows.map((r) => ({
    seq: r.text('seq'),
    at: r.text('at'),
    migrationId: r.text('migration_id'),
    operationId: r.text('operation_id'),
    event: r.text('event'),
    detail: r.jsonObject('detail') as JsonObject,
  }))
}

export async function readVerifications(
  reader: CatalogReader,
  migrationId?: string,
): Promise<VerificationRecord[]> {
  const rows = await reader.query(VERIFICATIONS, [migrationId ?? null])
  return rows.map((r) => {
    const status = r.text('status')
    if (status !== 'passed' && status !== 'failed' && status !== 'partial' && status !== 'error') {
      throw new TargetError('TARGET_SQL_ERROR', 'server_error')
    }
    return {
      verificationId: r.text('verification_id'),
      migrationId: r.text('migration_id'),
      operationId: r.text('operation_id'),
      verifyDigest: r.textOrNull('verify_digest'),
      startedAt: r.text('started_at'),
      finishedAt: r.text('finished_at'),
      status,
      structural: r.jsonObject('structural') as JsonObject,
      runtime: objectOrNull(r, 'runtime'),
      engine: r.jsonObject('engine') as JsonObject,
      fingerprint: r.text('fingerprint'),
    }
  })
}

/**
 * Inside the migration transaction: the identity marker, locked `FOR SHARE`
 * so a concurrent re-stamp (restore, placement switch) waits for this
 * transaction or makes it fail, and compared with the expected identity.
 */
export async function lockMarker(
  session: TargetSession,
  expected: {
    readonly installationId: string
    readonly targetId: string
    readonly generation: number
    readonly systemIdentifier: string
  },
): Promise<void> {
  const rows = await session.query(MARKER_FOR_SHARE)
  const row = rows[0]
  if (rows.length !== 1 || row === undefined) {
    throw new TargetError('TARGET_IDENTITY_MISMATCH', 'marker_missing')
  }
  if (
    row.text('installation_id') !== expected.installationId ||
    row.text('target_id') !== expected.targetId ||
    row.int('generation') !== expected.generation
  ) {
    throw new TargetError('TARGET_IDENTITY_MISMATCH', 'marker_mismatch')
  }
  if (row.text('cluster_system_id') !== expected.systemIdentifier) {
    throw new TargetError('CLUSTER_IDENTITY_MISMATCH', 'system_identifier')
  }
}

export interface NewLedgerRow {
  readonly migrationId: string
  readonly origin: 'exponetdb' | 'legacy_import' | 'baseline'
  readonly name: string
  readonly checksum: string
  readonly checksumProvenance:
    | 'computed_at_apply'
    | 'legacy_file_at_import'
    | 'legacy_tool_hash'
    | 'legacy_applied_statements'
    | 'unknown'
  readonly sourceDigest: string | null
  readonly verifyDigest: string | null
  readonly rollbackDigest: string | null
  readonly manifest: JsonObject | null
  readonly dependencies: readonly string[]
  readonly transactional: boolean | null
  readonly source: JsonObject | null
  readonly applyDurationMs: number | null
  readonly planId: string | null
  readonly operationId: string
  readonly actorRef: string | null
  readonly clientRef: string | null
  readonly engineVersion: string
  readonly pgVersionNum: number
  readonly fingerprintBefore: string | null
  readonly fingerprintAfter: string | null
}

/** Inserts a ledger row (as the migrator, in the transaction of its change). */
export async function insertLedgerRow(session: TargetSession, row: NewLedgerRow): Promise<void> {
  await session.query(INSERT_ROW, [
    row.migrationId,
    row.origin,
    row.name,
    row.checksum,
    row.checksumProvenance,
    row.sourceDigest,
    row.verifyDigest,
    row.rollbackDigest,
    row.manifest === null ? null : JSON.stringify(row.manifest),
    JSON.stringify(row.dependencies),
    row.transactional,
    row.source === null ? null : JSON.stringify(row.source),
    row.applyDurationMs,
    row.planId,
    row.operationId,
    row.actorRef,
    row.clientRef,
    row.engineVersion,
    row.pgVersionNum,
    row.fingerprintBefore,
    row.fingerprintAfter,
  ])
}

export type LedgerEvent =
  | 'nontx_started'
  | 'nontx_statement_done'
  | 'nontx_failed'
  | 'applied'
  | 'reverted'
  | 'imported'
  | 'baselined'
  | 'ledger_reconciled'

export async function insertMigrationEvent(
  session: TargetSession,
  event: {
    readonly migrationId: string
    readonly operationId: string
    readonly event: LedgerEvent
    readonly detail?: JsonObject
  },
): Promise<void> {
  await session.query(INSERT_EVENT, [
    event.migrationId,
    event.operationId,
    event.event,
    JSON.stringify(event.detail ?? {}),
  ])
}

/** Appends a verification run (as the migrator; the ledger row must exist). */
export async function insertVerification(
  session: TargetSession,
  run: VerificationRecord,
): Promise<void> {
  await session.query(INSERT_VERIFICATION, [
    run.verificationId,
    run.migrationId,
    run.operationId,
    run.verifyDigest,
    run.startedAt,
    run.finishedAt,
    run.status,
    JSON.stringify(run.structural),
    run.runtime === null ? null : JSON.stringify(run.runtime),
    JSON.stringify(run.engine),
    run.fingerprint,
  ])
}

/** Marks a migration reverted, once (the only update the ledger allows). */
export async function markReverted(
  session: TargetSession,
  migrationId: string,
  operationId: string,
): Promise<boolean> {
  const rows = await session.query(REVERT, [migrationId, operationId])
  return rows.length === 1
}

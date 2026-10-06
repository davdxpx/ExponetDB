import type { ControlStore, Queryable, Row, Tx } from '@exponetdb/control-store'
import { isJsonObject, newId } from '@exponetdb/kernel'
import {
  type DocumentHeader,
  type ManagedScope,
  OBJECT_CLASSES,
  type ObjectClass,
  type Snapshot,
  type SnapshotOptions,
  takeSnapshot,
  type VisibilityItem,
} from '@exponetdb/postgres'
import { type Connector, getProject, type TargetRecord } from '@exponetdb/registry'
import { storeDocument } from './documents.ts'
import { DiagnosticsError } from './errors.ts'
import { requireIdentity } from './identity.ts'

/**
 * Schema snapshots ([schema-fingerprints.md §8, §9](../../../exponetdb-docs/03-database-model/schema-fingerprints.md)):
 * an observer session on the target's current placement, the identity
 * check first (a snapshot of the wrong database is never stored), then
 * `takeSnapshot` of the managed scope in one read-only transaction. The
 * document goes into `schema_documents` once per fingerprint and the
 * snapshot row records completeness, the visibility report, the schemas
 * outside the scope and why it was taken. An incomplete snapshot is stored
 * (it is the truth about what could be read) but is never a baseline.
 */
export type SnapshotPurpose = 'registration' | 'drift_check' | 'read'

export interface SnapshotDeps {
  /** The Control Store login of the process (serve for reads, worker for checks and registration). */
  readonly store: ControlStore
  /** The connector of the same process (observer sessions). */
  readonly connector: Connector
  readonly installationId: string
  readonly options?: SnapshotOptions
}

export interface SnapshotRecord {
  readonly snapshotId: string
  readonly targetId: string
  readonly generation: number
  readonly fingerprint: string
  readonly complete: boolean
  readonly visibility: readonly VisibilityItem[]
  readonly missingSchemas: readonly string[]
  readonly excludedSchemas: readonly string[]
  readonly serverVersionNum: number
  readonly purpose: SnapshotPurpose
  readonly durationMs: number
  readonly operationId: string | null
  readonly takenAt: string
}

/** The most visibility gaps one snapshot row keeps (the report counts them all). */
const MAX_STORED_GAPS = 10_000

/** The project's managed scope as the snapshotter takes it. */
export function scopeOfProject(project: {
  readonly managedScope: {
    readonly includeSchemas: readonly string[] | null
    readonly excludeSchemas: readonly string[]
  }
}): ManagedScope {
  return {
    ...(project.managedScope.includeSchemas === null
      ? {}
      : { includeSchemas: [...project.managedScope.includeSchemas] }),
    excludeSchemas: [...project.managedScope.excludeSchemas],
  }
}

/** The scope a stored document was taken with (its header). */
export function scopeOfHeader(header: DocumentHeader): ManagedScope {
  return {
    ...(header.scope.include === 'all' ? {} : { includeSchemas: [...header.scope.include] }),
    excludeSchemas: [...header.scope.exclude],
  }
}

export function sameScope(a: ManagedScope, b: ManagedScope): boolean {
  const norm = (s: ManagedScope) =>
    JSON.stringify([
      s.includeSchemas === undefined ? null : [...new Set(s.includeSchemas)].sort(),
      [...new Set(s.excludeSchemas ?? [])].sort(),
    ])
  return norm(a) === norm(b)
}

export async function projectScope(q: Queryable, target: TargetRecord): Promise<ManagedScope> {
  const project = await getProject(q, target.projectId)
  if (project === undefined) {
    throw new DiagnosticsError('TARGET_NOT_FOUND')
  }
  return scopeOfProject(project)
}

/** Takes a live snapshot of a target (identity checked on the same session first). */
export async function observeSchema(
  deps: SnapshotDeps,
  target: TargetRecord,
  purpose: SnapshotPurpose,
  scope: ManagedScope,
): Promise<Snapshot> {
  if (target.placement === null) {
    throw new DiagnosticsError('TARGET_UNAVAILABLE')
  }
  const opened = await deps.connector.forTarget(
    target,
    'observer',
    `schema/${purpose}/${target.targetId}`,
  )
  try {
    await requireIdentity(opened.session, target, deps.installationId)
    return await takeSnapshot(opened.session, scope, deps.options ?? {})
  } finally {
    await opened.session.close()
  }
}

const SNAPSHOT_COLUMNS = `s.snapshot_id, s.target_id, s.generation, s.fingerprint, s.complete, s.visibility,
  s.missing_schemas, s.excluded_schemas, s.server_version_num, s.purpose, s.duration_ms, s.operation_id,
  to_char(s.taken_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS taken_at`

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function visibilityOf(value: unknown): VisibilityItem[] {
  if (!Array.isArray(value)) return []
  const out: VisibilityItem[] = []
  for (const v of value) {
    if (!isJsonObject(v)) continue
    const cls = v['class']
    const attribute = v['attribute']
    const reason = v['reason']
    if (
      typeof cls !== 'string' ||
      !(OBJECT_CLASSES as readonly string[]).includes(cls) ||
      typeof attribute !== 'string' ||
      (reason !== 'unreadable' && reason !== 'missing_schema')
    ) {
      continue
    }
    out.push({ class: cls as ObjectClass, key: strings(v['key']), attribute, reason })
  }
  return out
}

function snapshotFrom(row: Row): SnapshotRecord {
  const purpose = row.text('purpose')
  return {
    snapshotId: row.text('snapshot_id'),
    targetId: row.text('target_id'),
    generation: row.int('generation'),
    fingerprint: row.text('fingerprint'),
    complete: row.bool('complete'),
    visibility: visibilityOf(row.json('visibility')),
    missingSchemas: strings(row.json('missing_schemas')),
    excludedSchemas: strings(row.json('excluded_schemas')),
    serverVersionNum: row.int('server_version_num'),
    purpose: purpose === 'registration' || purpose === 'drift_check' ? purpose : 'read',
    durationMs: row.int('duration_ms'),
    operationId: row.textOrNull('operation_id'),
    takenAt: row.text('taken_at'),
  }
}

/** Stores the document (once per fingerprint) and the snapshot row, in the caller's transaction. */
export async function persistSnapshot(
  tx: Tx,
  target: Pick<TargetRecord, 'targetId' | 'generation'>,
  snapshot: Snapshot,
  purpose: SnapshotPurpose,
  operationId: string | null,
): Promise<SnapshotRecord> {
  await storeDocument(tx, snapshot.document)
  const snapshotId = newId('smp', Date.now())
  const { rows } = await tx.query(
    'observation.snapshots.insert',
    `INSERT INTO observation.schema_snapshots AS s
       (snapshot_id, target_id, generation, fingerprint, complete, visibility, missing_schemas,
        excluded_schemas, server_version_num, purpose, duration_ms, operation_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11, $12)
     RETURNING ${SNAPSHOT_COLUMNS}`,
    [
      snapshotId,
      target.targetId,
      target.generation,
      snapshot.fingerprint,
      snapshot.complete,
      JSON.stringify(
        snapshot.visibility.slice(0, MAX_STORED_GAPS).map((v) => ({
          class: v.class,
          key: [...v.key],
          attribute: v.attribute,
          reason: v.reason,
        })),
      ),
      JSON.stringify([...snapshot.missingSchemas]),
      JSON.stringify([...snapshot.excludedSchemas]),
      snapshot.serverVersionNum,
      purpose,
      Math.max(0, Math.round(snapshot.stats.durationMs)),
      operationId,
    ],
  )
  const row = rows[0]
  if (row === undefined) {
    throw new DiagnosticsError('INTERNAL')
  }
  return snapshotFrom(row)
}

export async function getSnapshot(
  q: Queryable,
  snapshotId: string,
): Promise<SnapshotRecord | undefined> {
  const { rows } = await q.query(
    'observation.snapshots.get',
    `SELECT ${SNAPSHOT_COLUMNS} FROM observation.schema_snapshots s WHERE s.snapshot_id = $1`,
    [snapshotId],
  )
  const row = rows[0]
  return row === undefined ? undefined : snapshotFrom(row)
}

/** The newest snapshot of a target's current generation, optionally no older than `maxAgeMs`. */
export async function latestSnapshot(
  q: Queryable,
  target: Pick<TargetRecord, 'targetId' | 'generation'>,
  options: { readonly maxAgeMs?: number } = {},
): Promise<SnapshotRecord | undefined> {
  const { rows } = await q.query(
    'observation.snapshots.latest',
    `SELECT ${SNAPSHOT_COLUMNS} FROM observation.schema_snapshots s
      WHERE s.target_id = $1 AND s.generation = $2
        AND ($3::bigint IS NULL OR s.taken_at >= clock_timestamp() - make_interval(secs => $3::bigint / 1000.0))
      ORDER BY s.taken_at DESC LIMIT 1`,
    [target.targetId, target.generation, options.maxAgeMs ?? null],
  )
  const row = rows[0]
  return row === undefined ? undefined : snapshotFrom(row)
}

export async function registrationSnapshotOf(
  q: Queryable,
  operationId: string,
): Promise<SnapshotRecord | undefined> {
  const { rows } = await q.query(
    'observation.snapshots.of_operation',
    `SELECT ${SNAPSHOT_COLUMNS} FROM observation.schema_snapshots s
      WHERE s.operation_id = $1 AND s.purpose = 'registration'
      ORDER BY s.taken_at DESC LIMIT 1`,
    [operationId],
  )
  const row = rows[0]
  return row === undefined ? undefined : snapshotFrom(row)
}

export interface BaselineRecord {
  readonly baselineId: string
  readonly targetId: string
  readonly generation: number
  readonly snapshotId: string
  readonly fingerprint: string
  readonly reason: 'registration' | 'drift_accept'
  readonly operationId: string
  readonly establishedAt: string
}

/**
 * The expected schema of a target until Wave 6 (order §138): the latest
 * baseline of its current generation (registration, or an accepted drift).
 * Never "whatever is there now".
 */
export async function currentBaseline(
  q: Queryable,
  target: Pick<TargetRecord, 'targetId' | 'generation'>,
): Promise<BaselineRecord | undefined> {
  const { rows } = await q.query(
    'observation.baselines.current',
    `SELECT b.baseline_id, b.target_id, b.generation, b.snapshot_id, b.fingerprint, b.reason, b.operation_id,
            to_char(b.established_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS established_at
       FROM observation.schema_baselines b
      WHERE b.target_id = $1 AND b.generation = $2
      ORDER BY b.established_at DESC, b.baseline_id DESC LIMIT 1`,
    [target.targetId, target.generation],
  )
  const row = rows[0]
  return row === undefined
    ? undefined
    : {
        baselineId: row.text('baseline_id'),
        targetId: row.text('target_id'),
        generation: row.int('generation'),
        snapshotId: row.text('snapshot_id'),
        fingerprint: row.text('fingerprint'),
        reason: row.text('reason') === 'drift_accept' ? 'drift_accept' : 'registration',
        operationId: row.text('operation_id'),
        establishedAt: row.text('established_at'),
      }
}

/** Records a baseline from a complete snapshot (the Control Store refuses anything else, EXH02). */
export async function insertBaseline(
  tx: Tx,
  snapshot: SnapshotRecord,
  reason: 'registration' | 'drift_accept',
  operationId: string,
): Promise<string> {
  const baselineId = newId('smp', Date.now())
  await tx.query(
    'observation.baselines.insert',
    `INSERT INTO observation.schema_baselines
       (baseline_id, target_id, generation, snapshot_id, fingerprint, reason, operation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      baselineId,
      snapshot.targetId,
      snapshot.generation,
      snapshot.snapshotId,
      snapshot.fingerprint,
      reason,
      operationId,
    ],
  )
  return baselineId
}

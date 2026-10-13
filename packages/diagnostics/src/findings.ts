import type { Finding } from '@exponetdb/contracts'
import type { Queryable, Row, Tx } from '@exponetdb/control-store'
import { type JsonObject, newId } from '@exponetdb/kernel'
import {
  brand,
  decodeCursor,
  encodeCursor,
  type Page,
  type PageRequest,
  type TargetVisibility,
  targetVisibilitySql,
} from '@exponetdb/registry'

/**
 * Findings ([drift-detection.md](../../../exponetdb-docs/03-database-model/drift-detection.md),
 * health.md §3, order §139): one open finding per target and
 * deduplication key (a partial unique index). Seeing it again counts one
 * more occurrence on the same row; it is resolved once, with a reason, and
 * kept as history. Nothing is deleted.
 *
 * Details are bounded and structured; they hold object names (untrusted,
 * from the catalog) and hashes, never values read from rows, function
 * bodies or settings text.
 */
export type FindingKind = 'drift' | 'health'
export type Severity = 'info' | 'warning' | 'critical'
export type Resolution = 'cleared' | 'accepted' | 'superseded'

export interface FindingInput {
  readonly targetId: string
  readonly kind: FindingKind
  readonly code: string
  readonly severity: Severity
  readonly dedupKey: string
  readonly summary: string
  readonly details: JsonObject
  /** The drift check that saw it (drift findings). */
  readonly checkId?: string | null
}

export interface FindingRecord {
  readonly findingId: string
  readonly targetId: string
  readonly kind: FindingKind
  readonly code: string
  readonly severity: Severity
  readonly dedupKey: string
  readonly summary: string
  readonly details: JsonObject
  readonly state: 'open' | 'resolved'
  readonly occurrences: number
  readonly firstSeenAt: string
  readonly lastSeenAt: string
  readonly resolvedAt: string | null
  readonly resolution: Resolution | null
}

const ts = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

const FINDING_COLUMNS = `f.finding_id, f.target_id, f.kind, f.code, f.severity, f.dedup_key, f.summary, f.details,
  f.state, f.occurrences, ${ts('f.first_seen_at')} AS first_seen_at, ${ts('f.last_seen_at')} AS last_seen_at,
  ${ts('f.resolved_at')} AS resolved_at, f.resolution`

function findingFrom(row: Row): FindingRecord {
  const details = row.json('details')
  const severity = row.text('severity')
  const resolution = row.textOrNull('resolution')
  return {
    findingId: row.text('finding_id'),
    targetId: row.text('target_id'),
    kind: row.text('kind') === 'health' ? 'health' : 'drift',
    code: row.text('code'),
    severity: severity === 'critical' || severity === 'info' ? severity : 'warning',
    dedupKey: row.text('dedup_key'),
    summary: row.text('summary'),
    details:
      typeof details === 'object' && details !== null && !Array.isArray(details)
        ? (details as JsonObject)
        : {},
    state: row.text('state') === 'resolved' ? 'resolved' : 'open',
    occurrences: row.int('occurrences'),
    firstSeenAt: row.text('first_seen_at'),
    lastSeenAt: row.text('last_seen_at'),
    resolvedAt: row.textOrNull('resolved_at'),
    resolution:
      resolution === 'cleared' || resolution === 'accepted' || resolution === 'superseded'
        ? resolution
        : null,
  }
}

/**
 * Bounded text for summaries (object names are untrusted and may be long).
 * Cut on a code point boundary: half a surrogate pair is not valid Unicode,
 * and PostgreSQL refuses it in JSON.
 */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  let end = Math.max(0, max - 1)
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end--
  return `${text.slice(0, end)}…`
}

/** Opens a finding, or counts one more occurrence of the open one with the same key. */
export async function recordFinding(
  tx: Tx,
  input: FindingInput,
): Promise<{ readonly findingId: string; readonly opened: boolean }> {
  const { rows } = await tx.query(
    'observation.findings.record',
    `INSERT INTO observation.findings AS f
       (finding_id, target_id, kind, code, severity, dedup_key, summary, details, state, opened_by_check)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'open', $9)
     ON CONFLICT (target_id, dedup_key) WHERE state = 'open'
     DO UPDATE SET occurrences = f.occurrences + 1, severity = EXCLUDED.severity,
                   summary = EXCLUDED.summary, details = EXCLUDED.details
     RETURNING f.finding_id, (f.xmax = 0) AS opened`,
    [
      newId('fnd', Date.now()),
      input.targetId,
      input.kind,
      input.code,
      input.severity,
      clip(input.dedupKey, 1024),
      clip(input.summary, 1024),
      JSON.stringify(input.details),
      input.checkId ?? null,
    ],
  )
  const row = rows[0]
  if (row === undefined) {
    throw new Error('a finding upsert returns its row')
  }
  return { findingId: row.text('finding_id'), opened: row.bool('opened') }
}

export async function resolveFinding(
  tx: Tx,
  findingId: string,
  resolution: Resolution,
  checkId: string | null,
): Promise<boolean> {
  const { rowCount } = await tx.query(
    'observation.findings.resolve',
    `UPDATE observation.findings SET state = 'resolved', resolution = $2, resolved_by_check = $3
      WHERE finding_id = $1 AND state = 'open'`,
    [findingId, resolution, checkId],
  )
  return rowCount === 1
}

export async function openFindings(
  q: Queryable,
  targetId: string,
  kind: FindingKind,
): Promise<FindingRecord[]> {
  const { rows } = await q.query(
    'observation.findings.open',
    `SELECT ${FINDING_COLUMNS} FROM observation.findings f
      WHERE f.target_id = $1 AND f.kind = $2 AND f.state = 'open' ORDER BY f.finding_id`,
    [targetId, kind],
  )
  return rows.map(findingFrom)
}

/** One finding by id, open or resolved. */
export async function getFinding(
  q: Queryable,
  findingId: string,
): Promise<FindingRecord | undefined> {
  const { rows } = await q.query(
    'observation.findings.get',
    `SELECT ${FINDING_COLUMNS} FROM observation.findings f WHERE f.finding_id = $1`,
    [findingId],
  )
  const row = rows[0]
  return row === undefined ? undefined : findingFrom(row)
}

/** Whether a finding's drift is security-relevant or critical (drift-detection.md §6). */
export function securitySensitive(f: Pick<FindingRecord, 'severity' | 'details'>): boolean {
  return f.severity === 'critical' || f.details['securityRelevant'] === true
}

export async function openFindingCount(q: Queryable, targetId: string): Promise<number> {
  const { rows } = await q.query(
    'observation.findings.open_count',
    `SELECT count(*)::int AS n FROM observation.findings WHERE target_id = $1 AND state = 'open'`,
    [targetId],
  )
  return rows[0]?.int('n') ?? 0
}

export interface FindingFilter {
  readonly includeResolved?: boolean
  readonly kind?: FindingKind
  readonly severity?: Severity
}

/** Open findings first (newest id first within each state); resolved ones only when asked. */
export async function listFindings(
  q: Queryable,
  targetId: string,
  filter: FindingFilter,
  request: PageRequest,
): Promise<Page<FindingRecord>> {
  const limit = Math.min(Math.max(1, Math.trunc(request.limit)), 200)
  const after = decodeCursor(request.cursor)
  const { rows } = await q.query(
    'observation.findings.list',
    `SELECT ${FINDING_COLUMNS} FROM observation.findings f
      WHERE f.target_id = $1
        AND ($2::boolean OR f.state = 'open')
        AND ($3::text IS NULL OR f.kind = $3)
        AND ($4::text IS NULL OR f.severity = $4)
        AND ($5::text IS NULL OR f.finding_id < $5)
      ORDER BY f.finding_id DESC LIMIT $6`,
    [
      targetId,
      filter.includeResolved === true,
      filter.kind ?? null,
      filter.severity ?? null,
      after,
      limit + 1,
    ],
  )
  const items = rows.slice(0, limit).map(findingFrom)
  const last = items[items.length - 1]
  return {
    items,
    nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last.findingId) : null,
  }
}

export interface FleetFindingFilter {
  readonly severity?: Severity
  /** `open` is the default; `all` lists both. */
  readonly state?: 'open' | 'resolved' | 'all'
  readonly kind?: FindingKind
  /** One target, already resolved and authorized by the caller of this read. */
  readonly targetId?: string
}

export interface FleetFindingRecord extends FindingRecord {
  readonly targetPath: string
}

/**
 * Findings across the targets a caller may read (Wave 8), newest first. The
 * visibility is the target list's own clause (`targetVisibilitySql`), applied
 * in SQL before the page is cut, so no row, cursor or count names a target
 * the caller may not read. Keyset on the finding id (a ULID: descending id is
 * newest first); the primary key serves the order, no index is added.
 */
export async function listFleetFindings(
  q: Queryable,
  visibility: TargetVisibility,
  filter: FleetFindingFilter,
  request: PageRequest,
): Promise<Page<FleetFindingRecord>> {
  const limit = Math.min(Math.max(1, Math.trunc(request.limit)), 200)
  const after = decodeCursor(request.cursor)
  const visible = targetVisibilitySql(visibility, 1)
  const state = filter.state ?? 'open'
  const { rows } = await q.query(
    'observation.findings.list_fleet',
    `SELECT ${FINDING_COLUMNS}, t.path AS target_path
       FROM observation.findings f
       JOIN registry.targets t ON t.target_id = f.target_id
       JOIN registry.projects j ON j.project_id = t.project_id
      WHERE ${visible.sql}
        AND ($8::text = 'all' OR f.state = $8)
        AND ($9::text IS NULL OR f.kind = $9)
        AND ($10::text IS NULL OR f.severity = $10)
        AND ($11::text IS NULL OR f.target_id = $11)
        AND ($12::text IS NULL OR f.finding_id < $12)
      ORDER BY f.finding_id DESC LIMIT $13`,
    [
      ...visible.params,
      state,
      filter.kind ?? null,
      filter.severity ?? null,
      filter.targetId ?? null,
      after,
      limit + 1,
    ],
  )
  const items = rows
    .slice(0, limit)
    .map((r) => ({ ...findingFrom(r), targetPath: r.text('target_path') }))
  const last = items[items.length - 1]
  return {
    items,
    nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last.findingId) : null,
  }
}

export function findingView(f: FindingRecord): Finding {
  const object = f.details['object']
  return {
    id: brand('fnd', f.findingId),
    kind: f.kind,
    code: f.code,
    severity: f.severity,
    subject: { targetId: brand('tgt', f.targetId), clusterId: null, nodeId: null },
    summary: f.summary,
    state: f.state,
    occurrences: f.occurrences,
    object: typeof object === 'string' ? clip(object, 512) : null,
    securityRelevant: f.details['securityRelevant'] === true,
    resolution: f.resolution,
    firstSeenAt: f.firstSeenAt,
    lastSeenAt: f.lastSeenAt,
    resolvedAt: f.resolvedAt,
  }
}

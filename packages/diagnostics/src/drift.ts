import type { DriftCheck, DriftFinding } from '@exponetdb/contracts'
import {
  EXDB_LOCK_NAMESPACE,
  lockKey2,
  type Queryable,
  type Row,
  type Tx,
} from '@exponetdb/control-store'
import {
  canonicalize,
  type IdentityId,
  type JsonObject,
  type JsonValue,
  newId,
} from '@exponetdb/kernel'
import { sha256Hex } from '@exponetdb/kernel/hash'
import {
  type CanonicalDocument,
  type CanonicalEntry,
  type DocumentDiff,
  diffDocuments,
  entryId,
  type Snapshot,
  securityRelevant,
} from '@exponetdb/postgres'
import { brand, type TargetRecord } from '@exponetdb/registry'
import { loadDocument } from './documents.ts'
import { DocumentCorrupt, failureCodeOf } from './errors.ts'
import {
  clip,
  type FindingRecord,
  openFindings,
  recordFinding,
  resolveFinding,
  type Severity,
} from './findings.ts'
import { objectLabel } from './objects.ts'
import {
  currentBaseline,
  observeSchema,
  persistSnapshot,
  type SnapshotDeps,
  scopeOfHeader,
} from './snapshots.ts'

/**
 * Drift kind C, expected ↔ actual ([drift-detection.md §1, §2, §4, §6](../../../exponetdb-docs/03-database-model/drift-detection.md),
 * order §137 to §142). Until Wave 6 the expected schema of a target is its
 * latest baseline (the registration snapshot, or an accepted drift); never
 * "whatever is there now".
 *
 * - The current snapshot is taken with the baseline's own managed scope, so
 *   the two fingerprints are comparable; schemas outside that scope are
 *   counted as `unmanaged`, never as matched. A project scope change takes
 *   effect for drift with the next baseline.
 * - A failed read records a `failed` check with its code; an incomplete
 *   snapshot records `incomplete`; baselines of another canonicalizer or
 *   PostgreSQL major record `not_comparable`. None of them changes a
 *   finding (an unreadable or partial view is never "clean").
 * - Each drifted object is one finding (deduplicated by kind, code and
 *   object): seen again it counts an occurrence; gone, it is resolved
 *   `cleared` (or `superseded` when the same object now drifts another
 *   way). Security-relevant drift (ACLs, owners, default privileges, row
 *   security, policies, SECURITY DEFINER, function configuration, event
 *   triggers) is `critical`; other drift is a `warning`.
 * - At most {@link MAX_DRIFT_FINDINGS} new findings per check; the rest is
 *   one `drift_overflow` finding with the count, and nothing open is
 *   resolved because it was left out.
 * - Drift never changes the database. There is no automatic fix.
 */
export const MAX_DRIFT_FINDINGS = 500

export type DriftStatus =
  | 'clean'
  | 'drifted'
  | 'incomplete'
  | 'no_baseline'
  | 'not_comparable'
  | 'failed'

export type DriftCode = 'object_added' | 'object_removed' | 'object_changed'

export interface DriftItem {
  readonly code: DriftCode
  /** The object as it is now (added, changed) or as it was expected (removed). */
  readonly entry: CanonicalEntry
  readonly expected: CanonicalEntry | null
  readonly actual: CanonicalEntry | null
  /** Changed top-level attributes (`object_changed`). */
  readonly attributes: readonly string[]
  readonly securityRelevant: boolean
  readonly severity: Severity
  readonly dedupKey: string
}

/** The object part of a deduplication key (shared by every code of the same object). */
export function objectKey(entry: Pick<CanonicalEntry, 'class' | 'key'>): string {
  return `${entry.class}:${sha256Hex(entryId(entry))}`
}

export function dedupKeyOf(code: DriftCode, entry: Pick<CanonicalEntry, 'class' | 'key'>): string {
  return `C:${code}:${objectKey(entry)}`
}

const OVERFLOW_KEY = 'C:drift_overflow'

/** The drifted objects of a diff, security-relevant first, then in document order. */
export function driftItems(diff: DocumentDiff): DriftItem[] {
  const items: DriftItem[] = []
  const item = (
    code: DriftCode,
    entry: CanonicalEntry,
    expected: CanonicalEntry | null,
    actual: CanonicalEntry | null,
    attributes: readonly string[],
    security: boolean,
  ): DriftItem => ({
    code,
    entry,
    expected,
    actual,
    attributes,
    securityRelevant: security,
    severity: security ? 'critical' : 'warning',
    dedupKey: dedupKeyOf(code, entry),
  })
  for (const entry of diff.added) {
    items.push(
      item('object_added', entry, null, entry, [], securityRelevant({ kind: 'added', entry })),
    )
  }
  for (const entry of diff.removed) {
    items.push(
      item('object_removed', entry, entry, null, [], securityRelevant({ kind: 'removed', entry })),
    )
  }
  for (const change of diff.changed) {
    items.push(
      item(
        'object_changed',
        change.after,
        change.before,
        change.after,
        change.attributes,
        securityRelevant({ kind: 'changed', change }),
      ),
    )
  }
  return items.sort(
    (a, b) =>
      Number(b.securityRelevant) - Number(a.securityRelevant) ||
      (a.dedupKey < b.dedupKey ? -1 : a.dedupKey > b.dedupKey ? 1 : 0),
  )
}

export interface DriftCheckRecord {
  readonly checkId: string
  readonly targetId: string
  readonly generation: number
  readonly requestedBy: string
  readonly status: DriftStatus
  readonly baselineFingerprint: string | null
  readonly currentFingerprint: string | null
  readonly snapshotId: string | null
  readonly drifted: number
  readonly matched: number
  readonly unmanaged: number
  readonly opened: number
  readonly updated: number
  readonly resolved: number
  readonly errorCode: string | null
  readonly startedAt: string
  readonly finishedAt: string
}

export interface DriftResult {
  readonly check: DriftCheckRecord
  /** The drifted objects with their findings (at most {@link MAX_DRIFT_FINDINGS}). */
  readonly items: readonly { readonly item: DriftItem; readonly findingId: string }[]
  readonly truncated: boolean
}

export type DriftDeps = SnapshotDeps & {
  /** New findings per check (default {@link MAX_DRIFT_FINDINGS}; tests use a small cap). */
  readonly maxFindings?: number
}

const ts = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

const CHECK_COLUMNS = `d.check_id, d.target_id, d.generation, d.requested_by, d.status, d.baseline_fingerprint,
  d.current_fingerprint, d.snapshot_id, d.drifted, d.matched, d.unmanaged, d.opened, d.updated, d.resolved,
  d.error_code, ${ts('d.started_at')} AS started_at, ${ts('d.finished_at')} AS finished_at`

const STATUSES: readonly DriftStatus[] = [
  'clean',
  'drifted',
  'incomplete',
  'no_baseline',
  'not_comparable',
  'failed',
]

function checkFrom(row: Row): DriftCheckRecord {
  const status = row.text('status')
  return {
    checkId: row.text('check_id'),
    targetId: row.text('target_id'),
    generation: row.int('generation'),
    requestedBy: row.text('requested_by'),
    status: (STATUSES as readonly string[]).includes(status) ? (status as DriftStatus) : 'failed',
    baselineFingerprint: row.textOrNull('baseline_fingerprint'),
    currentFingerprint: row.textOrNull('current_fingerprint'),
    snapshotId: row.textOrNull('snapshot_id'),
    drifted: row.int('drifted'),
    matched: row.int('matched'),
    unmanaged: row.int('unmanaged'),
    opened: row.int('opened'),
    updated: row.int('updated'),
    resolved: row.int('resolved'),
    errorCode: row.textOrNull('error_code'),
    startedAt: row.text('started_at'),
    finishedAt: row.text('finished_at'),
  }
}

interface CheckValues {
  readonly status: DriftStatus
  readonly baselineFingerprint: string | null
  readonly currentFingerprint: string | null
  readonly snapshotId: string | null
  readonly drifted?: number
  readonly matched?: number
  readonly unmanaged?: number
  readonly opened?: number
  readonly updated?: number
  readonly resolved?: number
  readonly errorCode?: string | null
}

async function insertCheck(
  tx: Queryable,
  checkId: string,
  target: Pick<TargetRecord, 'targetId' | 'generation'>,
  requestedBy: string,
  startedAt: string,
  v: CheckValues,
): Promise<DriftCheckRecord> {
  const { rows } = await tx.query(
    'observation.drift.insert',
    `INSERT INTO observation.drift_checks AS d
       (check_id, target_id, generation, requested_by, status, baseline_fingerprint, current_fingerprint,
        snapshot_id, drifted, matched, unmanaged, opened, updated, resolved, error_code, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             LEAST($16::timestamptz, clock_timestamp()))
     RETURNING ${CHECK_COLUMNS}`,
    [
      checkId,
      target.targetId,
      target.generation,
      requestedBy,
      v.status,
      v.baselineFingerprint,
      v.currentFingerprint,
      v.snapshotId,
      v.drifted ?? 0,
      v.matched ?? 0,
      v.unmanaged ?? 0,
      v.opened ?? 0,
      v.updated ?? 0,
      v.resolved ?? 0,
      v.errorCode ?? null,
      startedAt,
    ],
  )
  const row = rows[0]
  if (row === undefined) throw new Error('a drift check insert returns its row')
  return checkFrom(row)
}

function lockTarget(tx: Tx, targetId: string) {
  return tx.query('observation.drift.lock', 'SELECT pg_advisory_xact_lock($1::int, $2::int)', [
    EXDB_LOCK_NAMESPACE,
    lockKey2(`observation/drift/${targetId}`),
  ])
}

function findingDetails(item: DriftItem, baseline: string, current: string): JsonObject {
  return {
    driftKind: 'C',
    bucket: 'drifted',
    class: item.entry.class,
    key: item.entry.key.slice(0, 8).map((k) => clip(k, 256)),
    object: objectLabel(item.entry),
    attributes: item.attributes.slice(0, 64).map((a) => clip(a, 64)),
    securityRelevant: item.securityRelevant,
    expectedHash: item.expected?.hash ?? null,
    actualHash: item.actual?.hash ?? null,
    baselineFingerprint: baseline,
    currentFingerprint: current,
  }
}

function summaryOf(item: DriftItem): string {
  const label = objectLabel(item.entry)
  switch (item.code) {
    case 'object_added':
      return clip(`${label} exists but is not in the expected schema`, 1024)
    case 'object_removed':
      return clip(`${label} is expected but missing`, 1024)
    case 'object_changed':
      return clip(`${label} changed: ${item.attributes.join(', ')}`, 1024)
  }
}

/** A failed or partial check, recorded without touching any finding. */
async function recordWithoutFindings(
  deps: DriftDeps,
  target: TargetRecord,
  requestedBy: string,
  startedAt: string,
  v: CheckValues,
  snapshot?: Snapshot,
): Promise<DriftResult> {
  const checkId = newId('smp', Date.now())
  const check = await deps.store.transaction('observation.drift.record_partial', async (tx) => {
    let snapshotId: string | null = null
    if (snapshot !== undefined) {
      snapshotId = (await persistSnapshot(tx, target, snapshot, 'drift_check', null)).snapshotId
    }
    return insertCheck(tx, checkId, target, requestedBy, startedAt, { ...v, snapshotId })
  })
  return { check, items: [], truncated: false }
}

/**
 * Records a check that could not complete (an unexpected failure of the
 * check itself): `failed` with the failure code, findings untouched, so
 * the target is neither shown as clean nor checked again at once.
 */
export async function recordDriftFailure(
  deps: DriftDeps,
  target: TargetRecord,
  requestedBy: 'schedule' | IdentityId,
  error: unknown,
): Promise<DriftResult> {
  return recordWithoutFindings(deps, target, requestedBy, new Date().toISOString(), {
    status: 'failed',
    baselineFingerprint: null,
    currentFingerprint: null,
    snapshotId: null,
    errorCode: failureCodeOf(error),
  })
}

/** Runs one drift check of a target against its baseline and records the outcome. */
export async function runDriftCheck(
  deps: DriftDeps,
  target: TargetRecord,
  requestedBy: 'schedule' | IdentityId,
): Promise<DriftResult> {
  const startedAt = new Date().toISOString()
  const baseline = await currentBaseline(deps.store, target)
  if (baseline === undefined) {
    return recordWithoutFindings(deps, target, requestedBy, startedAt, {
      status: 'no_baseline',
      baselineFingerprint: null,
      currentFingerprint: null,
      snapshotId: null,
    })
  }
  let expected: CanonicalDocument
  try {
    expected = await loadDocument(deps.store, baseline.fingerprint)
  } catch (error) {
    if (!(error instanceof DocumentCorrupt)) throw error
    return recordWithoutFindings(deps, target, requestedBy, startedAt, {
      status: 'failed',
      baselineFingerprint: baseline.fingerprint,
      currentFingerprint: null,
      snapshotId: null,
      errorCode: 'INTERNAL',
    })
  }
  let snapshot: Snapshot
  try {
    snapshot = await observeSchema(deps, target, 'drift_check', scopeOfHeader(expected.header))
  } catch (error) {
    return recordWithoutFindings(deps, target, requestedBy, startedAt, {
      status: 'failed',
      baselineFingerprint: baseline.fingerprint,
      currentFingerprint: null,
      snapshotId: null,
      errorCode: failureCodeOf(error),
    })
  }
  const unmanaged = snapshot.excludedSchemas.length
  if (!snapshot.complete) {
    return recordWithoutFindings(
      deps,
      target,
      requestedBy,
      startedAt,
      {
        status: 'incomplete',
        baselineFingerprint: baseline.fingerprint,
        currentFingerprint: snapshot.fingerprint,
        snapshotId: null,
        unmanaged,
      },
      snapshot,
    )
  }
  const diff = diffDocuments(expected, snapshot.document)
  const matched = diff.matched
  if (!diff.comparable) {
    return recordWithoutFindings(
      deps,
      target,
      requestedBy,
      startedAt,
      {
        status: 'not_comparable',
        baselineFingerprint: baseline.fingerprint,
        currentFingerprint: snapshot.fingerprint,
        snapshotId: null,
        drifted: diff.added.length + diff.removed.length + diff.changed.length,
        matched,
        unmanaged,
      },
      snapshot,
    )
  }
  const items = driftItems(diff)
  const current = snapshot.fingerprint
  const checkId = newId('smp', Date.now())
  return deps.store.transaction('observation.drift.record', async (tx) => {
    await lockTarget(tx, target.targetId)
    const stored = await persistSnapshot(tx, target, snapshot, 'drift_check', null)
    const open = await openFindings(tx, target.targetId, 'drift')
    const openByKey = new Map<string, FindingRecord>(open.map((f) => [f.dedupKey, f]))
    const keys = new Set(items.map((i) => i.dedupKey))
    const objects = new Set(items.map((i) => objectKey(i.entry)))

    // New findings up to the cap; every finding already open is counted again.
    const recorded: DriftItem[] = []
    let omitted = 0
    let omittedCritical = false
    let fresh = 0
    for (const item of items) {
      if (openByKey.has(item.dedupKey)) {
        recorded.push(item)
      } else if (fresh < (deps.maxFindings ?? MAX_DRIFT_FINDINGS)) {
        recorded.push(item)
        fresh++
      } else {
        omitted++
        omittedCritical ||= item.securityRelevant
      }
    }
    const overflowOpen = openByKey.get(OVERFLOW_KEY)
    const recordedObjects = new Set(recorded.map((i) => objectKey(i.entry)))
    const toResolve = open.filter((f) => {
      if (f.dedupKey === OVERFLOW_KEY || keys.has(f.dedupKey)) return false
      const objectPart = f.dedupKey.split(':').slice(2).join(':')
      // An object that still drifts another way keeps its open finding until the
      // new one is recorded (the cap may have left it out of this check).
      return !objects.has(objectPart) || recordedObjects.has(objectPart)
    })
    const opened = fresh + (omitted > 0 && overflowOpen === undefined ? 1 : 0)
    const updated = recorded.length - fresh + (omitted > 0 && overflowOpen !== undefined ? 1 : 0)
    const resolvedCount = toResolve.length + (omitted === 0 && overflowOpen !== undefined ? 1 : 0)

    const check = await insertCheck(tx, checkId, target, requestedBy, startedAt, {
      status: items.length === 0 ? 'clean' : 'drifted',
      baselineFingerprint: baseline.fingerprint,
      currentFingerprint: current,
      snapshotId: stored.snapshotId,
      drifted: items.length,
      matched,
      unmanaged,
      opened,
      updated,
      resolved: resolvedCount,
    })
    const out: { item: DriftItem; findingId: string }[] = []
    for (const item of recorded) {
      const f = await recordFinding(tx, {
        targetId: target.targetId,
        kind: 'drift',
        code: item.code,
        severity: item.severity,
        dedupKey: item.dedupKey,
        summary: summaryOf(item),
        details: findingDetails(item, baseline.fingerprint, current),
        checkId,
      })
      if (out.length < MAX_DRIFT_FINDINGS) out.push({ item, findingId: f.findingId })
    }
    if (omitted > 0) {
      await recordFinding(tx, {
        targetId: target.targetId,
        kind: 'drift',
        code: 'drift_overflow',
        severity: omittedCritical ? 'critical' : 'warning',
        dedupKey: OVERFLOW_KEY,
        summary: clip(
          `${omitted} more drifted objects were not recorded as separate findings in this check`,
          1024,
        ),
        details: {
          driftKind: 'C',
          bucket: 'drifted',
          omitted,
          securityRelevant: omittedCritical,
          baselineFingerprint: baseline.fingerprint,
          currentFingerprint: current,
        },
        checkId,
      })
    } else if (overflowOpen !== undefined) {
      await resolveFinding(tx, overflowOpen.findingId, 'cleared', checkId)
    }
    for (const f of toResolve) {
      const objectPart = f.dedupKey.split(':').slice(2).join(':')
      await resolveFinding(
        tx,
        f.findingId,
        objects.has(objectPart) ? 'superseded' : 'cleared',
        checkId,
      )
    }
    return { check, items: out, truncated: items.length > out.length }
  })
}

function rendered(value: JsonValue | undefined): string | null {
  if (value === undefined) return null
  const text = canonicalize(value)
  return text.ok ? clip(text.value, 4096) : null
}

function changedValues(entry: CanonicalEntry | null, attributes: readonly string[]): string | null {
  if (entry === null) return null
  if (attributes.length === 0) return rendered(entry.attributes)
  const picked: Record<string, JsonValue> = {}
  for (const a of attributes) {
    const v = entry.attributes[a]
    picked[a] = v === undefined ? null : v
  }
  return rendered(picked)
}

/** The drift check as the contract shows it (for a caller holding `schema.read`). */
export function driftCheckView(result: DriftResult): DriftCheck {
  const c = result.check
  const findings: DriftFinding[] = result.items.map(({ item, findingId }) => ({
    id: brand('fnd', findingId),
    driftKind: 'C',
    bucket: 'drifted',
    code: item.code,
    severity: item.severity,
    object: objectLabel(item.entry),
    expected: changedValues(item.expected, item.attributes),
    actual: changedValues(item.actual, item.attributes),
    explainedByOperationId: null,
  }))
  return {
    id: brand('smp', c.checkId),
    targetId: brand('tgt', c.targetId),
    checkedAt: c.finishedAt,
    status: c.status,
    baselineFingerprint: c.baselineFingerprint as DriftCheck['baselineFingerprint'],
    currentFingerprint: c.currentFingerprint as DriftCheck['currentFingerprint'],
    counts: {
      drifted: c.drifted,
      matched: c.matched,
      unmanaged: c.unmanaged,
      opened: c.opened,
      updated: c.updated,
      resolved: c.resolved,
    },
    errorCode: c.errorCode,
    findings,
    truncated: result.truncated,
  }
}

export async function latestDriftCheck(
  q: Queryable,
  target: Pick<TargetRecord, 'targetId' | 'generation'>,
): Promise<DriftCheckRecord | undefined> {
  const { rows } = await q.query(
    'observation.drift.latest',
    `SELECT ${CHECK_COLUMNS} FROM observation.drift_checks d
      WHERE d.target_id = $1 AND d.generation = $2 ORDER BY d.finished_at DESC LIMIT 1`,
    [target.targetId, target.generation],
  )
  const row = rows[0]
  return row === undefined ? undefined : checkFrom(row)
}

/** Default schedule (drift-detection.md §3): every 15 minutes for production, 60 for nonprod. */
export const DRIFT_INTERVAL_MINUTES = { prod: 15, nonprod: 60 } as const

/** Targets whose scheduled drift check is due, the longest-waiting first. */
export async function dueDriftTargets(
  q: Queryable,
  limit: number,
  intervals: { readonly prod: number; readonly nonprod: number } = DRIFT_INTERVAL_MINUTES,
): Promise<string[]> {
  const { rows } = await q.query(
    'observation.drift.due',
    `SELECT t.target_id
       FROM registry.targets t
       LEFT JOIN LATERAL (SELECT max(d.finished_at) AS last FROM observation.drift_checks d
                           WHERE d.target_id = t.target_id AND d.generation = t.generation) l ON true
      WHERE t.state IN ('active', 'suspended')
        AND (l.last IS NULL OR l.last < clock_timestamp()
             - make_interval(mins => CASE WHEN t.tier = 'prod' THEN $1::int ELSE $2::int END))
      ORDER BY l.last NULLS FIRST, t.target_id LIMIT $3`,
    [intervals.prod, intervals.nonprod, Math.max(1, Math.min(limit, 100))],
  )
  return rows.map((r) => r.text('target_id'))
}

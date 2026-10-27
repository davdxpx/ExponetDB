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
import type { FindingSummary } from './contract-types.ts'
import { clip } from './findings.ts'

/**
 * Findings beyond drift and health (Wave 9 Part B; bundle `subject-findings`,
 * [performance.md §2, §4](../../../exponetdb-docs/10-observability/performance.md)):
 * advisor findings and statement regressions of one target, backup findings
 * of one cluster, in `observation.subject_findings`. The lifecycle is the
 * frozen findings' one, enforced by the table's guard: a finding opens once
 * per subject, kind and deduplication key, counts one more occurrence each
 * time it is seen while open, is resolved once with a reason and is never
 * deleted.
 *
 * Object names and evidence come from the target's catalog: untrusted text,
 * bounded here, never interpreted.
 */
export type SubjectFindingKind = 'advisor' | 'statements' | 'backup'
export type SubjectSeverity = 'info' | 'warning' | 'critical'

export interface SubjectFindingInput {
  readonly subject: { readonly targetId: string } | { readonly clusterId: string }
  readonly kind: SubjectFindingKind
  readonly code: string
  /** The advisor category (advisor findings only). */
  readonly category: string | null
  readonly severity: SubjectSeverity
  readonly securityRelevant: boolean
  readonly dedupKey: string
  readonly summary: string
  readonly object: string | null
  readonly remediation: string | null
  readonly details: JsonObject
  /** The advisor run that saw it (advisor findings). */
  readonly runId?: string | null
}

/** Opens a finding, or counts one more occurrence of the open one with the same key. */
export async function upsertSubjectFinding(
  tx: Tx,
  input: SubjectFindingInput,
): Promise<{ readonly findingId: string; readonly opened: boolean }> {
  const onTarget = 'targetId' in input.subject
  const details = JSON.stringify(input.details)
  const { rows } = await tx.query(
    onTarget
      ? 'observation.subject_findings.upsert_target'
      : 'observation.subject_findings.upsert_cluster',
    `INSERT INTO observation.subject_findings AS f
       (finding_id, target_id, cluster_id, kind, code, category, severity, security_relevant, dedup_key,
        summary, object, remediation, details, state, first_seen_at, last_seen_at, opened_by_run)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, 'open',
             clock_timestamp(), clock_timestamp(), $14)
     ON CONFLICT ${onTarget ? "(target_id, kind, dedup_key) WHERE state = 'open' AND target_id IS NOT NULL" : "(cluster_id, kind, dedup_key) WHERE state = 'open' AND cluster_id IS NOT NULL"}
     DO UPDATE SET occurrences = f.occurrences + 1, severity = EXCLUDED.severity,
                   security_relevant = EXCLUDED.security_relevant, summary = EXCLUDED.summary,
                   object = EXCLUDED.object, remediation = EXCLUDED.remediation, details = EXCLUDED.details
     RETURNING f.finding_id, (f.xmax = 0) AS opened`,
    [
      newId('fnd', Date.now()),
      onTarget ? input.subject.targetId : null,
      onTarget ? null : input.subject.clusterId,
      input.kind,
      input.code,
      input.category,
      input.severity,
      input.securityRelevant,
      clip(input.dedupKey, 1024),
      clip(input.summary, 1024),
      input.object === null ? null : clip(input.object, 512),
      input.remediation === null ? null : clip(input.remediation, 2048),
      // The table bounds details at 16 KiB; a larger record keeps only its size.
      details.length > 16_000 ? JSON.stringify({ truncated: true }) : details,
      input.runId ?? null,
    ],
  )
  const row = rows[0]
  if (row === undefined) throw new Error('a finding upsert returns its row')
  return { findingId: row.text('finding_id'), opened: row.bool('opened') }
}

/** Resolves one open finding (`cleared`, `expired` or `superseded`); false when it was not open. */
export async function resolveSubjectFinding(
  tx: Tx,
  findingId: string,
  resolution: 'cleared' | 'expired' | 'superseded',
  runId: string | null = null,
): Promise<boolean> {
  const { rowCount } = await tx.query(
    'observation.subject_findings.resolve',
    `UPDATE observation.subject_findings
        SET state = 'resolved', resolution = $2, resolved_at = clock_timestamp(), resolved_by_run = $3
      WHERE finding_id = $1 AND state = 'open'`,
    [findingId, resolution, runId],
  )
  return rowCount === 1
}

export interface OpenSubjectFinding {
  readonly findingId: string
  readonly code: string
  readonly category: string | null
  readonly dedupKey: string
}

/** The open findings of a target and kind (optionally of some codes). */
export async function openSubjectFindings(
  q: Queryable,
  targetId: string,
  kind: SubjectFindingKind,
  codes?: readonly string[],
): Promise<OpenSubjectFinding[]> {
  const { rows } = await q.query(
    'observation.subject_findings.open',
    `SELECT finding_id, code, category, dedup_key FROM observation.subject_findings
      WHERE target_id = $1 AND kind = $2 AND state = 'open'
        AND ($3::text[] IS NULL OR code = ANY($3::text[]))
      ORDER BY finding_id`,
    [targetId, kind, codes === undefined ? null : [...codes]],
  )
  return rows.map((r) => ({
    findingId: r.text('finding_id'),
    code: r.text('code'),
    category: r.textOrNull('category'),
    dedupKey: r.text('dedup_key'),
  }))
}

const ts = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

function subjectView(row: Row): Finding {
  const severity = row.text('severity')
  const targetId = row.textOrNull('target_id')
  const clusterId = row.textOrNull('cluster_id')
  const object = row.textOrNull('object')
  return {
    id: brand('fnd', row.text('finding_id')),
    kind: row.text('kind'),
    code: row.text('code'),
    severity: severity === 'critical' || severity === 'info' ? severity : 'warning',
    subject: {
      targetId: targetId === null ? null : brand('tgt', targetId),
      clusterId: clusterId === null ? null : brand('cls', clusterId),
      nodeId: null,
    },
    summary: row.text('summary'),
    state: row.text('state') === 'resolved' ? 'resolved' : 'open',
    occurrences: row.int('occurrences'),
    object: object === null ? null : clip(object, 512),
    securityRelevant: row.bool('security_relevant'),
    resolution: row.textOrNull('resolution'),
    firstSeenAt: row.text('first_seen_at'),
    lastSeenAt: row.text('last_seen_at'),
    resolvedAt: row.textOrNull('resolved_at'),
  }
}

/** The findings of a cluster (backups and other cluster-level findings), newest first, keyset pages. */
export async function listClusterFindings(
  q: Queryable,
  clusterId: string,
  state: 'open' | 'resolved' | 'all',
  request: PageRequest,
): Promise<Page<Finding>> {
  const limit = Math.min(Math.max(1, Math.trunc(request.limit)), 200)
  const after = decodeCursor(request.cursor)
  const { rows } = await q.query(
    'observation.subject_findings.list_cluster',
    `SELECT s.finding_id, s.target_id, s.cluster_id, s.kind, s.code, s.severity, s.summary, s.object,
            s.security_relevant, s.state, s.occurrences, s.resolution,
            ${ts('s.first_seen_at')} AS first_seen_at, ${ts('s.last_seen_at')} AS last_seen_at,
            ${ts('s.resolved_at')} AS resolved_at
       FROM observation.subject_findings s
      WHERE s.cluster_id = $1
        AND ($2::text = 'all' OR s.state = $2)
        AND ($3::text IS NULL OR s.finding_id < $3)
      ORDER BY s.finding_id DESC LIMIT $4`,
    [clusterId, state, after, limit + 1],
  )
  const items = rows.slice(0, limit).map(subjectView)
  const last = items[items.length - 1]
  return {
    items,
    nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last.id) : null,
  }
}

/**
 * Counts of the open findings over the targets a caller may read (`finding.summary`):
 * drift and health findings and the target's subject findings together, by
 * severity, kind and the 50 most frequent codes. Cluster findings are not
 * part of it (their read permission is another one).
 */
export async function findingSummary(
  q: Queryable,
  visibility: TargetVisibility,
): Promise<FindingSummary> {
  const visible = targetVisibilitySql(visibility, 1)
  const { rows } = await q.query(
    'observation.findings.summary',
    `WITH open AS (
       SELECT f.kind, f.code, f.severity, f.target_id FROM observation.findings f WHERE f.state = 'open'
       UNION ALL
       SELECT s.kind, s.code, s.severity, s.target_id FROM observation.subject_findings s
        WHERE s.state = 'open' AND s.target_id IS NOT NULL
     )
     SELECT o.kind, o.code, o.severity, count(*)::int AS n,
            to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS as_of
       FROM open o
       JOIN registry.targets t ON t.target_id = o.target_id
       JOIN registry.projects j ON j.project_id = t.project_id
      WHERE ${visible.sql}
      GROUP BY o.kind, o.code, o.severity`,
    visible.params,
  )
  const bySeverity = { critical: 0, warning: 0, info: 0 }
  const byKind = new Map<string, number>()
  const codes: { kind: string; code: string; severity: SubjectSeverity; count: number }[] = []
  let asOf: string | null = null
  for (const row of rows) {
    asOf = row.text('as_of')
    const n = row.int('n')
    const raw = row.text('severity')
    const severity: SubjectSeverity = raw === 'critical' || raw === 'info' ? raw : 'warning'
    bySeverity[severity] += n
    const kind = clip(row.text('kind'), 64)
    byKind.set(kind, (byKind.get(kind) ?? 0) + n)
    codes.push({ kind, code: clip(row.text('code'), 64), severity, count: n })
  }
  const rank = { critical: 0, warning: 1, info: 2 } as const
  codes.sort(
    (a, b) =>
      b.count - a.count ||
      rank[a.severity] - rank[b.severity] ||
      a.kind.localeCompare(b.kind) ||
      a.code.localeCompare(b.code),
  )
  return {
    open: bySeverity.critical + bySeverity.warning + bySeverity.info,
    bySeverity,
    byKind: [...byKind.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 32)
      .map(([kind, count]) => ({ kind, count })),
    topCodes: codes.slice(0, 50),
    source: 'control_store',
    observedAt: asOf ?? new Date().toISOString(),
  }
}

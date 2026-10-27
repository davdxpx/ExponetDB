import type { Tx } from '@exponetdb/control-store'
import { newId } from '@exponetdb/kernel'

/**
 * The drill findings of [restore.md §6](../../../exponetdb-docs/09-backups-and-restore/restore.md#6-drills),
 * computed from the Control Store alone (a worker task; no node is asked):
 *
 * - `backup_drill_never_run`: a cluster with a live repository and a policy, and no drill ever passed;
 * - `backup_drill_overdue`: the last passed drill is older than the policy's cadence (warning),
 *   or older than twice the cadence (critical);
 * - `backup_drill_failed`: the newest drill run by ExponetDB failed, and no later one passed (critical);
 * - `restore_scratch_left`: a drill's restore older than 24 hours is not discarded (warning).
 *
 * An offline drill (C-35) is an attestation and never counts as a passed
 * drill here. A finding whose condition no longer holds is resolved.
 */

export const SCRATCH_LEFT_AFTER_MS = 24 * 3_600_000

export interface DrillFindingsOutcome {
  readonly clusters: number
  readonly opened: number
  readonly resolved: number
}

interface ClusterFacts {
  readonly clusterId: string
  readonly cadenceDays: number | null
  readonly lastPassedAt: Date | null
  readonly lastFailedAfterPass: boolean
  readonly scratchLeft: number
}

const CODES = [
  'backup_drill_never_run',
  'backup_drill_overdue',
  'backup_drill_failed',
  'restore_scratch_left',
] as const
type Code = (typeof CODES)[number]

interface Wanted {
  readonly code: Code
  readonly severity: 'warning' | 'critical'
  readonly summary: string
  readonly details: Record<string, string | number | null>
}

export function drillFindings(f: ClusterFacts, nowMs: number): Wanted[] {
  const out: Wanted[] = []
  if (f.cadenceDays !== null) {
    if (f.lastPassedAt === null) {
      out.push({
        code: 'backup_drill_never_run',
        severity: 'warning',
        summary: 'No restore drill of this cluster ever passed; its backups are not proven restorable.',
        details: { cadenceDays: f.cadenceDays },
      })
    } else {
      const ageMs = nowMs - f.lastPassedAt.getTime()
      const cadenceMs = f.cadenceDays * 86_400_000
      if (ageMs > cadenceMs) {
        out.push({
          code: 'backup_drill_overdue',
          severity: ageMs > 2 * cadenceMs ? 'critical' : 'warning',
          summary: `The last passed restore drill is older than the policy's cadence of ${f.cadenceDays} days.`,
          details: { cadenceDays: f.cadenceDays, lastPassedAt: f.lastPassedAt.toISOString() },
        })
      }
    }
  }
  if (f.lastFailedAfterPass) {
    out.push({
      code: 'backup_drill_failed',
      severity: 'critical',
      summary: 'The newest restore drill failed and no later drill passed.',
      details: {},
    })
  }
  if (f.scratchLeft > 0) {
    out.push({
      code: 'restore_scratch_left',
      severity: 'warning',
      summary: `${f.scratchLeft} restore scratch directories older than 24 hours are not discarded.`,
      details: { restores: f.scratchLeft },
    })
  }
  return out
}

/** One pass over every cluster with a live repository, in the caller's (worker) transaction. */
export async function maintainDrillFindings(tx: Tx, nowMs: number): Promise<DrillFindingsOutcome> {
  const { rows } = await tx.query(
    'backups.findings.drill_facts',
    `SELECT c.cluster_id,
            (SELECT (p.body ->> 'drillCadenceDays')::int FROM backups.policies p
              WHERE p.cluster_id = c.cluster_id AND p.state = 'active') AS cadence_days,
            (SELECT max(d.finished_at) FROM backups.drills d
              WHERE d.cluster_id = c.cluster_id AND d.mode = 'control_plane' AND d.outcome = 'passed') AS last_passed_at,
            (SELECT d.outcome FROM backups.drills d
              WHERE d.cluster_id = c.cluster_id AND d.mode = 'control_plane' AND d.outcome <> 'pending'
              ORDER BY d.finished_at DESC NULLS LAST, d.created_at DESC LIMIT 1) AS newest_outcome,
            (SELECT count(*)::int FROM backups.restores x
              WHERE x.cluster_id = c.cluster_id AND x.purpose = 'drill'
                AND x.state NOT IN ('discarded', 'promoted')
                AND x.created_at < $1::timestamptz) AS scratch_left
       FROM registry.clusters c
      WHERE c.state <> 'retired'
        AND EXISTS (SELECT FROM backups.repositories r WHERE r.cluster_id = c.cluster_id AND r.state <> 'retired')
      ORDER BY c.cluster_id
      LIMIT 1000`,
    [new Date(nowMs - SCRATCH_LEFT_AFTER_MS).toISOString()],
  )
  let opened = 0
  let resolved = 0
  for (const row of rows) {
    const clusterId = row.text('cluster_id')
    const wanted = drillFindings(
      {
        clusterId,
        cadenceDays: row.intOrNull('cadence_days'),
        lastPassedAt: row.dateOrNull('last_passed_at'),
        lastFailedAfterPass: row.textOrNull('newest_outcome') === 'failed',
        scratchLeft: row.int('scratch_left'),
      },
      nowMs,
    )
    for (const w of wanted) {
      const { rows: inserted } = await tx.query(
        'backups.findings.drill_open',
        `INSERT INTO observation.subject_findings
           (finding_id, cluster_id, kind, code, severity, dedup_key, summary, details, state,
            occurrences, first_seen_at, last_seen_at)
         VALUES ($1, $2, 'backup', $3, $4, $3, $5, $6, 'open', 1, now(), now())
         ON CONFLICT (cluster_id, kind, dedup_key) WHERE state = 'open' AND cluster_id IS NOT NULL
         DO UPDATE SET occurrences = observation.subject_findings.occurrences + 1, severity = EXCLUDED.severity,
                       summary = EXCLUDED.summary, details = EXCLUDED.details, last_seen_at = now()
         RETURNING (xmax = 0) AS fresh`,
        [newId('fnd', nowMs), clusterId, w.code, w.severity, w.summary, JSON.stringify(w.details)],
      )
      if (inserted[0]?.bool('fresh') === true) opened++
    }
    const keep = wanted.map((w) => w.code)
    const { rows: cleared } = await tx.query(
      'backups.findings.drill_resolve',
      `UPDATE observation.subject_findings SET state = 'resolved', resolution = 'cleared', resolved_at = now()
        WHERE cluster_id = $1 AND kind = 'backup' AND state = 'open'
          AND code = ANY($2::text[]) AND NOT (code = ANY($3::text[]))
       RETURNING finding_id`,
      [clusterId, [...CODES], keep],
    )
    resolved += cleared.length
  }
  return { clusters: rows.length, opened, resolved }
}

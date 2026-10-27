import type { BackupDependency } from '@exponetdb/contracts'
import type { Queryable } from '@exponetdb/control-store'
import type { BackupBindings, BackupBindingsPort } from '@exponetdb/registry'

/**
 * What the backup domain binds to a server or a cluster, for its retirement
 * (registry.md §4.4; the port the UI/UX session's `#42` left for Wave 9,
 * `PRE-WAVE-11-REVIEW.md` U9 and W9-07). Answers with ExponetDB ids and
 * states only: never a bucket, a prefix, an endpoint or a key.
 *
 * - `blocking`: a repository that is not retired (its PITR chain, lock
 *   retention and offline-recovery obligations live as long as it does), an
 *   engine run that is not over, a restore that is not discarded.
 * - `unknown`: the backup records could not be read; it blocks like
 *   `blocking` (fail closed), never "nothing depends on it".
 * - `none`: the records were read and hold nothing for the subject.
 *
 * Retiring the registry record never deletes anything in storage or on the
 * host; a repository leaves ExponetDB by its own retirement operation
 * (`backup.repository.retire`), which keeps its catalog, runs, restores and
 * drills as history. The Control Store guard `clusters_backup_obligations`
 * (bundle `backup-catalog`) decides again under the row lock.
 */
export interface BackupDependencyReport {
  readonly state: Exclude<BackupBindings, 'not_installed'>
  readonly dependencies: readonly BackupDependency[]
  /** How many there are in all; `dependencies` names at most `DEPENDENCY_LIMIT`. */
  readonly total: number
}

export const DEPENDENCY_LIMIT = 50

export async function backupDependencies(
  q: Queryable,
  subject: { readonly kind: 'server' | 'cluster'; readonly id: string },
): Promise<BackupDependencyReport> {
  try {
    const clusters =
      subject.kind === 'cluster'
        ? 'SELECT $1::text AS cluster_id'
        : 'SELECT cluster_id FROM registry.clusters WHERE server_id = $1'
    const { rows } = await q.query(
      'backups.dependencies',
      `WITH c AS (${clusters}),
            deps AS (
              SELECT 'repository'::text AS kind, r.repository_id AS id, r.state, 'repository_live'::text AS reason
                FROM backups.repositories r WHERE r.cluster_id IN (SELECT cluster_id FROM c) AND r.state <> 'retired'
              UNION ALL
              SELECT 'engine_run', x.run_id, x.state, 'run_not_over'
                FROM backups.runs x WHERE x.cluster_id IN (SELECT cluster_id FROM c)
                 AND x.state IN ('starting', 'running', 'unknown')
              UNION ALL
              SELECT 'restore', s.restore_id, s.state, 'restore_not_discarded'
                FROM backups.restores s WHERE s.cluster_id IN (SELECT cluster_id FROM c)
                 AND s.state NOT IN ('discarded', 'promoted')
              ${
                subject.kind === 'server'
                  ? `UNION ALL
              SELECT 'engine_run', x.run_id, x.state, 'run_not_over_on_node'
                FROM backups.runs x JOIN nodes.nodes n ON n.node_id = x.node_id
               WHERE n.server_id = $1 AND x.state IN ('starting', 'running', 'unknown')`
                  : ''
              }
            )
       SELECT DISTINCT ON (kind, id) kind, id, state, reason, (SELECT count(DISTINCT (kind, id)) FROM deps)::int AS total
         FROM deps ORDER BY kind, id LIMIT ${DEPENDENCY_LIMIT}`,
      [subject.id],
    )
    const total = rows[0]?.int('total') ?? 0
    const dependencies = rows.map((row) => ({
      kind: row.text('kind') as BackupDependency['kind'],
      id: row.text('id'),
      state: row.text('state'),
      reason: row.text('reason'),
    }))
    return { state: total === 0 ? 'none' : 'blocking', dependencies, total }
  } catch {
    // The records could not be read: never "nothing binds it".
    return {
      state: 'unknown',
      dependencies: [
        { kind: 'unreadable', id: null, state: 'unknown', reason: 'backup_records_unreadable' },
      ],
      total: 1,
    }
  }
}

/** The `BackupBindingsPort` of the registry (`RegistryKindDeps.backupBindings`, the preflight, the planners). */
export const backupBindings: BackupBindingsPort = async (q, subject) =>
  (await backupDependencies(q, subject)).state

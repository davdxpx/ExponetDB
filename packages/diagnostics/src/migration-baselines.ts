import { findTarget } from '@exponetdb/registry'
import {
  currentBaseline,
  insertBaseline,
  observeSchema,
  persistSnapshot,
  projectScope,
  type SnapshotDeps,
} from './snapshots.ts'

/**
 * The expected schema after a verified migration (drift-detection.md §7,
 * Wave 6): the last verified `fingerprint_after` supersedes the
 * registration baseline. The worker takes a snapshot with the project's
 * managed scope once the migration's verification passed and records it as
 * the target's baseline, but only when it is complete and has exactly the
 * fingerprint the verification saw: a schema that changed in between is not
 * adopted, so the next drift check still reports it.
 *
 * Nor is a change made outside the migrations before this one adopted
 * (TC-006): when the caller names the fingerprint the migration started from
 * and the target's baseline is another, the schema had drifted already, so
 * the baseline and the open findings stay (`drift_open`) until someone
 * accepts the drift (`drift.accept`). The migration's own change then shows as
 * drift too, with the rest, which is what a person decides on.
 */
export type MigrationBaselineOutcome =
  | 'recorded'
  | 'differs'
  | 'incomplete'
  | 'stale'
  | 'drift_open'

export class MigrationBaselineStore {
  readonly #deps: SnapshotDeps

  constructor(deps: SnapshotDeps) {
    this.#deps = deps
  }

  async record(input: {
    readonly targetId: string
    readonly generation: number
    readonly operationId: string
    readonly fingerprint: string
    /**
     * The fingerprint the migration started from. Left out by a baseline that
     * adopts a schema as it is (the legacy import): nothing to compare.
     */
    readonly preFingerprint?: string
  }): Promise<MigrationBaselineOutcome> {
    const target = await findTarget(this.#deps.store, input.targetId)
    if (target === undefined || target.generation !== input.generation) return 'stale'
    if (input.preFingerprint !== undefined) {
      const baseline = await currentBaseline(this.#deps.store, target)
      if (baseline !== undefined && baseline.fingerprint !== input.preFingerprint) {
        return 'drift_open'
      }
    }
    const scope = await projectScope(this.#deps.store, target)
    const snapshot = await observeSchema(this.#deps, target, 'migration', scope)
    if (!snapshot.complete) return 'incomplete'
    if (snapshot.fingerprint !== input.fingerprint) return 'differs'
    return this.#deps.store.transaction('observation.migration_baseline', async (tx) => {
      const stored = await persistSnapshot(tx, target, snapshot, 'migration', input.operationId)
      await insertBaseline(tx, stored, 'migration', input.operationId)
      return 'recorded' as const
    })
  }
}

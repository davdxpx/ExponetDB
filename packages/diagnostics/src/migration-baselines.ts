import { findTarget } from '@exponetdb/registry'
import {
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
 */
export type MigrationBaselineOutcome = 'recorded' | 'differs' | 'incomplete' | 'stale'

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
  }): Promise<MigrationBaselineOutcome> {
    const target = await findTarget(this.#deps.store, input.targetId)
    if (target === undefined || target.generation !== input.generation) return 'stale'
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

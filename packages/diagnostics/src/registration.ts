import { findTarget, type RegistrationSnapshots } from '@exponetdb/registry'
import { DiagnosticsError } from './errors.ts'
import {
  insertBaseline,
  observeSchema,
  persistSnapshot,
  projectScope,
  registrationSnapshotOf,
  type SnapshotDeps,
} from './snapshots.ts'

/**
 * The registration snapshot (registry.md §2.3 step 4, order §138): taken by
 * the worker after the identity read-back and before activation, with the
 * project's managed scope. A complete snapshot becomes the target's
 * registration baseline in the same transaction; an incomplete one is
 * stored without a baseline, so drift checks report `no_baseline` instead
 * of trusting a partial view.
 */
export class RegistrationSnapshotStore implements RegistrationSnapshots {
  readonly #deps: SnapshotDeps

  constructor(deps: SnapshotDeps) {
    this.#deps = deps
  }

  async capture(input: {
    readonly targetId: string
    readonly generation: number
    readonly operationId: string
  }): Promise<{
    readonly snapshotId: string
    readonly fingerprint: string
    readonly complete: boolean
    readonly baseline: boolean
  }> {
    const target = await findTarget(this.#deps.store, input.targetId)
    if (target === undefined || target.generation !== input.generation) {
      throw new DiagnosticsError('TARGET_NOT_FOUND')
    }
    const scope = await projectScope(this.#deps.store, target)
    const snapshot = await observeSchema(this.#deps, target, 'registration', scope)
    return this.#deps.store.transaction('observation.registration_snapshot', async (tx) => {
      const stored = await persistSnapshot(tx, target, snapshot, 'registration', input.operationId)
      if (stored.complete) {
        await insertBaseline(tx, stored, 'registration', input.operationId)
      }
      return {
        snapshotId: stored.snapshotId,
        fingerprint: stored.fingerprint,
        complete: stored.complete,
        baseline: stored.complete,
      }
    })
  }

  async ofOperation(operationId: string): Promise<{ readonly snapshotId: string } | undefined> {
    const stored = await registrationSnapshotOf(this.#deps.store, operationId)
    return stored === undefined ? undefined : { snapshotId: stored.snapshotId }
  }
}

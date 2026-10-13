import {
  type BoundedVerification,
  chainHead,
  exportSinks,
  latestCheckpoints,
  verifyChainBounded,
} from '@exponetdb/audit'
import type { AuditChain } from '@exponetdb/contracts'
import { type ControlStore, type TaskState, taskStates } from '@exponetdb/control-store'
import type { Clock } from '@exponetdb/kernel'

/**
 * `GET /audit-events/chain` (audit.md §4; Wave 8 order §9): the head and the
 * newest checkpoints of the chain, the export state per exporter (kind and
 * progress, never a bucket, path or endpoint) and a verification computed on
 * this request, incrementally from the latest checkpoint, read-only in one
 * repeatable-read transaction (`verifyChainBounded`).
 *
 * The work is bounded: with more events since the latest checkpoint than the
 * bound, nothing is walked and the answer is `not_verified`. Polling cannot
 * make the server verify without end: a repeat at the same head and checkpoint
 * within `REUSE_MS` returns the result already computed, with the time it was
 * computed at, and concurrent requests share one run. A full verification is
 * the worker's daily task; the sequence and time it covered are not stored,
 * only the outcome of the task, which this read shows.
 */
const REUSE_MS = 15_000
const CHECKPOINTS_SHOWN = 10

type Run = NonNullable<AuditChain['exports']['task']>
type Verification = AuditChain['verification']

function runOf(t: TaskState | undefined): Run | null {
  return t === undefined
    ? null
    : {
        outcome: t.lastOutcome,
        reason: t.lastReason,
        finishedAt: t.lastFinishedAt?.toISOString() ?? null,
        consecutiveFailures: t.consecutiveFailures,
        nextRunAt: t.nextRunAt.toISOString(),
      }
}

function verificationOf(result: BoundedVerification, verifiedAt: string): Verification {
  switch (result.status) {
    case 'verified':
      return { ...result, verifiedAt }
    case 'broken':
      return { ...result, verifiedAt }
    case 'not_verified':
      return result
  }
}

export class AuditChainReader {
  readonly #store: ControlStore
  readonly #clock: Clock
  #recent:
    | { readonly key: string; readonly at: number; readonly value: Promise<Verification> }
    | undefined

  constructor(store: ControlStore, clock: Clock) {
    this.#store = store
    this.#clock = clock
  }

  async #verification(headSeq: number | null, checkpointSeq: number | null): Promise<Verification> {
    const now = this.#clock.nowMs()
    const key = `${headSeq ?? 'none'}:${checkpointSeq ?? 'none'}`
    const recent = this.#recent
    if (recent !== undefined && recent.key === key && now - recent.at < REUSE_MS) {
      return recent.value
    }
    const value = verifyChainBounded(this.#store).then((result) =>
      verificationOf(result, new Date(this.#clock.nowMs()).toISOString()),
    )
    this.#recent = { key, at: now, value }
    // A failed run is not reused.
    value.catch(() => {
      if (this.#recent?.value === value) this.#recent = undefined
    })
    return value
  }

  async read(): Promise<AuditChain> {
    const head = await chainHead(this.#store)
    const checkpoints = await latestCheckpoints(this.#store, CHECKPOINTS_SHOWN)
    const sinks = await exportSinks(this.#store)
    const tasks = await taskStates(this.#store)
    const verification = await this.#verification(head?.seq ?? null, checkpoints[0]?.seq ?? null)
    const byName = (name: string) => tasks.find((t) => t.task === name)
    return {
      head:
        head === null
          ? null
          : { seq: head.seq, occurredAt: head.occurredAt.toISOString(), hash: head.hash as never },
      checkpoints: checkpoints.map((c) => ({
        seq: c.seq,
        hash: c.hash as never,
        createdAt: c.createdAt.toISOString(),
        reason: c.reason,
      })),
      exports: {
        sinks: sinks.map((s) => ({
          kind: s.kind,
          state: s.pendingCheckpoints === 0 ? 'up_to_date' : 'behind',
          lastExportedSeq: s.lastExportedSeq,
          lastExportedAt: s.lastExportedAt?.toISOString() ?? null,
          pendingCheckpoints: s.pendingCheckpoints,
        })),
        task: runOf(byName('audit.export')),
      },
      verification,
      workerVerification: {
        runsIn: 'worker',
        resultPersisted: false,
        incremental: runOf(byName('audit.verify_incremental')),
        full: runOf(byName('audit.verify_full')),
      },
      source: 'live',
      observedAt: new Date(this.#clock.nowMs()).toISOString(),
    }
  }
}

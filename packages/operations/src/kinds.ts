import type { Tx } from '@exponetdb/control-store'
import type { JsonObject } from '@exponetdb/kernel'
import type { ChangedBinding } from './errors.ts'
import type { PlanRecord } from './plans.ts'

/**
 * Operation kinds ([operations-engine.md §2](../../../exponetdb-docs/02-control-plane/operations-engine.md#2-operation-kinds)).
 * One engine, pluggable kinds: plan binding, staleness, idempotency, leases,
 * exclusivity, reconciliation and audit are implemented once here; a kind
 * supplies only its domain work. Wave 2 registers no product kinds; tests
 * register synthetic ones.
 *
 * Outcomes are reported, never inferred: `execute` says what it knows
 * (`unknown` when it cannot tell, for example after a lost connection), and
 * the engine never calls `execute` twice for one operation.
 */
export interface ExecutionContext {
  readonly plan: PlanRecord
  readonly operationId: string
  /** Aborted when the worker loses its lease; the kind stops starting new steps. */
  readonly signal: AbortSignal
  /**
   * The worker holding the operation's lease: a step that starts work outside
   * the Control Store, or writes a change, checks in its own transaction that
   * this worker still holds it ({@link leaseHeld}), so an executor that lost
   * the lease starts and writes nothing. Always set (Wave 5 correction F3):
   * a missing owner is never a pass.
   */
  readonly leaseOwner: string
  /**
   * The dispatch admission again, in the caller's transaction (correction
   * review of F2): a kind that starts an effect long after the operation
   * started (an apply job after its reads) checks in the transaction that
   * creates it that the policy, the live tier and the approvals still hold.
   * Unset when the worker has no admission (no rule needs one).
   */
  readonly readmit?: (tx: Tx) => Promise<readonly ChangedBinding[]>
  /**
   * Set on the verify step an operator asked for (needs_attention to
   * verifying): the kind verifies again what errored or never finished. A
   * kind's own verify step after its execution never repeats a verification
   * that already ran.
   */
  readonly verificationRetry?: boolean
}

/**
 * What `execute` reports. A refusal that changed nothing may name its
 * catalog code (and safe, structured detail) so the operation shows why
 * it failed, e.g. `TARGET_REGISTRATION_REFUSED` with the reason.
 */
export type ExecutionOutcome =
  | 'applied'
  | 'not_applied'
  | 'partially_applied'
  | 'unknown'
  | {
      readonly outcome: 'not_applied'
      readonly errorCode: string
      readonly detail?: JsonObject
    }

export interface OperationKind {
  readonly kind: string
  readonly version: number
  readonly actionClass: 'low' | 'standard' | 'high' | 'critical'
  /** Whether the kind has a verification step; without one, verification is `not_applicable`. */
  readonly verifies: boolean
  /** Exclusivity domains held from `running` until the operation finishes. */
  exclusivity(plan: PlanRecord): readonly string[]
  /**
   * Operations in `needs_attention` that this operation's plan names as the
   * ones it recovers (the plan binds them; TC-005). One that holds a domain
   * this operation needs is closed, in the transaction that takes the domains
   * ([`supersede.ts`](./supersede.ts)); nothing else is touched.
   */
  supersedes?(plan: PlanRecord): readonly string[]
  /** Kind-specific bindings, checked at acceptance and again under the locks. */
  checkBindings(plan: PlanRecord): Promise<readonly ChangedBinding[]>
  execute(ctx: ExecutionContext): Promise<ExecutionOutcome>
  verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'>
  /** After a lost worker: what really happened? Never re-executes. */
  reconcile(ctx: ExecutionContext): Promise<'applied' | 'not_applied' | 'unknown'>
  /** Optional summary of the plan content for audit `changes` (never secrets, never SQL text). */
  auditSummary?(plan: PlanRecord): JsonObject
}

export class KindRegistry {
  readonly #kinds = new Map<string, OperationKind>()

  constructor(kinds: readonly OperationKind[] = []) {
    for (const k of kinds) {
      if (this.#kinds.has(k.kind)) {
        throw new Error(`operation kind ${k.kind} registered twice`)
      }
      this.#kinds.set(k.kind, k)
    }
  }

  get(kind: string): OperationKind | undefined {
    return this.#kinds.get(kind)
  }

  names(): readonly string[] {
    return [...this.#kinds.keys()].sort()
  }
}

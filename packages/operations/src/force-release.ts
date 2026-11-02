import type { Queryable } from '@exponetdb/control-store'
import { isJsonArray, isJsonObject, type JsonObject } from '@exponetdb/kernel'
import type { ChangedBinding } from './errors.ts'
import type { ExecutionContext, OperationKind } from './kinds.ts'
import type { PlanRecord } from './plans.ts'

/**
 * `operation.force_release` (VC-006, VC-055, VC-007,
 * [operations-engine.md §4.1](../../../exponetdb-docs/02-control-plane/operations-engine.md#41-state-machine)):
 * the exit of `needs_attention` for an operation of any kind, which no retry
 * and no recovery plan covers or whose outcome stayed `unknown`. A person
 * plans it naming the operation, what happened to its change and why; the
 * plan takes the domains the operation holds and names it (`supersedes`), so
 * the worker closes it in the transaction that takes them (supersede.ts),
 * with the stated outcome. Nothing of the closed operation runs again; this
 * operation itself does nothing more, and verifies that the operation is
 * finished.
 */
export const FORCE_RELEASE_KIND = 'operation.force_release'

export type AssertedOutcome = 'applied' | 'not_applied' | 'unknown'

export interface ForceReleaseContent {
  readonly operationId: string
  readonly outcome: AssertedOutcome
  readonly reason: string
  /** The domains the operation held when the plan was made. */
  readonly domains: readonly string[]
}

export function forceReleaseContent(plan: PlanRecord): ForceReleaseContent | undefined {
  const c = plan.body['content']
  if (!isJsonObject(c)) return undefined
  const { operationId, outcome, reason, domains } = c
  if (
    typeof operationId !== 'string' ||
    (outcome !== 'applied' && outcome !== 'not_applied' && outcome !== 'unknown') ||
    typeof reason !== 'string' ||
    !isJsonArray(domains) ||
    !domains.every((d) => typeof d === 'string')
  ) {
    return undefined
  }
  return { operationId, outcome, reason, domains: domains as string[] }
}

const STATE = 'SELECT state FROM operations.operations WHERE operation_id = $1'

export class ForceReleaseKind implements OperationKind {
  readonly kind = FORCE_RELEASE_KIND
  readonly version = 1
  readonly actionClass = 'high' as const
  readonly verifies = true
  readonly #store: Queryable

  /** `store` reads on its own connection: the close in the dispatch transaction is not seen yet. */
  constructor(store: Queryable) {
    this.#store = store
  }

  exclusivity(plan: PlanRecord): readonly string[] {
    return forceReleaseContent(plan)?.domains ?? []
  }

  supersedes(plan: PlanRecord): readonly string[] {
    const c = forceReleaseContent(plan)
    return c === undefined ? [] : [c.operationId]
  }

  supersedeOutcome(plan: PlanRecord): AssertedOutcome | undefined {
    return forceReleaseContent(plan)?.outcome
  }

  async checkBindings(plan: PlanRecord): Promise<readonly ChangedBinding[]> {
    const c = forceReleaseContent(plan)
    if (c === undefined) return [{ binding: 'content', actual: 'invalid' }]
    const state = (await this.#store.query('operations.release.state', STATE, [c.operationId]))
      .rows[0]
    const actual = state?.text('state') ?? 'missing'
    return actual === 'needs_attention' ? [] : [{ binding: 'operation', actual }]
  }

  async execute(): Promise<'applied'> {
    // The operation was closed when this one took its domains; there is nothing else to do.
    return 'applied'
  }

  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed'> {
    return (await this.#closed(ctx.plan)) ? 'passed' : 'failed'
  }

  async reconcile(ctx: ExecutionContext): Promise<'applied' | 'unknown'> {
    return (await this.#closed(ctx.plan)) ? 'applied' : 'unknown'
  }

  auditSummary(plan: PlanRecord): JsonObject {
    const c = forceReleaseContent(plan)
    return c === undefined ? {} : { releasedOperationId: c.operationId, outcome: c.outcome }
  }

  async #closed(plan: PlanRecord): Promise<boolean> {
    const c = forceReleaseContent(plan)
    if (c === undefined) return false
    const state = (await this.#store.query('operations.release.state', STATE, [c.operationId]))
      .rows[0]
    return ['failed', 'verification_failed'].includes(state?.text('state') ?? '')
  }
}

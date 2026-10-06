import { appendAuditEvent } from '@exponetdb/audit'
import { type ControlStore, ControlStoreError, type Tx } from '@exponetdb/control-store'
import { type Clock, isId, type JsonObject } from '@exponetdb/kernel'
import {
  type ChangedBinding,
  type ExecutionContext,
  type ExecutionOutcome,
  type OperationKind,
  type PlanRecord,
  WORKER_ACTOR,
} from '@exponetdb/operations'
import { TargetError } from '@exponetdb/postgres'
import type { Connector } from './connect.ts'
import { Body, ContentInvalid } from './content.ts'
import { RegistryError } from './errors.ts'

/**
 * Registry operation kinds ([operations-engine.md §2](../../../exponetdb-docs/02-control-plane/operations-engine.md#2-operation-kinds)),
 * executed by the worker from a stored plan. Each one re-checks the plan's
 * expected state (`checkBindings`, at acceptance and again under the
 * locks), writes the Control Store in one transaction with its audit event,
 * verifies what it wrote (rows carry the operation id) and reconciles by
 * reading, never by executing again. A Control Store guard that refuses
 * (`EX…`, a unique or foreign key violation) means nothing was applied.
 *
 * Only `target.register` writes to a managed database (`register.ts`).
 */
export interface RegistryKindDeps {
  /** The worker's Control Store login. */
  readonly store: ControlStore
  readonly clock: Clock
  /** The worker's connector (it can read every role's secret). */
  readonly connector: Connector
  readonly installationId: string
  readonly controlStoreSystemIdentifier: () => Promise<string>
  /** Takes and stores the registration snapshot (diagnostics); see `register.ts`. */
  readonly snapshots: RegistrationSnapshots
}

/**
 * The registration snapshot port: diagnostics owns schema documents,
 * snapshots and baselines; the registry asks it, after the identity read-back
 * and before activation, to snapshot the target as the observer and to store
 * the snapshot (with a registration baseline when it is complete).
 */
export interface RegistrationSnapshots {
  capture(input: {
    readonly targetId: string
    readonly generation: number
    readonly operationId: string
  }): Promise<{
    readonly snapshotId: string
    readonly fingerprint: string
    readonly complete: boolean
    readonly baseline: boolean
  }>
  /** The registration snapshot this operation stored, if any. */
  ofOperation(operationId: string): Promise<{ readonly snapshotId: string } | undefined>
}

const sqlstate = (error: unknown) =>
  error instanceof ControlStoreError ? error.sqlstate : undefined

export abstract class RegistryKind implements OperationKind {
  abstract readonly kind: string
  readonly version = 1
  abstract readonly actionClass: 'standard' | 'high' | 'critical'
  readonly verifies = true
  protected readonly deps: RegistryKindDeps

  constructor(deps: RegistryKindDeps) {
    this.deps = deps
  }

  /** Registry changes serialize on the rows they touch; no exclusivity domain by default. */
  exclusivity(_plan: PlanRecord): readonly string[] {
    return []
  }

  abstract bindings(plan: PlanRecord, content: Body, expected: Body): Promise<ChangedBinding[]>
  abstract run(ctx: ExecutionContext, content: Body): Promise<ExecutionOutcome>
  abstract check(ctx: ExecutionContext, content: Body): Promise<boolean>
  abstract applied(ctx: ExecutionContext, content: Body): Promise<boolean>

  async checkBindings(plan: PlanRecord): Promise<readonly ChangedBinding[]> {
    try {
      return await this.bindings(plan, Body.content(plan), Body.expected(plan))
    } catch (error) {
      if (error instanceof ContentInvalid) {
        return [{ binding: 'content', actual: 'invalid' }]
      }
      throw error
    }
  }

  async execute(ctx: ExecutionContext): Promise<ExecutionOutcome> {
    let content: Body
    try {
      content = Body.content(ctx.plan)
    } catch {
      return 'not_applied'
    }
    return this.run(ctx, content)
  }

  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    return (await this.check(ctx, Body.content(ctx.plan))) ? 'passed' : 'failed'
  }

  async reconcile(ctx: ExecutionContext): Promise<'applied' | 'not_applied' | 'unknown'> {
    return (await this.applied(ctx, Body.content(ctx.plan))) ? 'applied' : 'not_applied'
  }

  protected async audit(
    tx: Tx,
    ctx: ExecutionContext,
    changes: JsonObject,
    subject: {
      readonly targetId?: string
      readonly targetPath?: string
      readonly tier?: 'prod' | 'nonprod'
      readonly clusterId?: string
      readonly serverId?: string
    } = {},
  ): Promise<void> {
    if (!isId('op', ctx.operationId)) {
      throw new RegistryError('INTERNAL')
    }
    const typedSubject: Record<string, string> = {}
    for (const [key, value] of Object.entries(subject)) {
      if (value !== undefined) typedSubject[key] = value
    }
    await appendAuditEvent(
      tx,
      {
        action: this.kind,
        phase: 'completed',
        actor: { kind: 'system', identityId: null, label: WORKER_ACTOR.label },
        ...(Object.keys(typedSubject).length === 0 ? {} : { subject: typedSubject as never }),
        refs: {
          operationId: ctx.operationId,
          planId: ctx.plan.planId,
          planHash: ctx.plan.planHash,
        },
        changes: { ...changes },
        result: { status: 'succeeded', applyOutcome: 'applied' },
      },
      { clock: this.deps.clock },
    )
  }

  /** One Control Store transaction; a guard refusal is "not applied", a lost connection is unknown. */
  protected async effect(
    fn: (tx: Tx) => Promise<boolean>,
  ): Promise<'applied' | 'not_applied' | 'unknown'> {
    try {
      const applied = await this.deps.store.transaction(`registry.kind.${this.kind}`, fn)
      return applied ? 'applied' : 'not_applied'
    } catch (error) {
      const state = sqlstate(error)
      if (
        state !== undefined &&
        (state.startsWith('EX') || state === '23505' || state === '23503')
      ) {
        return 'not_applied'
      }
      return 'unknown'
    }
  }

  protected async exists(
    queryClass: string,
    sql: string,
    params: readonly unknown[],
  ): Promise<boolean> {
    const { rows } = await this.deps.store.query(queryClass, sql, params)
    return rows.length > 0
  }
}

/** The catalog code of a failure from the target side, for a refused execution. */
export function refusalOf(error: unknown): ExecutionOutcome {
  if (error instanceof RegistryError) {
    const reason = error.details?.['reason']
    return {
      outcome: 'not_applied',
      errorCode: error.code,
      ...(typeof reason === 'string' ? { detail: { reason } } : {}),
    }
  }
  if (
    error instanceof TargetError &&
    /^[A-Z][A-Z_]+$/.test(error.code) &&
    error.code !== 'TARGET_SQL_ERROR'
  ) {
    return { outcome: 'not_applied', errorCode: error.code, detail: { reason: error.reason } }
  }
  return 'not_applied'
}

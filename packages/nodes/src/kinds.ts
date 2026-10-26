import { appendAuditEvent } from '@exponetdb/audit'
import { type ControlStore, ControlStoreError, type Tx } from '@exponetdb/control-store'
import { type Clock, isId, type JsonObject } from '@exponetdb/kernel'
import {
  type ChangedBinding,
  type ExecutionContext,
  type ExecutionOutcome,
  leaseHeld,
  type OperationKind,
  type PlanRecord,
  WORKER_ACTOR,
} from '@exponetdb/operations'
import { Body, ContentInvalid } from '@exponetdb/registry'
import { subjectOf } from './binding.ts'
import { NodeError } from './errors.ts'
import { DECOMMISSIONABLE, nodeState, REVOCABLE, serverEnrollment } from './plans.ts'
import { createEnrollmentToken } from './tokens.ts'

/**
 * The node operation kinds, executed by the worker from a stored plan
 * ([operations-engine.md §2](../../../exponetdb-docs/02-control-plane/operations-engine.md#2-operation-kinds),
 * [control-plane.md §4, §6](../../../exponetdb-docs/07-node-agent/control-plane.md)).
 * Each writes the Control Store in one transaction with its audit event,
 * verifies what it wrote and reconciles by reading, never by executing again;
 * a guard refusal means nothing was applied.
 */

export interface NodeKindDeps {
  /** The worker's Control Store login. */
  readonly store: ControlStore
  readonly clock: Clock
}

abstract class NodeKind implements OperationKind {
  abstract readonly kind: 'node.enroll' | 'node.revoke' | 'node.decommission'
  readonly version = 1
  readonly actionClass = 'high' as const
  readonly verifies = true
  protected readonly deps: NodeKindDeps

  constructor(deps: NodeKindDeps) {
    this.deps = deps
  }

  exclusivity(_plan: PlanRecord): readonly string[] {
    return []
  }

  protected abstract bindings(content: Body, expected: Body): Promise<ChangedBinding[]>
  protected abstract run(tx: Tx, ctx: ExecutionContext, content: Body): Promise<boolean>
  protected abstract done(ctx: ExecutionContext, content: Body): Promise<boolean>

  async checkBindings(plan: PlanRecord): Promise<readonly ChangedBinding[]> {
    try {
      return await this.bindings(Body.content(plan), Body.expected(plan))
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
    if (ctx.signal.aborted) {
      return 'not_applied'
    }
    try {
      const applied = await this.deps.store.transaction(`nodes.kind.${this.kind}`, async (tx) => {
        // Fenced (Wave 5 correction F3): the change is written only while
        // this worker still holds the lease, checked in the transaction that
        // writes it (`FOR SHARE`: a takeover waits for it). A worker that lost
        // the lease writes nothing; its successor reconciles from what is there.
        if (ctx.signal.aborted || !(await leaseHeld(tx, ctx.operationId, ctx.leaseOwner))) {
          return false
        }
        return this.run(tx, ctx, content)
      })
      return applied ? 'applied' : 'not_applied'
    } catch (error) {
      const state = error instanceof ControlStoreError ? error.sqlstate : undefined
      if (
        state !== undefined &&
        (state.startsWith('EX') || state === '23505' || state === '23503')
      ) {
        return 'not_applied'
      }
      if (error instanceof NodeError) {
        return { outcome: 'not_applied', errorCode: error.code }
      }
      return 'unknown'
    }
  }

  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    return (await this.done(ctx, Body.content(ctx.plan))) ? 'passed' : 'failed'
  }

  async reconcile(ctx: ExecutionContext): Promise<'applied' | 'not_applied' | 'unknown'> {
    return (await this.done(ctx, Body.content(ctx.plan))) ? 'applied' : 'not_applied'
  }

  protected async audit(
    tx: Tx,
    ctx: ExecutionContext,
    changes: JsonObject,
    subject: { readonly serverId: string; readonly nodeId?: string },
  ): Promise<void> {
    if (!isId('op', ctx.operationId) || !isId('srv', subject.serverId)) {
      throw new NodeError('INTERNAL')
    }
    await appendAuditEvent(
      tx,
      {
        action: this.kind,
        phase: 'completed',
        actor: { kind: 'system', identityId: null, label: WORKER_ACTOR.label },
        subject:
          subject.nodeId === undefined
            ? { serverId: subject.serverId }
            : subjectOf(subject.nodeId, subject.serverId),
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
}

/**
 * `node.enroll`: the token record (no secret) for the server, revealable by
 * the identity that made and applied the plan (control-plane.md §4).
 */
export class NodeEnrollKind extends NodeKind {
  readonly kind = 'node.enroll' as const

  protected async bindings(content: Body): Promise<ChangedBinding[]> {
    const server = await serverEnrollment(this.deps.store, content.id('srv', 'serverId'))
    if (!server.exists) {
      return [{ binding: 'server', expected: 'exists', actual: 'missing' }]
    }
    if (server.retired) {
      return [{ binding: 'server', expected: 'active', actual: 'retired' }]
    }
    return server.liveNode ? [{ binding: 'node', expected: 'none', actual: 'enrolled' }] : []
  }

  protected async run(tx: Tx, ctx: ExecutionContext, content: Body): Promise<boolean> {
    const identityId = ctx.plan.actor.identityId
    if (identityId === null || !isId('idn', identityId)) {
      throw new NodeError('INTERNAL')
    }
    const serverId = content.id('srv', 'serverId')
    const tokenId = content.id('ent', 'tokenId')
    await createEnrollmentToken(tx, this.deps.clock, {
      tokenId,
      serverId,
      revealBy: identityId,
      operationId: ctx.operationId,
    })
    await this.audit(tx, ctx, { tokenId }, { serverId })
    return true
  }

  protected async done(ctx: ExecutionContext, content: Body): Promise<boolean> {
    const { rows } = await this.deps.store.query(
      'nodes.kind.enroll.check',
      'SELECT 1 FROM nodes.enrollment_tokens WHERE token_id = $1 AND created_by_operation_id = $2',
      [content.id('ent', 'tokenId'), ctx.operationId],
    )
    return rows.length > 0
  }
}

/** Revocation and decommissioning: the node's state, its waiting jobs canceled. */
class NodeStateKind extends NodeKind {
  readonly kind: 'node.revoke' | 'node.decommission'
  readonly #to: 'revoked' | 'decommissioned'
  readonly #from: readonly string[]

  constructor(deps: NodeKindDeps, kind: 'node.revoke' | 'node.decommission') {
    super(deps)
    this.kind = kind
    this.#to = kind === 'node.revoke' ? 'revoked' : 'decommissioned'
    this.#from = kind === 'node.revoke' ? REVOCABLE : DECOMMISSIONABLE
  }

  protected async bindings(content: Body, expected: Body): Promise<ChangedBinding[]> {
    const node = await nodeState(this.deps.store, content.id('nod', 'nodeId'))
    const want = expected.text('state')
    if (node === undefined) {
      return [{ binding: 'node', expected: want, actual: 'missing' }]
    }
    return node.state === want
      ? []
      : [{ binding: 'node_state', expected: want, actual: node.state }]
  }

  protected async run(tx: Tx, ctx: ExecutionContext, content: Body): Promise<boolean> {
    const nodeId = content.id('nod', 'nodeId')
    // The write's predicate is the state the plan was bound to, under the
    // row lock the UPDATE takes: a node that changed since does not move.
    const expected = Body.expected(ctx.plan).text('state')
    const updated = await tx.query(
      `nodes.kind.${this.#to}`,
      `UPDATE nodes.nodes SET state = $2, state_changed_by_operation_id = $3, state_reason = $4
        WHERE node_id = $1 AND state = $5 AND state = ANY($6::text[]) RETURNING server_id`,
      [nodeId, this.#to, ctx.operationId, this.#to, expected, [...this.#from]],
    )
    const serverId = updated.rows[0]?.text('server_id')
    if (serverId === undefined) {
      return false
    }
    // Waiting jobs never start. Revocation is an immediate cut-off: the node
    // can no longer report, so a running job is never asked to stop; it is
    // reconciled from its lease as outcome unknown, never assumed undone.
    const canceled = await tx.query(
      'nodes.kind.cancel_waiting',
      `UPDATE nodes.jobs SET state = 'canceled' WHERE node_id = $1 AND state IN ('pending', 'dispatched')`,
      [nodeId],
    )
    const running = await tx.query(
      'nodes.kind.running',
      `SELECT count(*)::int AS n FROM nodes.jobs WHERE node_id = $1 AND state = 'running'`,
      [nodeId],
    )
    await this.audit(
      tx,
      ctx,
      {
        state: this.#to,
        canceledJobs: canceled.rowCount,
        runningJobsLeftUnknown: running.rows[0]?.int('n') ?? 0,
      },
      { serverId, nodeId },
    )
    return true
  }

  protected async done(ctx: ExecutionContext, content: Body): Promise<boolean> {
    const { rows } = await this.deps.store.query(
      'nodes.kind.state.check',
      'SELECT 1 FROM nodes.nodes WHERE node_id = $1 AND state = $2 AND state_changed_by_operation_id = $3',
      [content.id('nod', 'nodeId'), this.#to, ctx.operationId],
    )
    return rows.length > 0
  }
}

export class NodeRevokeKind extends NodeStateKind {
  constructor(deps: NodeKindDeps) {
    super(deps, 'node.revoke')
  }
}

export class NodeDecommissionKind extends NodeStateKind {
  constructor(deps: NodeKindDeps) {
    super(deps, 'node.decommission')
  }
}

export function nodeKinds(deps: NodeKindDeps): OperationKind[] {
  return [new NodeEnrollKind(deps), new NodeRevokeKind(deps), new NodeDecommissionKind(deps)]
}

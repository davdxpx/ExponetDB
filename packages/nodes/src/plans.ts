import type { Queryable, Tx } from '@exponetdb/control-store'
import { type JsonObject, newId } from '@exponetdb/kernel'
import { createPlan, type PlanRecord, type PlanSubject } from '@exponetdb/operations'
import {
  evaluateRegistryPolicy,
  operationActor,
  type RegistryActor,
  type RegistryPolicyContext,
} from '@exponetdb/registry'
import { NodeError } from './errors.ts'

/**
 * Plans of the node operations ([control-plane.md §4, §6](../../../exponetdb-docs/07-node-agent/control-plane.md),
 * [enrollment.md §3, §5](../../../exponetdb-docs/07-node-agent/enrollment.md)):
 * `node.enroll` (a token record for a server, its id fixed in the plan),
 * `node.revoke` and `node.decommission`. All are high-class stored plans;
 * the action catalog requires re-authentication within 300 s at apply, and
 * the plan is bound to the state it was made against.
 */

export interface NodePlanContext {
  readonly policy: RegistryPolicyContext
}

/** Node states a revocation or decommissioning may start from. */
export const REVOCABLE = ['pending_binding', 'active', 'degraded'] as const
export const DECOMMISSIONABLE = ['pending_binding', 'active', 'degraded', 'revoked'] as const

async function store(
  tx: Tx,
  context: NodePlanContext,
  actor: RegistryActor,
  draft: {
    readonly kind: 'node.enroll' | 'node.revoke' | 'node.decommission'
    readonly subject: PlanSubject
    readonly content: JsonObject
    readonly expectedState: JsonObject
  },
): Promise<PlanRecord> {
  const policy = await evaluateRegistryPolicy(tx, context.policy, {
    kind: draft.kind,
    actor,
    subject: {},
    content: draft.content,
  })
  return createPlan(
    tx,
    {
      kind: draft.kind,
      kindVersion: 1,
      actionClass: 'high',
      actor: operationActor(actor),
      subject: draft.subject,
      content: draft.content,
      expectedState: draft.expectedState,
      policy,
    },
    { clock: context.policy.clock },
  )
}

/** Whether a server exists and whether it has a node that is not terminal (I-6). */
export async function serverEnrollment(
  q: Queryable,
  serverId: string,
): Promise<{ readonly exists: boolean; readonly liveNode: boolean }> {
  const { rows } = await q.query(
    'nodes.plan.server',
    `SELECT EXISTS (SELECT 1 FROM nodes.nodes n
                     WHERE n.server_id = s.server_id AND n.state IN ('pending_binding', 'active', 'degraded')) AS live
       FROM registry.servers s WHERE s.server_id = $1`,
    [serverId],
  )
  const row = rows[0]
  return { exists: row !== undefined, liveNode: row?.bool('live') ?? false }
}

/** `node.enroll` for a server without a live node. */
export async function planNodeEnroll(
  tx: Tx,
  context: NodePlanContext,
  actor: RegistryActor,
  serverId: string,
): Promise<PlanRecord> {
  const server = await serverEnrollment(tx, serverId)
  if (!server.exists) {
    throw new NodeError('NOT_FOUND')
  }
  if (server.liveNode) {
    throw new NodeError('NODE_ALREADY_ENROLLED')
  }
  const tokenId = newId('ent', context.policy.clock.nowMs())
  return store(tx, context, actor, {
    kind: 'node.enroll',
    subject: { serverId },
    content: { serverId, tokenId },
    expectedState: { liveNode: false },
  })
}

/** The node's server and state, for a plan or a binding check. */
export async function nodeState(
  q: Queryable,
  nodeId: string,
): Promise<{ readonly serverId: string; readonly state: string } | undefined> {
  const { rows } = await q.query(
    'nodes.plan.node',
    'SELECT server_id, state FROM nodes.nodes WHERE node_id = $1',
    [nodeId],
  )
  const row = rows[0]
  return row === undefined
    ? undefined
    : { serverId: row.text('server_id'), state: row.text('state') }
}

async function planStateChange(
  tx: Tx,
  context: NodePlanContext,
  actor: RegistryActor,
  nodeId: string,
  kind: 'node.revoke' | 'node.decommission',
  from: readonly string[],
): Promise<PlanRecord> {
  const node = await nodeState(tx, nodeId)
  if (node === undefined) {
    throw new NodeError('NOT_FOUND')
  }
  if (!from.includes(node.state)) {
    throw new NodeError('CONFLICT')
  }
  return store(tx, context, actor, {
    kind,
    subject: { serverId: node.serverId, nodeId },
    content: { nodeId },
    expectedState: { state: node.state },
  })
}

/** `node.revoke`: the node is refused at its next request; pending jobs are canceled. */
export function planNodeRevoke(
  tx: Tx,
  context: NodePlanContext,
  actor: RegistryActor,
  nodeId: string,
): Promise<PlanRecord> {
  return planStateChange(tx, context, actor, nodeId, 'node.revoke', REVOCABLE)
}

/** `node.decommission`: the node leaves for good; its server may enroll a new one. */
export function planNodeDecommission(
  tx: Tx,
  context: NodePlanContext,
  actor: RegistryActor,
  nodeId: string,
): Promise<PlanRecord> {
  return planStateChange(tx, context, actor, nodeId, 'node.decommission', DECOMMISSIONABLE)
}

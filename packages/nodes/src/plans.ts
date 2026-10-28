import type { Queryable, Tx } from '@exponetdb/control-store'
import { type JsonObject, newId } from '@exponetdb/kernel'
import {
  createPlan,
  type PlanRecord,
  type PlanSubject,
  TERMINAL_STATES,
} from '@exponetdb/operations'
import {
  evaluateRegistryPolicy,
  operationActor,
  type RegistryActor,
  type RegistryPolicyContext,
} from '@exponetdb/registry'
import { nodePolicySubject } from './capability-plans.ts'
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
    /** What the plan does and what depends on it, shown with the plan. */
    readonly analysis?: JsonObject
    /** The derived tier of the node's server, when it has one (the rules read it). */
    readonly tier?: 'prod' | 'nonprod'
  },
): Promise<PlanRecord> {
  const policy = await evaluateRegistryPolicy(tx, context.policy, {
    kind: draft.kind,
    actor,
    subject: draft.tier === undefined ? {} : { tier: draft.tier },
    content: draft.content,
  })
  return createPlan(
    tx,
    {
      kind: draft.kind,
      kindVersion: 1,
      actionClass: 'high',
      actor: operationActor(actor),
      subject: draft.tier === undefined ? draft.subject : { ...draft.subject, tier: draft.tier },
      content: draft.content,
      expectedState: draft.expectedState,
      ...(draft.analysis === undefined ? {} : { analysis: draft.analysis }),
      policy,
    },
    { clock: context.policy.clock },
  )
}

/**
 * Whether a server exists, whether it is retired (registry.md §4.4: a retired server gets no
 * node) and whether it has a node that is not terminal (I-6).
 */
export async function serverEnrollment(
  q: Queryable,
  serverId: string,
): Promise<{ readonly exists: boolean; readonly retired: boolean; readonly liveNode: boolean }> {
  const { rows } = await q.query(
    'nodes.plan.server',
    `SELECT s.state = 'retired' AS retired,
            EXISTS (SELECT 1 FROM nodes.nodes n
                     WHERE n.server_id = s.server_id AND n.state IN ('pending_binding', 'active', 'degraded')) AS live
       FROM registry.servers s WHERE s.server_id = $1`,
    [serverId],
  )
  const row = rows[0]
  return {
    exists: row !== undefined,
    retired: row?.bool('retired') ?? false,
    liveNode: row?.bool('live') ?? false,
  }
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
  if (server.retired) {
    throw new NodeError('CONFLICT', { reason: 'server_retired' })
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
  const { tier } = await nodePolicySubject(tx, { serverId: node.serverId })
  return store(tx, context, actor, {
    kind,
    subject: { serverId: node.serverId, nodeId },
    // The kind is part of the content, so a revocation and a decommissioning of one node do
    // not share a content checksum (TC-019).
    content: { nodeId, action: kind === 'node.revoke' ? 'revoke' : 'decommission' },
    expectedState: { state: node.state },
    analysis: {
      effect:
        kind === 'node.revoke'
          ? 'The gateway refuses the node at its next request and its waiting jobs are canceled; a running job is left to its lease as outcome unknown. ExponetDB can no longer manage the server through the node.'
          : 'As a revocation, and the node leaves for good: its server may enroll a new node. ExponetDB can no longer manage the server through the node.',
      impact: await nodeImpact(tx, nodeId),
    },
    ...(tier === undefined ? {} : { tier }),
  })
}

/** What depends on a node, counted when the plan is made (informational; the apply re-checks the state). */
async function nodeImpact(q: Queryable, nodeId: string): Promise<JsonObject> {
  const jobs = await q.query(
    'nodes.plan.impact_jobs',
    `SELECT count(*) FILTER (WHERE state IN ('pending', 'dispatched'))::int AS waiting,
            count(*) FILTER (WHERE state = 'running')::int AS running
       FROM nodes.jobs WHERE node_id = $1`,
    [nodeId],
  )
  const operations = await q.query(
    'nodes.plan.impact_operations',
    `SELECT count(DISTINCT o.operation_id)::int AS n
       FROM nodes.jobs j JOIN operations.operations o ON o.operation_id = j.operation_id
      WHERE j.node_id = $1 AND NOT (o.state = ANY($2::text[]))`,
    [nodeId, [...TERMINAL_STATES]],
  )
  const plans = await q.query(
    'nodes.plan.impact_plans',
    `SELECT count(*)::int AS n
       FROM operations.plans p JOIN operations.plan_bodies b ON b.plan_id = p.plan_id
      WHERE p.state = 'active' AND p.expires_at > clock_timestamp()
        AND b.body::jsonb -> 'subject' ->> 'nodeId' = $1`,
    [nodeId],
  )
  const clusters = await q.query(
    'nodes.plan.impact_clusters',
    'SELECT clusters FROM nodes.nodes WHERE node_id = $1',
    [nodeId],
  )
  const reported = clusters.rows[0]?.json('clusters')
  return {
    servedClusters: Array.isArray(reported) ? reported.length : 0,
    waitingJobs: jobs.rows[0]?.int('waiting') ?? 0,
    runningJobs: jobs.rows[0]?.int('running') ?? 0,
    openOperations: operations.rows[0]?.int('n') ?? 0,
    activePlans: plans.rows[0]?.int('n') ?? 0,
  }
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

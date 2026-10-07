import {
  type AccessRole,
  actionDefinition,
  NODE_CAPABILITIES,
  type NodeCapabilityKey,
  type NodeChange,
  type NodeInspectionRequest,
  type NodePlanKind,
  takesCluster,
} from '@exponetdb/contracts'
import type { Queryable, Tx } from '@exponetdb/control-store'
import { isJsonObject, type JsonObject, type JsonValue } from '@exponetdb/kernel'
import { createPlan, type PlanRecord } from '@exponetdb/operations'
import {
  evaluateRegistryPolicy,
  getServer,
  operationActor,
  type RegistryActor,
  type RegistryPolicyContext,
} from '@exponetdb/registry'
import { NodeError } from './errors.ts'
import { argsHashOf } from './jobs.ts'
import {
  type ClusterMapping,
  clusterArg,
  mapCluster,
  requireCapabilities,
  servedNode,
} from './mapping.ts'
import {
  latestObservation,
  OBSERVATION_MAX_AGE_MS,
  type ObservationRecord,
} from './observations.ts'
import { bundleTrusts, postgresCa } from './postgres-ca.ts'

/**
 * Plans of capability operations, made by `serve` from the change and the
 * latest node-signed observation ([control-plane.md §9.2, §9.3](../../../exponetdb-docs/07-node-agent/control-plane.md#93-plans-nodeplan)).
 * A plan never waits for a host: the analysis is the observation's, and the
 * worker checks the host again when the change runs.
 */

export interface CapabilityPlanContext {
  readonly policy: RegistryPolicyContext
}

export type CapabilityKindName = NodePlanKind | 'credential.rotate'

/** The capability whose observation a plan binds (§9.3). */
export const BASIS: Readonly<Record<CapabilityKindName, NodeCapabilityKey>> = {
  'postgres.reload': 'postgres.status@1',
  'postgres.restart': 'postgres.restart.plan@1',
  'postgres.config.apply': 'postgres.config.plan@1',
  'postgres.hba.apply': 'postgres.hba.inspect@1',
  'postgres.roles.apply': 'postgres.roles.inspect@1',
  'postgres.extensions.apply': 'postgres.extensions.inspect@1',
  'postgres.tls.rotate': 'postgres.tls.inspect@1',
  'credential.rotate': 'postgres.roles.inspect@1',
}

/** The capabilities a kind runs at apply time (each must be accepted by the node). */
export const RUNS: Readonly<Record<CapabilityKindName, readonly NodeCapabilityKey[]>> = {
  'postgres.reload': ['postgres.reload@1', 'postgres.status@1'],
  'postgres.restart': ['postgres.restart@1', 'postgres.status@1'],
  'postgres.config.apply': ['postgres.config.inspect@1', 'postgres.config.apply@1'],
  'postgres.hba.apply': ['postgres.hba.inspect@1', 'postgres.hba.apply@1'],
  'postgres.roles.apply': ['postgres.roles.inspect@1', 'postgres.roles.apply@1'],
  'postgres.extensions.apply': ['postgres.extensions.inspect@1', 'postgres.extensions.apply@1'],
  'postgres.tls.rotate': ['postgres.tls.inspect@1', 'postgres.tls.plan@1', 'postgres.tls.rotate@1'],
  'credential.rotate': ['postgres.roles.inspect@1', 'postgres.roles.apply@1'],
}

/** The arguments of a kind's basis capability (its observation is looked up by their hash). */
export function basisArgs(
  kind: CapabilityKindName,
  mapping: Pick<ClusterMapping, 'localName' | 'systemIdentifier'>,
  change: JsonObject,
): JsonObject {
  const cluster = clusterArg(mapping)
  switch (kind) {
    case 'postgres.config.apply':
      return { cluster, changes: change['changes'] ?? [] }
    case 'postgres.extensions.apply':
      return { cluster, database: change['database'] ?? null }
    default:
      return { cluster }
  }
}

/** The digest a plan binds from its basis observation, or null for kinds that bind none. */
export function basisDigest(kind: CapabilityKindName, result: JsonObject): string | null {
  const text = (v: JsonValue | undefined) => (typeof v === 'string' ? v : null)
  switch (kind) {
    case 'postgres.config.apply':
      return text(result['configVersion'])
    case 'postgres.hba.apply':
      return text(result['fileDigest'])
    case 'postgres.roles.apply':
      return text(result['rolesDigest'])
    case 'postgres.extensions.apply':
      return text(result['extensionsDigest'])
    case 'postgres.tls.rotate': {
      const certificate = result['certificate']
      return isJsonObject(certificate) ? text(certificate['fingerprint']) : null
    }
    default:
      return null
  }
}

function classOf(kind: CapabilityKindName | 'node.inspect', tier: 'prod' | 'nonprod') {
  const rule = actionDefinition(kind).class
  if (rule.kind === 'fixed') {
    return rule.class
  }
  if (rule.kind === 'by_tier') {
    return tier === 'prod' ? rule.prod : rule.nonprod
  }
  return 'high'
}

async function storePlan(
  tx: Tx,
  context: CapabilityPlanContext,
  actor: RegistryActor,
  draft: {
    readonly kind: CapabilityKindName | 'node.inspect'
    readonly tier: 'prod' | 'nonprod'
    readonly subject: {
      readonly clusterId?: string
      readonly nodeId: string
      readonly serverId: string
    }
    readonly content: JsonObject
    readonly expectedState: JsonObject
    readonly analysis: JsonObject
  },
): Promise<PlanRecord> {
  const actionClass = classOf(draft.kind, draft.tier)
  if (actionClass === 'read') {
    throw new NodeError('INTERNAL')
  }
  const policy = await evaluateRegistryPolicy(tx, context.policy, {
    kind: draft.kind,
    actor,
    subject: { tier: draft.tier },
    content: draft.content,
  })
  return createPlan(
    tx,
    {
      kind: draft.kind,
      kindVersion: 1,
      actionClass,
      actor: operationActor(actor),
      subject: { ...draft.subject, tier: draft.tier },
      content: draft.content,
      expectedState: draft.expectedState,
      analysis: draft.analysis,
      policy,
    },
    { clock: context.policy.clock },
  )
}

// ----- node.inspect -----

/** The tier of a server's clusters, production when unknown. */
async function serverTier(q: Queryable, serverId: string): Promise<'prod' | 'nonprod'> {
  return (await getServer(q, serverId))?.derivedTier ?? 'prod'
}

/** `node.inspect`: one read or plan capability on a node (§9.2); accepted by the caller in the same transaction. */
export async function planNodeInspection(
  tx: Tx,
  context: CapabilityPlanContext,
  actor: RegistryActor,
  nodeId: string,
  request: NodeInspectionRequest,
): Promise<PlanRecord> {
  const now = context.policy.clock.nowMs()
  const capability = request.capability
  const node = await servedNode(tx, { nodeId }, now)
  requireCapabilities(node, [capability])
  if (Object.hasOwn(request.args, 'cluster')) {
    throw new NodeError('VALIDATION_FAILED')
  }
  let mapping: ClusterMapping | undefined
  let args: JsonObject = { ...(request.args as JsonObject) }
  if (takesCluster(capability)) {
    if (request.clusterId !== null) {
      mapping = (await mapCluster(tx, request.clusterId, now, { nodeId })).mapping
    }
    args = { ...args, cluster: mapping === undefined ? null : clusterArg(mapping) }
  } else if (request.clusterId !== null) {
    throw new NodeError('VALIDATION_FAILED')
  }
  if (!NODE_CAPABILITIES[capability].args.safeParse(args).success) {
    throw new NodeError('VALIDATION_FAILED')
  }
  const tier = mapping?.tier ?? (await serverTier(tx, node.serverId))
  return storePlan(tx, context, actor, {
    kind: 'node.inspect',
    tier,
    subject: {
      nodeId,
      serverId: node.serverId,
      ...(mapping === undefined ? {} : { clusterId: mapping.clusterId }),
    },
    content: {
      nodeId,
      serverId: node.serverId,
      clusterId: mapping?.clusterId ?? null,
      capability,
      args,
      argsHash: argsHashOf(args),
    },
    expectedState: {
      nodeId,
      localName: mapping?.localName ?? null,
      systemIdentifier: mapping?.systemIdentifier ?? null,
    },
    analysis: { capability, kind: NODE_CAPABILITIES[capability].kind },
  })
}

// ----- node.plan -----

async function basisObservation(
  q: Queryable,
  kind: CapabilityKindName,
  mapping: ClusterMapping,
  change: JsonObject,
): Promise<ObservationRecord> {
  const capability = BASIS[kind]
  const observation = await latestObservation(q, {
    nodeId: mapping.nodeId,
    clusterId: mapping.clusterId,
    capability,
    argsHash: argsHashOf(basisArgs(kind, mapping, change)),
    withinMs: OBSERVATION_MAX_AGE_MS,
  })
  if (observation === undefined) {
    throw new NodeError('NODE_OBSERVATION_STALE', { capability })
  }
  return observation
}

const OWN_ROLE = /^exponetdb_/

/** A step's class (§9.3): escalations are critical. */
function roleStepClass(step: JsonObject): 'critical' | 'high' {
  const attributes = step['attributes']
  if (isJsonObject(attributes)) {
    for (const a of ['createrole', 'replication', 'bypassrls'] as const) {
      if (attributes[a] === true) {
        return 'critical'
      }
    }
  }
  const role = step['role']
  if (step['op'] === 'grant_membership' && typeof role === 'string' && role.startsWith('pg_')) {
    return 'critical'
  }
  return 'high'
}

function list(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : []
}

function str(o: JsonValue | undefined, key: string): string | null {
  if (!isJsonObject(o)) return null
  const v = o[key]
  return typeof v === 'string' ? v : null
}

/** Checks a change against its basis observation; returns the plan's analysis. */
function analyze(kind: NodePlanKind, change: JsonObject, result: JsonObject): JsonObject {
  switch (kind) {
    case 'postgres.reload':
    case 'postgres.restart':
      if (kind === 'postgres.reload' && result['running'] !== true) {
        throw new NodeError('CONFLICT')
      }
      return { observed: result }
    case 'postgres.config.apply': {
      const include = result['managedInclude']
      if (!isJsonObject(include) || include['included'] !== true) {
        throw new NodeError('CONFLICT')
      }
      const parameters = list(result['parameters'])
      for (const p of parameters) {
        if (!isJsonObject(p) || p['valid'] !== true) {
          throw new NodeError('VALIDATION_FAILED')
        }
        if (p['conflict'] !== null) {
          throw new NodeError('CONFLICT')
        }
      }
      const planned = list(change['changes']).map((c) => str(c, 'name'))
      const analyzed = parameters.map((p) => str(p, 'name'))
      if (planned.length !== analyzed.length || planned.some((n, i) => n !== analyzed[i])) {
        throw new NodeError('CONFLICT')
      }
      const restart = parameters.some((p) => isJsonObject(p) && p['effect'] === 'restart')
      return { parameters, managedInclude: include, needsRestart: restart }
    }
    case 'postgres.hba.apply': {
      const rules = list(result['rules'])
      return {
        hbaFile: result['hbaFile'] ?? null,
        managedBlockBefore: result['managedBlock'] ?? null,
        foreignRules: rules.filter((r) => isJsonObject(r) && r['managed'] === false).length,
        managedRulesAfter: list(change['managedRules']).length,
      }
    }
    case 'postgres.roles.apply': {
      const steps = list(change['steps'])
      for (const s of steps) {
        const role = str(s, 'role')
        const member = str(s, 'member')
        if ((role !== null && OWN_ROLE.test(role)) || (member !== null && OWN_ROLE.test(member))) {
          // ExponetDB's own roles change only through credential.rotate and the bootstrap SQL.
          throw new NodeError('VALIDATION_FAILED')
        }
      }
      return {
        steps: steps.map((s) => ({
          op: str(s, 'op'),
          role: str(s, 'role'),
          classification: isJsonObject(s) ? roleStepClass(s) : 'high',
        })),
      }
    }
    case 'postgres.extensions.apply': {
      const installed = new Map(
        list(result['installed']).flatMap((e) =>
          isJsonObject(e) && typeof e['name'] === 'string' ? [[e['name'], e]] : [],
        ),
      )
      const available = new Map(
        list(result['available']).flatMap((e) =>
          isJsonObject(e) && typeof e['name'] === 'string'
            ? [[e['name'], list(e['versions'])]]
            : [],
        ),
      )
      const seen = new Set<string>()
      for (const step of list(change['steps'])) {
        const name = str(step, 'name') ?? ''
        const version = str(step, 'version')
        const op = str(step, 'op')
        if (!(available.get(name) ?? []).includes(version)) {
          throw new NodeError('CONFLICT')
        }
        const present = installed.has(name) || seen.has(name)
        if ((op === 'create') === present) {
          throw new NodeError('CONFLICT')
        }
        seen.add(name)
      }
      return { database: change['database'] ?? null, installedBefore: [...installed.values()] }
    }
    case 'postgres.tls.rotate':
      return { certificateBefore: result['certificate'] ?? null, ssl: result['ssl'] ?? null }
  }
}

/** Placed targets of a cluster: a restart takes their schema domains (operations-engine.md §7). */
async function placedTargets(q: Queryable, clusterId: string): Promise<string[]> {
  const { rows } = await q.query(
    'nodes.plan.placed_targets',
    `SELECT DISTINCT pl.target_id FROM registry.placements pl
       JOIN registry.databases d ON d.database_id = pl.database_id
      WHERE d.cluster_id = $1 AND pl.valid_to IS NULL ORDER BY 1`,
    [clusterId],
  )
  return rows.map((r) => r.text('target_id'))
}

function mappingContent(m: ClusterMapping): JsonObject {
  return {
    nodeId: m.nodeId,
    serverId: m.serverId,
    clusterId: m.clusterId,
    localName: m.localName,
    systemIdentifier: m.systemIdentifier,
  }
}

/** `node.plan`: a PostgreSQL operation through the node, bound to its basis observation (§9.3). */
export async function planNodeOperation(
  tx: Tx,
  context: CapabilityPlanContext,
  actor: RegistryActor,
  nodeId: string,
  request: { readonly clusterId: string; readonly change: NodeChange },
): Promise<PlanRecord> {
  const kind = request.change.kind
  const { mapping, node } = await mapCluster(tx, request.clusterId, context.policy.clock.nowMs(), {
    nodeId,
  })
  requireCapabilities(node, [BASIS[kind], ...RUNS[kind]])
  const change = request.change as unknown as JsonObject
  if (kind === 'postgres.tls.rotate') {
    const ca = await postgresCa(tx)
    if (ca === undefined) {
      throw new NodeError('REGISTRY_CONFLICT', { reason: 'postgres_ca_missing' })
    }
    if (!bundleTrusts(mapping.caBundle, ca)) {
      throw new NodeError('REGISTRY_CONFLICT', { reason: 'ca_bundle_lacks_postgres_ca' })
    }
  }
  const observation = await basisObservation(tx, kind, mapping, change)
  const analysis = analyze(kind, change, observation.result)
  const digest = basisDigest(kind, observation.result)
  const { kind: _kind, ...fields } = change
  return storePlan(tx, context, actor, {
    kind,
    tier: mapping.tier,
    subject: { clusterId: mapping.clusterId, nodeId, serverId: mapping.serverId },
    content: {
      ...mappingContent(mapping),
      change: fields,
      basis: { capability: BASIS[kind], jobId: observation.jobId, digest },
      ...(kind === 'postgres.restart'
        ? { targetIds: await placedTargets(tx, mapping.clusterId) }
        : {}),
    },
    expectedState: {
      nodeId,
      localName: mapping.localName,
      systemIdentifier: mapping.systemIdentifier,
      basisDigest: digest,
    },
    analysis: {
      ...analysis,
      basis: {
        capability: BASIS[kind],
        observedAt: observation.observedAt.toISOString(),
        source: 'agent_reported',
      },
      tier: mapping.tier,
    },
  })
}

/** `credential.rotate` on an agent-managed cluster (§9.7). */
export async function planCredentialRotation(
  tx: Tx,
  context: CapabilityPlanContext,
  actor: RegistryActor,
  clusterId: string,
  role: AccessRole,
): Promise<PlanRecord> {
  const { mapping, node } = await mapCluster(tx, clusterId, context.policy.clock.nowMs())
  requireCapabilities(node, [BASIS['credential.rotate'], ...RUNS['credential.rotate']])
  const roleName = `exponetdb_${role}`
  const observation = await basisObservation(tx, 'credential.rotate', mapping, {})
  const present = list(observation.result['roles']).some(
    (r) => isJsonObject(r) && r['name'] === roleName && r['login'] === true,
  )
  if (!present) {
    throw new NodeError('REGISTRY_CONFLICT', { reason: 'role_missing' })
  }
  const { rows } = await tx.query(
    'nodes.plan.active_credential',
    `SELECT credential_id FROM registry.credentials
      WHERE cluster_id = $1 AND access_role = $2 AND state = 'active'`,
    [clusterId, role],
  )
  const replaces = rows[0]?.text('credential_id') ?? null
  return storePlan(tx, context, actor, {
    kind: 'credential.rotate',
    tier: mapping.tier,
    subject: { clusterId, nodeId: mapping.nodeId, serverId: mapping.serverId },
    content: {
      ...mappingContent(mapping),
      role,
      roleName,
      basis: { capability: BASIS['credential.rotate'], jobId: observation.jobId, digest: null },
    },
    expectedState: {
      nodeId: mapping.nodeId,
      localName: mapping.localName,
      systemIdentifier: mapping.systemIdentifier,
      basisDigest: null,
      activeCredentialId: replaces,
    },
    analysis: {
      role,
      roleName,
      replacesCredentialId: replaces,
      tier: mapping.tier,
      basis: {
        capability: BASIS['credential.rotate'],
        observedAt: observation.observedAt.toISOString(),
        source: 'agent_reported',
      },
    },
  })
}

import type { NodeCapabilityKey } from '@exponetdb/contracts'
import type { Queryable } from '@exponetdb/control-store'
import { isJsonObject, type JsonValue, toJsonValue } from '@exponetdb/kernel'
import { getCluster } from '@exponetdb/registry'
import { NodeError } from './errors.ts'
import { OFFLINE_AFTER_MS } from './views.ts'

/**
 * The registry cluster a capability operation acts on, and the node
 * instance it maps to ([control-plane.md §9.1](../../../exponetdb-docs/07-node-agent/control-plane.md#91-the-cluster-a-job-acts-on)).
 * The instance list is what the agent reported in `hello` (gateway-sourced);
 * every job still carries the registry's pinned system identifier, which the
 * agent checks before anything runs.
 */
export interface ClusterMapping {
  readonly clusterId: string
  readonly serverId: string
  readonly nodeId: string
  /** The cluster's derived tier; a cluster without one counts as production. */
  readonly tier: 'prod' | 'nonprod'
  readonly localName: string
  readonly systemIdentifier: string
  readonly caBundle: string
}

/** A node that may receive jobs: bound, served, with its accepted capabilities. */
export interface ServedNode {
  readonly nodeId: string
  readonly serverId: string
  readonly state: 'active' | 'degraded'
  readonly capabilities: ReadonlySet<string>
  readonly clusters: readonly { readonly localName: string; readonly systemIdentifier: string }[]
}

function json(value: unknown): JsonValue {
  const parsed = toJsonValue(value)
  return parsed.ok ? parsed.value : null
}

function capabilityKeys(value: JsonValue): Set<string> {
  const out = new Set<string>()
  if (Array.isArray(value)) {
    for (const c of value) {
      if (isJsonObject(c) && typeof c['name'] === 'string' && typeof c['major'] === 'number') {
        out.add(`${c['name']}@${c['major']}`)
      }
    }
  }
  return out
}

function localClusters(value: JsonValue): ServedNode['clusters'] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((c) =>
    isJsonObject(c) &&
    typeof c['localName'] === 'string' &&
    typeof c['systemIdentifier'] === 'string'
      ? [{ localName: c['localName'], systemIdentifier: c['systemIdentifier'] }]
      : [],
  )
}

/**
 * The node that serves a server (or the named node), refused when it cannot
 * take a job now: revoked (`NODE_REVOKED`), not bound or without a
 * heartbeat for the offline threshold (`NODE_OFFLINE`).
 */
export async function servedNode(
  q: Queryable,
  by: { readonly nodeId: string } | { readonly serverId: string },
  nowMs: number,
): Promise<ServedNode> {
  const { rows } = await q.query(
    'nodes.mapping.node',
    `SELECT node_id, server_id, state, capabilities, clusters, last_heartbeat_at
       FROM nodes.nodes
      WHERE ${'nodeId' in by ? 'node_id' : 'server_id'} = $1
      ORDER BY (state IN ('pending_binding', 'active', 'degraded')) DESC, enrolled_at DESC
      LIMIT 1`,
    ['nodeId' in by ? by.nodeId : by.serverId],
  )
  const row = rows[0]
  if (row === undefined) {
    throw 'nodeId' in by ? new NodeError('NOT_FOUND') : unmapped()
  }
  const state = row.text('state')
  if (state === 'revoked' || state === 'decommissioned' || state === 'binding_failed') {
    throw new NodeError('NODE_REVOKED')
  }
  const heartbeat = row.dateOrNull('last_heartbeat_at')
  if (
    (state !== 'active' && state !== 'degraded') ||
    heartbeat === null ||
    nowMs - heartbeat.getTime() > OFFLINE_AFTER_MS
  ) {
    throw new NodeError('NODE_OFFLINE')
  }
  return {
    nodeId: row.text('node_id'),
    serverId: row.text('server_id'),
    state,
    capabilities: capabilityKeys(json(row.json('capabilities'))),
    clusters: localClusters(json(row.json('clusters'))),
  }
}

function unmapped(): NodeError {
  return new NodeError('REGISTRY_CONFLICT', { reason: 'cluster_unmapped' })
}

/** Refuses a capability the node did not accept in its last hello. */
export function requireCapabilities(node: ServedNode, keys: readonly NodeCapabilityKey[]): void {
  for (const key of keys) {
    if (!node.capabilities.has(key)) {
      throw new NodeError('CAPABILITY_UNAVAILABLE')
    }
  }
}

/**
 * Resolves a registry cluster to its node instance (§9.1). `nodeId`, when
 * given, must be the node that serves the cluster's server.
 */
export async function mapCluster(
  q: Queryable,
  clusterId: string,
  nowMs: number,
  options: { readonly nodeId?: string } = {},
): Promise<{ readonly mapping: ClusterMapping; readonly node: ServedNode }> {
  const cluster = await getCluster(q, clusterId)
  if (cluster === undefined) {
    throw new NodeError('NOT_FOUND')
  }
  if (cluster.managementMode !== 'agent') {
    throw new NodeError('CAPABILITY_UNAVAILABLE')
  }
  if (cluster.state === 'retired') {
    throw new NodeError('REGISTRY_CONFLICT', { reason: 'cluster_retired' })
  }
  if (cluster.state !== 'active' || cluster.systemIdentifier === null) {
    throw new NodeError('REGISTRY_CONFLICT', { reason: 'cluster_not_confirmed' })
  }
  if (cluster.serverId === null) {
    throw unmapped()
  }
  const node = await servedNode(q, { serverId: cluster.serverId }, nowMs)
  if (options.nodeId !== undefined && node.nodeId !== options.nodeId) {
    throw unmapped()
  }
  const local = node.clusters.find((c) => c.systemIdentifier === cluster.systemIdentifier)
  if (local === undefined) {
    throw unmapped()
  }
  return {
    node,
    mapping: {
      clusterId,
      serverId: cluster.serverId,
      nodeId: node.nodeId,
      tier: cluster.derivedTier ?? 'prod',
      localName: local.localName,
      systemIdentifier: cluster.systemIdentifier,
      caBundle: cluster.caBundle,
    },
  }
}

/** The `cluster` argument of a job. */
export function clusterArg(m: Pick<ClusterMapping, 'localName' | 'systemIdentifier'>) {
  return { localName: m.localName, systemIdentifier: m.systemIdentifier }
}

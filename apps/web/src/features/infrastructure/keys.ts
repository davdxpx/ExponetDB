import type { InspectableCapability } from '@exponetdb/sdk/operations'
import { queryOptions } from '@tanstack/react-query'
import type { ApiClient } from '../../lib/api/client.ts'
import { classifyFailure } from '../../lib/query/errors.ts'

/**
 * Query keys and query options of the infrastructure pages (servers,
 * clusters, nodes, certificates). Keys are built from validated ids only,
 * and every query of one object is disabled for anything else, so an id that
 * failed its grammar never reaches the server. The cache holds the server's
 * answers as they came; none carries a secret (an enrollment token exists
 * only in the answer of its reveal, which is never cached).
 */
const ULID = '[0-7][0-9A-HJKMNP-TV-Z]{25}'
const SERVER_ID = new RegExp(`^srv_${ULID}$`)
const CLUSTER_ID = new RegExp(`^cls_${ULID}$`)
const NODE_ID = new RegExp(`^nod_${ULID}$`)
const TOKEN_ID = new RegExp(`^ent_${ULID}$`)

export const isServerId = (value: unknown): value is string =>
  typeof value === 'string' && SERVER_ID.test(value)
export const isClusterId = (value: unknown): value is string =>
  typeof value === 'string' && CLUSTER_ID.test(value)
export const isNodeId = (value: unknown): value is string =>
  typeof value === 'string' && NODE_ID.test(value)
export const isTokenId = (value: unknown): value is string =>
  typeof value === 'string' && TOKEN_ID.test(value)

export const infraKeys = {
  all: ['infrastructure'] as const,
  servers: () => ['infrastructure', 'servers'] as const,
  server: (id: string) => ['infrastructure', 'servers', id] as const,
  clusters: () => ['infrastructure', 'clusters'] as const,
  cluster: (id: string) => ['infrastructure', 'clusters', id] as const,
  databases: (id: string) => ['infrastructure', 'clusters', id, 'databases'] as const,
  endpoints: (id: string) => ['infrastructure', 'clusters', id, 'endpoints'] as const,
  bootstrap: (id: string) => ['infrastructure', 'clusters', id, 'bootstrap-sql'] as const,
  nodes: () => ['infrastructure', 'nodes'] as const,
  node: (id: string) => ['infrastructure', 'nodes', id] as const,
  jobs: (id: string) => ['infrastructure', 'nodes', id, 'jobs'] as const,
  observations: (id: string, capability: string, clusterId: string) =>
    ['infrastructure', 'nodes', id, 'observations', capability, clusterId] as const,
  certificates: () => ['infrastructure', 'certificates'] as const,
  enrollments: () => ['infrastructure', 'enrollments'] as const,
}

/** The most items one list read asks for (the API's page maximum). */
export const INFRA_PAGE_LIMIT = 200
/** Recent jobs one read asks for. */
export const JOB_PAGE_LIMIT = 50
/**
 * How often an open page reads again. Heartbeats arrive every 15 seconds and
 * a node is offline after 60 without one, so node pages read every 15
 * seconds; the registry pages every 30 (`toReadable` turns 60 seconds stale).
 */
export const NODE_POLL_MS = 15_000
export const INFRA_POLL_MS = 30_000

function poll(interval: number) {
  return (query: { readonly state: { readonly error: unknown } }): number | false => {
    const kind = classifyFailure(query.state.error).kind
    return kind === 'not_permitted' || kind === 'not_found' || kind === 'session' ? false : interval
  }
}

export function serversQuery(client: ApiClient) {
  return queryOptions({
    queryKey: infraKeys.servers(),
    queryFn: ({ signal }) =>
      client.operation('listServers', { query: { limit: INFRA_PAGE_LIMIT }, signal }),
    refetchInterval: poll(INFRA_POLL_MS),
  })
}

export function serverQuery(client: ApiClient, serverId: string) {
  return queryOptions({
    queryKey: infraKeys.server(serverId),
    queryFn: ({ signal }) => client.operation('getServer', { params: { serverId }, signal }),
    enabled: isServerId(serverId),
    refetchInterval: poll(INFRA_POLL_MS),
  })
}

export function clustersQuery(client: ApiClient) {
  return queryOptions({
    queryKey: infraKeys.clusters(),
    queryFn: ({ signal }) =>
      client.operation('listClusters', { query: { limit: INFRA_PAGE_LIMIT }, signal }),
    refetchInterval: poll(INFRA_POLL_MS),
  })
}

export function clusterQuery(client: ApiClient, clusterId: string) {
  return queryOptions({
    queryKey: infraKeys.cluster(clusterId),
    queryFn: ({ signal }) => client.operation('getCluster', { params: { clusterId }, signal }),
    enabled: isClusterId(clusterId),
    refetchInterval: poll(INFRA_POLL_MS),
  })
}

export function clusterDatabasesQuery(client: ApiClient, clusterId: string) {
  return queryOptions({
    queryKey: infraKeys.databases(clusterId),
    queryFn: ({ signal }) =>
      client.operation('listClusterDatabases', { params: { clusterId }, signal }),
    enabled: isClusterId(clusterId),
    refetchInterval: poll(INFRA_POLL_MS),
  })
}

export function clusterEndpointsQuery(client: ApiClient, clusterId: string) {
  return queryOptions({
    queryKey: infraKeys.endpoints(clusterId),
    queryFn: ({ signal }) =>
      client.operation('listClusterEndpoints', { params: { clusterId }, signal }),
    enabled: isClusterId(clusterId),
    refetchInterval: poll(INFRA_POLL_MS),
  })
}

/**
 * The role bootstrap SQL of an external cluster: read-only text for a person
 * to run. It holds no password. It lists the registered databases, so it is
 * read again like the other registry reads and an old copy shows as stale.
 */
export function bootstrapSqlQuery(client: ApiClient, clusterId: string) {
  return queryOptions({
    queryKey: infraKeys.bootstrap(clusterId),
    queryFn: ({ signal }) =>
      client.operation('getClusterBootstrapSql', { params: { clusterId }, signal }),
    enabled: isClusterId(clusterId),
    refetchInterval: poll(INFRA_POLL_MS),
  })
}

export function nodesQuery(client: ApiClient) {
  return queryOptions({
    queryKey: infraKeys.nodes(),
    queryFn: ({ signal }) =>
      client.operation('listNodes', { query: { limit: INFRA_PAGE_LIMIT }, signal }),
    refetchInterval: poll(NODE_POLL_MS),
  })
}

export function nodeQuery(client: ApiClient, nodeId: string) {
  return queryOptions({
    queryKey: infraKeys.node(nodeId),
    queryFn: ({ signal }) => client.operation('getNode', { params: { nodeId }, signal }),
    enabled: isNodeId(nodeId),
    refetchInterval: poll(NODE_POLL_MS),
  })
}

export function nodeJobsQuery(client: ApiClient, nodeId: string) {
  return queryOptions({
    queryKey: infraKeys.jobs(nodeId),
    queryFn: ({ signal }) =>
      client.operation('listNodeJobs', {
        params: { nodeId },
        query: { limit: JOB_PAGE_LIMIT },
        signal,
      }),
    enabled: isNodeId(nodeId),
    refetchInterval: poll(NODE_POLL_MS),
  })
}

/** The roles capability whose node-signed observation the cluster page shows. */
export const ROLES_INSPECT: InspectableCapability = 'postgres.roles.inspect@2'

export function rolesObservationQuery(client: ApiClient, nodeId: string, clusterId: string) {
  return queryOptions({
    queryKey: infraKeys.observations(nodeId, ROLES_INSPECT, clusterId),
    queryFn: ({ signal }) =>
      client.operation('listNodeObservations', {
        params: { nodeId },
        query: { capability: ROLES_INSPECT, clusterId },
        signal,
      }),
    enabled: isNodeId(nodeId) && isClusterId(clusterId),
    refetchInterval: poll(INFRA_POLL_MS),
  })
}

export function certificatesQuery(client: ApiClient) {
  return queryOptions({
    queryKey: infraKeys.certificates(),
    queryFn: ({ signal }) => client.operation('listNodeCertificates', { signal }),
    refetchInterval: poll(INFRA_POLL_MS),
  })
}

/**
 * The person's own applied `node.enroll` plans (state `consumed`): each names
 * the enrollment token its operation created, which only this person may
 * reveal, once, within 30 minutes of the operation's success.
 */
export function enrollmentPlansQuery(client: ApiClient) {
  return queryOptions({
    queryKey: infraKeys.enrollments(),
    queryFn: ({ signal }) =>
      client.operation('listPlans', {
        query: { kind: 'node.enroll', state: 'consumed', actor: 'self', limit: 20 },
        signal,
      }),
    refetchInterval: poll(INFRA_POLL_MS),
  })
}

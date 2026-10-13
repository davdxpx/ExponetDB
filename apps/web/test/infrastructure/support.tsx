import type {
  Cluster,
  DatabaseView,
  EndpointView,
  Node,
  NodeCertificates,
  NodeJob,
  NodeObservation,
  NodeStatus,
  PlanRead,
  Server,
  TargetSummary,
} from '@exponetdb/sdk/operations'
import type { QueryClient } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { configure, render } from '@testing-library/react'
import { vi } from 'vitest'
import { AppProviders } from '../../src/app/providers.tsx'
import { createReauthBridge } from '../../src/features/reauth/reauth.tsx'
import { ApiClient } from '../../src/lib/api/client.ts'
import { createQueryClient } from '../../src/lib/query/client.ts'
import { routeTree } from '../../src/routeTree.gen.ts'

/**
 * A fake server for the infrastructure pages and a way to mount the real
 * route tree on it. It answers from a `World` the test changes between
 * steps, records every request with its method, path and body, and answers
 * anything it does not know with a 404, so a request a page should not make
 * is visible. A path in `hang` never answers (a read that stays loading). A
 * change answers `REAUTH_REQUIRED` until the TOTP proof `123456` was given
 * when `needsProof` holds.
 */
configure({ asyncUtilTimeout: 5_000 })
vi.setConfig({ testTimeout: 30_000 })

export const IDENTITY = 'idn_01M4S9000000000000000000AD'
export const SERVER = 'srv_01M4S9000000000000000000S1'
export const CLUSTER = 'cls_01M4S9000000000000000000C1'
export const NODE = 'nod_01M4S9000000000000000000N1'
export const PLAN = 'pln_01M4S9000000000000000000P1'
export const ENROLL_PLAN = 'pln_01M4S9000000000000000000P2'
export const TOKEN_ID = 'ent_01M4S9000000000000000000E1'
export const TARGET = 'tgt_01M4S9000000000000000000T1'
export const OP = 'op_01M4S9000000000000000000O1'
export const TOKEN = `exdbt1.${'Q'.repeat(60)}`

export const BIDI = String.fromCodePoint(0x202e)
export const ZWSP = String.fromCodePoint(0x200b)
export const TAG = String.fromCodePoint(0xe0041, 0xe0042)
/** A name with markup, a direction override, a zero-width space and tag characters. */
export const HOSTILE = `<script>alert(1)</script>db${BIDI}gnp${ZWSP}x${TAG}`

const NOW = new Date().toISOString()
const SOON = new Date(Date.now() + 3 * 86_400_000).toISOString()
const LATER = new Date(Date.now() + 200 * 86_400_000).toISOString()

export function server(over: Partial<Server> = {}): Server {
  return {
    id: SERVER,
    displayName: 'acme-db-01',
    provider: 'hetzner_cloud',
    location: 'fsn1',
    derivedTier: 'nonprod',
    observedFacts: {
      os: 'Debian 13',
      kernel: '6.12.0',
      cpus: 8,
      memoryBytes: 32 * 1024 ** 3,
      reportedAt: NOW,
    },
    ...over,
  }
}

export function cluster(over: Partial<Cluster> = {}): Cluster {
  return {
    id: CLUSTER,
    displayName: 'shop-main',
    serverId: SERVER,
    managementMode: 'agent',
    state: 'active',
    confirmedAt: NOW,
    postgresVersion: '17.6',
    systemIdentifier: '7412345678901234567',
    derivedTier: 'nonprod',
    declaredTier: 'nonprod',
    health: { state: 'healthy', source: 'live', observedAt: NOW },
    ...over,
  }
}

export function node(over: Partial<Node> = {}): Node {
  return {
    id: NODE,
    serverId: SERVER,
    state: 'active',
    agentVersion: '1.4.0',
    protocolMajor: 1,
    lastHeartbeatAt: NOW,
    clockSkewMs: 12,
    capabilities: [
      { name: 'postgres.status', major: 1 },
      { name: 'postgres.roles.apply', major: 2 },
    ],
    ...over,
  }
}

export function nodeStatus(over: Partial<NodeStatus> = {}): NodeStatus {
  return {
    ...node(),
    clusters: [
      {
        clusterId: CLUSTER,
        localName: '17/main',
        running: true,
        pendingRestart: false,
        serverCertificateExpiresAt: LATER,
      },
    ],
    host: { loadAverage1m: 0.42, memoryUsedBytes: 4 * 1024 ** 3, diskUsedPercent: 37 },
    nodeCertificateExpiresAt: SOON,
    source: 'agent_reported',
    observedAt: NOW,
    ...over,
  }
}

export function job(over: Partial<NodeJob> = {}): NodeJob {
  return {
    id: 'job_01M4S9000000000000000000J1',
    nodeId: NODE,
    operationId: OP,
    capability: 'postgres.roles.inspect',
    capabilityMajor: 2,
    state: 'completed',
    createdAt: NOW,
    startedAt: NOW,
    finishedAt: NOW,
    outcome: 'succeeded',
    resultVerified: true,
    ...over,
  }
}

export function certificates(over: Partial<NodeCertificates> = {}): NodeCertificates {
  return {
    authorities: [
      {
        role: 'root_ca',
        subjectCommonName: 'ExponetDB Agent Root CA',
        notBefore: '2026-01-01T00:00:00Z',
        notAfter: LATER,
        fingerprint: `sha256:${'a'.repeat(64)}`,
      },
      {
        role: 'issuing_ca',
        subjectCommonName: 'ExponetDB Agent Issuing CA',
        notBefore: '2026-01-01T00:00:00Z',
        notAfter: SOON,
        fingerprint: `sha256:${'b'.repeat(64)}`,
      },
    ],
    notRecorded: [{ role: 'postgres_ca', reason: 'not_initialized' }],
    nodes: [
      {
        nodeId: NODE,
        serverId: SERVER,
        state: 'active',
        certificateExpiresAt: SOON,
        serverCertificates: [{ localName: '17/main', expiresAt: LATER }],
      },
    ],
    nodesTruncated: false,
    notKnown: [
      { subject: 'gateway_leaf', reason: 'in_memory_only' },
      { subject: 'external_server_certificates', reason: 'not_probed' },
    ],
    source: 'live',
    observedAt: NOW,
    ...over,
  }
}

export function enrollPlan(over: Partial<PlanRead> = {}): PlanRead {
  return {
    id: ENROLL_PLAN,
    kind: 'node.enroll',
    kindVersion: 1,
    class: 'high',
    state: 'consumed',
    planHash: `sha256:ph1:${'ab'.repeat(32)}`,
    createdAt: NOW,
    expiresAt: LATER,
    actor: { identityId: IDENTITY, kind: 'human', via: 'web' },
    clientId: null,
    subject: { targetId: null, targetPath: null, clusterId: null, nodeId: null, tier: 'nonprod' },
    contentChecksum: `sha256:${'cd'.repeat(32)}`,
    decision: 'allow',
    requirements: [],
    approvals: { given: 0, required: 0 },
    overriddenRules: [],
    change: { content: { serverId: SERVER, tokenId: TOKEN_ID }, analysis: {} },
    ...over,
  } as PlanRead
}

export interface Sent {
  readonly method: string
  readonly path: string
  readonly body: unknown
}

export interface FailureSpec {
  readonly status: number
  readonly code: string
  readonly message?: string
}

export class World {
  servers: Server[] = [server()]
  serversNextCursor: string | null = null
  clustersNextCursor: string | null = null
  nodesNextCursor: string | null = null
  databasesTruncated = false
  endpointsTruncated = false
  clusters: Cluster[] = [cluster()]
  nodes: Node[] = [node()]
  status: NodeStatus = nodeStatus()
  jobs: NodeJob[] = [job()]
  jobsNextCursor: string | null = null
  certs: NodeCertificates = certificates()
  enrollPlans: PlanRead[] = []
  databases: DatabaseView[] = []
  endpoints: EndpointView[] = []
  targets: TargetSummary[] = []
  observations: NodeObservation[] = []
  /** The reveal answers once; a second reveal is refused like an unknown token. */
  revealed = false
  /** Answers that fail, by a substring of `METHOD path` (first match wins). */
  readonly failures = new Map<string, FailureSpec>()
  /** Paths (`METHOD /api/v1/...`, exact) that never answer. */
  readonly hang = new Set<string>()
  needsProof = false
  private proven = false
  readonly sent: Sent[] = []

  get changes(): Sent[] {
    return this.sent.filter((s) => s.method !== 'GET' && !s.path.startsWith('/auth/'))
  }

  proof(code: string): boolean {
    this.proven = code === '123456'
    return this.proven
  }

  mustProve(): boolean {
    return this.needsProof && !this.proven
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const problem = (status: number, code: string, message: string) => json(status, { code, message })

function me() {
  return {
    identity: {
      id: IDENTITY,
      kind: 'human',
      state: 'active',
      label: 'owner',
      displayName: 'Ada',
      email: 'owner@example.test',
    },
    session: {},
    bindings: [],
    effectivePermissions: [],
  }
}

/** The plan every plan request answers with (the page only reads its id). */
function planView(kind: string): unknown {
  return { ...enrollPlan(), id: PLAN, kind, state: 'active', change: undefined }
}

export function answer(world: World, sent: Sent): Response | Promise<Response> {
  const { method } = sent
  const url = new URL(sent.path, 'http://localhost')
  const p = url.pathname
  if (world.hang.has(`${method} ${p}`)) return new Promise<Response>(() => {})
  for (const [part, failure] of world.failures) {
    if (`${method} ${sent.path}`.includes(part)) {
      return problem(failure.status, failure.code, failure.message ?? `${failure.code} happened.`)
    }
  }
  if (p === '/api/v1/me') return json(200, me())
  if (p === '/auth/reauth/totp' && method === 'POST') {
    const code = (sent.body as { code?: string } | undefined)?.code ?? ''
    return world.proof(code)
      ? json(200, { reauthenticatedAt: NOW })
      : problem(400, 'REAUTH_FAILED', 'The proof was not accepted.')
  }
  if (method === 'GET') return read(world, p, url)
  if (world.mustProve()) return problem(403, 'REAUTH_REQUIRED', 'Confirm it is you.')
  return change(world, p)
}

function read(world: World, p: string, url: URL): Response {
  if (p === '/api/v1/servers') {
    return json(200, { items: world.servers, nextCursor: world.serversNextCursor })
  }
  let m = /^\/api\/v1\/servers\/([^/]+)$/.exec(p)
  if (m !== null) {
    const found = world.servers.find((s) => s.id === m?.[1])
    return found === undefined ? problem(404, 'NOT_FOUND', 'Not found.') : json(200, found)
  }
  if (p === '/api/v1/clusters')
    return json(200, { items: world.clusters, nextCursor: world.clustersNextCursor })
  m = /^\/api\/v1\/clusters\/([^/]+)$/.exec(p)
  if (m !== null) {
    const found = world.clusters.find((c) => c.id === m?.[1])
    return found === undefined ? problem(404, 'NOT_FOUND', 'Not found.') : json(200, found)
  }
  if (/^\/api\/v1\/clusters\/[^/]+\/databases$/.test(p)) {
    return json(200, { items: world.databases, truncated: world.databasesTruncated })
  }
  if (/^\/api\/v1\/clusters\/[^/]+\/endpoints$/.test(p)) {
    return json(200, { items: world.endpoints, truncated: world.endpointsTruncated })
  }
  if (p === '/api/v1/targets') return json(200, { items: world.targets, nextCursor: null })
  if (p === '/api/v1/nodes')
    return json(200, { items: world.nodes, nextCursor: world.nodesNextCursor })
  if (p === '/api/v1/nodes/certificates') return json(200, world.certs)
  m = /^\/api\/v1\/nodes\/([^/]+)$/.exec(p)
  if (m !== null) {
    return m[1] === world.status.id
      ? json(200, world.status)
      : problem(404, 'NOT_FOUND', 'Not found.')
  }
  if (/^\/api\/v1\/nodes\/[^/]+\/jobs$/.test(p)) {
    return json(200, { items: world.jobs, nextCursor: world.jobsNextCursor })
  }
  if (/^\/api\/v1\/nodes\/[^/]+\/observations$/.test(p)) {
    return json(200, { items: world.observations })
  }
  if (p === '/api/v1/plans' && url.searchParams.get('kind') === 'node.enroll') {
    return json(200, { items: world.enrollPlans, nextCursor: null })
  }
  return problem(404, 'NOT_FOUND', 'Not found.')
}

function change(world: World, p: string): Response {
  if (p === '/api/v1/servers') return json(201, planView('registry.server.create'))
  if (/^\/api\/v1\/servers\/[^/]+\/nodes\/enroll$/.test(p))
    return json(201, planView('node.enroll'))
  if (/^\/api\/v1\/clusters\/[^/]+\/declared-tier$/.test(p)) {
    return json(201, planView('registry.cluster.declare_tier'))
  }
  if (/^\/api\/v1\/clusters\/[^/]+\/confirm$/.test(p)) {
    return json(201, planView('registry.cluster.confirm'))
  }
  if (/^\/api\/v1\/clusters\/[^/]+\/role-verifiers$/.test(p)) {
    return json(201, planView('postgres.roles.verifier.set'))
  }
  if (/^\/api\/v1\/nodes\/[^/]+\/plans$/.test(p)) return json(201, planView('postgres.roles.apply'))
  if (/^\/api\/v1\/nodes\/[^/]+\/(revoke|decommission|config-updates)$/.test(p)) {
    return json(201, planView('node.revoke'))
  }
  if (/^\/api\/v1\/nodes\/[^/]+\/inspections$/.test(p)) {
    return json(202, { id: OP, state: 'queued' })
  }
  if (p === `/api/v1/enrollment-tokens/${TOKEN_ID}/reveal` && !world.revealed) {
    world.revealed = true
    return json(200, { tokenId: TOKEN_ID, serverId: SERVER, token: TOKEN, expiresAt: SOON })
  }
  return problem(404, 'NOT_FOUND', 'Not found.')
}

export interface Mounted {
  readonly router: { readonly state: { readonly location: { readonly pathname: string } } }
  readonly queryClient: QueryClient
  readonly unmount: () => void
  readonly container: HTMLElement
}

export function mountApp(
  initialPath: string,
  world: World,
  seed?: (queryClient: QueryClient) => void,
): Mounted {
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const sent: Sent = {
      method: init?.method ?? 'GET',
      path: String(input),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    world.sent.push(sent)
    return answer(world, sent)
  })
  const client = new ApiClient({
    fetch: fetchFn as unknown as typeof fetch,
    cookies: () => '__Host-exdb_csrf=t',
    onSessionGone: vi.fn(),
  })
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  })
  const queryClient = createQueryClient()
  seed?.(queryClient)
  const view = render(
    <AppProviders
      services={{
        queryClient,
        client,
        reauth: createReauthBridge(),
        navigate: (to, options) =>
          void router.navigate({ href: to, replace: options?.replace === true }),
      }}
    >
      <RouterProvider router={router} />
    </AppProviders>,
  )
  return {
    router: router as unknown as Mounted['router'],
    queryClient,
    unmount: view.unmount,
    container: view.container,
  }
}

/** Everything the query and mutation caches hold, as JSON text. */
export function cacheText(queryClient: QueryClient): string {
  return JSON.stringify({
    queries: queryClient
      .getQueryCache()
      .getAll()
      .map((q) => q.state),
    mutations: queryClient
      .getMutationCache()
      .getAll()
      .map((m) => m.state),
  })
}

import type {
  Finding,
  MigrationStatus,
  MigrationStream,
  OperationRead,
  SchemaFingerprintResult,
  SchemaObject,
  SchemaObjectRef,
  SchemaOverview,
  TargetHealthHistory,
} from '@exponetdb/sdk/operations'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { configure, render } from '@testing-library/react'
import { vi } from 'vitest'
import { AppProviders } from '../../src/app/providers.tsx'
import { createReauthBridge } from '../../src/features/reauth/reauth.tsx'
import { ApiClient, type ResponseOf } from '../../src/lib/api/client.ts'
import { createQueryClient } from '../../src/lib/query/client.ts'
import { routeTree } from '../../src/routeTree.gen.ts'
import { answer, World as TargetWorld } from '../target/support.tsx'

export { project } from '../target/support.tsx'

/**
 * The fake server of the target overview and the schema browser: the target
 * pages' world (`getMe`, `getTarget`, `listTargets`, `getTargetHealth`) plus
 * the reads of the blocks (history, findings, migrations, the promotion
 * stream, operations, schema overview, fingerprint, search and object). A
 * path nobody set up answers 404, so a request a page should not make shows.
 */
configure({ asyncUtilTimeout: 5_000 })
vi.setConfig({ testTimeout: 30_000 })

export const BIDI = String.fromCodePoint(0x202e)
export const ZWSP = String.fromCodePoint(0x200b)
export const TAG = String.fromCodePoint(0xe0041, 0xe0042)

const NOW = (): string => new Date().toISOString()
const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString()

export { minutesAgo }

export type NodeStatus = ResponseOf<'getNode'>

export class World extends TargetWorld {
  /** Node status by node id (`getNode`). */
  readonly nodes = new Map<string, NodeStatus>()
  history: TargetHealthHistory | undefined
  findings: Finding[] = []
  findingsNext: string | null = null
  migrations: MigrationStatus | undefined
  stream: MigrationStream | undefined
  operations: OperationRead[] = []
  operationsNext: string | null = null
  overview: SchemaOverview | undefined
  fingerprint: SchemaFingerprintResult | undefined
  /** What a search finds: every ref whose name contains the term and whose kind is asked for. */
  refs: SchemaObjectRef[] = []
  searchNext: string | null = null
  /** Object details by `kind|qualifiedName`. */
  readonly objects = new Map<string, SchemaObject>()
  readonly extra: string[] = []
  /** Reads that fail, by the exact path (so `/health` does not also fail `/health/history`). */
  readonly failuresExact = new Map<string, { status: number; code: string; message?: string }>()
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export function answerMore(world: World, input: string | URL | Request): Response {
  const url = new URL(String(input), 'http://localhost')
  const request = `${url.pathname}${url.search}`
  const exact = world.failuresExact.get(url.pathname)
  if (exact !== undefined) {
    world.requests.push(request)
    return json(exact.status, {
      code: exact.code,
      message: exact.message ?? `${exact.code} happened.`,
    })
  }
  const mine = (body: unknown): Response | undefined => {
    world.requests.push(request)
    world.extra.push(request)
    for (const [part, failure] of world.failures) {
      if (request.includes(part)) {
        return json(failure.status, {
          code: failure.code,
          message: failure.message ?? `${failure.code} happened.`,
        })
      }
    }
    return body === undefined
      ? json(404, { code: 'NOT_FOUND', message: 'Not found.' })
      : json(200, body)
  }
  const target = /^\/api\/v1\/targets\/([^/]+)\/(.+)$/.exec(url.pathname)
  const rest = target?.[2]
  switch (rest) {
    case 'health/history':
      return mine(world.history) as Response
    case 'findings':
      return mine(
        world.findings === undefined
          ? undefined
          : { items: world.findings, nextCursor: world.findingsNext },
      ) as Response
    case 'migrations':
      return mine(world.migrations) as Response
    case 'schema':
      return mine(world.overview) as Response
    case 'schema/fingerprint':
      return mine(world.fingerprint) as Response
    case 'schema/search': {
      const q = (url.searchParams.get('q') ?? '').toLowerCase()
      const kinds = url.searchParams.getAll('kinds')
      const items = world.refs.filter(
        (ref) =>
          ref.name.toLowerCase().includes(q) && (kinds.length === 0 || kinds.includes(ref.kind)),
      )
      return mine({ items, nextCursor: world.searchNext }) as Response
    }
    default:
      break
  }
  const node = /^\/api\/v1\/nodes\/([^/]+)$/.exec(url.pathname)
  if (node?.[1] !== undefined) return mine(world.nodes.get(decodeURIComponent(node[1]))) as Response
  const object = /^\/api\/v1\/targets\/[^/]+\/schema\/objects\/([^/]+)\/(.+)$/.exec(url.pathname)
  if (object?.[1] !== undefined && object[2] !== undefined) {
    const key = `${decodeURIComponent(object[1])}|${decodeURIComponent(object[2])}`
    return mine(world.objects.get(key)) as Response
  }
  if (/^\/api\/v1\/projects\/[^/]+\/migrations$/.test(url.pathname)) {
    return mine(world.stream) as Response
  }
  if (url.pathname === '/api/v1/operations') {
    return mine({ items: world.operations, nextCursor: world.operationsNext }) as Response
  }
  return answer(world, input)
}

export function mountApp(initialPath: string, world: World) {
  const fetchFn = vi.fn(async (input: string | URL | Request) => {
    const request = String(input)
    for (const [part, held] of world.delays) {
      if (request.includes(part)) await held
    }
    return answerMore(world, input)
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
  render(
    <AppProviders
      services={{
        queryClient,
        client,
        reauth: createReauthBridge(),
        navigate: (to) => void router.navigate({ href: to }),
      }}
    >
      <RouterProvider router={router} />
    </AppProviders>,
  )
  return { router, fetchFn, queryClient }
}

// ----- fixtures -----

export const PROJECT_ID = 'prj_00000000000000000000000001'
export const NODE_ID = 'nod_00000000000000000000000001'

/** A node that reports its host: load, memory and disk, with the time of the report. */
export function nodeFixture(over: Partial<NodeStatus> = {}): NodeStatus {
  return {
    id: NODE_ID,
    serverId: 'srv_00000000000000000000000001',
    state: 'active',
    agentVersion: '1.0.0',
    protocolMajor: 1,
    lastHeartbeatAt: NOW(),
    clockSkewMs: 12,
    capabilities: [],
    clusters: [],
    host: {
      loadAverage1m: 0.42,
      memoryUsedBytes: Math.round(3.1 * 1024 ** 3),
      diskUsedPercent: 61,
    },
    nodeCertificateExpiresAt: null,
    source: 'agent_reported',
    observedAt: NOW(),
    ...over,
  }
}

/** The placement of a target whose cluster a node agent manages (or an external one). */
export function placementFixture(mode: 'agent' | 'external' = 'agent') {
  return {
    clusterId: 'cls_00000000000000000000000001',
    clusterName: 'main',
    generation: 1,
    managementMode: mode,
    postgresVersion: '17.2',
    serverName: 'db-01',
    since: '2026-10-01T00:00:00.000Z',
  } as const
}

export function historyFixture(over: Partial<TargetHealthHistory> = {}): TargetHealthHistory {
  const base = Date.parse('2026-10-13T10:00:00.000Z')
  const at = (seconds: number): string => new Date(base + seconds * 1000).toISOString()
  const counts = (healthy: number, rest: Partial<Record<string, number>> = {}) => ({
    healthy,
    degraded: 0,
    unhealthy: 0,
    unreachable: 0,
    unknown: 0,
    suspended: 0,
    ...rest,
  })
  return {
    targetId: 'tgt_00000000000000000000000001',
    from: at(0),
    to: at(1200),
    bucketSeconds: 300,
    samplePeriodSeconds: 15,
    gapThresholdSeconds: 30,
    firstSampleAt: at(0),
    gapsTruncated: false,
    // Buckets at 0, 300 and 900: the one at 600 is missing (a gap).
    buckets: [
      { start: at(0), samples: 20, worst: 'healthy', counts: counts(20) },
      { start: at(300), samples: 20, worst: 'degraded', counts: counts(15, { degraded: 5 }) },
      { start: at(900), samples: 20, worst: 'healthy', counts: counts(20) },
    ],
    gaps: [
      {
        from: at(500),
        to: at(880),
        durationSeconds: 380,
        cause: 'control_plane_down',
        reason: 'no_live_worker',
      },
    ],
    source: 'sampled',
    observedAt: NOW(),
    ...over,
  }
}

export function findingFixture(over: Partial<Finding> = {}): Finding {
  return {
    id: 'fnd_00000000000000000000000001',
    kind: 'drift',
    code: 'DRIFT_OBJECT_ADDED',
    severity: 'warning',
    state: 'open',
    summary: 'An object was added outside a migration.',
    object: null,
    firstSeenAt: minutesAgo(120),
    lastSeenAt: minutesAgo(5),
    occurrences: 3,
    resolution: null,
    resolvedAt: null,
    securityRelevant: false,
    subject: { targetId: 'tgt_00000000000000000000000001', clusterId: null, nodeId: null },
    ...over,
  }
}

export function operationFixture(over: Partial<OperationRead> = {}): OperationRead {
  return {
    id: 'op_00000000000000000000000001',
    kind: 'migration.apply',
    state: 'succeeded',
    applyOutcome: 'applied',
    verificationOutcome: 'passed',
    planId: 'pln_00000000000000000000000001',
    actor: { kind: 'human', identityId: 'idn_00000000000000000000000001' },
    approvalUrl: null,
    createdAt: minutesAgo(30),
    updatedAt: minutesAgo(20),
    errorCode: null,
    steps: [],
    subject: {
      targetId: 'tgt_00000000000000000000000001',
      targetPath: 'shop/platform/staging',
      clusterId: null,
      nodeId: null,
      tier: 'nonprod',
    },
    waitingFor: null,
    ...over,
  } as OperationRead
}

export function migrationStatusFixture(over: Partial<MigrationStatus> = {}): MigrationStatus {
  return {
    targetId: 'tgt_00000000000000000000000001',
    applied: [
      {
        migrationId: '01M4S9000000000000000000A1',
        name: 'create_orders',
        checksum: `sha256:c1:${'ab'.repeat(32)}`,
        appliedAt: minutesAgo(90),
        operationId: null,
        origin: 'exponetdb',
        reverted: false,
        verification: { status: 'passed', verifiedAt: minutesAgo(89), verifyDigest: null },
      },
    ],
    pending: [
      {
        migrationId: '01M4S9000000000000000000A2',
        name: 'add_orders_index',
        checksum: `sha256:c1:${'cd'.repeat(32)}`,
      },
    ],
    baselineId: null,
    ledgerStateHash: null,
    mirror: { inSync: true, checkedAt: minutesAgo(2) },
    source: 'live',
    observedAt: NOW(),
    ...over,
  } as MigrationStatus
}

export function streamFixture(over: Partial<MigrationStream> = {}): MigrationStream {
  const cell = (environment: string, state: string, extra = {}) => ({
    environment,
    state,
    checksum: null,
    checksumMatches: null,
    appliedAt: null,
    verification: null,
    observedAt: NOW(),
    ...extra,
  })
  const env = (slug: string, rank: number, tier: 'prod' | 'nonprod', mirror: boolean) => ({
    slug,
    displayName: slug,
    tier,
    evidenceFrom: null,
    rank,
    target: {
      id: `tgt_0000000000000000000000000${rank + 1}`,
      path: `shop/platform/${slug}`,
      lifecycle: 'active',
      generation: 1,
    },
    mirror: mirror
      ? {
          observedAt: minutesAgo(3),
          ledgerStateHash: `sha256:ls1:${'00'.repeat(32)}`,
          baselineId: null,
          divergent: false,
          divergence: null,
          entriesOutsideStream: 0,
        }
      : null,
  })
  return {
    projectId: PROJECT_ID,
    graph: { valid: true, errors: [] },
    heads: ['01M4S9000000000000000000A2'],
    baselines: [],
    bundleCount: 2,
    truncated: false,
    environments: [
      env('development', 0, 'nonprod', true),
      env('staging', 1, 'nonprod', true),
      env('production', 2, 'prod', false),
    ],
    bundles: [
      {
        migrationId: '01M4S9000000000000000000A1',
        name: 'create_orders',
        revision: 1,
        checksum: `sha256:c1:${'ab'.repeat(32)}`,
        dependsOn: [],
        states: [
          cell('development', 'verified'),
          cell('staging', 'applied'),
          cell('production', 'unknown', { observedAt: null }),
        ],
      },
      {
        migrationId: '01M4S9000000000000000000A2',
        name: 'add_orders_index',
        revision: 1,
        checksum: `sha256:c1:${'cd'.repeat(32)}`,
        dependsOn: ['01M4S9000000000000000000A1'],
        states: [
          cell('development', 'applied', { checksumMatches: false }),
          cell('staging', 'not_applied'),
          cell('production', 'unknown', { observedAt: null }),
        ],
      },
    ],
    source: 'sampled',
    observedAt: NOW(),
    ...over,
  } as MigrationStream
}

export function overviewFixture(over: Partial<SchemaOverview> = {}): SchemaOverview {
  return {
    targetId: 'tgt_00000000000000000000000001',
    fingerprint: `sha256:fp1:${'ab'.repeat(32)}`,
    pgMajor: 17,
    complete: true,
    visibility: { complete: true, gapCount: 0, gaps: [], missingSchemas: [] },
    schemas: [
      { name: 'public', managed: false, objectCounts: { table: 2, view: 1, index: 3 } },
      { name: 'exponetdb', managed: true, objectCounts: { table: 4 } },
    ],
    source: 'live',
    observedAt: NOW(),
    ...over,
  } as SchemaOverview
}

export function fingerprintFixture(
  over: Partial<SchemaFingerprintResult> = {},
): SchemaFingerprintResult {
  return {
    targetId: 'tgt_00000000000000000000000001',
    fingerprint: `sha256:fp1:${'ab'.repeat(32)}`,
    canonicalizer: 'fp1',
    complete: true,
    documentDigest: `sha256:${'cd'.repeat(32)}`,
    entries: 42,
    pgMajor: 17,
    snapshotId: 'smp_00000000000000000000000001',
    visibility: { complete: true, gapCount: 0, gaps: [], missingSchemas: [] },
    source: 'live',
    observedAt: NOW(),
    ...over,
  } as SchemaFingerprintResult
}

export function ref(over: Partial<SchemaObjectRef> & { name: string }): SchemaObjectRef {
  const schema = over.schema ?? 'public'
  return {
    kind: 'table',
    schema,
    signature: null,
    parent: null,
    key: [schema, over.name],
    ...over,
  }
}

export function objectFixture(
  reference: SchemaObjectRef,
  over: Partial<SchemaObject> = {},
): SchemaObject {
  return {
    ref: reference,
    owner: 'app_owner',
    comment: null,
    definition: null,
    columns: null,
    constraints: null,
    indexes: null,
    policies: null,
    rowLevelSecurity: null,
    grants: null,
    sizeBytes: null,
    source: 'live',
    observedAt: NOW(),
    ...over,
  }
}

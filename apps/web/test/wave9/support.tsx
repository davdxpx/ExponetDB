import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { configure, render } from '@testing-library/react'
import { vi } from 'vitest'
import { AppProviders } from '../../src/app/providers.tsx'
import { createReauthBridge } from '../../src/features/reauth/reauth.tsx'
import { ApiClient, type ResponseOf } from '../../src/lib/api/client.ts'
import { createQueryClient } from '../../src/lib/query/client.ts'
import { routeTree } from '../../src/routeTree.gen.ts'
import { answer, type FailureSpec, NOW_ISO, project, World } from '../target/support.tsx'

export { NOW_ISO, project }

/**
 * A fake server for the Wave 9 pages on top of the target `World`: the
 * statement and table statistics, advisors, the backup reads of one cluster,
 * the fleet's backup overview, sessions, and the actions (plans answer with a
 * plan view, inline operations with an operation). Anything it was not given
 * answers 404, as a route that has not landed would, so a page must show a
 * named failure. Every request is recorded with its method and body.
 */
configure({ asyncUtilTimeout: 5_000 })
vi.setConfig({ testTimeout: 30_000 })

export const BIDI = String.fromCodePoint(0x202e)
export const CLUSTER = 'cls_01M4S9000000000000000000AF'
export const REPO = 'bkr_01M4S9000000000000000000R1'
export const REPO2 = 'bkr_01M4S9000000000000000000R2'
export const BACKUP = 'bkp_01M4S9000000000000000000B1'
export const DRILL = 'drl_01M4S9000000000000000000D1'
export const RESTORE = 'rst_01M4S9000000000000000000S1'
export const NODE = 'nod_01M4S9000000000000000000N1'
export const PLAN = 'pln_01M4S9000000000000000000AA'
export const OPERATION = 'op_01M4S9000000000000000000P1'
export const DIGEST = `sha256:${'ab'.repeat(32)}`
export const TARGET = 'shop/platform/staging'

export type QueryStats = ResponseOf<'getQueryStats'>
export type TableStats = ResponseOf<'getTableStats'>
export type AdvisorRun = ResponseOf<'runAdvisors'>
export type Catalog = ResponseOf<'listClusterBackups'>
export type Protection = Catalog['protection']
export type RepositoryList = ResponseOf<'listBackupRepositories'>
export type Repository = RepositoryList['repositories'][number]
export type Overview = ResponseOf<'getBackupOverview'>
export type Drill = ResponseOf<'listDrills'>['drills'][number]
export type Restore = ResponseOf<'listRestores'>['restores'][number]
export type Session = ResponseOf<'listSessions'>['sessions'][number]

export interface Sent {
  readonly method: string
  readonly path: string
  readonly body: unknown
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

export function queryStats(over: Partial<QueryStats> = {}): QueryStats {
  return {
    targetId: 'tgt_00000000000000000000000002',
    window: { from: ago(86_400_000), to: NOW_ISO() },
    statements: [
      {
        digest: `sha256:${'cd'.repeat(32)}`,
        normalizedText: 'select * from orders where id = $1',
        calls: 1200,
        totalTimeMs: 3400.5,
        meanTimeMs: 2.83,
        rows: 1200,
        sharedBlocksHit: 9000,
        sharedBlocksRead: 12,
        database: 'shop',
        role: 'app_rw',
        regression: {
          state: 'regressed',
          meanTimeMs24h: 2.83,
          meanTimeMs7d: 1.1,
          factor: 2.57,
          thresholdFactor: 2,
          minCalls: 50,
          migrationsBetween: 2,
        },
      },
    ],
    truncated: false,
    source: 'sampled',
    observedAt: NOW_ISO(),
    sampling: {
      state: 'active',
      intervalSeconds: 300,
      lastSampleAt: NOW_ISO(),
      lastErrorCode: null,
      resets: [],
      gaps: [],
    },
    ...over,
  }
}

export function tableStats(over: Partial<TableStats> = {}): TableStats {
  return {
    targetId: 'tgt_00000000000000000000000002',
    tables: [
      {
        schema: 'public',
        name: 'orders',
        sizeBytes: 10 * 1024 * 1024,
        indexSizeBytes: 2 * 1024 * 1024,
        sequentialScans: 5,
        indexScans: 900,
        liveTuples: 1000,
        deadTuples: 40,
        lastVacuumAt: null,
        lastAutovacuumAt: ago(3_600_000),
        lastAnalyzeAt: null,
        lastAutoanalyzeAt: null,
        bloatEstimateBytes: 1024 * 1024,
        xidAge: 12345,
      },
    ],
    indexes: [
      {
        schema: 'public',
        table: 'orders',
        name: 'orders_pkey',
        sizeBytes: 8192,
        scans: 0,
        valid: true,
        duplicateOf: null,
        primary: true,
        unique: true,
      },
      {
        schema: 'public',
        table: 'orders',
        name: 'orders_status_idx',
        sizeBytes: 8192,
        scans: 0,
        valid: true,
        duplicateOf: null,
      },
      {
        schema: 'public',
        table: 'orders',
        name: 'orders_status_idx2',
        sizeBytes: 8192,
        scans: 3,
        valid: false,
        duplicateOf: 'orders_status_idx',
      },
    ],
    truncated: false,
    source: 'live',
    observedAt: NOW_ISO(),
    statsSince: '2026-10-01T00:00:00.000Z',
    estimateMethod: 'heuristic_page_estimate',
    ...over,
  }
}

export function advisorRun(over: Partial<AdvisorRun> = {}): AdvisorRun {
  return {
    targetId: 'tgt_00000000000000000000000002',
    ranAt: NOW_ISO(),
    id: 'adv_01M4S9000000000000000000AV',
    catalogVersion: 3,
    findings: [
      {
        rule: 'unindexed_foreign_key',
        category: 'performance',
        level: 'warning',
        object: `public.orders${BIDI}`,
        message: 'The foreign key has no index.',
        remediation: 'Create an index on the referencing columns.',
        findingId: 'fnd_01M4S9000000000000000000F1',
        evidence: { columns: 'customer_id', rows: 1000 },
        draft: 'migration_draft',
      },
    ],
    skipped: [{ rule: 'wraparound_risk', reason: 'needs_node' }],
    ...over,
  }
}

export function protection(over: Partial<Protection> = {}): Protection {
  return {
    state: 'unproven',
    reasons: ['lock_not_proven', 'drill_never'],
    rpo: {
      achievableSeconds: 120,
      uncertaintySeconds: 60,
      basis: 'wal_archive',
      objectiveSeconds: 900,
    },
    rto: { measuredSeconds: null, drillId: null, drillAt: null, objectiveSeconds: 3600 },
    pitrWindow: { from: ago(7 * 86_400_000), to: ago(120_000) },
    lastVerifiedBackupAt: ago(86_400_000),
    drill: { state: 'never', lastPassedAt: null, cadenceDays: 30 },
    ...over,
  }
}

export function catalog(over: Partial<Catalog> = {}): Catalog {
  return {
    clusterId: CLUSTER,
    state: 'unproven',
    backups: [
      {
        id: BACKUP,
        repositoryId: REPO,
        engineLabel: '20261026-020000F',
        kind: 'full',
        state: 'succeeded',
        startedAt: ago(86_400_000),
        finishedAt: ago(86_000_000),
        sizeBytes: 50 * 1024 * 1024,
        repositorySizeBytes: 20 * 1024 * 1024,
        lsnStart: '0/3000028',
        lsnStop: '0/3000100',
        timeline: 1,
        postgresMajor: 17,
        engineVersion: '2.59.3',
        verification: { state: 'pending', verifiedAt: null },
        divergence: 'none',
        firstSeenAt: ago(86_000_000),
        lastSeenAt: NOW_ISO(),
      },
    ],
    walWindow: null,
    achievableRpoSeconds: 120,
    lastDrillAt: null,
    truncated: false,
    source: 'cached',
    observedAt: NOW_ISO(),
    repositories: [
      {
        id: REPO,
        layer: 'l1_physical',
        engine: 'pgbackrest',
        provider: 'hetzner_object_storage',
        ownership: 'adopted_runs',
        state: 'active',
        lockCapability: 'unproven',
        reconciledAt: NOW_ISO(),
      },
    ],
    protection: protection(),
    walCoverage: [
      {
        repositoryId: REPO,
        timeline: 1,
        from: { lsn: '0/3000028', at: ago(7 * 86_400_000) },
        to: { lsn: '0/9000000', at: ago(120_000) },
        gaps: [],
        observedAt: NOW_ISO(),
      },
    ],
    nextCursor: null,
    ...over,
  }
}

export function repository(over: Partial<Repository> = {}): Repository {
  return {
    id: REPO,
    clusterId: CLUSTER,
    layer: 'l1_physical',
    engine: 'pgbackrest',
    provider: 'hetzner_object_storage',
    location: null,
    priority: 1,
    purpose: 'primary',
    ownership: 'adopted_runs',
    secretSource: 'host_config',
    lock: { mode: 's3_object_lock', capability: 'unproven', retentionDays: 14, provenAt: null },
    encryption: { cipher: 'aes-256-cbc', offlineCopyConfirmedAt: null },
    engineVersion: { pinned: '2.59.3', observed: '2.59.3', advisory: 'none' },
    state: 'active',
    revision: 1,
    reconciliation: { outcome: 'ok', at: NOW_ISO(), errorCode: null },
    createdAt: ago(10 * 86_400_000),
    retiredAt: null,
    ...over,
  }
}

export function drill(over: Partial<Drill> = {}): Drill {
  return {
    id: DRILL,
    clusterId: CLUSTER,
    restoreId: null,
    repositoryId: REPO,
    selection: 'latest',
    mode: 'control_plane',
    outcome: 'passed',
    measuredRtoSeconds: 1500,
    startedAt: ago(3 * 86_400_000),
    finishedAt: ago(3 * 86_400_000 - 1_500_000),
    ...over,
  }
}

export function restore(over: Partial<Restore> = {}): Restore {
  return {
    id: RESTORE,
    clusterId: CLUSTER,
    targetId: null,
    purpose: 'drill',
    state: 'ready',
    source: {
      repositoryId: REPO,
      backupId: BACKUP,
      pointInTime: null,
      timeline: 1,
      walFrom: null,
      walTo: null,
    },
    destination: { kind: 'scratch', nodeId: NODE, runId: null, port: 55432 },
    phases: [
      { name: 'restore', startedAt: ago(10_000), finishedAt: ago(5_000), outcome: 'passed' },
    ],
    checks: [{ check: 'probe_simple', outcome: 'passed', detail: null }],
    planId: PLAN,
    operationId: null,
    createdAt: ago(20_000),
    finishedAt: null,
    ...over,
  }
}

export function overview(over: Partial<Overview> = {}): Overview {
  return {
    clusters: [
      {
        clusterId: CLUSTER,
        serverId: null,
        displayName: `main${BIDI}`,
        managementMode: 'agent',
        repositories: 1,
        protection: protection(),
      },
    ],
    counts: { protected: 2, atRisk: 1, unprotected: 0, unproven: 3, unknown: 4 },
    nextCursor: null,
    source: 'inferred',
    observedAt: NOW_ISO(),
    ...over,
  }
}

export function session(over: Partial<Session> = {}): Session {
  return {
    pid: 101,
    role: 'app_rw',
    applicationName: 'shop-api',
    backendStart: '2026-10-13T08:00:00.000Z',
    state: 'active',
    stateAgeMs: 2_000,
    transactionAgeMs: 2_000,
    queryAgeMs: 2_000,
    queryStart: '2026-10-13T08:10:00.000Z',
    waitEvent: null,
    statement: null,
    exponetdbOperationId: null,
    ...over,
  }
}

export function planView(kind: string): unknown {
  return {
    id: PLAN,
    kind,
    kindVersion: 1,
    class: 'standard',
    state: 'active',
    planHash: `sha256:ph1:${'ab'.repeat(32)}`,
    createdAt: NOW_ISO(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    actor: { identityId: 'idn_00000000000000000000000001', kind: 'human', via: 'web' },
    clientId: null,
    subject: {
      targetId: null,
      targetPath: null,
      clusterId: CLUSTER,
      nodeId: null,
      tier: 'nonprod',
    },
    contentChecksum: `sha256:${'cd'.repeat(32)}`,
    decision: 'allow',
    requirements: [],
    approvals: { given: 0, required: 0 },
    overriddenRules: [],
  }
}

export function operation(kind: string): unknown {
  return {
    id: OPERATION,
    kind,
    planId: null,
    state: 'running',
    applyOutcome: 'pending',
    verificationOutcome: 'pending',
    subject: { targetId: null, clusterId: CLUSTER },
    actor: { identityId: 'idn_00000000000000000000000001', kind: 'human' },
    createdAt: NOW_ISO(),
    updatedAt: NOW_ISO(),
    waitingFor: null,
    approvalUrl: null,
    errorCode: null,
    steps: [],
  }
}

type Paged = (url: URL) => unknown

export class Wave9World extends World {
  queryStats: QueryStats | ((url: URL) => QueryStats) | undefined
  tableStats: TableStats | undefined
  advisorRun: AdvisorRun | undefined
  advisorFindings: Paged | undefined
  catalog: Catalog | ((url: URL) => Catalog) | undefined
  repositories: RepositoryList | undefined
  policy: unknown
  runs: unknown
  drills: unknown
  restores: unknown
  clusterFindings: unknown
  overview: Overview | ((url: URL) => Overview) | undefined
  runbook: unknown
  nodes: unknown
  sessions: Session[] | undefined
  /** Failures of a request, by `METHOD <path substring>` (first match wins). */
  readonly refusals = new Map<string, FailureSpec>()
  readonly sent: Sent[] = []
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const notFound = () => json(404, { code: 'NOT_FOUND', message: 'Not found.' })
const give = (value: unknown, url: URL) =>
  value === undefined ? notFound() : json(200, typeof value === 'function' ? value(url) : value)

const POSTS: readonly (readonly [RegExp, number, string, 'plan' | 'operation'])[] = [
  [/\/backup-runs$/, 201, 'backup.run', 'plan'],
  [/\/drills$/, 201, 'restore.drill', 'plan'],
  [/\/restore-plans$/, 201, 'restore.execute', 'plan'],
  [/\/restores\/[^/]+\/discard$/, 201, 'restore.discard', 'plan'],
  [/\/backup-repositories$/, 201, 'backup.repository.adopt', 'plan'],
  [/\/backup-policy$/, 201, 'backup.policy.set', 'plan'],
  [/\/sessions\/\d+\/terminate$/, 201, 'connections.terminate', 'plan'],
  [/\/backups\/refresh$/, 202, 'backup.catalog.refresh', 'operation'],
  [/\/backups\/[^/]+\/verify$/, 202, 'backup.verify', 'operation'],
  [/\/sessions\/\d+\/cancel$/, 202, 'connections.cancel', 'operation'],
]

function respond(world: Wave9World, method: string, input: string, body: unknown): Response {
  const url = new URL(input, 'http://localhost')
  const p = url.pathname
  const request = `${p}${url.search}`
  for (const [part, failure] of world.refusals) {
    if (`${method} ${request}`.includes(part)) {
      world.requests.push(request)
      world.sent.push({ method, path: request, body })
      return json(failure.status, {
        code: failure.code,
        message: failure.message ?? `${failure.code} happened.`,
      })
    }
  }
  if (method !== 'GET') {
    world.requests.push(request)
    world.sent.push({ method, path: request, body })
    if (p.endsWith('/advisor-runs')) {
      return world.advisorRun === undefined ? notFound() : json(200, world.advisorRun)
    }
    if (p.endsWith('/drills/offline')) {
      return json(201, { ...drillOf(body), mode: 'offline_runbook', outcome: 'attested' })
    }
    for (const [pattern, status, kind, shape] of POSTS) {
      if (pattern.test(p)) return json(status, shape === 'plan' ? planView(kind) : operation(kind))
    }
    return notFound()
  }
  const mine =
    /\/(query-stats|table-stats|backup-repositories|backup-policy|backup-runs|drills|restores|restore-runbook|sessions|locks)$/.test(
      p,
    ) ||
    /^\/api\/v1\/clusters\/[^/]+\/(backups|findings)$/.test(p) ||
    p === '/api/v1/backups/overview' ||
    p === '/api/v1/nodes' ||
    (p === '/api/v1/findings' && world.advisorFindings !== undefined)
  if (!mine) return answer(world, input)
  for (const [part, failure] of world.failures) {
    if (request.includes(part)) {
      world.requests.push(request)
      return json(failure.status, {
        code: failure.code,
        message: failure.message ?? `${failure.code} happened.`,
      })
    }
  }
  world.requests.push(request)
  if (p.endsWith('/query-stats')) return give(world.queryStats, url)
  if (p.endsWith('/table-stats')) return give(world.tableStats, url)
  if (p === '/api/v1/findings') return give(world.advisorFindings, url)
  if (p.endsWith('/backups')) return give(world.catalog, url)
  if (p.endsWith('/backup-repositories')) return give(world.repositories, url)
  if (p.endsWith('/backup-policy')) return give(world.policy, url)
  if (p.endsWith('/backup-runs')) return give(world.runs, url)
  if (p.endsWith('/drills')) return give(world.drills, url)
  if (p.endsWith('/restores')) return give(world.restores, url)
  if (p.endsWith('/findings')) return give(world.clusterFindings, url)
  if (p.endsWith('/restore-runbook')) return give(world.runbook, url)
  if (p === '/api/v1/backups/overview') return give(world.overview, url)
  if (p === '/api/v1/nodes') return give(world.nodes, url)
  if (p.endsWith('/sessions')) {
    return world.sessions === undefined
      ? notFound()
      : json(200, {
          targetId: 'tgt_00000000000000000000000002',
          source: 'live',
          observedAt: NOW_ISO(),
          cap: 500,
          truncated: false,
          sessions: world.sessions,
        })
  }
  if (p.endsWith('/locks')) {
    return json(200, {
      targetId: 'tgt_00000000000000000000000002',
      source: 'live',
      observedAt: NOW_ISO(),
      truncated: false,
      waits: [],
    })
  }
  return notFound()
}

function drillOf(body: unknown) {
  const b = (body ?? {}) as { repositoryId?: string; durationSeconds?: number }
  return {
    id: DRILL,
    clusterId: CLUSTER,
    restoreId: null,
    repositoryId: b.repositoryId ?? REPO,
    selection: 'latest',
    measuredRtoSeconds: null,
    startedAt: null,
    finishedAt: NOW_ISO(),
  }
}

/** A world with the target of `TARGET` placed on `CLUSTER` and its health sampled. */
export function placedWorld(): Wave9World {
  const world = new Wave9World()
  project(world)
  for (const path of [TARGET, 'shop/platform/production']) {
    world.update(path, {
      placement: {
        clusterId: CLUSTER,
        generation: 1,
        since: '2026-10-01T00:00:00.000Z',
        serverName: 'db-01',
        clusterName: 'main',
        managementMode: 'agent',
        postgresVersion: '17.2',
      },
    })
    world.sample(path)
  }
  return world
}

export function mountWave9(initialPath: string, world: Wave9World) {
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const text = String(input)
    for (const [part, held] of world.delays) {
      if (text.includes(part)) await held
    }
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    return respond(world, init?.method ?? 'GET', text, body)
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
  return { router, queryClient, fetchFn }
}

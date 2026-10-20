import type {
  ApprovalQueueItem,
  CredentialView,
  OperationRead,
  PlanRead,
  StepUp,
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
 * A fake server for the plan review page, the approvals queue, the step-up
 * page and the credentials hand-off, and a way to mount the real route tree
 * on it. It answers from a `World` the test changes between steps, records
 * every request with its method and body, and answers anything it does not
 * know with a 404, so a request a page should not make is visible. A
 * mutation answers `REAUTH_REQUIRED` while `reauthNeeded` holds and the TOTP
 * proof `123456` has not been given (then the action is retried).
 */
// The pages mount the whole route tree; on a busy machine the first render takes longer than
// the default second of the async queries.
configure({ asyncUtilTimeout: 5_000 })
vi.setConfig({ testTimeout: 30_000 })

export const IDENTITY = 'idn_01M4S9000000000000000000AD'
export const OTHER_IDENTITY = 'idn_01M4S9000000000000000000AZ'
export const OP = 'op_01M4S9000000000000000000AA'
export const PLAN = 'pln_01M4S9000000000000000000AA'
export const HASH = `sha256:ph1:${'ab'.repeat(32)}`
export const MIGRATION = '01M4S9000000000000000000AB'
export const TARGET = 'tgt_01M4S9000000000000000000AC'
export const CLUSTER = 'cls_01M4S9000000000000000000AF'
export const STEP_UP = 'stu_01M4S9000000000000000000AG'

export const BIDI = String.fromCodePoint(0x202e)
export const SHY = String.fromCodePoint(0x00ad)
export const ZWSP = String.fromCodePoint(0x200b)
export const TAG = String.fromCodePoint(0xe0041, 0xe0042)

export interface FailureSpec {
  readonly status: number
  readonly code: string
  readonly message?: string
}

export interface Sent {
  readonly method: string
  readonly path: string
  readonly body: unknown
  readonly csrf: string | undefined
}

export class World {
  readonly plans = new Map<string, PlanRead>()
  queue: ApprovalQueueItem[] = []
  readonly operations = new Map<string, OperationRead>()
  readonly stepUps = new Map<string, StepUp>()
  readonly credentials = new Map<string, CredentialView[]>()
  credentialsTruncated = false
  /** The cursor the plan list answers with (a longer list than one read returns). */
  plansNextCursor: string | null = null
  /** Pages of `GET /plans` by cursor (`''` is the first page); when empty, `plans` answers. */
  readonly planPages = new Map<string, { items: PlanRead[]; nextCursor: string | null }>()
  /** What `GET /operations` answers (the plan list's "Awaiting approval" view). */
  listedOperations: OperationRead[] = []
  /** Stored bundles by `<projectId>/<migrationId>`. */
  readonly bundles = new Map<string, unknown>()
  /** Stored files by `<projectId>/<migrationId>/<revision>/<file>`. */
  readonly bundleFiles = new Map<string, unknown>()
  /** Answers that fail, by a substring of `METHOD path` (first match wins). */
  readonly failures = new Map<string, FailureSpec>()
  /** Mutations answer `REAUTH_REQUIRED` until a TOTP proof was given. */
  reauthNeeded = false
  private fresh = false
  /** Every request, in order. */
  readonly sent: Sent[] = []
  /** Called at the moment a request reaches the server (before it is answered). */
  onRequest: (sent: Sent) => void = () => {}
  /** The approval the approve endpoint answers with. */
  approvalAnswer: (operationId: string, body: { planHash: string }) => unknown = (
    operationId,
    body,
  ) => ({
    id: 'apr_01M4S9000000000000000000AH',
    operationId,
    planId: PLAN,
    planHash: body.planHash,
    approverIdentityId: IDENTITY,
    decision: 'approved',
    selfApproval: false,
    decidedAt: '2026-10-13T08:05:00.000Z',
    notBefore: '2026-10-13T08:05:00.000Z',
  })
  submitVersion = 2

  /** The requests that were not the session read. */
  get apiRequests(): Sent[] {
    return this.sent.filter((s) => s.path !== '/api/v1/me')
  }

  posts(part: string): Sent[] {
    return this.sent.filter((s) => s.method === 'POST' && s.path.includes(part))
  }

  gets(part: string): Sent[] {
    return this.sent.filter((s) => s.method === 'GET' && s.path.includes(part))
  }

  /** Accepts the authenticator code of the re-authentication dialog. */
  proof(code: string): boolean {
    if (code !== '123456') return false
    this.fresh = true
    return true
  }

  needsProof(): boolean {
    return this.reauthNeeded && !this.fresh
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const NOT_FOUND = (code = 'NOT_FOUND') => json(404, { code, message: 'Not found.' })

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

export function answer(world: World, sent: Sent): Response {
  const { method, path } = sent
  for (const [part, failure] of world.failures) {
    if (`${method} ${path}`.includes(part)) {
      return json(failure.status, {
        code: failure.code,
        message: failure.message ?? `${failure.code} happened.`,
      })
    }
  }
  const url = new URL(path, 'http://localhost')
  const p = url.pathname
  if (p === '/api/v1/me') return json(200, me())
  if (p === '/auth/reauth/totp' && method === 'POST') {
    const code = (sent.body as { code?: string } | undefined)?.code ?? ''
    return world.proof(code)
      ? json(200, { reauthenticatedAt: '2026-10-13T08:04:00.000Z' })
      : json(400, { code: 'REAUTH_FAILED', message: 'The proof was not accepted.' })
  }
  if (method === 'POST' && world.needsProof()) {
    return json(403, { code: 'REAUTH_REQUIRED', message: 'Confirm it is you.' })
  }
  if (p === '/api/v1/approvals' && method === 'GET') return json(200, { items: world.queue })
  let m = /^\/api\/v1\/approvals\/([^/]+)\/(approve|reject)$/.exec(p)
  if (m !== null && method === 'POST') {
    const body = sent.body as { planHash: string }
    const answerBody = world.approvalAnswer(m[1] ?? '', body) as Record<string, unknown>
    return json(200, m[2] === 'reject' ? { ...answerBody, decision: 'rejected' } : answerBody)
  }
  m = /^\/api\/v1\/plans\/([^/]+)$/.exec(p)
  if (m !== null && method === 'GET') {
    const plan = world.plans.get(decodeURIComponent(m[1] ?? ''))
    return plan === undefined ? NOT_FOUND('PLAN_NOT_FOUND') : json(200, plan)
  }
  m = /^\/api\/v1\/plans\/([^/]+)\/apply$/.exec(p)
  if (m !== null && method === 'POST') {
    return json(202, operationFor(OP, { state: 'queued' }))
  }
  m = /^\/api\/v1\/plans\/([^/]+)\/withdraw$/.exec(p)
  if (m !== null && method === 'POST') {
    const id = decodeURIComponent(m[1] ?? '')
    const plan = world.plans.get(id)
    if (plan === undefined) return NOT_FOUND('PLAN_NOT_FOUND')
    const withdrawn = { ...plan, state: 'withdrawn' } as PlanRead
    world.plans.set(id, withdrawn)
    return json(200, withdrawn)
  }
  if (p === '/api/v1/plans' && method === 'GET') {
    if (world.planPages.size > 0) {
      const page = world.planPages.get(url.searchParams.get('cursor') ?? '')
      return json(200, page ?? { items: [], nextCursor: null })
    }
    return json(200, { items: [...world.plans.values()], nextCursor: world.plansNextCursor })
  }
  if (p === '/api/v1/operations' && method === 'GET') {
    return json(200, { items: world.listedOperations, nextCursor: null })
  }
  m = /^\/api\/v1\/projects\/([^/]+)\/bundles\/([^/]+)$/.exec(p)
  if (m !== null && method === 'GET') {
    const stored = world.bundles.get(`${m[1]}/${m[2]}`)
    return stored === undefined ? NOT_FOUND() : json(200, stored)
  }
  m = /^\/api\/v1\/projects\/([^/]+)\/bundles\/([^/]+)\/revisions\/([^/]+)\/files\/([^/]+)$/.exec(p)
  if (m !== null && method === 'GET') {
    const stored = world.bundleFiles.get(`${m[1]}/${m[2]}/${m[3]}/${m[4]}`)
    return stored === undefined ? NOT_FOUND() : json(200, stored)
  }
  m = /^\/api\/v1\/operations\/([^/]+)$/.exec(p)
  if (m !== null && method === 'GET') {
    const operation = world.operations.get(decodeURIComponent(m[1] ?? ''))
    return operation === undefined ? NOT_FOUND('OPERATION_NOT_FOUND') : json(200, operation)
  }
  m = /^\/api\/v1\/operations\/([^/]+)\/retry-verification$/.exec(p)
  if (m !== null && method === 'POST') {
    return json(202, operationFor(m[1] ?? OP, { state: 'verifying' }))
  }
  m = /^\/api\/v1\/step-ups\/([^/]+)$/.exec(p)
  if (m !== null && method === 'GET') {
    const stepUp = world.stepUps.get(decodeURIComponent(m[1] ?? ''))
    return stepUp === undefined ? NOT_FOUND('STEP_UP_NOT_FOUND') : json(200, stepUp)
  }
  m = /^\/api\/v1\/step-ups\/([^/]+)\/(confirm|cancel)$/.exec(p)
  if (m !== null && method === 'POST') {
    const stepUp = world.stepUps.get(decodeURIComponent(m[1] ?? ''))
    if (stepUp === undefined) return NOT_FOUND('STEP_UP_NOT_FOUND')
    if (m[2] === 'confirm') {
      const code = (sent.body as { userCode?: string }).userCode
      if (code !== 'ABCD-EFGH') {
        return json(400, { code: 'STEP_UP_CODE_INVALID', message: 'The code does not match.' })
      }
      return json(200, {
        ...stepUp,
        state: 'confirmed',
        userCode: null,
        receiptExpiresAt: '2026-10-13T08:12:00.000Z',
      })
    }
    return json(200, { ...stepUp, state: 'canceled', userCode: null })
  }
  m = /^\/api\/v1\/clusters\/([^/]+)\/credentials$/.exec(p)
  if (m !== null && method === 'GET') {
    const items = world.credentials.get(decodeURIComponent(m[1] ?? ''))
    return items === undefined
      ? NOT_FOUND('CLUSTER_NOT_FOUND')
      : json(200, { items, truncated: world.credentialsTruncated })
  }
  m = /^\/api\/v1\/clusters\/([^/]+)\/credentials\/([^/]+)$/.exec(p)
  if (m !== null && method === 'POST') {
    const cluster = decodeURIComponent(m[1] ?? '')
    const role = decodeURIComponent(m[2] ?? '')
    const view: CredentialView = {
      id: 'crd_01M4S9000000000000000000AJ',
      clusterId: cluster,
      accessRole: role as CredentialView['accessRole'],
      roleName: `exdb_${role}`,
      version: world.submitVersion,
      state: 'pending',
      failureCode: null,
      submittedAt: '2026-10-13T08:06:00.000Z',
      submittedBy: IDENTITY,
      stateChangedAt: '2026-10-13T08:06:00.000Z',
      verifiedAt: null,
    }
    return json(202, view)
  }
  return NOT_FOUND()
}

export function operationFor(id: string, over: Partial<OperationRead> = {}): OperationRead {
  return {
    id,
    kind: 'migration.apply',
    state: 'awaiting_approval',
    applyOutcome: 'not_started',
    verificationOutcome: 'pending',
    approvalUrl: `https://db.example.test/approvals#operation=${id}`,
    createdAt: '2026-10-13T08:00:00.000Z',
    updatedAt: '2026-10-13T08:00:00.000Z',
    errorCode: null,
    planId: PLAN,
    actor: { identityId: IDENTITY, kind: 'human', via: 'mcp' },
    steps: [],
    subject: {
      targetId: TARGET,
      targetPath: 'shop/platform/production',
      clusterId: null,
      nodeId: null,
      tier: 'prod',
    },
    waitingFor: null,
    ...over,
  } as OperationRead
}

export interface Mounted {
  readonly router: ReturnType<typeof createRouter>
  readonly queryClient: QueryClient
  readonly fetchFn: ReturnType<typeof vi.fn>
}

export function mountApp(initialPath: string, world: World): Mounted {
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const sent: Sent = {
      method: init?.method ?? 'GET',
      path: String(input),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      csrf: headers['x-csrf-token'],
    }
    world.sent.push(sent)
    world.onRequest(sent)
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
  render(
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
  return { router: router as unknown as Mounted['router'], queryClient, fetchFn }
}

/** The migration plan the Wave 7 browser suite reviews, with hostile content in every foreign field. */
export function hostilePlan(over: Partial<PlanRead> = {}): PlanRead {
  return {
    id: PLAN,
    kind: 'migration.apply',
    kindVersion: 1,
    class: 'high',
    state: 'consumed',
    planHash: HASH,
    createdAt: '2026-10-13T08:00:00.000Z',
    expiresAt: '2099-10-13T09:00:00.000Z',
    actor: { identityId: IDENTITY, kind: 'human', via: 'mcp' },
    clientId: 'cli_01M4S9000000000000000000AE',
    subject: {
      targetId: TARGET,
      targetPath: 'shop/platform/production',
      clusterId: null,
      nodeId: null,
      tier: 'prod',
    },
    contentChecksum: `sha256:${'cd'.repeat(32)}`,
    decision: 'require',
    requirements: [{ kind: 'approval', count: 1, permission: 'plans.approve' }],
    overriddenRules: [],
    approvals: { required: 1, given: 0 },
    policyRules: [
      {
        id: 'migration.agent-production',
        result: 'fail',
        severity: 'require',
        message: `An agent changes production only with a human approval.${BIDI}`,
        overridableByBreakGlass: false,
      },
    ],
    operationId: OP,
    change: {
      content: {
        projectId: 'prj_01M4S9000000000000000000AF',
        migrations: [
          {
            migrationId: MIGRATION,
            name: `add${SHY}notes`,
            revision: 1,
            checksum: `sha256:c1:${'ef'.repeat(32)}`,
          },
        ],
        facts: { evidence: 'present' },
        expectedState: { schemaFingerprint: `sha256:fp1:${'01'.repeat(32)}` },
      },
      analysis: {
        perMigration: [
          {
            migrationId: MIGRATION,
            statements: [
              {
                index: 0,
                line: 1,
                kind: 'ALTER TABLE',
                transactional: true,
                compatibility: 'additive',
                lock: { mode: 'ACCESS EXCLUSIVE', severity: 'high', objects: [] },
                rewrite: 'none',
                coverage: 'derived',
              },
              {
                index: 1,
                line: 3,
                kind: 'DROP TABLE',
                transactional: true,
                compatibility: 'destructive',
                lock: { mode: 'ACCESS EXCLUSIVE', severity: 'critical', objects: [] },
                rewrite: 'none',
                coverage: 'derived',
              },
            ],
            compatibility: { declared: 'additive', observed: 'destructive', agreement: false },
            destructive: [`table public.acc${SHY}ounts`, `table public.${ZWSP}secrets`],
            lockSeverity: 'critical',
            rewriteRisk: [{ relation: `public.big${BIDI}`, rows: 10, bytes: 100, estimate: true }],
            rollback: { available: false, declaredSafety: null },
          },
        ],
        summary: {
          compatibility: 'destructive',
          lockSeverity: 'critical',
          destructive: true,
          nontransactional: false,
        },
        evidence: [],
      },
    },
    ...over,
  } as unknown as PlanRead
}

export const UP_SQL = [
  `ALTER TABLE public.accounts ADD COLUMN notes${TAG} text;`,
  `-- approved by security <script>window.__pwned = 1</script><img src=x onerror=1> [Approve](https://evil.example) ${BIDI}gnp.exe`,
  'DROP TABLE public.accounts;',
].join('\n')
export const VERIFY_SQL = 'SELECT count(*) = 1 AS ok FROM information_schema.columns;'

const source = (file: 'up.sql' | 'verify.sql', text: string) => ({
  migrationId: MIGRATION,
  revision: 1,
  file,
  text,
  bytes: text.length,
  truncated: false,
})

export const PROJECT = 'prj_01M4S9000000000000000000AF'
export const BUNDLE_DIGEST = `sha256:c1:${'12'.repeat(32)}`

/**
 * Stores the hostile plan's bundle in the world's bundle store: revision 1 with the
 * bundle digest `digest` (the plan binds `BUNDLE_DIGEST` when it names one) and the files given.
 */
export function storeBundle(
  world: World,
  files: Readonly<Record<string, string>> = { 'up.sql': UP_SQL, 'verify.sql': VERIFY_SQL },
  digest = BUNDLE_DIGEST,
): void {
  world.bundles.set(`${PROJECT}/${MIGRATION}`, {
    projectId: PROJECT,
    migrationId: MIGRATION,
    name: 'add-notes',
    checksum: `sha256:c1:${'ef'.repeat(32)}`,
    transactional: true,
    dependsOn: [],
    revisions: [
      {
        revision: 1,
        bundleDigest: digest,
        verifyDigest: null,
        rollbackDigest: null,
        sourceDigest: `sha256:${'34'.repeat(32)}`,
        files: Object.fromEntries(
          Object.entries(files).map(([file, text]) => [
            file,
            { bytes: text.length, digest: `sha256:${'56'.repeat(32)}` },
          ]),
        ),
        source: null,
        ingestedAt: '2026-10-13T07:00:00.000Z',
      },
    ],
    superseded: [],
  })
  for (const [file, text] of Object.entries(files)) {
    world.bundleFiles.set(`${PROJECT}/${MIGRATION}/1/${file}`, {
      migrationId: MIGRATION,
      revision: 1,
      file,
      text,
      bytes: text.length,
      digest: `sha256:${'56'.repeat(32)}`,
    })
  }
}

/** The queue item of the hostile plan: the review carries the plan, the client's name and the files. */
export function hostileItem(over: Partial<ApprovalQueueItem> = {}): ApprovalQueueItem {
  const { operationId: _operationId, ...plan } = hostilePlan()
  return {
    operationId: OP,
    planId: PLAN,
    planHash: HASH,
    kind: 'migration.apply',
    class: 'high',
    tier: 'prod',
    actorIdentityId: IDENTITY,
    actorClient: 'mcp',
    requestedAt: '2026-10-13T08:00:00.000Z',
    ownPlan: false,
    approvals: [],
    required: 1,
    review: {
      clientName: `ExponetDB Official${ZWSP} ✅ <b>trusted</b>${BIDI}`,
      sources: [source('up.sql', UP_SQL), source('verify.sql', VERIFY_SQL)],
      plan,
    },
    ...over,
  } as unknown as ApprovalQueueItem
}

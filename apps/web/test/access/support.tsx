import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { configure, render } from '@testing-library/react'
import { vi } from 'vitest'
import { AppProviders } from '../../src/app/providers.tsx'
import type {
  ApiKey,
  MachineGrant,
  OAuthClient,
  ServiceAccount,
} from '../../src/features/access/model.ts'
import { createReauthBridge } from '../../src/features/reauth/reauth.tsx'
import { ApiClient } from '../../src/lib/api/client.ts'
import { createQueryClient } from '../../src/lib/query/client.ts'
import type { Me } from '../../src/lib/session/guard.tsx'
import { routeTree } from '../../src/routeTree.gen.ts'

/**
 * A fake server for the access administration pages and a way to mount the
 * real route tree on it. It answers the session read, the client and
 * service-account lists and every change those pages make, from a `World`
 * the test changes between steps. Changes answer `REAUTH_REQUIRED` until the
 * authenticator code 123456 was sent (when `needsProof` is set). Every
 * request is recorded with its body; anything else is a 404, so a request a
 * page should not make is visible.
 */
// The pages mount the whole shell; on a loaded machine a dialog or a list can take longer than
// the default second to appear. Waiting longer changes no assertion (these files only).
configure({ asyncUtilTimeout: 5_000 })

export const SECRET = `exak_${'S'.repeat(43)}`
export const FINGERPRINT = `sha256:${'a'.repeat(64)}`
const T0 = '2026-10-13T09:00:00Z'

let counter = 0
const ulid = (prefix: string): string => {
  counter += 1
  return `${prefix}_01JZ${String(counter).padStart(22, '0')}`
}

export function oauthClient(over: Partial<OAuthClient> = {}): OAuthClient {
  return {
    applicationType: 'native',
    approvedAt: null,
    approvedBy: null,
    approvedFingerprint: null,
    clientId: `exdb-dcr-${'c'.repeat(43)}`,
    clientUri: null,
    createdAt: T0,
    firstParty: false,
    grantTypes: ['authorization_code', 'refresh_token'],
    id: ulid('ocl'),
    keys: [],
    kind: 'mcp',
    metadataExpiresAt: null,
    metadataFetchedAt: null,
    metadataFingerprint: FINGERPRINT,
    name: 'Agent',
    pendingExpiresAt: null,
    redirectUris: ['https://agent.example.test/callback'],
    registration: 'dcr',
    requesterHash: null,
    serviceAccountId: null,
    softwareId: null,
    softwareVersion: null,
    state: 'pending',
    stateChangedAt: T0,
    tokenEndpointAuthMethod: 'none',
    ...over,
  }
}

export function apiKey(over: Partial<ApiKey> = {}): ApiKey {
  return {
    createdAt: T0,
    createdBy: 'idn_01JZ0000000000000000000001',
    expiresAt: '2027-01-11T09:00:00Z',
    id: ulid('key'),
    label: null,
    lastUsedAt: null,
    restrictions: { tiers: ['nonprod'], targets: { kind: 'all' } },
    revokedAt: null,
    scopes: ['targets.read'],
    serviceAccountId: 'idn_01JZ0000000000000000000009',
    state: 'active',
    ...over,
  }
}

export function serviceAccount(over: Partial<ServiceAccount> = {}): ServiceAccount {
  return {
    apiKeys: [],
    client: null,
    createdAt: T0,
    createdBy: 'idn_01JZ0000000000000000000001',
    displayName: 'Nightly checks',
    grants: [],
    id: ulid('idn'),
    label: 'svc-nightly-checks',
    responsibleIdentityId: 'idn_01JZ0000000000000000000001',
    state: 'active',
    ...over,
  }
}

export type Permission = Me['effectivePermissions'][number]['permission']

export function meWith(permissions: readonly Permission[]): Me {
  return {
    identity: {
      activatedAt: T0,
      createdAt: T0,
      displayName: 'Ada',
      email: 'owner@example.test',
      factors: { passkeys: 1, password: true, recoveryCodesRemaining: 10, totp: true },
      id: 'idn_01JZ0000000000000000000001',
      kind: 'human',
      label: 'owner',
      recoveryRequired: false,
      state: 'active',
    },
    session: {
      assurance: 'full',
      clientKind: 'web',
      createdAt: T0,
      current: true,
      device: 'Test',
      expiresAt: '2026-10-14T09:00:00Z',
      id: 'wss_01JZ0000000000000000000001',
      idleExpiresAt: '2026-10-13T21:00:00Z',
      lastSeenAt: T0,
      reauthAt: null,
    },
    bindings: [],
    effectivePermissions: permissions.map((permission) => ({ permission, scopes: [] })),
  }
}

export interface Recorded {
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
  clients: OAuthClient[] = []
  accounts: ServiceAccount[] = []
  permissions: Permission[] = ['access.read', 'access.manage']
  /** Changes answer REAUTH_REQUIRED until the authenticator code was sent. */
  needsProof = false
  proven = false
  /** Answers by `METHOD path` (a substring), first match wins. */
  readonly failures = new Map<string, FailureSpec>()
  nextCursor: string | null = null
  readonly requests: Recorded[] = []

  /** The changes the page sent (everything but reads and the proof). */
  get changes(): Recorded[] {
    return this.requests.filter(
      (request) => request.method !== 'GET' && !request.path.startsWith('/auth/'),
    )
  }

  account(id: string): ServiceAccount {
    const found = this.accounts.find((account) => account.id === id)
    if (found === undefined) throw new Error(`no service account ${id}`)
    return found
  }

  replaceAccount(next: ServiceAccount): void {
    this.accounts = this.accounts.map((account) => (account.id === next.id ? next : account))
  }

  replaceClient(next: OAuthClient): void {
    this.clients = this.clients.map((client) => (client.id === next.id ? next : client))
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const problem = (status: number, code: string, message: string) => json(status, { code, message })

function bodyOf(init: RequestInit | undefined): unknown {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/** One answer of the fake server. */
export function answer(world: World, input: string | URL | Request, init?: RequestInit): Response {
  const url = new URL(String(input), 'http://localhost')
  const method = init?.method ?? 'GET'
  const path = url.pathname
  const body = bodyOf(init)
  world.requests.push({ method, path: `${path}${url.search}`, body })
  for (const [part, failure] of world.failures) {
    if (`${method} ${path}${url.search}`.includes(part)) {
      return problem(failure.status, failure.code, failure.message ?? `${failure.code} happened.`)
    }
  }
  if (path === '/api/v1/me') return json(200, meWith(world.permissions))
  if (path === '/auth/reauth/totp') {
    if (record(body)['code'] !== '123456') {
      return problem(400, 'REAUTH_FAILED', 'The proof was not accepted.')
    }
    world.proven = true
    return json(200, { reauthenticatedAt: new Date().toISOString() })
  }
  if (method === 'GET' && path === '/api/v1/oauth-clients') {
    return json(200, { items: world.clients, nextCursor: world.nextCursor })
  }
  if (method === 'GET' && path === '/api/v1/service-accounts') {
    return json(200, { items: world.accounts, nextCursor: world.nextCursor })
  }
  if (method === 'GET') return problem(404, 'NOT_FOUND', 'Not found.')
  if (world.needsProof && !world.proven) {
    return problem(403, 'REAUTH_REQUIRED', 'Confirm it is you.')
  }
  return change(world, method, path, record(body))
}

function change(
  world: World,
  method: string,
  path: string,
  body: Readonly<Record<string, unknown>>,
): Response {
  if (method !== 'POST') return problem(404, 'NOT_FOUND', 'Not found.')
  if (path === '/api/v1/oauth-clients/cimd') {
    const created = oauthClient({
      clientId: String(body['clientId']),
      registration: 'cimd',
      name: 'Fetched client',
    })
    world.clients = [...world.clients, created]
    return json(201, created)
  }
  const decision =
    /^\/api\/v1\/oauth-clients\/([^/]+)\/(approve|reject|disable|refresh-metadata)$/.exec(path)
  if (decision !== null) {
    const client = world.clients.find((c) => c.id === decision[1])
    if (client === undefined) return problem(404, 'NOT_FOUND', 'Not found.')
    const verb = decision[2]
    if (verb === 'approve' && body['fingerprint'] !== client.metadataFingerprint) {
      return problem(409, 'PLAN_STALE', 'The metadata changed since the review.')
    }
    const next: OAuthClient =
      verb === 'approve'
        ? {
            ...client,
            state: 'active',
            approvedBy: 'idn_01JZ0000000000000000000001',
            approvedAt: T0,
            approvedFingerprint: client.metadataFingerprint,
          }
        : verb === 'reject'
          ? { ...client, state: 'rejected' }
          : verb === 'disable'
            ? { ...client, state: 'disabled' }
            : { ...client, metadataFetchedAt: T0 }
    world.replaceClient(next)
    return json(200, next)
  }
  if (path === '/api/v1/service-accounts') {
    const created = serviceAccount({
      displayName: String(body['displayName']),
      label: 'svc-created',
    })
    world.accounts = [...world.accounts, created]
    return json(201, created)
  }
  const sub =
    /^\/api\/v1\/service-accounts\/([^/]+)\/(oauth-client|oauth-client\/keys|grants|api-keys)$/.exec(
      path,
    )
  if (sub?.[1] !== undefined) {
    const account = world.account(sub[1])
    const keys = Array.isArray(record(body['jwks'])['keys'])
      ? (record(body['jwks'])['keys'] as unknown[]).map((key) => {
          const k = record(key)
          return {
            kid: String(k['kid']),
            kty:
              k['kty'] === 'RSA'
                ? ('RSA' as const)
                : k['kty'] === 'OKP'
                  ? ('OKP' as const)
                  : ('EC' as const),
            alg: null,
            thumbprint: 'thumb',
          }
        })
      : []
    switch (sub[2]) {
      case 'oauth-client':
      case 'oauth-client/keys': {
        const client = oauthClient({
          clientId: `cli_${account.id.slice(4)}`,
          registration: 'pre_registered',
          kind: 'ci',
          state: 'active',
          tokenEndpointAuthMethod: 'private_key_jwt',
          keys,
          serviceAccountId: account.id,
        })
        world.replaceAccount({ ...account, client })
        return json(sub[2] === 'oauth-client' ? 201 : 200, client)
      }
      case 'grants': {
        const grant: MachineGrant = {
          client: {
            clientId: account.client?.clientId ?? 'cli_x',
            firstParty: false,
            id: account.client?.id ?? 'ocl_x',
            kind: 'ci',
            name: 'svc',
            registration: 'pre_registered',
            state: 'active',
          },
          consentAt: null,
          createdAt: T0,
          expiresAt: '2027-01-11T09:00:00Z',
          id: ulid('grt'),
          identityId: account.id,
          kind: 'machine',
          lastTokenAt: null,
          resource: 'api',
          resourceUri: 'http://localhost/api/v1',
          restrictions: { tiers: ['nonprod'], targets: { kind: 'all' } },
          revokeReason: null,
          revokedAt: null,
          scopes: ['targets.read'],
          state: 'active',
        }
        world.replaceAccount({
          ...account,
          grants: [...account.grants.map((g) => ({ ...g, state: 'revoked' as const })), grant],
        })
        return json(201, grant)
      }
      case 'api-keys': {
        const created = apiKey({ serviceAccountId: account.id })
        world.replaceAccount({ ...account, apiKeys: [...account.apiKeys, created] })
        return json(201, { apiKey: created, secret: SECRET })
      }
    }
  }
  const revoke = /^\/api\/v1\/api-keys\/([^/]+)\/revoke$/.exec(path)
  if (revoke !== null) {
    for (const account of world.accounts) {
      if (account.apiKeys.some((key) => key.id === revoke[1])) {
        world.replaceAccount({
          ...account,
          apiKeys: account.apiKeys.map((key) =>
            key.id === revoke[1] ? { ...key, state: 'revoked' as const, revokedAt: T0 } : key,
          ),
        })
      }
    }
    return json(200, { revoked: true })
  }
  return problem(404, 'NOT_FOUND', 'Not found.')
}

export function mountApp(initialPath: string, world: World) {
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    answer(world, input, init),
  )
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
  const view = render(
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
  return { router, fetchFn, queryClient, container: view.container }
}

/** Everything the query and mutation caches hold, as JSON text. */
export function cacheText(queryClient: ReturnType<typeof createQueryClient>): string {
  const queries = queryClient
    .getQueryCache()
    .getAll()
    .map((query) => query.state)
  const mutations = queryClient
    .getMutationCache()
    .getAll()
    .map((mutation) => mutation.state)
  return JSON.stringify({ queries, mutations })
}

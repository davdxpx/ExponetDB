import type { BindingScope, Permission, Tier } from '@exponetdb/contracts'
import { type Queryable, Row } from '@exponetdb/control-store'
import { type IdentityId, newId } from '@exponetdb/kernel'
import { describe, expect, it } from 'vitest'
import { authorityChain, registryTier } from '../src/authorization/registry-tier.ts'
import {
  Authorizer,
  ControlPlaneSubjectResolver,
  type Principal,
  type SessionContext,
  type SubjectChain,
  type SubjectChainSource,
  type SubjectRef,
} from '../src/index.ts'

/**
 * The tier-aware `registry.manage` (OD-22, extended 2026-10-13;
 * authorization.md §5.1), decided by the central engine over a synthetic
 * registry: the registry tier of each kind of registry action, environment
 * and target bindings that carry their environment's tier only, and a
 * delegated grant whose tiers must include the registry tier.
 */
const P1 = newId('prd', 1)
const J1 = newId('prj', 2)
const E_STAGING = newId('env', 3)
const E_PRODUCTION = newId('env', 4)
const C_PROD = newId('cls', 5)
const C_NONPROD = newId('cls', 6)
const C_UNDECLARED = newId('cls', 7)
/** Declared nonprod, but a production target was placed on it (derived tier prod). */
const C_NONPROD_HOSTING_PROD = newId('cls', 8)
const STAGING = 'acme/app/staging'
const PRODUCTION = 'acme/app/production'

const CLUSTERS: Record<string, SubjectChain> = {
  [C_PROD]: { cluster: { declaredTier: 'prod' } },
  [C_NONPROD]: { tier: 'nonprod', cluster: { declaredTier: 'nonprod' } },
  [C_UNDECLARED]: { tier: 'nonprod', cluster: { declaredTier: null } },
  [C_NONPROD_HOSTING_PROD]: { tier: 'prod', cluster: { declaredTier: 'nonprod' } },
}

const PATHS: Record<string, SubjectChain> = {
  [STAGING]: { productId: P1, projectId: J1, environmentId: E_STAGING, tier: 'nonprod' },
  [PRODUCTION]: { productId: P1, projectId: J1, environmentId: E_PRODUCTION, tier: 'prod' },
}

const source: SubjectChainSource = {
  target: async () => undefined,
  targetPath: async (path) => PATHS[path],
  product: async (id) => (id === P1 ? { productId: P1 } : undefined),
  project: async (id) => (id === J1 ? { productId: P1, projectId: J1 } : undefined),
  environment: async (id) =>
    id === E_STAGING
      ? { productId: P1, environmentId: E_STAGING, tier: 'nonprod' }
      : id === E_PRODUCTION
        ? { productId: P1, environmentId: E_PRODUCTION, tier: 'prod' }
        : undefined,
  cluster: async (id) => CLUSTERS[id],
  server: async () => ({}),
}

const authorizer = new Authorizer(new ControlPlaneSubjectResolver(source))
const IDENTITY: IdentityId = newId('idn', 99)

/** A Control Store stand-in that answers only the grants query: the admin role at one scope. */
function store(scope: BindingScope): Queryable {
  const scopeId =
    scope.kind === 'global'
      ? null
      : scope.kind === 'product'
        ? scope.productId
        : scope.kind === 'project'
          ? scope.projectId
          : scope.kind === 'environment'
            ? scope.environmentId
            : scope.targetId
  const permissions: Permission[] = ['registry.manage', 'targets.read', 'nodes.read']
  return {
    async query(queryClass) {
      if (queryClass !== 'auth.grants.load') throw new Error(`unexpected query ${queryClass}`)
      const rows = permissions.map(
        (permission, i) =>
          new Row({
            binding_id: newId('rlb', 1000 + i),
            role_id: 'admin',
            scope_kind: scope.kind,
            scope_id: scopeId,
            permission,
          }),
      )
      return { rows, rowCount: rows.length }
    },
  }
}

function session(): SessionContext {
  return {
    sessionId: newId('ses', 1),
    identityId: IDENTITY,
    labelNumber: 1,
    label: 'human #1',
    assurance: 'full',
    recoveryRequired: false,
    reauthAt: '2026-10-13T00:00:00.000000Z',
    reauthAgeSeconds: 30,
    reauthMethod: 'passkey',
    reauthEventId: newId('rau', 1),
    authzRevision: 1,
    createdAt: '2026-10-13T00:00:00.000000Z',
    lastSeenAt: '2026-10-13T00:00:00.000000Z',
    idleExpiresAt: '2026-10-13T00:30:00.000000Z',
    absoluteExpiresAt: '2026-10-13T12:00:00.000000Z',
    deviceLabel: 'Chrome on Linux',
    csrfHash: `sha256:${'0'.repeat(64)}`,
  }
}

const web: Principal = { kind: 'human', identityId: IDENTITY, client: 'web', session: session() }

/** A person's first-party CLI with `registry.manage` and the given grant tiers. */
function cli(tiers: Tier[]): Principal {
  return {
    kind: 'delegated',
    identityId: IDENTITY,
    identityKind: 'human',
    label: 'human #1',
    client: 'cli',
    delegation: {
      credential: {
        type: 'access_token',
        grantId: newId('grt', 1),
        clientId: newId('cli', 1),
        grantKind: 'delegated',
      },
      resource: 'api',
      scopes: new Set(['registry.manage', 'targets.read', 'nodes.read']),
      restrictions: { tiers, targets: { kind: 'all' } },
    },
  }
}

const GLOBAL: BindingScope = { kind: 'global' }
const PRODUCT: BindingScope = { kind: 'product', productId: P1 }
const STAGING_ENV: BindingScope = { kind: 'environment', environmentId: E_STAGING }
const PRODUCTION_ENV: BindingScope = { kind: 'environment', environmentId: E_PRODUCTION }

const placement = (path: string, clusterId: string): SubjectRef => ({
  kind: 'plan',
  subject: { targetPath: path, tier: PATHS[path]?.tier ?? 'prod', clusterId },
})

async function decide(
  who: Principal,
  binding: BindingScope,
  action: string,
  subject: SubjectRef,
  planKind?: string,
): Promise<string> {
  const result = await authorizer.authorize(
    store(binding),
    {
      action,
      principal: who,
      ...(who.kind === 'delegated' ? { resource: 'api' as const } : {}),
      ...(planKind === undefined ? {} : { planKind }),
    },
    subject,
  )
  return result.allowed ? 'allow' : result.error.code
}

describe('registry tiers', () => {
  it('derive the tier of each kind of registry action from the registry, failing closed', () => {
    expect(registryTier('production', {})).toBe('prod')
    expect(registryTier('cluster_registry', { cluster: { declaredTier: 'nonprod' } })).toBe(
      'nonprod',
    )
    expect(registryTier('cluster_registry', { cluster: { declaredTier: null } })).toBe('prod')
    expect(
      registryTier('cluster_registry', { tier: 'prod', cluster: { declaredTier: 'nonprod' } }),
    ).toBe('prod')
    expect(registryTier('cluster_registry', { tier: 'nonprod' })).toBeUndefined()
    const staging = PATHS[STAGING] ?? {}
    expect(registryTier('placement', { ...staging, cluster: { declaredTier: 'prod' } })).toBe(
      'prod',
    )
    expect(registryTier('placement', { ...staging, cluster: { declaredTier: null } })).toBe('prod')
    expect(registryTier('placement', { ...staging, cluster: { declaredTier: 'nonprod' } })).toBe(
      'nonprod',
    )
    expect(
      registryTier('placement', { ...PATHS[PRODUCTION], cluster: { declaredTier: 'nonprod' } }),
    ).toBe('prod')
    expect(registryTier('placement', staging)).toBeUndefined()
    // Only a raise above the subject's own tier marks it.
    expect(authorityChain(staging, 'prod').tierRaised).toBe(true)
    expect(authorityChain(staging, 'nonprod').tierRaised).toBeUndefined()
    expect(authorityChain(PATHS[PRODUCTION] ?? {}, 'prod').tierRaised).toBeUndefined()
  })
})

describe('registering a database (target.register) by placement', () => {
  it('needs production authority on a cluster declared prod or undeclared, whatever environment', async () => {
    for (const cluster of [C_PROD, C_UNDECLARED]) {
      // A nonprod environment binding carries nonprod authority only.
      expect(
        await decide(web, STAGING_ENV, 'target.register.plan', placement(STAGING, cluster)),
      ).toBe('PERMISSION_DENIED')
      // Global and product bindings span both tiers.
      expect(await decide(web, GLOBAL, 'target.register.plan', placement(STAGING, cluster))).toBe(
        'allow',
      )
      expect(await decide(web, PRODUCT, 'target.register.plan', placement(STAGING, cluster))).toBe(
        'allow',
      )
    }
  })

  it('lets the environment decide on a cluster declared nonprod', async () => {
    for (const cluster of [C_NONPROD, C_NONPROD_HOSTING_PROD]) {
      expect(
        await decide(web, STAGING_ENV, 'target.register.plan', placement(STAGING, cluster)),
      ).toBe('allow')
      expect(
        await decide(web, STAGING_ENV, 'target.register.plan', placement(PRODUCTION, cluster)),
      ).toBe('PERMISSION_DENIED')
      expect(
        await decide(web, PRODUCTION_ENV, 'target.register.plan', placement(PRODUCTION, cluster)),
      ).toBe('allow')
    }
  })

  it('decides again at apply with the cluster as the registry holds it now', async () => {
    const targetId = newId('tgt', 50)
    const apply = (clusterId: string): SubjectRef => ({
      kind: 'plan',
      subject: { targetId, targetPath: STAGING, tier: 'nonprod', clusterId },
    })
    expect(await decide(web, STAGING_ENV, 'plan.apply', apply(C_NONPROD), 'target.register')).toBe(
      'allow',
    )
    expect(await decide(web, STAGING_ENV, 'plan.apply', apply(C_PROD), 'target.register')).toBe(
      'PERMISSION_DENIED',
    )
    expect(await decide(web, GLOBAL, 'plan.apply', apply(C_PROD), 'target.register')).toBe('allow')
    // A grant for nonprod only cannot apply it once the cluster is production.
    expect(
      await decide(cli(['nonprod']), GLOBAL, 'plan.apply', apply(C_PROD), 'target.register'),
    ).toBe('TIER_NOT_PERMITTED')
    expect(
      await decide(cli(['nonprod']), GLOBAL, 'plan.apply', apply(C_NONPROD), 'target.register'),
    ).toBe('allow')
  })

  it('denies when the cluster cannot be read (no registry facts)', async () => {
    const unknown = newId('cls', 60)
    expect(await decide(web, GLOBAL, 'target.register.plan', placement(STAGING, unknown))).toBe(
      'PERMISSION_DENIED',
    )
    expect(
      await decide(web, GLOBAL, 'target.register.plan', {
        kind: 'plan',
        subject: { targetPath: STAGING, tier: 'nonprod' },
      }),
    ).toBe('PERMISSION_DENIED')
  })
})

describe('cluster registry actions and the declared tier', () => {
  it('declares a tier only with production authority, whichever value', async () => {
    for (const cluster of [C_PROD, C_NONPROD, C_UNDECLARED]) {
      const subject: SubjectRef = { kind: 'cluster', clusterId: cluster }
      expect(await decide(web, GLOBAL, 'registry.cluster.declare_tier.plan', subject)).toBe('allow')
      expect(await decide(web, STAGING_ENV, 'registry.cluster.declare_tier.plan', subject)).toBe(
        'PERMISSION_DENIED',
      )
      expect(
        await decide(cli(['nonprod']), GLOBAL, 'registry.cluster.declare_tier.plan', subject),
      ).toBe('TIER_NOT_PERMITTED')
      expect(
        await decide(
          cli(['prod', 'nonprod']),
          GLOBAL,
          'registry.cluster.declare_tier.plan',
          subject,
        ),
      ).toBe('allow')
    }
  })

  it('records a database of a cluster at the cluster registry tier', async () => {
    const register = (clusterId: string) =>
      decide(cli(['nonprod']), GLOBAL, 'registry.database.register.plan', {
        kind: 'cluster',
        clusterId,
      })
    expect(await register(C_NONPROD)).toBe('allow')
    expect(await register(C_PROD)).toBe('TIER_NOT_PERMITTED')
    expect(await register(C_UNDECLARED)).toBe('TIER_NOT_PERMITTED')
    expect(await register(C_NONPROD_HOSTING_PROD)).toBe('TIER_NOT_PERMITTED')
  })

  it('keeps installation-wide registry changes to unrestricted grants and production authority', async () => {
    const installation: SubjectRef = { kind: 'installation' }
    expect(
      await decide(cli(['nonprod']), GLOBAL, 'registry.server.create.plan', installation),
    ).toBe('TIER_NOT_PERMITTED')
    // A grant for prod alone is still restricted: installation-wide needs an unrestricted one.
    expect(await decide(cli(['prod']), GLOBAL, 'registry.server.create.plan', installation)).toBe(
      'PERMISSION_DENIED',
    )
    expect(
      await decide(cli(['prod', 'nonprod']), GLOBAL, 'registry.server.create.plan', installation),
    ).toBe('allow')
    // An environment change is production authority, even for a nonprod environment.
    const staging: SubjectRef = { kind: 'environment', environmentId: E_STAGING }
    expect(await decide(web, STAGING_ENV, 'registry.environment.update.plan', staging)).toBe(
      'PERMISSION_DENIED',
    )
    expect(await decide(web, PRODUCT, 'registry.environment.update.plan', staging)).toBe('allow')
  })
})

import type { ResponseOf } from '../../src/lib/api/client.ts'
import { BGL, CLIENT, GRANT, ME, OTHER, T0, TARGET } from './support.tsx'

/** Typed fixtures of the access, audit and settings answers (neutral names only). */
export type Identity = ResponseOf<'listIdentities'>['items'][number]
export type RoleBinding = ResponseOf<'listRoleBindings'>['items'][number]
export type Grant = ResponseOf<'listGrants'>['items'][number]
export type AuditEvent = ResponseOf<'searchAuditEvents'>['items'][number]
export type AuditChain = ResponseOf<'getAuditChain'>
export type BreakGlassGrant = ResponseOf<'listBreakGlassGrants'>['items'][number]
export type PolicyRule = ResponseOf<'getPolicySettings'>['rules'][number]
export type Environment = ResponseOf<'listProductEnvironments'>['items'][number]

export function identity(over: Partial<Identity> = {}): Identity {
  return {
    activatedAt: T0,
    createdAt: T0,
    displayName: 'Grace',
    email: 'grace@example.test',
    factors: { passkeys: 2, password: true, recoveryCodesRemaining: 9, totp: true },
    id: OTHER,
    kind: 'human',
    label: 'grace',
    recoveryRequired: false,
    state: 'active',
    ...over,
  }
}

export function binding(over: Partial<RoleBinding> = {}): RoleBinding {
  return {
    createdAt: T0,
    createdByOperationId: null,
    id: 'rbd_01JZ0000000000000000000001',
    identityId: OTHER,
    revokedAt: null,
    roleId: 'developer',
    scope: { kind: 'product', productId: 'prd_01JZ0000000000000000000001' },
    state: 'active',
    ...over,
  }
}

export const ROLES: ResponseOf<'listRoles'> = {
  items: [
    {
      builtIn: true,
      id: 'owner',
      intendedFor: 'The people responsible for the installation.',
      permissions: ['access.manage', 'policy.manage'],
      title: 'Owner',
    },
    {
      builtIn: true,
      id: 'developer',
      intendedFor: 'People who plan migrations.',
      permissions: ['targets.read', 'migrations.plan'],
      title: 'Developer',
    },
  ],
}

export function grant(over: Partial<Grant> = {}): Grant {
  return {
    client: {
      clientId: 'https://agent.example.test/client.json',
      firstParty: false,
      id: CLIENT,
      kind: 'mcp',
      name: 'Agent',
      registration: 'cimd',
      state: 'active',
    },
    consentAt: T0,
    createdAt: T0,
    expiresAt: '2027-01-11T09:00:00Z',
    id: GRANT,
    identityId: OTHER,
    kind: 'delegated',
    lastTokenAt: T0,
    lastUseClass: 'plan',
    lastUsedAt: '2026-10-13T10:15:00Z',
    resource: 'mcp',
    resourceUri: 'http://localhost/mcp',
    restrictions: { tiers: ['nonprod'], targets: { kind: 'all' } },
    revokeReason: null,
    revokedAt: null,
    scopes: ['targets.read', 'migrations.plan'],
    state: 'active',
    ...over,
  }
}

export function event(over: Partial<AuditEvent> = {}): AuditEvent {
  return {
    action: 'migration.apply',
    actor: { identityId: ME, kind: 'human', label: 'human #1' },
    client: { clientId: CLIENT, grantId: GRANT, kind: 'mcp', sessionId: null },
    denial: null,
    id: 'aud_01JZ0000000000000000000001',
    occurredAt: T0,
    phase: 'completed',
    reason: null,
    refs: {
      jobId: null,
      operationId: 'op_01JZ0000000000000000000001',
      planHash: `sha256:ph1:${'ab'.repeat(32)}`,
      planId: 'pln_01JZ0000000000000000000001',
    },
    result: { errorCode: null, status: 'succeeded' },
    subject: {
      clusterId: null,
      nodeId: null,
      targetId: TARGET,
      targetPath: 'shop/app/production',
      tier: 'prod',
    },
    ...over,
  }
}

export function chain(verification: AuditChain['verification']): AuditChain {
  return {
    checkpoints: [
      { createdAt: T0, hash: `sha256:${'c'.repeat(64)}`, reason: 'scheduled', seq: 100 },
    ],
    exports: { sinks: [], task: null },
    head: { hash: `sha256:${'d'.repeat(64)}`, occurredAt: T0, seq: 120 },
    observedAt: new Date().toISOString(),
    source: 'live',
    verification,
    workerVerification: {
      full: null,
      incremental: {
        consecutiveFailures: 0,
        finishedAt: T0,
        nextRunAt: '2026-10-13T10:00:00Z',
        outcome: 'succeeded',
        reason: null,
      },
      resultPersisted: false,
      runsIn: 'worker',
    },
  }
}

export function breakGlass(over: Partial<BreakGlassGrant> = {}): BreakGlassGrant {
  return {
    activatedBy: { identityId: ME },
    createdAt: T0,
    expiresAt: '2026-10-13T11:00:00Z',
    grantId: BGL,
    maxUses: 3,
    reason: 'Incident 42: the lock-risk rule blocks the hotfix.',
    review: null,
    revokedAt: null,
    rules: ['migration.lock-risk'],
    state: 'expired',
    target: { path: 'shop/app/production', targetId: TARGET, tier: 'prod' },
    uses: 1,
    ...over,
  }
}

export function breakGlassList(
  items: readonly BreakGlassGrant[],
  nextCursor: string | null = null,
) {
  return { items, nextCursor, observedAt: new Date().toISOString(), source: 'live' as const }
}

export function dataReadRule(over: Partial<PolicyRule> = {}): PolicyRule {
  return {
    appliesTo: ['query.run', 'query.explain'],
    defaults: { mode: 'by_tier', sensitiveColumns: [] },
    description: 'Who may read rows of a target.',
    id: 'data.read',
    settings: [],
    severity: 'deny',
    version: 1,
    ...over,
  }
}

export function environment(over: Partial<Environment> = {}): Environment {
  return {
    displayName: 'Staging',
    evidenceFrom: null,
    id: 'env_01JZ0000000000000000000001',
    productId: 'prd_01JZ0000000000000000000001',
    rank: 10,
    revision: 1,
    slug: 'staging',
    tier: 'nonprod',
    ...over,
  }
}

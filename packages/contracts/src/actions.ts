import { InvariantError } from '@exponetdb/kernel'
import * as z from 'zod'
import type { Permission } from './permissions.ts'
import {
  CLIENT_KINDS,
  type ClientKind,
  HUMAN_SESSION_CLIENT_KINDS,
  isScope,
  type Scope,
} from './scopes.ts'

/** Action classes ([operations-engine.md §1](../../../exponetdb-docs/02-control-plane/operations-engine.md#1-action-classification)). */
export const ACTION_CLASSES = ['read', 'low', 'standard', 'high', 'critical'] as const
export type ActionClass = (typeof ACTION_CLASSES)[number]
export const ActionClassSchema = z.enum(ACTION_CLASSES)

/**
 * What an action changes.
 * - `read`: nothing anywhere.
 * - `control_record`: only ExponetDB-internal records that cannot change a
 *   managed system by themselves (plans, findings, approvals, reports).
 * - `consequential`: a managed database, host, cluster, backup or ExponetDB's
 *   own access-control state (C-6). Always planned, applied, verified, audited.
 */
export const ACTION_EFFECTS = ['read', 'control_record', 'consequential'] as const
export type ActionEffect = (typeof ACTION_EFFECTS)[number]

/**
 * How the action is confirmed: `none` (reads and record creation),
 * `inline_plan` (precondition tokens in the request, class `low`),
 * `stored_plan` (a plan, then `plan.apply`), `plan_apply` (the generic apply).
 */
export const MECHANISMS = ['none', 'inline_plan', 'stored_plan', 'plan_apply'] as const
export type Mechanism = (typeof MECHANISMS)[number]

export const SUBJECT_KINDS = [
  'installation',
  'product',
  'project',
  'target',
  'cluster',
  'server',
  'node',
  'backup',
  'plan',
  'operation',
  'access',
  'audit',
  'identity',
] as const
export type SubjectKind = (typeof SUBJECT_KINDS)[number]

/**
 * How the subject's tier matters (C-24): `none`; `subject` (the subject's
 * tier: a target's environment tier; for a plan, the tier recorded in the
 * plan's subject at planning time; for an operation, the tier of the plan it
 * executes, so an action on a production operation is a production action);
 * `subject_max` (cluster, server, node: the highest tier of any database they
 * host).
 */
export const TIER_SEMANTICS = ['none', 'subject', 'subject_max'] as const
export type TierSemantics = (typeof TIER_SEMANTICS)[number]

/** Exclusivity domains ([operations-engine.md §7](../../../exponetdb-docs/02-control-plane/operations-engine.md#7-exclusivity-domains)). */
export const EXCLUSIVITY_DOMAINS = [
  'target.schema',
  'target.maintenance',
  'cluster.config',
  'cluster.backup',
  'node.packages',
] as const
export type ExclusivityDomain = (typeof EXCLUSIVITY_DOMAINS)[number]

/**
 * Which permission an action needs. Derived rules resolve through the plan's
 * or operation's kind. `self` (Wave 3A): no RBAC permission; the
 * authenticated human acts on their own identity (own credentials, own
 * sessions), never on another subject. `public` (Wave 3A): a browser
 * ceremony before any session exists (sign-in, enrollment by a one-time
 * link); the ceremony's own proof (an assertion, a password and a second
 * factor, a capability) is the only authorization, and it never acts on a
 * managed system.
 */
export type PermissionRule =
  | { readonly kind: 'fixed'; readonly permission: Permission }
  | { readonly kind: 'of_plan_kind' }
  | { readonly kind: 'read_of_kind' }
  | { readonly kind: 'self' }
  | { readonly kind: 'public' }
  /**
   * `protocol` (Wave 3B): an OAuth protocol endpoint (`/oauth/*`,
   * `/.well-known/*`). The protocol's own proof is the only authorization:
   * client authentication, an authorization code with its PKCE verifier, a
   * refresh token, a device code, or nothing for public metadata. Any client
   * kind may call it; it never acts on a managed system and never reads
   * anything but public metadata.
   */
  | { readonly kind: 'protocol' }

/** Which OAuth scope an action needs. */
export type ScopeRule =
  | { readonly kind: 'fixed'; readonly scope: Scope }
  /** `<permission>:<tier of the subject>` */
  | { readonly kind: 'tiered'; readonly permission: Permission }
  /** the scope of the plan's kind at the plan's tier (plan.apply) */
  | { readonly kind: 'of_plan_kind' }
  /** the read scope of the plan's or operation's kind */
  | { readonly kind: 'read_of_kind' }
  /** no scope: a pre-session browser ceremony or an OAuth protocol endpoint (`public` and `protocol` rules only) */
  | { readonly kind: 'none' }

/** The class is fixed, depends on the subject's tier, or is decided by the plan from its content. */
export type ClassRule =
  | { readonly kind: 'fixed'; readonly class: ActionClass }
  | { readonly kind: 'by_tier'; readonly nonprod: ActionClass; readonly prod: ActionClass }
  | { readonly kind: 'by_plan'; readonly possible: readonly ActionClass[]; readonly rule: string }

export interface ActionDefinition {
  readonly title: string
  readonly effect: ActionEffect
  readonly class: ClassRule
  readonly mechanism: Mechanism
  readonly subject: SubjectKind
  readonly permission: PermissionRule
  readonly scope: ScopeRule
  readonly clientKinds: readonly ClientKind[]
  /** Only a human identity, through a human session, may perform it. */
  readonly humanOnly: boolean
  /** Fresh passkey or TOTP proof required. */
  readonly reauthentication: boolean
  /**
   * The re-authentication window in seconds when `reauthentication` is true
   * (identity.md §4); absent otherwise. The central authorization engine
   * enforces it; handlers never compare times themselves.
   */
  readonly reauthWithinSeconds?: number
  readonly tierSemantics: TierSemantics
  readonly exclusivity: readonly ExclusivityDomain[]
  /** Applied is not verified (C-13): consequential actions always verify. */
  readonly verification: 'none' | 'required'
  /** Registered as an Operations Engine kind (plans, operations, reconciliation). */
  readonly operationKind: boolean
  /** Wave that implements it. */
  readonly wave: string
  /** Basis in the documentation, or an assumption the gate record lists. */
  readonly basis: string
}

const ALL: readonly ClientKind[] = CLIENT_KINDS
const HUMAN: readonly ClientKind[] = HUMAN_SESSION_CLIENT_KINDS
const fixed = (c: ActionClass): ClassRule => ({ kind: 'fixed', class: c })
const byTier = (nonprod: ActionClass, prod: ActionClass): ClassRule => ({
  kind: 'by_tier',
  nonprod,
  prod,
})
const perm = (permission: Permission): PermissionRule => ({ kind: 'fixed', permission })
const scopeOf = (scope: Scope): ScopeRule => ({ kind: 'fixed', scope })
const tieredScope = (permission: Permission): ScopeRule => ({ kind: 'tiered', permission })

/** The untiered scope that carries the same name as the permission. */
function scopeNamed(permission: Permission): ScopeRule {
  if (!isScope(permission)) {
    throw new InvariantError(`no untiered scope named ${permission}`)
  }
  return { kind: 'fixed', scope: permission }
}

const READ_DOC = 'resources.md, tool-catalog.md'

function read(
  title: string,
  subject: SubjectKind,
  permission: Permission,
  extra: Partial<ActionDefinition> = {},
): ActionDefinition {
  return {
    title,
    effect: 'read',
    class: fixed('read'),
    mechanism: 'none',
    subject,
    permission: perm(permission),
    clientKinds: ALL,
    humanOnly: false,
    reauthentication: false,
    tierSemantics: 'none',
    exclusivity: [],
    verification: 'none',
    operationKind: false,
    wave: '4',
    basis: READ_DOC,
    ...extra,
    scope: extra.scope ?? scopeNamed(permission),
  }
}

function record(
  title: string,
  subject: SubjectKind,
  permission: PermissionRule,
  scope: ScopeRule,
  extra: Partial<ActionDefinition> = {},
): ActionDefinition {
  return {
    title,
    effect: 'control_record',
    class: fixed('read'),
    mechanism: 'none',
    subject,
    permission,
    scope,
    clientKinds: ALL,
    humanOnly: false,
    reauthentication: false,
    tierSemantics: 'none',
    exclusivity: [],
    verification: 'none',
    operationKind: false,
    wave: '6',
    basis: READ_DOC,
    ...extra,
  }
}

function operation(
  title: string,
  cls: ClassRule,
  subject: SubjectKind,
  permission: Permission,
  scope: ScopeRule,
  extra: Partial<ActionDefinition> = {},
): ActionDefinition {
  const isLow = cls.kind === 'fixed' && cls.class === 'low'
  return {
    title,
    effect: 'consequential',
    class: cls,
    mechanism: isLow ? 'inline_plan' : 'stored_plan',
    subject,
    permission: perm(permission),
    scope,
    clientKinds: ALL,
    humanOnly: false,
    reauthentication: false,
    tierSemantics: scope.kind === 'tiered' ? 'subject' : 'none',
    exclusivity: [],
    verification: 'required',
    operationKind: true,
    wave: '6',
    basis: 'operations-engine.md §2',
    ...extra,
  }
}

const adminOperation = (
  title: string,
  cls: ClassRule,
  subject: SubjectKind,
  permission: Permission,
  extra: Partial<ActionDefinition> = {},
) =>
  operation(title, cls, subject, permission, scopeNamed(permission), {
    clientKinds: HUMAN,
    humanOnly: true,
    ...extra,
  })

const WEB: readonly ClientKind[] = ['web']
const SELF: PermissionRule = { kind: 'self' }
const PUBLIC: PermissionRule = { kind: 'public' }
const AUTH_DOC = 'identity.md, authorization.md (Wave 3A)'

/**
 * A browser ceremony before any session exists (sign-in, enrollment through
 * a one-time link): the ceremony's own proof is its authorization.
 */
function ceremony(
  title: string,
  effect: 'control_record' | 'consequential',
  extra: Partial<ActionDefinition> = {},
): ActionDefinition {
  const consequential = effect === 'consequential'
  return {
    title,
    effect,
    class: fixed(consequential ? 'low' : 'read'),
    mechanism: consequential ? 'inline_plan' : 'none',
    subject: 'identity',
    permission: PUBLIC,
    scope: { kind: 'none' },
    clientKinds: WEB,
    humanOnly: true,
    reauthentication: false,
    tierSemantics: 'none',
    exclusivity: [],
    verification: consequential ? 'required' : 'none',
    operationKind: consequential,
    wave: '3A',
    basis: AUTH_DOC,
    ...extra,
  }
}

/** The authenticated human acting on their own identity, through the Web App only. */
function selfService(
  title: string,
  effect: 'read' | 'control_record' | 'consequential',
  extra: Partial<ActionDefinition> = {},
): ActionDefinition {
  const consequential = effect === 'consequential'
  const reauthentication = extra.reauthentication ?? consequential
  const definition: ActionDefinition = {
    title,
    effect,
    class: fixed(consequential ? 'low' : 'read'),
    mechanism: consequential ? 'inline_plan' : 'none',
    subject: 'identity',
    permission: SELF,
    scope: scopeOf('api'),
    clientKinds: WEB,
    humanOnly: true,
    tierSemantics: 'none',
    exclusivity: [],
    verification: consequential ? 'required' : 'none',
    operationKind: consequential,
    wave: '3A',
    basis: AUTH_DOC,
    ...extra,
    reauthentication,
  }
  if (!reauthentication) {
    const { reauthWithinSeconds: _none, ...rest } = definition
    return rest
  }
  return { ...definition, reauthWithinSeconds: extra.reauthWithinSeconds ?? 300 }
}

const OAUTH_DOC = 'oauth.md, identity.md §5, authorization.md §4 (Wave 3B)'

/** An OAuth protocol endpoint: its own proof is its authorization (`protocol` rule). */
function protocol(
  title: string,
  effect: 'read' | 'control_record',
  extra: Partial<ActionDefinition> = {},
): ActionDefinition {
  return {
    title,
    effect,
    class: fixed('read'),
    mechanism: 'none',
    subject: 'access',
    permission: { kind: 'protocol' },
    scope: { kind: 'none' },
    clientKinds: ALL,
    humanOnly: false,
    reauthentication: false,
    tierSemantics: 'none',
    exclusivity: [],
    verification: 'none',
    operationKind: false,
    wave: '3B',
    basis: OAUTH_DOC,
    ...extra,
  }
}

/** An administrative change of ExponetDB's own access state with an inline plan (C-6). */
function inlineAccess(title: string, extra: Partial<ActionDefinition> = {}): ActionDefinition {
  return {
    title,
    effect: 'consequential',
    class: fixed('low'),
    mechanism: 'inline_plan',
    subject: 'identity',
    permission: perm('access.manage'),
    scope: scopeNamed('access.manage'),
    clientKinds: HUMAN,
    humanOnly: true,
    reauthentication: true,
    reauthWithinSeconds: 300,
    tierSemantics: 'none',
    exclusivity: [],
    verification: 'required',
    operationKind: true,
    wave: '3A',
    basis: AUTH_DOC,
    ...extra,
  }
}

const accessRead = (title: string, extra: Partial<ActionDefinition> = {}) =>
  read(title, 'access', 'access.read', {
    clientKinds: HUMAN,
    wave: '3A',
    basis: 'resources.md (Access)',
    ...extra,
  })

const accessPlan = (
  title: string,
  subject: SubjectKind,
  permission: Permission,
  extra: Partial<ActionDefinition> = {},
) =>
  record(title, subject, perm(permission), scopeNamed(permission), {
    clientKinds: HUMAN,
    humanOnly: true,
    wave: '3A',
    basis: 'resources.md (Access): registry and access changes create a plan',
    ...extra,
  })

const REGISTRY_DOC = 'registry.md, resources.md (Registry) (Wave 4)'

/** A registry read that shows administrative detail (addresses, credential metadata): registry.manage, human only. */
const registryRead = (title: string, extra: Partial<ActionDefinition> = {}) =>
  read(title, 'cluster', 'registry.manage', {
    clientKinds: HUMAN,
    humanOnly: true,
    basis: REGISTRY_DOC,
    ...extra,
  })

/** Creates the plan of a registry change (a record); `plan.apply` executes it. */
const registryPlan = (title: string, subject: SubjectKind, extra: Partial<ActionDefinition> = {}) =>
  record(title, subject, perm('registry.manage'), scopeNamed('registry.manage'), {
    clientKinds: HUMAN,
    humanOnly: true,
    wave: '4',
    basis: 'resources.md (Registry): registry changes create a plan',
    ...extra,
  })

/** A registry change executed by the worker from a stored plan. */
const registryKind = (
  title: string,
  cls: ClassRule,
  subject: SubjectKind,
  extra: Partial<ActionDefinition> = {},
) =>
  adminOperation(title, cls, subject, 'registry.manage', {
    wave: '4',
    basis: REGISTRY_DOC,
    ...extra,
  })

/** Re-authentication within five minutes (identity.md §4). */
const REAUTH: Partial<ActionDefinition> = { reauthentication: true, reauthWithinSeconds: 300 }

/**
 * The action registry. Every action any interface exposes is registered here
 * with its class; a REST route or MCP tool can only reference an id from this
 * registry (compile-time `ActionId`), and contract tests check the invariants
 * (C-6). Actions of later waves are registered with their documented
 * metadata; their input schemas arrive with the wave that implements them.
 */
export const ACTIONS = {
  // ----- reads behind the Wave 1 REST and MCP read contracts -----
  'installation.get': read('Get installation', 'installation', 'targets.read', { wave: '2' }),
  'installation.health.get': read('Get Control Plane health', 'installation', 'nodes.read', {
    wave: '2',
  }),
  'product.list': read('List products', 'product', 'targets.read'),
  'product.get': read('Get product', 'product', 'targets.read'),
  'environment.list': read('List environments of a product', 'product', 'targets.read'),
  'project.list': read('List projects', 'project', 'targets.read'),
  'project.get': read('Get project', 'project', 'targets.read'),
  'target.list': read('List targets', 'target', 'targets.read'),
  'target.get': read('Get target', 'target', 'targets.read'),
  'target.health.get': read('Get target health', 'target', 'diagnostics.read'),
  'target.finding.list': read('List findings of a target', 'target', 'diagnostics.read'),
  'schema.overview.get': read('Get schema overview', 'target', 'schema.read'),
  'schema.object.get': read('Get schema object', 'target', 'schema.read'),
  'schema.search': read('Search schema objects', 'target', 'schema.read'),
  'schema.fingerprint.get': read('Get schema fingerprint', 'target', 'schema.read'),
  'schema.diff': read('Diff two schemas', 'target', 'schema.read'),
  'query.run': read('Run a read-only query', 'target', 'data.read', {
    scope: tieredScope('data.read'),
    tierSemantics: 'subject',
    wave: '7',
  }),
  'query.explain': read('Explain a read-only query', 'target', 'data.read', {
    scope: tieredScope('data.read'),
    tierSemantics: 'subject',
    wave: '7',
  }),
  'migration.lint': read('Lint migration bundles', 'project', 'migrations.read', { wave: '6' }),
  'migration.status.get': read('Get migration status of a target', 'target', 'migrations.read', {
    wave: '6',
  }),
  'session.list': read('List sessions', 'target', 'diagnostics.read'),
  'lock.list': read('List locks', 'target', 'diagnostics.read'),
  'query_stats.list': read('List statement statistics', 'target', 'diagnostics.read', {
    wave: '9',
  }),
  'table_stats.list': read('List table statistics', 'target', 'diagnostics.read', { wave: '9' }),
  'advisor.run': read('Run live advisors', 'target', 'diagnostics.read', { wave: '9' }),
  'server.list': read('List servers', 'server', 'nodes.read'),
  'server.get': read('Get server', 'server', 'nodes.read'),
  'cluster.list': read('List clusters', 'cluster', 'nodes.read'),
  'cluster.get': read('Get cluster', 'cluster', 'nodes.read'),
  'node.list': read('List nodes', 'node', 'nodes.read', { wave: '5' }),
  'node.get': read('Get node status', 'node', 'nodes.read', { wave: '5' }),
  'backup.list': read('List backups of a cluster', 'cluster', 'backups.read', { wave: '9' }),
  'audit.search': read('Search audit events', 'audit', 'audit.read', { wave: '2' }),
  'plan.get': read('Get plan', 'plan', 'targets.read', {
    permission: { kind: 'read_of_kind' },
    scope: { kind: 'read_of_kind' },
    wave: '2',
    basis: "OD-26 (c): the read permission of the kind's domain, or plans.approve (Web App)",
  }),
  'operation.get': read('Get operation', 'operation', 'targets.read', {
    permission: { kind: 'read_of_kind' },
    scope: { kind: 'read_of_kind' },
    wave: '2',
  }),
  'operation.list': read('List operations', 'operation', 'targets.read', {
    permission: { kind: 'read_of_kind' },
    scope: { kind: 'read_of_kind' },
    wave: '2',
  }),

  // ----- ExponetDB-internal records (plans, findings, reviews) -----
  'drift.check': record(
    'Run a drift check',
    'target',
    perm('schema.read'),
    scopeOf('schema.read'),
    { wave: '4' },
  ),
  'migration.plan': record(
    'Plan migrations',
    'target',
    perm('migrations.plan'),
    scopeOf('migrations.plan'),
  ),
  'migration.rollback.plan': record(
    'Plan a rollback',
    'target',
    perm('migrations.plan'),
    scopeOf('migrations.plan'),
  ),
  'migration.bundle.ingest': record(
    'Ingest bundles without planning',
    'project',
    perm('migrations.plan'),
    scopeOf('migrations.plan'),
  ),
  'migration.import.analyze': record(
    'Analyze a legacy import',
    'target',
    perm('migrations.import'),
    scopeOf('migrations.import'),
    {
      clientKinds: HUMAN,
      humanOnly: true,
    },
  ),
  'migration.baseline.plan': record(
    'Plan a baseline',
    'target',
    perm('migrations.import'),
    scopeOf('migrations.import'),
    {
      clientKinds: HUMAN,
      humanOnly: true,
    },
  ),
  'ledger.reconcile.plan': record(
    'Plan a ledger reconciliation',
    'target',
    perm('migrations.import'),
    scopeOf('migrations.import'),
    {
      clientKinds: HUMAN,
      humanOnly: true,
    },
  ),
  'connections.terminate.plan': record(
    'Plan a backend termination',
    'target',
    perm('connections.operate'),
    tieredScope('connections.operate'),
    {
      tierSemantics: 'subject',
      wave: '9',
    },
  ),
  'node.plan': record(
    'Plan a node or cluster operation',
    'node',
    perm('nodes.plan'),
    scopeOf('nodes.plan'),
    {
      tierSemantics: 'subject_max',
      wave: '5',
    },
  ),
  'restore.plan': record(
    'Plan a restore',
    'target',
    perm('restore.plan'),
    scopeOf('restore.plan'),
    { wave: '9' },
  ),
  'plan.withdraw': record(
    'Withdraw a plan',
    'plan',
    { kind: 'of_plan_kind' },
    { kind: 'of_plan_kind' },
    {
      wave: '2',
      basis: 'resources.md: plan actor',
    },
  ),
  'approval.approve': record(
    'Approve a plan',
    'plan',
    perm('plans.approve'),
    scopeOf('plans.approve'),
    {
      clientKinds: ['web'],
      humanOnly: true,
      reauthentication: true,
      reauthWithinSeconds: 300,
      wave: '3A',
      basis: 'operations-engine.md §6, authorization.md §6',
    },
  ),
  'approval.reject': record(
    'Reject a plan',
    'plan',
    perm('plans.approve'),
    scopeOf('plans.approve'),
    {
      clientKinds: ['web'],
      humanOnly: true,
      reauthentication: true,
      reauthWithinSeconds: 300,
      wave: '3A',
      basis: 'operations-engine.md §6, authorization.md §6',
    },
  ),
  'breakglass.activate': record(
    'Activate break-glass',
    'access',
    perm('breakglass.activate'),
    scopeOf('breakglass.activate'),
    {
      clientKinds: HUMAN,
      humanOnly: true,
      reauthentication: true,
      reauthWithinSeconds: 120,
      basis: 'operations-engine.md §8: a time-boxed grant; overrides apply only inside later plans',
    },
  ),

  // ----- the generic apply -----
  'plan.apply': {
    title: 'Apply a plan',
    effect: 'consequential',
    class: {
      kind: 'by_plan',
      possible: ['standard', 'high', 'critical'],
      rule: "the class of the plan's kind",
    },
    mechanism: 'plan_apply',
    subject: 'plan',
    permission: { kind: 'of_plan_kind' },
    scope: { kind: 'of_plan_kind' },
    clientKinds: ALL,
    humanOnly: false,
    reauthentication: false,
    tierSemantics: 'subject',
    exclusivity: [],
    verification: 'required',
    operationKind: false,
    wave: '2',
    basis:
      'operations-engine.md §5; critical plans are applied by humans only (authorization.md §6)',
  },

  // ----- Operations Engine kinds (operations-engine.md §2) -----
  'target.register': adminOperation(
    'Register a target',
    fixed('standard'),
    'target',
    'registry.manage',
    {
      exclusivity: ['target.schema'],
      wave: '4',
      basis: 'operations-engine.md §2; target.register-prod-approval',
    },
  ),
  'target.suspend': adminOperation(
    'Suspend writes to a target',
    fixed('standard'),
    'target',
    'registry.manage',
    { wave: '4' },
  ),
  'target.resume': adminOperation(
    'Resume writes to a target',
    fixed('standard'),
    'target',
    'registry.manage',
    { wave: '4' },
  ),
  'target.decommission': adminOperation(
    'Decommission a target',
    fixed('critical'),
    'target',
    'registry.manage',
    {
      exclusivity: ['target.maintenance'],
      reauthentication: true,
      reauthWithinSeconds: 300,
      wave: '4',
    },
  ),
  'target.identity.stamp': adminOperation(
    'Stamp the target identity marker',
    fixed('standard'),
    'target',
    'registry.manage',
    {
      exclusivity: ['target.schema'],
      wave: '4',
    },
  ),
  'ledger.initialize': adminOperation(
    'Initialize the target ledger',
    byTier('standard', 'high'),
    'target',
    'registry.manage',
    {
      exclusivity: ['target.schema'],
      tierSemantics: 'subject',
      wave: '4',
    },
  ),
  'credential.rotate': adminOperation(
    'Rotate a credential',
    fixed('high'),
    'cluster',
    'registry.manage',
    {
      tierSemantics: 'subject_max',
      wave: '4/5',
      basis:
        'operations-engine.md §2; permission registry.manage decided by the owner before G1 (credential lifecycle is registry management in V1)',
    },
  ),
  'migration.apply': operation(
    'Apply migrations',
    byTier('standard', 'high'),
    'target',
    'migrations.apply',
    tieredScope('migrations.apply'),
    {
      exclusivity: ['target.schema'],
    },
  ),
  'migration.verify': operation(
    'Re-run verification',
    fixed('low'),
    'target',
    'migrations.apply',
    tieredScope('migrations.apply'),
  ),
  'migration.rollback': operation(
    'Roll back a migration (down.sql)',
    {
      kind: 'by_plan',
      possible: ['high', 'critical'],
      rule: 'critical on prod tier when rollback.safety is lossy or unsafe',
    },
    'target',
    'migrations.apply',
    tieredScope('migrations.apply'),
    { exclusivity: ['target.schema'] },
  ),
  'migration.baseline': adminOperation(
    'Baseline a legacy history',
    fixed('high'),
    'target',
    'migrations.import',
    {
      exclusivity: ['target.schema'],
    },
  ),
  'migration.resume': operation(
    'Resume a non-transactional bundle',
    fixed('high'),
    'target',
    'migrations.apply',
    tieredScope('migrations.apply'),
    {
      exclusivity: ['target.schema'],
      basis:
        'operations-engine.md §2; permission migrations.apply with the tiered scope decided by the owner before G1',
    },
  ),
  'migration.rebaseline': adminOperation(
    'Correct a legacy import',
    fixed('high'),
    'target',
    'migrations.import',
    {
      exclusivity: ['target.schema'],
    },
  ),
  'ledger.reconcile': adminOperation(
    'Reconcile ledger and mirror',
    fixed('high'),
    'target',
    'migrations.import',
    {
      exclusivity: ['target.schema'],
    },
  ),
  'drift.accept': adminOperation(
    'Accept drift',
    byTier('standard', 'high'),
    'target',
    'schema.manage',
    {
      tierSemantics: 'subject',
      basis: 'operations-engine.md §2; policy drift.accept-prod',
    },
  ),
  'operation.force_release': adminOperation(
    'Release a lock domain held by a lost worker',
    fixed('high'),
    'operation',
    'operations.recover',
    {
      reauthentication: true,
      reauthWithinSeconds: 300,
      // The released lock belongs to an operation on a real target, cluster or
      // node: its tier is the tier of that operation's plan (production lock
      // recovery is a production action).
      tierSemantics: 'subject',
      basis:
        'operations-engine.md §2, concurrency.md; permission operations.recover decided by the owner before G1',
    },
  ),
  'connections.cancel': operation(
    'Cancel a query',
    fixed('low'),
    'target',
    'connections.operate',
    tieredScope('connections.operate'),
    {
      wave: '9',
    },
  ),
  'connections.terminate': operation(
    'Terminate a backend',
    byTier('standard', 'high'),
    'target',
    'connections.operate',
    tieredScope('connections.operate'),
    {
      wave: '9',
    },
  ),
  'postgres.config.apply': operation(
    'Apply PostgreSQL configuration',
    byTier('standard', 'high'),
    'cluster',
    'nodes.operate',
    tieredScope('nodes.operate'),
    {
      exclusivity: ['cluster.config'],
      tierSemantics: 'subject_max',
      wave: '5',
    },
  ),
  'postgres.reload': operation(
    'Reload PostgreSQL',
    byTier('standard', 'high'),
    'cluster',
    'nodes.operate',
    tieredScope('nodes.operate'),
    {
      exclusivity: ['cluster.config'],
      tierSemantics: 'subject_max',
      wave: '5',
    },
  ),
  'postgres.restart': operation(
    'Restart PostgreSQL',
    byTier('standard', 'high'),
    'cluster',
    'nodes.operate',
    tieredScope('nodes.operate'),
    {
      exclusivity: ['cluster.config', 'target.schema'],
      tierSemantics: 'subject_max',
      wave: '5',
      basis:
        'operations-engine.md §2 and §7: restart also takes the schema domain of placed targets',
    },
  ),
  'postgres.tls.rotate': operation(
    'Rotate the server certificate',
    fixed('high'),
    'cluster',
    'nodes.operate',
    tieredScope('nodes.operate'),
    {
      exclusivity: ['cluster.config'],
      tierSemantics: 'subject_max',
      wave: '5',
    },
  ),
  'postgres.roles.apply': operation(
    'Apply role desired state',
    {
      kind: 'by_plan',
      possible: ['high', 'critical'],
      rule: 'critical when a step sets createrole, replication or bypassrls, or grants a predefined role or a role that has or reaches a privileged attribute or a predefined role (control-plane.md §9.3); high otherwise',
    },
    'cluster',
    'nodes.operate',
    tieredScope('nodes.operate'),
    {
      exclusivity: ['cluster.config'],
      tierSemantics: 'subject_max',
      wave: '5',
    },
  ),
  'postgres.extensions.apply': operation(
    'Install or update extensions',
    fixed('high'),
    'cluster',
    'nodes.operate',
    tieredScope('nodes.operate'),
    {
      exclusivity: ['cluster.config'],
      tierSemantics: 'subject_max',
      wave: '5',
    },
  ),
  'postgres.hba.apply': operation(
    'Apply pg_hba rules',
    fixed('high'),
    'cluster',
    'nodes.operate',
    tieredScope('nodes.operate'),
    {
      exclusivity: ['cluster.config'],
      tierSemantics: 'subject_max',
      wave: '5',
    },
  ),
  'packages.apply_update': operation(
    'Apply package updates',
    fixed('high'),
    'node',
    'nodes.operate',
    tieredScope('nodes.operate'),
    {
      exclusivity: ['node.packages'],
      tierSemantics: 'subject_max',
      wave: 'after 9',
    },
  ),
  'backup.run': operation(
    'Run a backup',
    fixed('standard'),
    'cluster',
    'backups.run',
    scopeOf('backups.run'),
    {
      exclusivity: ['cluster.backup'],
      tierSemantics: 'subject_max',
      wave: '9',
    },
  ),
  'backup.verify': operation(
    'Verify a backup',
    fixed('low'),
    'backup',
    'backups.run',
    scopeOf('backups.run'),
    {
      tierSemantics: 'subject_max',
      wave: '9',
    },
  ),
  'restore.execute': adminOperation(
    'Execute a restore',
    {
      kind: 'by_plan',
      possible: ['standard', 'high', 'critical'],
      rule: 'standard: drill into scratch; high: clone into a new nonprod target; critical: recovery or unmasked production clone',
    },
    'target',
    'restore.execute',
    {
      exclusivity: ['target.maintenance'],
      reauthentication: true,
      reauthWithinSeconds: 300,
      wave: '9',
    },
  ),
  'node.enroll': adminOperation('Enroll a node', fixed('high'), 'node', 'registry.manage', {
    ...REAUTH,
    wave: '5',
    basis: 'enrollment.md §3: registry.manage and re-authentication; ADR-0024 §6',
  }),
  'node.revoke': adminOperation('Revoke a node', fixed('high'), 'node', 'registry.manage', {
    ...REAUTH,
    wave: '5',
    basis: 'enrollment.md §5: plan, high, re-authentication; ADR-0024 §6',
  }),
  'node.decommission': adminOperation(
    'Decommission a node',
    fixed('high'),
    'node',
    'registry.manage',
    {
      ...REAUTH,
      wave: '5',
      basis: 'enrollment.md §5: as node.revoke; ADR-0024 §6',
    },
  ),
  'node.enroll.plan': record(
    'Plan a node enrollment for a server',
    'server',
    perm('registry.manage'),
    scopeNamed('registry.manage'),
    {
      clientKinds: HUMAN,
      humanOnly: true,
      wave: '5',
      basis: 'control-plane.md §4: node.enroll is a stored plan; plan.apply executes it',
    },
  ),
  'node.revoke.plan': record(
    'Plan a node revocation',
    'node',
    perm('registry.manage'),
    scopeNamed('registry.manage'),
    {
      clientKinds: HUMAN,
      humanOnly: true,
      wave: '5',
      basis: 'enrollment.md §5: node.revoke is a stored plan; plan.apply executes it',
    },
  ),
  'node.config.update.plan': record(
    'Plan a job-key change on a node',
    'node',
    perm('registry.manage'),
    scopeNamed('registry.manage'),
    {
      clientKinds: HUMAN,
      humanOnly: true,
      wave: '5',
      basis:
        'control-plane.md §9.8: node.config.update adds or removes job-signing keys on one node; a stored plan, plan.apply executes it',
    },
  ),
  'node.decommission.plan': record(
    'Plan a node decommissioning',
    'node',
    perm('registry.manage'),
    scopeNamed('registry.manage'),
    {
      clientKinds: HUMAN,
      humanOnly: true,
      wave: '5',
      basis: 'enrollment.md §5: node.decommission is a stored plan; plan.apply executes it',
    },
  ),
  'credential.rotate.plan': record(
    'Plan a credential rotation on an agent-managed cluster',
    'cluster',
    perm('registry.manage'),
    scopeNamed('registry.manage'),
    {
      clientKinds: HUMAN,
      humanOnly: true,
      wave: '5',
      basis: 'control-plane.md §9.7: credential.rotate is a stored plan; plan.apply executes it',
    },
  ),
  'node.inspect': operation(
    'Inspect a node or one of its clusters',
    fixed('low'),
    'node',
    'nodes.plan',
    scopeOf('nodes.plan'),
    {
      tierSemantics: 'none',
      wave: '5',
      basis:
        'control-plane.md §9.2: one read or plan capability as one signed job, planned and accepted in one call and run by the worker; its node-signed result is kept as an observation',
    },
  ),
  'node.enrollment_token.reveal': {
    title: 'Reveal an enrollment token once (Web App, re-authentication)',
    effect: 'consequential',
    class: fixed('low'),
    mechanism: 'inline_plan',
    subject: 'server',
    permission: perm('registry.manage'),
    scope: scopeNamed('registry.manage'),
    clientKinds: ['web'],
    humanOnly: true,
    reauthentication: true,
    reauthWithinSeconds: 300,
    tierSemantics: 'none',
    exclusivity: [],
    verification: 'required',
    operationKind: true,
    wave: '5',
    basis:
      'control-plane.md §4: the identity that applied node.enroll reveals the token once, with a fresh re-authentication, within 30 minutes; the secret exists only in that response. Applied: issued at once (redeem hash for the gateway, bind key for the worker); verified: the worker binds the node that redeemed it',
  },
  'node.config.update': adminOperation(
    'Update a node agent configuration',
    fixed('high'),
    'node',
    'registry.manage',
    {
      ...REAUTH,
      wave: '5',
      basis:
        'capabilities.md (config.update@1): job-signing key rotation and the gateway address, signed by a trusted key; never operator-local settings (G5 record C8); ADR-0024 §1',
    },
  ),
  'access.role_binding.create': adminOperation(
    'Create a role binding',
    {
      kind: 'by_plan',
      possible: ['standard', 'high'],
      rule: 'high when the bound scope covers prod tier',
    },
    'access',
    'access.manage',
    {
      reauthentication: true,
      reauthWithinSeconds: 300,
      wave: '3A',
      basis: 'operations-engine.md §2 (access.*), resources.md',
    },
  ),
  'access.role_binding.delete': adminOperation(
    'Delete a role binding',
    {
      kind: 'by_plan',
      possible: ['standard', 'high'],
      rule: 'high when the bound scope covers prod tier',
    },
    'access',
    'access.manage',
    {
      reauthentication: true,
      reauthWithinSeconds: 300,
      wave: '3A',
      basis: 'operations-engine.md §2 (access.*), resources.md',
    },
  ),
  'access.policy_settings.update': adminOperation(
    'Change policy configuration',
    fixed('high'),
    'access',
    'policy.manage',
    {
      reauthentication: true,
      reauthWithinSeconds: 300,
      wave: '3A',
      basis: 'policy-engine.md §5: changing policy configuration is an access.*-class operation',
    },
  ),

  // ----- Wave 3A: identity, sessions and access -----
  'auth.login': ceremony(
    'Sign in (passkey, or password with TOTP or a recovery code)',
    'control_record',
  ),
  'auth.enrollment': ceremony(
    'Activate an identity through a one-time link (first owner, invitation, out-of-band recovery)',
    'consequential',
    { basis: 'identity.md §1, §6; bootstrap.md §3' },
  ),
  'me.get': selfService('Get the current identity, its bindings and session', 'read'),
  'auth.session.list': selfService('List own sessions', 'read'),
  'auth.factor.list': selfService('List own authentication factors', 'read'),
  'auth.logout': selfService('Sign out (revoke the current session)', 'control_record'),
  'auth.reauth': selfService('Re-authenticate (passkey or TOTP)', 'control_record'),
  'auth.session.revoke': selfService('Revoke own sessions', 'control_record'),
  'auth.passkey.add': selfService('Add a passkey', 'consequential'),
  'auth.passkey.remove': selfService('Remove a passkey', 'consequential'),
  'auth.password.change': selfService('Change the password', 'consequential'),
  'auth.totp.replace': selfService('Enroll or replace the TOTP authenticator', 'consequential'),
  'auth.recovery_codes.regenerate': selfService('Regenerate recovery codes', 'consequential'),
  'identity.list': accessRead('List identities'),
  'identity.get': accessRead('Get an identity'),
  'role.list': accessRead('List built-in roles'),
  'role.get': accessRead('Get a role and its permissions'),
  'role_binding.list': accessRead('List role bindings'),
  'policy_settings.get': accessRead('Get policy settings and rule parameters'),
  'approval.list': read('List operations awaiting approval', 'plan', 'plans.approve', {
    clientKinds: ['web'],
    humanOnly: true,
    wave: '3A',
    basis: 'resources.md: the approval queue',
  }),
  'access.identity.invite': inlineAccess('Invite a person (identity without roles)'),
  'access.invitation.reissue': inlineAccess(
    'Issue a new invitation link (the old one stops working)',
  ),
  'access.identity.disable': inlineAccess('Disable an identity (sessions and links end at once)'),
  'access.identity.enable': adminOperation(
    'Enable a disabled identity',
    fixed('standard'),
    'identity',
    'access.manage',
    {
      reauthentication: true,
      reauthWithinSeconds: 300,
      wave: '3A',
      basis: 'identity.md §7; restoring access is a privilege increase, so it is planned',
    },
  ),
  'access.identity.erase': adminOperation(
    'Erase an identity (data protection request)',
    fixed('critical'),
    'identity',
    'access.manage',
    {
      reauthentication: true,
      reauthWithinSeconds: 300,
      wave: '3A',
      basis: 'identity.md §7; audit.md §6: destroys an identity, so critical',
    },
  ),
  'access.role_binding.create.plan': accessPlan('Plan a role binding', 'access', 'access.manage'),
  'access.role_binding.delete.plan': accessPlan(
    'Plan the removal of a role binding',
    'access',
    'access.manage',
  ),
  'access.policy_settings.update.plan': accessPlan(
    'Plan a policy configuration change',
    'access',
    'policy.manage',
  ),
  'access.identity.enable.plan': accessPlan(
    'Plan enabling an identity',
    'identity',
    'access.manage',
  ),
  'access.identity.erase.plan': accessPlan(
    'Plan the erasure of an identity',
    'identity',
    'access.manage',
  ),

  // ----- Wave 4: registry management (registry.md, resources.md "Registry") -----
  'endpoint.list': registryRead('List the endpoints of a cluster with their addresses'),
  'database.list': registryRead('List the databases of a cluster'),
  'credential.list': registryRead('List credential metadata of a cluster (never a secret)'),
  'cluster.bootstrap_sql.get': registryRead(
    'Get the role bootstrap SQL of an external cluster (contains no password)',
  ),
  'registry.product.create.plan': registryPlan('Plan a product', 'product'),
  'registry.environment.create.plan': registryPlan('Plan an environment', 'product'),
  'registry.environment.update.plan': registryPlan('Plan an environment change', 'product'),
  'registry.project.create.plan': registryPlan('Plan a project', 'project'),
  'registry.project.update.plan': registryPlan('Plan a project change', 'project'),
  'registry.server.create.plan': registryPlan('Plan a server record', 'server'),
  'registry.cluster.register.plan': registryPlan(
    'Plan the registration of an external cluster',
    'cluster',
  ),
  'registry.cluster.confirm.plan': registryPlan(
    'Plan the confirmation of a cluster (pins its system_identifier)',
    'cluster',
  ),
  'registry.endpoint.add.plan': registryPlan('Plan an endpoint', 'cluster'),
  'registry.endpoint.retire.plan': registryPlan('Plan the retirement of an endpoint', 'cluster'),
  'registry.database.register.plan': registryPlan('Plan the registration of a database', 'cluster'),
  'target.register.plan': registryPlan(
    'Plan the registration of a target (identity marker and empty ledger)',
    'target',
  ),
  'target.suspend.plan': registryPlan('Plan the suspension of a target', 'target'),
  'target.resume.plan': registryPlan('Plan resuming a target', 'target'),
  'target.decommission.plan': registryPlan('Plan the decommissioning of a target', 'target'),
  'registry.product.create': registryKind('Create a product', fixed('standard'), 'product'),
  'registry.environment.create': registryKind(
    'Create an environment',
    fixed('standard'),
    'product',
  ),
  'registry.environment.update': registryKind(
    'Change an environment (display name, tier, evidence source, rank)',
    {
      kind: 'by_plan',
      possible: ['standard', 'high'],
      rule: 'high when the tier or the evidence source changes',
    },
    'product',
    REAUTH,
  ),
  'registry.project.create': registryKind('Create a project', fixed('standard'), 'project'),
  'registry.project.update': registryKind(
    'Change a project (display name, managed schema scope, evidence override)',
    {
      kind: 'by_plan',
      possible: ['standard', 'high'],
      rule: 'high when the managed schema scope or the evidence override changes',
    },
    'project',
  ),
  'registry.server.create': registryKind('Create a server record', fixed('standard'), 'server'),
  'registry.cluster.register': registryKind(
    'Register an external cluster (pending, CA bundle and endpoints)',
    fixed('standard'),
    'cluster',
    REAUTH,
  ),
  'registry.cluster.confirm': registryKind(
    'Confirm a cluster: pin its system_identifier, refuse the Control Store',
    fixed('standard'),
    'cluster',
    REAUTH,
  ),
  'registry.endpoint.add': registryKind(
    'Add an endpoint to a cluster',
    byTier('standard', 'high'),
    'cluster',
    { ...REAUTH, tierSemantics: 'subject_max' },
  ),
  'registry.endpoint.retire': registryKind(
    'Retire an endpoint of a cluster',
    byTier('standard', 'high'),
    'cluster',
    { ...REAUTH, tierSemantics: 'subject_max' },
  ),
  'registry.database.register': registryKind(
    'Register an existing database of a confirmed cluster',
    fixed('standard'),
    'cluster',
  ),
  'registry.credential.submit': {
    title: 'Submit a credential of an ExponetDB role (write-only; the worker verifies it)',
    effect: 'consequential',
    class: fixed('low'),
    mechanism: 'inline_plan',
    subject: 'cluster',
    permission: perm('registry.manage'),
    scope: scopeNamed('registry.manage'),
    clientKinds: ['web'],
    humanOnly: true,
    reauthentication: true,
    reauthWithinSeconds: 300,
    tierSemantics: 'none',
    exclusivity: [],
    verification: 'required',
    operationKind: true,
    wave: '4',
    basis:
      'resources.md (write-only credential submission), registry.md §2.2; applied: encrypted at once and recorded pending; verified: a login over verified TLS by the worker activates it',
  },

  // ----- Wave 3B: the OAuth authorization server (protocol endpoints) -----
  'oauth.metadata.get': protocol(
    'Read authorization server and protected resource metadata (RFC 8414, RFC 9728)',
    'read',
  ),
  'oauth.authorize': protocol(
    'Start an authorization request (authorization code with PKCE S256)',
    'control_record',
  ),
  'oauth.token': protocol(
    'Exchange a code, refresh token, device code or client assertion for tokens',
    'control_record',
  ),
  'oauth.revoke': protocol('Revoke a token (RFC 7009)', 'control_record'),
  'oauth.register': protocol(
    'Register a public client for approval (RFC 7591, deprecated compatibility)',
    'control_record',
  ),
  'oauth.device_authorization': protocol(
    'Start a device authorization (RFC 8628, first-party CLI)',
    'control_record',
  ),

  // ----- Wave 3B: consent and connected applications (the human, Web App) -----
  'oauth.consent.get': selfService(
    'Show a pending authorization or device request for consent',
    'read',
    { wave: '3B', basis: OAUTH_DOC },
  ),
  'oauth.consent': selfService(
    'Consent: delegate a bounded subset of own authority to a client',
    'consequential',
    {
      // Re-authentication is a policy requirement for production writes and
      // human-only scopes only (`oauth.consent-elevated`), not for every consent.
      reauthentication: false,
      wave: '3B',
      basis: OAUTH_DOC,
    },
  ),
  'oauth.grant.list_own': selfService('List own connected applications (grants)', 'read', {
    wave: '3B',
    basis: OAUTH_DOC,
  }),
  'oauth.grant.revoke_own': selfService('Revoke an own grant and all its tokens', 'consequential', {
    reauthentication: false,
    wave: '3B',
    basis: OAUTH_DOC,
  }),

  // ----- Wave 3B: client, grant, service account and API key administration -----
  'oauth.client.list': accessRead('List OAuth clients', { wave: '3B', basis: OAUTH_DOC }),
  'oauth.client.get': accessRead('Get an OAuth client', { wave: '3B', basis: OAUTH_DOC }),
  'oauth.client.register_cimd': record(
    'Fetch a Client ID Metadata Document for review (pending client)',
    'access',
    perm('access.manage'),
    scopeNamed('access.manage'),
    { clientKinds: HUMAN, humanOnly: true, wave: '3B', basis: OAUTH_DOC },
  ),
  'oauth.client.refresh_metadata': record(
    'Fetch the metadata of a CIMD client again',
    'access',
    perm('access.manage'),
    scopeNamed('access.manage'),
    { clientKinds: HUMAN, humanOnly: true, wave: '3B', basis: OAUTH_DOC },
  ),
  'oauth.client.approve': inlineAccess(
    'Approve an OAuth client (exact client_id and metadata fingerprint)',
    { subject: 'access', wave: '3B', basis: OAUTH_DOC },
  ),
  'oauth.client.reject': inlineAccess('Reject a pending OAuth client', {
    subject: 'access',
    wave: '3B',
    basis: OAUTH_DOC,
  }),
  'oauth.client.disable': inlineAccess(
    'Disable an OAuth client (its grants and tokens end at once)',
    { subject: 'access', wave: '3B', basis: OAUTH_DOC },
  ),
  'oauth.grant.list': accessRead('List grants of every identity', {
    wave: '3B',
    basis: OAUTH_DOC,
  }),
  'oauth.grant.revoke': inlineAccess("Revoke another identity's grant and all its tokens", {
    subject: 'access',
    wave: '3B',
    basis: OAUTH_DOC,
  }),
  'service_account.list': accessRead('List service accounts', { wave: '3B', basis: OAUTH_DOC }),
  'service_account.get': accessRead('Get a service account', { wave: '3B', basis: OAUTH_DOC }),
  'service_account.create': inlineAccess('Create a service account (no role, no credential)', {
    wave: '3B',
    basis: OAUTH_DOC,
  }),
  'service_account.client.register': inlineAccess(
    'Register the OAuth client of a service account (private_key_jwt, public keys only)',
    { wave: '3B', basis: OAUTH_DOC },
  ),
  'service_account.client.keys.replace': inlineAccess(
    "Replace the public keys of a service account's client (rotation)",
    { wave: '3B', basis: OAUTH_DOC },
  ),
  'service_account.grant.create': inlineAccess(
    'Grant a service account a bounded machine authority (resource, scopes, restrictions, expiry)',
    { wave: '3B', basis: OAUTH_DOC },
  ),
  'api_key.list': accessRead('List API keys', { wave: '3B', basis: OAUTH_DOC }),
  'api_key.create': inlineAccess('Create an API key of a service account (shown once)', {
    wave: '3B',
    basis: OAUTH_DOC,
  }),
  'api_key.revoke': inlineAccess('Revoke an API key', { wave: '3B', basis: OAUTH_DOC }),
} as const satisfies Record<string, ActionDefinition>

export type ActionId = keyof typeof ACTIONS

export function isActionId(value: string): value is ActionId {
  return Object.hasOwn(ACTIONS, value)
}

export const ACTION_IDS: readonly ActionId[] = Object.keys(ACTIONS).filter(isActionId)

export function actionDefinition(id: ActionId): ActionDefinition {
  return ACTIONS[id]
}

export const ActionIdSchema = z.enum(ACTION_IDS).meta({ description: 'Registered action kind.' })

/** Changes any record or system (everything except pure reads). */
export function isMutation(id: ActionId): boolean {
  return ACTIONS[id].effect !== 'read'
}

/** A consequential mutation in the sense of C-6. */
export function isConsequential(id: ActionId): boolean {
  return ACTIONS[id].effect === 'consequential'
}

function scopesOfRule(rule: ScopeRule): readonly Scope[] {
  switch (rule.kind) {
    case 'fixed':
      return [rule.scope]
    case 'tiered':
      return (['nonprod', 'prod'] as const).flatMap((tier) => {
        const name = `${rule.permission}:${tier}`
        return isScope(name) ? [name] : []
      })
    default:
      return []
  }
}

/**
 * Scopes that authorize a change (Wave 3B, oauth.md §4): a scope is a write
 * scope when any registered action that needs it changes something (effect
 * other than `read`). Derived from the action registry, never from the
 * scope's name, so `migrations.apply:prod` is a write and `data.read:prod`
 * is not because of what their actions do.
 */
export const WRITE_SCOPES: ReadonlySet<Scope> = new Set(
  ACTION_IDS.flatMap((id) => {
    const a: ActionDefinition = ACTIONS[id]
    return a.effect === 'read' ? [] : scopesOfRule(a.scope)
  }),
)

export function isWriteScope(scope: Scope): boolean {
  return WRITE_SCOPES.has(scope)
}

/**
 * The read permission that governs a plan or an operation of a kind
 * (`read_of_kind`; OD-26 (c), resolved 2026-10-12 by the owner's Wave 6
 * order): the read permission of the kind's domain. A registry kind about a
 * server or a cluster belongs to the node domain, like `server.get` and
 * `cluster.get`. Holders of `plans.approve` at a scope covering the subject
 * may also read, through a Web App session; the creator reads by the same
 * rule.
 */
export function readPermissionOfKind(kind: ActionId): Permission {
  const domain = kind.slice(0, kind.indexOf('.'))
  switch (domain) {
    case 'migration':
    case 'ledger':
      return 'migrations.read'
    case 'node':
    case 'postgres':
    case 'credential':
    case 'packages':
      return 'nodes.read'
    case 'access':
      return 'access.read'
    case 'backup':
    case 'restore':
      return 'backups.read'
    case 'connections':
      return 'diagnostics.read'
    case 'drift':
      return 'schema.read'
    default: {
      const subject = actionDefinition(kind).subject
      return subject === 'server' || subject === 'cluster' || subject === 'node'
        ? 'nodes.read'
        : 'targets.read'
    }
  }
}

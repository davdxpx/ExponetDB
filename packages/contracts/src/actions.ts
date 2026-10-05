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

/** Which permission an action needs. Derived rules resolve through the plan's or operation's kind. */
export type PermissionRule =
  | { readonly kind: 'fixed'; readonly permission: Permission }
  | { readonly kind: 'of_plan_kind' }
  | { readonly kind: 'read_of_kind' }

/** Which OAuth scope an action needs. */
export type ScopeRule =
  | { readonly kind: 'fixed'; readonly scope: Scope }
  /** `<permission>:<tier of the subject>` */
  | { readonly kind: 'tiered'; readonly permission: Permission }
  /** the scope of the plan's kind at the plan's tier (plan.apply) */
  | { readonly kind: 'of_plan_kind' }
  /** the read scope of the plan's or operation's kind */
  | { readonly kind: 'read_of_kind' }

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
    basis: "resources.md: the creator's scope or plans.approve",
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
    { exclusivity: ['target.maintenance'], reauthentication: true, wave: '9' },
  ),
  'node.enroll': adminOperation('Enroll a node', fixed('high'), 'node', 'registry.manage', {
    wave: '5',
  }),
  'node.revoke': adminOperation('Revoke a node', fixed('high'), 'node', 'registry.manage', {
    wave: '5',
  }),
  'node.decommission': adminOperation(
    'Decommission a node',
    fixed('high'),
    'node',
    'registry.manage',
    { wave: '5' },
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
      wave: '3A',
      basis: 'policy-engine.md §5: changing policy configuration is an access.*-class operation',
    },
  ),
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

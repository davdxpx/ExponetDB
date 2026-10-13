import { appendAuditEvent } from '@exponetdb/audit'
import {
  type BindingScope,
  BindingScopeSchema,
  type BuiltInRoleId,
  isBuiltInRoleId,
  rolePermissions,
} from '@exponetdb/contracts'
import {
  type ControlStore,
  ControlStoreError,
  type Queryable,
  type Tx,
} from '@exponetdb/control-store'
import {
  type Clock,
  type IdentityId,
  isId,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  newId,
  type OAuthClientId,
  parseJson,
  type RoleBindingId,
} from '@exponetdb/kernel'
import {
  type ChangedBinding,
  createPlan,
  type ExecutionContext,
  type OperationActor,
  type OperationKind,
  type PlanRecord,
  readPolicySettings,
  WORKER_ACTOR,
} from '@exponetdb/operations'
import {
  type PolicyDecision,
  PolicyEngine,
  principalFacts,
  type RuleRegistry,
  resolveParams,
} from '@exponetdb/policy'
import { scopeColumns } from '../authorization/scope.ts'
import { AuthError } from '../errors.ts'
import { readIdentity } from '../identities.ts'
import { type AccessChange, accessFactProvider, computeAccessFacts } from './facts.ts'

/**
 * Planned access changes (operations-engine.md §2, `access.*`): role
 * bindings, policy settings, enabling and erasing identities. Each is a
 * stored plan with exact content, an analysis and the policy decision,
 * applied by the actor (human, Web App or CLI, 5-minute re-authentication),
 * executed by the worker, verified and audited. The worker writes the
 * Control Store in its own transaction; reconciliation reads what really
 * happened (the rows carry the operation id) and never re-executes.
 */
export interface AccessPolicyContext {
  readonly registry: RuleRegistry
  /** `<package version>+<commit>` of the running build (pv1). */
  readonly codeVersion: string
  readonly clock: Clock
}

/**
 * Who plans an access change: a person in a Web App session, or a person
 * through the first-party CLI (a delegated grant, Wave 3B; then `client` is
 * `cli` with the client's id, and there is no re-authentication). Access
 * actions are human-only, so a service account never plans one.
 */
export interface PlanActor {
  readonly identityId: IdentityId
  readonly label: string
  /** The session's last re-authentication; a delegated caller has none. */
  readonly reauthAt: string | null
  readonly client?: 'web' | 'cli'
  readonly clientId?: OAuthClientId | null
}

export function operationActor(actor: PlanActor): OperationActor {
  return {
    kind: 'human',
    identityId: actor.identityId,
    label: actor.label,
    client: actor.client ?? 'web',
    clientId: actor.clientId ?? null,
  }
}

export async function evaluateAccessPolicy(
  q: Queryable,
  context: AccessPolicyContext,
  input: {
    readonly kind: string
    readonly actor: { readonly identityId: IdentityId; readonly reauthAt?: string | null }
    readonly change: AccessChange
    readonly content: JsonValue
  },
): Promise<PolicyDecision> {
  const facts = await computeAccessFacts(q, input.actor.identityId, input.change)
  const engine = new PolicyEngine({
    registry: context.registry,
    providers: [principalFacts, accessFactProvider(facts)],
    codeVersion: context.codeVersion,
    clock: context.clock,
  })
  return engine.evaluate({
    request: {
      kind: input.kind,
      principal: {
        kind: 'human',
        identityId: input.actor.identityId,
        client: 'web',
        ...(input.actor.reauthAt === undefined || input.actor.reauthAt === null
          ? {}
          : { reauthAt: input.actor.reauthAt }),
      },
      subject: {},
      content: input.content,
    },
    settings: await readPolicySettings(q, {}),
  })
}

// ----- content parsing (plan bodies are JSON; every member is re-checked) -----

function member(body: JsonObject, key: string): JsonValue | undefined {
  return body[key]
}

function contentOf(plan: PlanRecord): JsonObject | undefined {
  const content = member(plan.body, 'content')
  return isJsonObject(content) ? content : undefined
}

export interface RoleBindingContent {
  readonly bindingId: RoleBindingId
  readonly identityId: IdentityId
  readonly roleId: BuiltInRoleId
  readonly scope: BindingScope
}

export function roleBindingContent(plan: PlanRecord): RoleBindingContent | undefined {
  const content = contentOf(plan)
  const scope = BindingScopeSchema.safeParse(content?.['scope'])
  const bindingId = content?.['bindingId']
  const identityId = content?.['identityId']
  const roleId = content?.['roleId']
  if (
    !scope.success ||
    !isId('rlb', bindingId) ||
    !isId('idn', identityId) ||
    typeof roleId !== 'string' ||
    !isBuiltInRoleId(roleId)
  ) {
    return undefined
  }
  return { bindingId, identityId, roleId, scope: scope.data }
}

function identityContent(plan: PlanRecord): IdentityId | undefined {
  const id = contentOf(plan)?.['identityId']
  return isId('idn', id) ? id : undefined
}

export type PolicySettingsContent = SettingsScope & {
  readonly ruleId: string
  readonly params: JsonObject
  readonly revision: number
}

function policySettingsContent(plan: PlanRecord): PolicySettingsContent | undefined {
  const content = contentOf(plan)
  const ruleId = content?.['ruleId']
  const params = content?.['params']
  const revision = content?.['revision']
  const scope = settingsScope(content?.['scopeKind'], content?.['scopeId'])
  if (
    typeof ruleId !== 'string' ||
    !isJsonObject(params) ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    scope === undefined
  ) {
    return undefined
  }
  return { ...scope, ruleId, params, revision }
}

// ----- planning (serve, in the caller's transaction) -----

async function activeBinding(
  q: Queryable,
  identityId: IdentityId,
  roleId: string,
  scope: BindingScope,
): Promise<boolean> {
  const { kind, id } = scopeColumns(scope)
  const { rows } = await q.query(
    'auth.binding.exists',
    `SELECT 1 FROM auth.role_bindings WHERE identity_id = $1 AND role_id = $2 AND scope_kind = $3
       AND coalesce(scope_id, '') = coalesce($4, '') AND state = 'active'`,
    [identityId, roleId, kind, id],
  )
  return rows.length > 0
}

async function rolesOf(q: Queryable, identityId: IdentityId): Promise<JsonValue[]> {
  const { rows } = await q.query(
    'auth.binding.of_identity',
    `SELECT binding_id, role_id, scope_kind, scope_id FROM auth.role_bindings
      WHERE identity_id = $1 AND state = 'active' ORDER BY binding_id`,
    [identityId],
  )
  return rows.map((r) => ({
    bindingId: r.text('binding_id'),
    roleId: r.text('role_id'),
    scopeKind: r.text('scope_kind'),
    scopeId: r.textOrNull('scope_id'),
  }))
}

function sessionReauth(actor: PlanActor) {
  return { identityId: actor.identityId, reauthAt: actor.reauthAt }
}

export async function planRoleBindingCreate(
  tx: Tx,
  context: AccessPolicyContext,
  actor: PlanActor,
  input: {
    readonly identityId: IdentityId
    readonly roleId: BuiltInRoleId
    readonly scope: BindingScope
  },
): Promise<PlanRecord> {
  const identity = await readIdentity(tx, input.identityId)
  if (identity === undefined) {
    throw new AuthError('NOT_FOUND')
  }
  if (identity.state !== 'invited' && identity.state !== 'active') {
    throw new AuthError('IDENTITY_STATE_INVALID')
  }
  // A service account receives roles through this same plan (Wave 3B), never `owner`;
  // the Control Store refuses it as well.
  if (identity.kind === 'service' && input.roleId === 'owner') {
    throw new AuthError('VALIDATION_FAILED')
  }
  if (input.roleId === 'owner' && input.scope.kind !== 'global') {
    throw new AuthError('VALIDATION_FAILED')
  }
  if (await activeBinding(tx, input.identityId, input.roleId, input.scope)) {
    throw new AuthError('BINDING_EXISTS')
  }
  const content: RoleBindingContent = {
    bindingId: newId('rlb', context.clock.nowMs()),
    identityId: input.identityId,
    roleId: input.roleId,
    scope: input.scope,
  }
  const change: AccessChange = { kind: 'role_binding.create', ...input }
  const facts = await computeAccessFacts(tx, actor.identityId, change)
  const before = await rolesOf(tx, input.identityId)
  const policy = await evaluateAccessPolicy(tx, context, {
    kind: 'access.role_binding.create',
    actor: sessionReauth(actor),
    change,
    content: { ...content },
  })
  return createPlan(
    tx,
    {
      kind: 'access.role_binding.create',
      kindVersion: 1,
      actionClass: 'high',
      actor: operationActor(actor),
      subject: {},
      content: { ...content },
      expectedState: { identityState: identity.state, bindingExists: false },
      analysis: {
        before,
        after: [
          ...before,
          {
            bindingId: content.bindingId,
            roleId: content.roleId,
            scopeKind: scopeColumns(content.scope).kind,
            scopeId: scopeColumns(content.scope).id,
          },
        ],
        permissionsGranted: [...rolePermissions(input.roleId)],
        // Without the registry, every non-target scope may cover production.
        coversProduction: input.scope.kind === 'target' ? 'unknown' : true,
        ownerImpact: input.roleId === 'owner' ? 'adds_owner' : 'none',
        escalation: facts === undefined ? 'unknown' : (facts['grantsNotHeld'] ?? []),
      },
      policy,
    },
    { clock: context.clock },
  )
}

export async function planRoleBindingDelete(
  tx: Tx,
  context: AccessPolicyContext,
  actor: PlanActor,
  bindingId: RoleBindingId,
): Promise<PlanRecord> {
  const { rows } = await tx.query(
    'auth.binding.read',
    `SELECT identity_id, role_id, scope_kind, scope_id, state FROM auth.role_bindings WHERE binding_id = $1`,
    [bindingId],
  )
  const row = rows[0]
  const identityId = row?.text('identity_id')
  if (row === undefined || !isId('idn', identityId)) {
    throw new AuthError('NOT_FOUND')
  }
  if (row.text('state') !== 'active') {
    throw new AuthError('IDENTITY_STATE_INVALID')
  }
  const change: AccessChange = { kind: 'role_binding.delete', bindingId }
  const content = { bindingId, identityId }
  const policy = await evaluateAccessPolicy(tx, context, {
    kind: 'access.role_binding.delete',
    actor: sessionReauth(actor),
    change,
    content,
  })
  const before = await rolesOf(tx, identityId)
  return createPlan(
    tx,
    {
      kind: 'access.role_binding.delete',
      kindVersion: 1,
      actionClass: 'high',
      actor: operationActor(actor),
      subject: {},
      content,
      expectedState: { bindingState: 'active' },
      analysis: {
        before,
        after: before.filter((b) => !(isJsonObject(b) && b['bindingId'] === bindingId)),
        ownerImpact: row.text('role_id') === 'owner' ? 'removes_owner' : 'none',
      },
      policy,
    },
    { clock: context.clock },
  )
}

async function latestRevision(
  q: Queryable,
  ruleId: string,
  scope: SettingsScope = INSTALLATION_SCOPE,
): Promise<{ revision: number; params: JsonObject }> {
  const { rows } = await q.query(
    'auth.policy_settings.latest',
    `SELECT revision, params::text AS params FROM policy.rule_settings
      WHERE scope_kind = $2 AND scope_id = $3 AND rule_id = $1
      ORDER BY revision DESC LIMIT 1`,
    [ruleId, scope.scopeKind, scope.scopeId],
  )
  const row = rows[0]
  if (row === undefined) {
    return { revision: 0, params: {} }
  }
  const parsed = parseJson(row.text('params'))
  if (!parsed.ok || !isJsonObject(parsed.value)) {
    throw new AuthError('INTERNAL')
  }
  return { revision: row.int('revision'), params: parsed.value }
}

/** Where a setting applies: the installation, or one registered target (Wave 7, OD-13 (a)). */
export type SettingsScope =
  | { readonly scopeKind: 'installation'; readonly scopeId: 'installation' }
  | { readonly scopeKind: 'target'; readonly scopeId: string }

const INSTALLATION_SCOPE: SettingsScope = { scopeKind: 'installation', scopeId: 'installation' }

function settingsScope(kind: unknown, id: unknown): SettingsScope | undefined {
  if (kind === 'installation' && id === 'installation') return INSTALLATION_SCOPE
  if (kind === 'target' && isId('tgt', id)) return { scopeKind: 'target', scopeId: id }
  return undefined
}

/**
 * Wave 3A planned installation-level settings; since Wave 7 a setting may
 * also apply to one registered target (OD-13 (a): an administrator changes
 * `data.read` per target). Product, project and environment settings are
 * not planned yet. The effective values before and after are computed with
 * what the target inherits, so a target setting that loosens the
 * installation's is seen as loosening (`access.policy-safety`).
 */
export async function planPolicySettingsUpdate(
  tx: Tx,
  context: AccessPolicyContext,
  actor: PlanActor,
  input: {
    readonly scopeKind: string
    readonly scopeId: string
    readonly ruleId: string
    readonly params: JsonObject
  },
): Promise<PlanRecord> {
  const rule = context.registry.get(input.ruleId)
  const scope = settingsScope(input.scopeKind, input.scopeId)
  if (rule === undefined || scope === undefined) {
    throw new AuthError('VALIDATION_FAILED')
  }
  if (scope.scopeKind === 'target') {
    const { rows } = await tx.query(
      'auth.policy_settings.target',
      `SELECT 1 FROM registry.targets WHERE target_id = $1 AND state <> 'decommissioned'`,
      [scope.scopeId],
    )
    if (rows.length === 0) throw new AuthError('NOT_FOUND')
  }
  const latest = await latestRevision(tx, input.ruleId, scope)
  // What the target inherits from the installation (nothing for the installation itself).
  const inherited =
    scope.scopeKind === 'target' ? await latestRevision(tx, input.ruleId) : undefined
  const subject = scope.scopeKind === 'target' ? { targetId: scope.scopeId } : {}
  const rows = (own: { revision: number; params: JsonObject } | undefined) => [
    ...(inherited === undefined || inherited.revision === 0
      ? []
      : [{ ...INSTALLATION_SCOPE, ruleId: rule.id, ...inherited }]),
    ...(own === undefined || own.revision === 0 ? [] : [{ ...scope, ruleId: rule.id, ...own }]),
  ]
  const merged = { ...latest.params, ...input.params }
  const currentEffective = resolveParams(rule, rows(latest), subject)
  const nextEffective = resolveParams(
    rule,
    rows({ revision: latest.revision + 1, params: merged }),
    subject,
  )
  if (
    !currentEffective.ok ||
    !nextEffective.ok ||
    (rule.checkParams !== undefined && !rule.checkParams(nextEffective.value))
  ) {
    throw new AuthError('VALIDATION_FAILED')
  }
  const content = {
    ruleId: rule.id,
    scopeKind: scope.scopeKind,
    scopeId: scope.scopeId,
    params: merged,
    revision: latest.revision + 1,
  }
  const policy = await evaluateAccessPolicy(tx, context, {
    kind: 'access.policy_settings.update',
    actor: sessionReauth(actor),
    change: {
      kind: 'policy_settings.update',
      ruleId: rule.id,
      current: currentEffective.value,
      next: nextEffective.value,
    },
    content,
  })
  return createPlan(
    tx,
    {
      kind: 'access.policy_settings.update',
      kindVersion: 1,
      actionClass: 'high',
      actor: operationActor(actor),
      subject: {},
      content,
      expectedState: { revision: latest.revision },
      analysis: { before: currentEffective.value, after: nextEffective.value },
      policy,
    },
    { clock: context.clock },
  )
}

export async function planIdentityChange(
  tx: Tx,
  context: AccessPolicyContext,
  actor: PlanActor,
  kind: 'access.identity.enable' | 'access.identity.erase',
  identityId: IdentityId,
): Promise<PlanRecord> {
  const identity = await readIdentity(tx, identityId)
  if (identity === undefined) {
    throw new AuthError('NOT_FOUND')
  }
  const allowed =
    kind === 'access.identity.enable' ? identity.state === 'disabled' : identity.state !== 'erased'
  if (!allowed) {
    throw new AuthError('IDENTITY_STATE_INVALID')
  }
  const content = { identityId }
  const policy = await evaluateAccessPolicy(tx, context, {
    kind,
    actor: sessionReauth(actor),
    change: {
      kind: kind === 'access.identity.enable' ? 'identity.enable' : 'identity.erase',
      identityId,
    },
    content,
  })
  return createPlan(
    tx,
    {
      kind,
      kindVersion: 1,
      actionClass: kind === 'access.identity.erase' ? 'critical' : 'standard',
      actor: operationActor(actor),
      subject: {},
      content,
      expectedState: { identityState: identity.state },
      analysis: {
        identityState: identity.state,
        effect:
          kind === 'access.identity.erase'
            ? 'removes e-mail, name, factors, sessions, links and role bindings; keeps the id and label'
            : 'the identity can sign in again with its factors; no role is added',
      },
      policy,
    },
    { clock: context.clock },
  )
}

/** Recomputes the access facts and policy decision of a stored access plan (apply-time recheck). */
export async function reevaluateAccessPlan(
  q: Queryable,
  context: AccessPolicyContext,
  plan: PlanRecord,
  actor: { readonly identityId: IdentityId; readonly reauthAt?: string | null },
): Promise<PolicyDecision | undefined> {
  const content = contentOf(plan)
  let change: AccessChange | undefined
  switch (plan.kind) {
    case 'access.role_binding.create': {
      const c = roleBindingContent(plan)
      change =
        c === undefined
          ? undefined
          : {
              kind: 'role_binding.create',
              identityId: c.identityId,
              roleId: c.roleId,
              scope: c.scope,
            }
      break
    }
    case 'access.role_binding.delete': {
      const bindingId = content?.['bindingId']
      change = isId('rlb', bindingId) ? { kind: 'role_binding.delete', bindingId } : undefined
      break
    }
    case 'access.identity.enable':
    case 'access.identity.erase': {
      const identityId = identityContent(plan)
      change =
        identityId === undefined
          ? undefined
          : {
              kind: plan.kind === 'access.identity.enable' ? 'identity.enable' : 'identity.erase',
              identityId,
            }
      break
    }
    case 'access.policy_settings.update': {
      const c = policySettingsContent(plan)
      const analysis = member(plan.body, 'analysis')
      const before = isJsonObject(analysis) ? analysis['before'] : undefined
      const after = isJsonObject(analysis) ? analysis['after'] : undefined
      change =
        c === undefined || !isJsonObject(before) || !isJsonObject(after)
          ? undefined
          : { kind: 'policy_settings.update', ruleId: c.ruleId, current: before, next: after }
      break
    }
    default:
      change = undefined
  }
  if (change === undefined || content === undefined) {
    return undefined
  }
  return evaluateAccessPolicy(q, context, { kind: plan.kind, actor, change, content })
}

// ----- execution (worker) -----

const sqlstate = (error: unknown) =>
  error instanceof ControlStoreError ? error.sqlstate : undefined

abstract class AccessKind implements OperationKind {
  abstract readonly kind: string
  readonly version = 1
  abstract readonly actionClass: 'standard' | 'high' | 'critical'
  readonly verifies = true
  protected readonly store: ControlStore
  protected readonly clock: Clock

  constructor(store: ControlStore, clock: Clock) {
    this.store = store
    this.clock = clock
  }

  /** Access changes serialize on the Control Store rows they touch; no target domain is held. */
  exclusivity(): readonly string[] {
    return []
  }

  abstract checkBindings(plan: PlanRecord): Promise<readonly ChangedBinding[]>
  abstract execute(
    ctx: ExecutionContext,
  ): Promise<'applied' | 'not_applied' | 'partially_applied' | 'unknown'>
  abstract verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'>
  abstract reconcile(ctx: ExecutionContext): Promise<'applied' | 'not_applied' | 'unknown'>

  protected async audit(tx: Tx, ctx: ExecutionContext, changes: JsonObject): Promise<void> {
    if (!isId('op', ctx.operationId)) {
      throw new AuthError('INTERNAL')
    }
    await appendAuditEvent(
      tx,
      {
        action: this.kind,
        phase: 'completed',
        actor: { kind: 'system', identityId: null, label: WORKER_ACTOR.label },
        refs: {
          operationId: ctx.operationId,
          planId: ctx.plan.planId,
          planHash: ctx.plan.planHash,
        },
        changes: { ...changes },
        result: { status: 'succeeded', applyOutcome: 'applied' },
      },
      { clock: this.clock },
    )
  }

  /** Runs one effect transaction; a refusal of a Control Store guard means nothing was applied. */
  protected async effect(
    fn: (tx: Tx) => Promise<boolean>,
  ): Promise<'applied' | 'not_applied' | 'unknown'> {
    try {
      const applied = await this.store.transaction(`auth.kind.${this.kind}`, fn)
      return applied ? 'applied' : 'not_applied'
    } catch (error) {
      const state = sqlstate(error)
      if (
        state !== undefined &&
        (state.startsWith('EX') || state === '23505' || state === '23503')
      ) {
        return 'not_applied'
      }
      return 'unknown'
    }
  }
}

export class RoleBindingCreateKind extends AccessKind {
  readonly kind = 'access.role_binding.create'
  readonly actionClass = 'high'

  async checkBindings(plan: PlanRecord): Promise<readonly ChangedBinding[]> {
    const content = roleBindingContent(plan)
    if (content === undefined) {
      return [{ binding: 'content', actual: 'invalid' }]
    }
    const { rows } = await this.store.query(
      'auth.kind.binding_create.check',
      'SELECT state FROM auth.identities WHERE identity_id = $1',
      [content.identityId],
    )
    const state = rows[0]?.text('state') ?? null
    const changed: ChangedBinding[] = []
    if (state !== 'invited' && state !== 'active') {
      changed.push({ binding: 'identityState', expected: 'invited|active', actual: state })
    }
    if (await activeBinding(this.store, content.identityId, content.roleId, content.scope)) {
      changed.push({ binding: 'bindingExists', expected: false, actual: true })
    }
    return changed
  }

  async execute(ctx: ExecutionContext) {
    const content = roleBindingContent(ctx.plan)
    if (content === undefined) {
      return 'not_applied' as const
    }
    const { kind, id } = scopeColumns(content.scope)
    return this.effect(async (tx) => {
      await tx.query(
        'auth.kind.binding_create.insert',
        `INSERT INTO auth.role_bindings (binding_id, identity_id, role_id, scope_kind, scope_id, state, origin,
                                         created_by_operation_id, created_at)
         VALUES ($1, $2, $3, $4, $5, 'active', 'operation', $6, clock_timestamp())`,
        [content.bindingId, content.identityId, content.roleId, kind, id, ctx.operationId],
      )
      await this.audit(tx, ctx, {
        bindingId: content.bindingId,
        identityId: content.identityId,
        roleId: content.roleId,
        scopeKind: kind,
        scopeId: id,
      })
      return true
    })
  }

  async verify(ctx: ExecutionContext) {
    const content = roleBindingContent(ctx.plan)
    const { rows } = await this.store.query(
      'auth.kind.binding_create.verify',
      `SELECT 1 FROM auth.role_bindings WHERE binding_id = $1 AND state = 'active'
         AND created_by_operation_id = $2`,
      [content?.bindingId ?? null, ctx.operationId],
    )
    return rows.length === 1 ? ('passed' as const) : ('failed' as const)
  }

  async reconcile(ctx: ExecutionContext) {
    const { rows } = await this.store.query(
      'auth.kind.binding_create.reconcile',
      'SELECT 1 FROM auth.role_bindings WHERE created_by_operation_id = $1',
      [ctx.operationId],
    )
    return rows.length > 0 ? ('applied' as const) : ('not_applied' as const)
  }

  auditSummary(plan: PlanRecord): JsonObject {
    const content = roleBindingContent(plan)
    return content === undefined ? {} : { roleId: content.roleId, scopeKind: content.scope.kind }
  }
}

export class RoleBindingDeleteKind extends AccessKind {
  readonly kind = 'access.role_binding.delete'
  readonly actionClass = 'high'

  #bindingId(plan: PlanRecord): RoleBindingId | undefined {
    const id = contentOf(plan)?.['bindingId']
    return isId('rlb', id) ? id : undefined
  }

  async checkBindings(plan: PlanRecord): Promise<readonly ChangedBinding[]> {
    const bindingId = this.#bindingId(plan)
    const { rows } = await this.store.query(
      'auth.kind.binding_delete.check',
      'SELECT state FROM auth.role_bindings WHERE binding_id = $1',
      [bindingId ?? null],
    )
    const state = rows[0]?.text('state') ?? null
    return state === 'active'
      ? []
      : [{ binding: 'bindingState', expected: 'active', actual: state }]
  }

  async execute(ctx: ExecutionContext) {
    const bindingId = this.#bindingId(ctx.plan)
    return this.effect(async (tx) => {
      const { rowCount } = await tx.query(
        'auth.kind.binding_delete.revoke',
        `UPDATE auth.role_bindings SET state = 'revoked', revoked_at = clock_timestamp(),
                revoke_reason = 'operation', revoked_by_operation_id = $2
          WHERE binding_id = $1 AND state = 'active'`,
        [bindingId ?? null, ctx.operationId],
      )
      if (rowCount !== 1) {
        return false
      }
      await this.audit(tx, ctx, { bindingId: bindingId ?? null })
      return true
    })
  }

  async verify(ctx: ExecutionContext) {
    const { rows } = await this.store.query(
      'auth.kind.binding_delete.verify',
      `SELECT 1 FROM auth.role_bindings WHERE binding_id = $1 AND state = 'revoked' AND revoked_by_operation_id = $2`,
      [this.#bindingId(ctx.plan) ?? null, ctx.operationId],
    )
    return rows.length === 1 ? ('passed' as const) : ('failed' as const)
  }

  async reconcile(ctx: ExecutionContext) {
    const { rows } = await this.store.query(
      'auth.kind.binding_delete.reconcile',
      'SELECT 1 FROM auth.role_bindings WHERE revoked_by_operation_id = $1',
      [ctx.operationId],
    )
    return rows.length > 0 ? ('applied' as const) : ('not_applied' as const)
  }
}

export class PolicySettingsUpdateKind extends AccessKind {
  readonly kind = 'access.policy_settings.update'
  readonly actionClass = 'high'

  async checkBindings(plan: PlanRecord): Promise<readonly ChangedBinding[]> {
    const content = policySettingsContent(plan)
    if (content === undefined) {
      return [{ binding: 'content', actual: 'invalid' }]
    }
    const latest = await latestRevision(this.store, content.ruleId, content)
    return latest.revision === content.revision - 1
      ? []
      : [{ binding: 'settingsRevision', expected: content.revision - 1, actual: latest.revision }]
  }

  async execute(ctx: ExecutionContext) {
    const content = policySettingsContent(ctx.plan)
    if (content === undefined) {
      return 'not_applied' as const
    }
    return this.effect(async (tx) => {
      await tx.query(
        'auth.kind.policy_settings.insert',
        `INSERT INTO policy.rule_settings (scope_kind, scope_id, rule_id, revision, params, operation_id, created_by)
         VALUES ($5, $6, $1, $2, $3::jsonb, $4, current_user)`,
        [
          content.ruleId,
          content.revision,
          JSON.stringify(content.params),
          ctx.operationId,
          content.scopeKind,
          content.scopeId,
        ],
      )
      await this.audit(tx, ctx, { ruleId: content.ruleId, revision: content.revision })
      return true
    })
  }

  async verify(ctx: ExecutionContext) {
    const content = policySettingsContent(ctx.plan)
    const { rows } = await this.store.query(
      'auth.kind.policy_settings.verify',
      `SELECT 1 FROM policy.rule_settings WHERE rule_id = $1 AND revision = $2 AND operation_id = $3`,
      [content?.ruleId ?? null, content?.revision ?? null, ctx.operationId],
    )
    return rows.length === 1 ? ('passed' as const) : ('failed' as const)
  }

  async reconcile(ctx: ExecutionContext) {
    const { rows } = await this.store.query(
      'auth.kind.policy_settings.reconcile',
      'SELECT 1 FROM policy.rule_settings WHERE operation_id = $1',
      [ctx.operationId],
    )
    return rows.length > 0 ? ('applied' as const) : ('not_applied' as const)
  }
}

export class IdentityEnableKind extends AccessKind {
  readonly kind = 'access.identity.enable'
  readonly actionClass = 'standard'

  async checkBindings(plan: PlanRecord): Promise<readonly ChangedBinding[]> {
    const { rows } = await this.store.query(
      'auth.kind.identity_enable.check',
      'SELECT state FROM auth.identities WHERE identity_id = $1',
      [identityContent(plan) ?? null],
    )
    const state = rows[0]?.text('state') ?? null
    return state === 'disabled'
      ? []
      : [{ binding: 'identityState', expected: 'disabled', actual: state }]
  }

  async execute(ctx: ExecutionContext) {
    const identityId = identityContent(ctx.plan)
    return this.effect(async (tx) => {
      const { rowCount } = await tx.query(
        'auth.kind.identity_enable.update',
        `UPDATE auth.identities SET state = 'active' WHERE identity_id = $1 AND state = 'disabled'`,
        [identityId ?? null],
      )
      if (rowCount !== 1) {
        return false
      }
      await tx.query(
        'auth.kind.identity_enable.event',
        `INSERT INTO operations.operation_events (operation_id, kind, detail)
         VALUES ($1, 'step_finished', jsonb_build_object('step', 'identity_enabled'))`,
        [ctx.operationId],
      )
      await this.audit(tx, ctx, { identityId: identityId ?? null, from: 'disabled', to: 'active' })
      return true
    })
  }

  async verify(ctx: ExecutionContext) {
    const { rows } = await this.store.query(
      'auth.kind.identity_enable.verify',
      `SELECT 1 FROM auth.identities WHERE identity_id = $1 AND state = 'active'`,
      [identityContent(ctx.plan) ?? null],
    )
    return rows.length === 1 ? ('passed' as const) : ('failed' as const)
  }

  async reconcile(ctx: ExecutionContext) {
    const { rows } = await this.store.query(
      'auth.kind.identity_enable.reconcile',
      `SELECT 1 FROM operations.operation_events WHERE operation_id = $1 AND kind = 'step_finished'
         AND detail->>'step' = 'identity_enabled'`,
      [ctx.operationId],
    )
    return rows.length > 0 ? ('applied' as const) : ('not_applied' as const)
  }
}

/**
 * Erasure (identity.md §7, audit.md §6): sessions, links, factors,
 * external subjects, role bindings and the profile (display name and
 * picture) go; the identity row keeps only its
 * id, kind and pseudonymous label. Audit events keep the label. The last
 * owner can never be erased (Control Store guard).
 */
export class IdentityEraseKind extends AccessKind {
  readonly kind = 'access.identity.erase'
  readonly actionClass = 'critical'

  async checkBindings(plan: PlanRecord): Promise<readonly ChangedBinding[]> {
    const { rows } = await this.store.query(
      'auth.kind.identity_erase.check',
      'SELECT state FROM auth.identities WHERE identity_id = $1',
      [identityContent(plan) ?? null],
    )
    const state = rows[0]?.text('state') ?? null
    return state !== null && state !== 'erased'
      ? []
      : [{ binding: 'identityState', expected: 'not erased', actual: state }]
  }

  async execute(ctx: ExecutionContext) {
    const identityId = identityContent(ctx.plan)
    if (identityId === undefined) {
      return 'not_applied' as const
    }
    return this.effect(async (tx) => {
      const sessions = await tx.query(
        'auth.kind.identity_erase.sessions',
        `UPDATE auth.web_sessions SET revoked_at = clock_timestamp(), revoke_reason = 'identity_erased'
          WHERE identity_id = $1 AND revoked_at IS NULL`,
        [identityId],
      )
      await tx.query(
        'auth.kind.identity_erase.device_labels',
        // After revocation (the guard allows only this change on a revoked session);
        // the worker may not read device labels, so all are cleared.
        'UPDATE auth.web_sessions SET device_label = NULL WHERE identity_id = $1',
        [identityId],
      )
      await tx.query(
        'auth.kind.identity_erase.links',
        `UPDATE auth.capabilities SET invalidated_at = clock_timestamp()
          WHERE identity_id = $1 AND redeemed_at IS NULL AND invalidated_at IS NULL`,
        [identityId],
      )
      const bindings = await tx.query(
        'auth.kind.identity_erase.bindings',
        `UPDATE auth.role_bindings SET state = 'revoked', revoked_at = clock_timestamp(),
                revoke_reason = 'identity_erased'
          WHERE identity_id = $1 AND state = 'active'`,
        [identityId],
      )
      const factors = await tx.query(
        'auth.kind.identity_erase.factors',
        'DELETE FROM auth.factors WHERE identity_id = $1',
        [identityId],
      )
      await tx.query(
        'auth.kind.identity_erase.subjects',
        'DELETE FROM auth.external_subjects WHERE identity_id = $1',
        [identityId],
      )
      const { rowCount } = await tx.query(
        'auth.kind.identity_erase.identity',
        `UPDATE auth.identities SET state = 'erased', email = NULL, email_normalized = NULL,
                display_name = NULL, webauthn_user_handle = NULL, recovery_required = false,
                session_epoch = session_epoch + 1
          WHERE identity_id = $1 AND state <> 'erased'`,
        [identityId],
      )
      if (rowCount !== 1) {
        return false
      }
      // The profile (display name and picture, owner decision S10) goes with the identity;
      // the Control Store allows the delete only once the identity is erased.
      const profiles = await tx.query(
        'auth.kind.identity_erase.profile',
        'DELETE FROM profiles.identity_profiles WHERE identity_id = $1',
        [identityId],
      )
      await this.audit(tx, ctx, {
        identityId,
        sessionsEnded: sessions.rowCount,
        bindingsRevoked: bindings.rowCount,
        factorsDeleted: factors.rowCount,
        profileDeleted: profiles.rowCount === 1,
      })
      return true
    })
  }

  async verify(ctx: ExecutionContext) {
    const { rows } = await this.store.query(
      'auth.kind.identity_erase.verify',
      `SELECT (SELECT state FROM auth.identities WHERE identity_id = $1) = 'erased'
              AND NOT EXISTS (SELECT FROM auth.factors WHERE identity_id = $1)
              AND NOT EXISTS (SELECT FROM auth.role_bindings WHERE identity_id = $1 AND state = 'active')
              AND NOT EXISTS (SELECT FROM auth.web_sessions WHERE identity_id = $1 AND revoked_at IS NULL)
              AND NOT EXISTS (SELECT FROM profiles.identity_profiles WHERE identity_id = $1) AS ok`,
      [identityContent(ctx.plan) ?? null],
    )
    return rows[0]?.bool('ok') === true ? ('passed' as const) : ('failed' as const)
  }

  async reconcile(ctx: ExecutionContext) {
    const { rows } = await this.store.query(
      'auth.kind.identity_erase.reconcile',
      `SELECT state FROM auth.identities WHERE identity_id = $1`,
      [identityContent(ctx.plan) ?? null],
    )
    return rows[0]?.text('state') === 'erased' ? ('applied' as const) : ('not_applied' as const)
  }
}

/** The access kinds, bound to the worker's Control Store login. */
export function accessKinds(worker: ControlStore, clock: Clock): readonly OperationKind[] {
  return [
    new RoleBindingCreateKind(worker, clock),
    new RoleBindingDeleteKind(worker, clock),
    new PolicySettingsUpdateKind(worker, clock),
    new IdentityEnableKind(worker, clock),
    new IdentityEraseKind(worker, clock),
  ]
}

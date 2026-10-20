import type { ResponseOf } from '../../lib/api/client.ts'
import { t } from '../../lib/i18n/i18n.ts'

/**
 * What the People, Roles and Connected applications pages show, as pure
 * functions: an identity's name, a binding's scope in words, the scope a
 * person types for a new binding (checked for its id prefix and shape; the
 * server checks that it exists), a grant's last use. Names and addresses are
 * untrusted presentation data: returned as text for the untrusted-text
 * patterns, never interpreted.
 */
export type Identity = ResponseOf<'listIdentities'>['items'][number]
export type RoleBinding = ResponseOf<'listRoleBindings'>['items'][number]
export type Role = ResponseOf<'listRoles'>['items'][number]
export type RoleId = Role['id']
export type BindingScope = RoleBinding['scope']
export type Grant = ResponseOf<'listGrants'>['items'][number]
export type Invitation = ResponseOf<'inviteIdentity'>

export const ROLE_IDS = [
  'owner',
  'admin',
  'operator',
  'developer',
  'viewer',
  'auditor',
] as const satisfies readonly RoleId[]

export function isRoleId(value: string): value is RoleId {
  return (ROLE_IDS as readonly string[]).includes(value)
}

export const SCOPE_KINDS = ['global', 'product', 'project', 'environment', 'target'] as const
export type ScopeKind = (typeof SCOPE_KINDS)[number]

export function isScopeKind(value: string): value is ScopeKind {
  return (SCOPE_KINDS as readonly string[]).includes(value)
}

const PREFIX: Readonly<Record<Exclude<ScopeKind, 'global'>, string>> = {
  product: 'prd',
  project: 'prj',
  environment: 'env',
  target: 'tgt',
}

const ULID = '[0-7][0-9A-HJKMNP-TV-Z]{25}'

/** The id prefix a scope of this kind takes (`prd_`, `prj_`, `env_`, `tgt_`). */
export function scopePrefix(kind: Exclude<ScopeKind, 'global'>): string {
  return `${PREFIX[kind]}_`
}

/** The scope a person chose for a new binding, or undefined when the id does not have the kind's shape. */
export function toBindingScope(kind: ScopeKind, id: string): BindingScope | undefined {
  if (kind === 'global') return { kind: 'global' }
  const value = id.trim()
  if (!new RegExp(`^${PREFIX[kind]}_${ULID}$`).test(value)) return undefined
  switch (kind) {
    case 'product':
      return { kind, productId: value }
    case 'project':
      return { kind, projectId: value }
    case 'environment':
      return { kind, environmentId: value }
    case 'target':
      return { kind, targetId: value }
  }
}

export function scopeKindLabel(kind: ScopeKind): string {
  switch (kind) {
    case 'global':
      return t('people.scope.global')
    case 'product':
      return t('people.scope.product')
    case 'project':
      return t('people.scope.project')
    case 'environment':
      return t('people.scope.environment')
    case 'target':
      return t('people.scope.target')
  }
}

/** The id a scope names, or undefined for the installation. */
export function scopeIdOf(scope: BindingScope): string | undefined {
  switch (scope.kind) {
    case 'global':
      return undefined
    case 'product':
      return scope.productId
    case 'project':
      return scope.projectId
    case 'environment':
      return scope.environmentId
    case 'target':
      return scope.targetId
  }
}

/** "Installation" or "Product prd_…". */
export function scopeText(scope: BindingScope): string {
  const id = scopeIdOf(scope)
  return id === undefined
    ? scopeKindLabel('global')
    : t('people.scope.withId', { kind: scopeKindLabel(scope.kind), id })
}

export function roleLabel(role: RoleId): string {
  switch (role) {
    case 'owner':
      return t('roles.role.owner')
    case 'admin':
      return t('roles.role.admin')
    case 'operator':
      return t('roles.role.operator')
    case 'developer':
      return t('roles.role.developer')
    case 'viewer':
      return t('roles.role.viewer')
    case 'auditor':
      return t('roles.role.auditor')
  }
}

/** The name a person gave, else the label the server derived. */
export function identityName(identity: Pick<Identity, 'displayName' | 'label'>): string {
  return identity.displayName ?? identity.label
}

export function identityStateLabel(state: Identity['state']): string {
  switch (state) {
    case 'invited':
      return t('people.state.invited')
    case 'active':
      return t('people.state.active')
    case 'disabled':
      return t('people.state.disabled')
    case 'erased':
      return t('people.state.erased')
  }
}

/** "Passkeys: 1 · Password: set · Authenticator app: set · Recovery codes left: 9". */
export function factorLine(factors: Identity['factors']): string {
  const parts = [
    t('people.factors.passkeys', { count: factors.passkeys }),
    factors.password ? t('people.factors.password') : t('people.factors.noPassword'),
    factors.totp ? t('people.factors.totp') : t('people.factors.noTotp'),
    t('people.factors.recovery', { count: factors.recoveryCodesRemaining }),
  ]
  return parts.join(' · ')
}

/** The active bindings of one identity, in the order the server listed them. */
export function bindingsOf(
  identityId: string,
  bindings: readonly RoleBinding[],
): readonly RoleBinding[] {
  return bindings.filter(
    (binding) => binding.identityId === identityId && binding.state === 'active',
  )
}

/** True when the identity matches what was typed into the filter: its name, address, audit label or ID. */
export function identityMatches(
  identity: Pick<Identity, 'id' | 'label' | 'displayName' | 'email'> & {
    /** Typed `unknown` in the generated SDK; only a string is searched. */
    readonly profileDisplayName?: unknown
  },
  text: string,
): boolean {
  const needle = text.trim().toLowerCase()
  if (needle === '') return true
  return [
    identity.displayName,
    identity.profileDisplayName,
    identity.email,
    identity.label,
    identity.id,
  ].some((field) => typeof field === 'string' && field.toLowerCase().includes(needle))
}

/** What the invitation's delivery means for the person who invited. */
export function deliveryText(delivery: Invitation['invitation']['delivery']): string {
  switch (delivery.status) {
    case 'sent':
      return t('people.invite.delivery.sent')
    case 'failed':
      return t('people.invite.delivery.failed')
    case 'not_configured':
      return t('people.invite.delivery.notConfigured')
  }
}

export function grantStateLabel(state: Grant['state']): string {
  switch (state) {
    case 'active':
      return t('connectedApps.state.active')
    case 'revoked':
      return t('connectedApps.state.revoked')
    case 'expired':
      return t('connectedApps.state.expired')
  }
}

export function lastUseLabel(useClass: NonNullable<Grant['lastUseClass']>): string {
  switch (useClass) {
    case 'read':
      return t('connectedApps.use.read')
    case 'plan':
      return t('connectedApps.use.plan')
    case 'apply':
      return t('connectedApps.use.apply')
    case 'data':
      return t('connectedApps.use.data')
    case 'rest':
      return t('connectedApps.use.rest')
  }
}

/** A map from identity id to the identity, for naming the person of a binding or a grant. */
export function identityIndex(identities: readonly Identity[]): ReadonlyMap<string, Identity> {
  return new Map(identities.map((identity) => [identity.id, identity]))
}

/** The reason of a change as the request takes it: trimmed, left out when empty. */
export function reasonBody(reason: string): { readonly reason?: string } {
  const trimmed = reason.trim()
  return trimmed.length === 0 ? {} : { reason: trimmed }
}

import type { ResponseOf } from '../../lib/api/client.ts'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'

/**
 * The decisions of the account page as pure functions: whether the session
 * is a recovery session, the roles line, which factors exist, which grants
 * are shown and how a grant reads. Everything shown here is either a fixed
 * enum of the contract or passed on to the untrusted-text patterns by the
 * page; nothing here builds markup or a link.
 */
export type Me = ResponseOf<'getMe'>
export type Factor = ResponseOf<'listMyFactors'>['items'][number]
export type Passkey = Extract<Factor, { readonly kind: 'passkey' }>
export type WebSession = ResponseOf<'listMySessions'>['items'][number]
export type Grant = ResponseOf<'listMyGrants'>['items'][number]
export type GrantUseClass = NonNullable<Grant['lastUseClass']>

/** A recovery session may only replace factors (identity.md §9). */
export function isRecoverySession(me: Me): boolean {
  return me.session.assurance === 'recovery' || me.identity.recoveryRequired
}

/** "owner (global), viewer (target)": the active role bindings, or "None". */
export function rolesText(me: Me): string {
  const roles = me.bindings
    .filter((binding) => binding.state === 'active')
    .map((binding) => t('account.role', { role: binding.roleId, scope: binding.scope.kind }))
  return roles.length === 0 ? t('account.roles.none') : roles.join(', ')
}

export function passkeysOf(factors: readonly Factor[]): Passkey[] {
  return factors.flatMap((factor) => (factor.kind === 'passkey' ? [factor] : []))
}

export function hasTotp(factors: readonly Factor[]): boolean {
  return factors.some((factor) => factor.kind === 'totp')
}

/** How many unused recovery codes are left, or undefined when the person has none set. */
export function recoveryCodesLeft(factors: readonly Factor[]): number | undefined {
  for (const factor of factors) {
    if (factor.kind === 'recovery_codes') return factor.remaining
  }
  return undefined
}

/** The grants that can still act: revoked and expired ones are history (audit), not shown. */
export function activeGrants(grants: readonly Grant[]): Grant[] {
  return grants.filter((grant) => grant.state === 'active')
}

/** "REST API: targets.read; nonprod": resource, scopes and tiers of a grant, from enums only. */
export function grantSummary(grant: Grant): string {
  const resource = t(
    grant.resource === 'mcp' ? 'account.grant.resource.mcp' : 'account.grant.resource.api',
  )
  const [first, second] = grant.restrictions.tiers
  const tiers =
    first !== undefined && second !== undefined
      ? t('account.grant.tiers.both', { first, second })
      : (first ?? '')
  return t('account.grant.summary', { resource, scopes: grant.scopes.join(' '), tiers })
}

export function grantTargets(grant: Grant): string {
  const targets = grant.restrictions.targets
  return targets.kind === 'all'
    ? t('account.grant.targets.all')
    : t('account.grant.targets.list', { count: targets.targetIds.length })
}

const USE_CLASS: Readonly<Record<GrantUseClass, MessageKey>> = {
  read: 'account.grant.use.read',
  plan: 'account.grant.use.plan',
  apply: 'account.grant.use.apply',
  data: 'account.grant.use.data',
  rest: 'account.grant.use.rest',
}

/**
 * The last recorded use of a grant: its minute and class, or undefined when
 * none is recorded. Undefined never means "never used": the record began
 * with its deployment and a background write can be lost (resources.md).
 */
export function lastUseOf(
  grant: Grant,
): { readonly at: string; readonly use: string | undefined } | undefined {
  const at = grant.lastUsedAt
  if (at === undefined || at === null) return undefined
  const cls = grant.lastUseClass
  const key = cls === undefined || cls === null ? undefined : USE_CLASS[cls]
  return { at, use: key === undefined ? undefined : t(key) }
}

const ENTITY_ID = (prefix: string) => new RegExp(`^${prefix}_[0-7][0-9A-HJKMNP-TV-Z]{25}$`)
const FACTOR_ID = ENTITY_ID('fac')

/**
 * The ceremony path that removes a passkey, built only from an id of the
 * contract's shape (`fac_<ULID>`); anything else builds no path at all.
 */
export function removePasskeyPath(id: string): `/auth/${string}` | undefined {
  return FACTOR_ID.test(id) ? `/auth/passkeys/${id}/remove` : undefined
}

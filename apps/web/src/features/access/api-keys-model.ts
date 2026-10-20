import { t } from '../../lib/i18n/i18n.ts'
import type { ApiKey, ServiceAccount } from './model.ts'

/**
 * What the API key overview decides, as pure functions: which keys the state
 * filter keeps, which warnings a key carries (it expires soon, it has not
 * been used for a month) and how an account is named. A warning is a reading
 * of the dates the server sent, never a decision: it appears only on a key
 * that is still active, and only because of data the read holds.
 */
export type KeyStateFilter = 'all' | ApiKey['state']

export const KEY_STATE_FILTERS = [
  'all',
  'active',
  'revoked',
  'expired',
] as const satisfies readonly KeyStateFilter[]

export function isKeyStateFilter(value: string): value is KeyStateFilter {
  return (KEY_STATE_FILTERS as readonly string[]).includes(value)
}

export function keyStateFilterLabel(filter: KeyStateFilter): string {
  switch (filter) {
    case 'all':
      return t('access.apiKeys.filter.all')
    case 'active':
      return t('access.apiKeys.filter.active')
    case 'revoked':
      return t('access.apiKeys.filter.revoked')
    case 'expired':
      return t('access.apiKeys.filter.expired')
  }
}

export function keyStateLabel(state: ApiKey['state']): string {
  switch (state) {
    case 'active':
      return t('access.apiKeys.state.active')
    case 'revoked':
      return t('access.apiKeys.state.revoked')
    case 'expired':
      return t('access.apiKeys.state.expired')
  }
}

export function filterKeys(keys: readonly ApiKey[], filter: KeyStateFilter): readonly ApiKey[] {
  return filter === 'all' ? keys : keys.filter((key) => key.state === filter)
}

/** A key that expires within this many days is flagged. */
export const EXPIRES_SOON_DAYS = 14
/** A key not used for this many days is flagged. */
export const UNUSED_DAYS = 30

const DAY_MS = 24 * 60 * 60_000

export interface KeyFlags {
  /** Active, and its expiry is less than 14 days away. */
  readonly expiresSoon: boolean
  /** Active, and the last use (else the creation) is more than 30 days ago. */
  readonly unused: boolean
}

/**
 * The warnings of a key at `nowMs`. Only an active key has any. A key that
 * was never used counts from its creation: one created more than 30 days ago
 * and never used has not been used for 30 days.
 */
export function keyFlags(key: ApiKey, nowMs: number): KeyFlags {
  if (key.state !== 'active') return { expiresSoon: false, unused: false }
  const expires = Date.parse(key.expiresAt)
  const lastActivity = Date.parse(key.lastUsedAt ?? key.createdAt)
  return {
    expiresSoon:
      Number.isFinite(expires) && expires > nowMs && expires - nowMs < EXPIRES_SOON_DAYS * DAY_MS,
    unused: Number.isFinite(lastActivity) && nowMs - lastActivity > UNUSED_DAYS * DAY_MS,
  }
}

/** The account of a key by its ID, for naming it. */
export function accountIndex(
  accounts: readonly ServiceAccount[],
): ReadonlyMap<string, ServiceAccount> {
  return new Map(accounts.map((account) => [account.id, account]))
}

/** The name an account is shown by: the name given at creation, else the audit label. */
export function accountName(account: Pick<ServiceAccount, 'displayName' | 'label'>): string {
  return account.displayName ?? account.label
}

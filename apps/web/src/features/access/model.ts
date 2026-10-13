import type { Tier } from '@exponetdb/contracts'
import { formatUtc } from '@exponetdb/ui-patterns'
import type { ResponseOf } from '../../lib/api/client.ts'
import { t } from '../../lib/i18n/i18n.ts'
import type { Me } from '../../lib/session/guard.tsx'

/**
 * What the access administration pages show and offer, as pure functions:
 * the labels of a client's registration, kind and authentication, its
 * redirect hosts, which decisions an administrator can take on it, and the
 * one-line summaries of keys, grants and API keys. Client metadata is
 * untrusted presentation data: it is returned as text for the untrusted-text
 * patterns, never interpreted.
 */
export type OAuthClient = ResponseOf<'listOAuthClients'>['items'][number]
export type ServiceAccount = ResponseOf<'listServiceAccounts'>['items'][number]
export type ApiKey = ServiceAccount['apiKeys'][number]
export type MachineGrant = ServiceAccount['grants'][number]
export type JwkView = OAuthClient['keys'][number]

/** Whether the person may change clients, service accounts and keys (`access.manage`; the server decides again). */
export function canManageAccess(me: Me): boolean {
  return me.effectivePermissions.some((entry) => entry.permission === 'access.manage')
}

export function registrationLabel(registration: OAuthClient['registration']): string {
  switch (registration) {
    case 'first_party':
      return t('access.client.registration.firstParty')
    case 'pre_registered':
      return t('access.client.registration.preRegistered')
    case 'cimd':
      return t('access.client.registration.cimd')
    case 'dcr':
      return t('access.client.registration.dcr')
  }
}

export function clientKindLabel(kind: OAuthClient['kind']): string {
  switch (kind) {
    case 'web':
      return t('access.client.type.web')
    case 'cli':
      return t('access.client.type.cli')
    case 'mcp':
      return t('access.client.type.mcp')
    case 'ci':
      return t('access.client.type.ci')
  }
}

export function authMethodLabel(method: OAuthClient['tokenEndpointAuthMethod']): string {
  return method === 'private_key_jwt'
    ? t('access.client.auth.privateKeyJwt')
    : t('access.client.auth.none')
}

export function clientStateLabel(state: OAuthClient['state']): string {
  switch (state) {
    case 'pending':
      return t('access.client.state.pending')
    case 'active':
      return t('access.client.state.active')
    case 'rejected':
      return t('access.client.state.rejected')
    case 'disabled':
      return t('access.client.state.disabled')
  }
}

export function serviceStateLabel(state: ServiceAccount['state']): string {
  switch (state) {
    case 'invited':
      return t('access.service.state.invited')
    case 'active':
      return t('access.service.state.active')
    case 'disabled':
      return t('access.service.state.disabled')
    case 'erased':
      return t('access.service.state.erased')
  }
}

/**
 * The distinct hosts of the redirect URIs, as the URL parser reads them (an
 * international name becomes its `xn--` form, so a look-alike host shows as
 * what it is). A URI the parser refuses is returned as it is.
 */
export function redirectHosts(uris: readonly string[]): string[] {
  const hosts: string[] = []
  for (const uri of uris) {
    let host: string
    try {
      host = new URL(uri).host
    } catch {
      host = uri
    }
    if (host.length === 0) host = uri
    if (!hosts.includes(host)) hosts.push(host)
  }
  return hosts
}

export interface ClientDecisions {
  /** Approve the exact client (its current metadata fingerprint). */
  readonly approve: boolean
  readonly reject: boolean
  readonly disable: boolean
  /** Fetch the metadata document again (CIMD only). */
  readonly refresh: boolean
}

/**
 * The decisions an administrator can take on a client, as the Wave 3B page
 * offered them: approve a pending, rejected or disabled client; reject a
 * pending one; disable an active client that is not first party; fetch a
 * CIMD document again.
 */
export function clientDecisions(client: OAuthClient): ClientDecisions {
  return {
    approve:
      client.state === 'pending' || client.state === 'rejected' || client.state === 'disabled',
    reject: client.state === 'pending',
    disable: client.state === 'active' && !client.firstParty,
    refresh: client.registration === 'cimd',
  }
}

/** An active third-party client nobody approved: approved automatically under open registration (OD-5). */
export function approvedAutomatically(client: OAuthClient): boolean {
  return client.state === 'active' && !client.firstParty && client.approvedBy === null
}

/** `kid (kty)` of a registered public key. */
export function keySummary(key: JwkView): string {
  return `${key.kid} (${key.kty})`
}

/** A time as fixed UTC text, or the text as received when it is not a time. */
export function utc(iso: string): string {
  return formatUtc(iso) ?? iso
}

export function tierLabel(tier: Tier): string {
  return tier === 'prod' ? t('access.authority.tier.prod') : t('access.authority.tier.nonprod')
}

export function tiersLabel(tiers: readonly Tier[]): string {
  return tiers.map(tierLabel).join(', ')
}

/** One line for an API key: scopes, state and expiry, the last use when there is one. */
export function apiKeyLine(key: ApiKey): string {
  const params = { scopes: key.scopes.join(' '), until: utc(key.expiresAt) }
  const line =
    key.state === 'active'
      ? t('access.service.apiKey.line.active', params)
      : key.state === 'revoked'
        ? t('access.service.apiKey.line.revoked', params)
        : t('access.service.apiKey.line.expired', params)
  return key.lastUsedAt === null
    ? line
    : `${line} ${t('access.service.apiKey.lastUsed', { time: utc(key.lastUsedAt) })}`
}

/** One line for a machine grant: scopes, tiers, state and expiry. */
export function grantLine(grant: MachineGrant): string {
  const params = {
    scopes: grant.scopes.join(' '),
    tiers: tiersLabel(grant.restrictions.tiers),
    until: utc(grant.expiresAt),
  }
  switch (grant.state) {
    case 'active':
      return t('access.service.grant.line.active', params)
    case 'revoked':
      return t('access.service.grant.line.revoked', params)
    case 'expired':
      return t('access.service.grant.line.expired', params)
  }
}

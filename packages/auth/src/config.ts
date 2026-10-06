import { AuthError } from './errors.ts'

/**
 * Trusted authentication configuration (identity.md §8). The public origin
 * and the WebAuthn relying party id come from the operator's configuration
 * (`EXPONETDB_PUBLIC_URL`, `EXPONETDB_WEBAUTHN_RP_ID`), never from `Host`,
 * `X-Forwarded-Host` or `Origin`. Production requires HTTPS; plain HTTP is
 * accepted only for a loopback host (local development), never a wildcard.
 */
export interface AuthConfig {
  /** `https://db.exponet.cloud`: scheme, host and port only. */
  readonly publicOrigin: string
  /** `db.exponet.cloud`: the origin's host or a registrable parent of it. */
  readonly rpId: string
  readonly rpName: string
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
const DOMAIN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK.has(hostname)
}

export function parseAuthConfig(input: {
  readonly publicUrl: string
  readonly rpId?: string | undefined
}): AuthConfig {
  let url: URL
  try {
    url = new URL(input.publicUrl)
  } catch {
    throw new AuthError('auth_configuration_invalid', { details: { field: 'publicUrl' } })
  }
  const loopback = isLoopbackHost(url.hostname)
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.hostname.includes('*')
  ) {
    throw new AuthError('auth_configuration_invalid', { details: { field: 'publicUrl' } })
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const rpId = input.rpId ?? host
  const isIp = /^[0-9.]+$/.test(rpId) || rpId.includes(':')
  if (
    isIp ||
    !(DOMAIN.test(rpId) || rpId === 'localhost') ||
    !(host === rpId || host.endsWith(`.${rpId}`))
  ) {
    throw new AuthError('auth_configuration_invalid', { details: { field: 'rpId' } })
  }
  return { publicOrigin: url.origin, rpId, rpName: 'ExponetDB' }
}

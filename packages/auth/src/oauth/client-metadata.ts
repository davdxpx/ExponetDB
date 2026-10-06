import {
  GRANT_TYPE_AUTHORIZATION_CODE,
  GRANT_TYPE_REFRESH_TOKEN,
  OAUTH_LIMITS,
} from '@exponetdb/contracts'
import { isJsonObject, type JsonObject, type JsonValue } from '@exponetdb/kernel'
import { parseRedirectUri } from './clients.ts'

/**
 * Validation of untrusted client metadata (CIMD documents, RFC 7591
 * registration requests; OD-5, oauth.md §3). Only public clients exist for
 * these registrations: `token_endpoint_auth_method` is `none` (or absent),
 * there is no secret, no key and no key URL. Redirect URIs follow the
 * redirect rules (https, or http on a loopback host; exact). Display data
 * (name, client URI, software id and version) is kept as text, bounded and
 * free of control characters; it never decides anything. Contacts, logos
 * and policy URLs are not stored (personal data, remote content).
 * Unknown members are ignored (RFC 7591 §2).
 */
export interface ClientMetadata {
  readonly clientName: string
  readonly redirectUris: readonly string[]
  readonly grantTypes: readonly ('authorization_code' | 'refresh_token')[]
  readonly applicationType: 'web' | 'native'
  /** Display-only members, as stored in `oauth.clients.metadata`. */
  readonly display: JsonObject
}

export type MetadataRefusal =
  | 'not_an_object'
  | 'client_id_mismatch'
  | 'redirect_uris_invalid'
  | 'grant_types_invalid'
  | 'response_types_invalid'
  | 'auth_method_unsupported'
  | 'secret_not_allowed'
  | 'keys_not_allowed'
  | 'application_type_invalid'
  | 'client_name_invalid'
  | 'member_invalid'
  | 'too_many_members'

export type MetadataResult =
  | { readonly ok: true; readonly metadata: ClientMetadata }
  | { readonly ok: false; readonly reason: MetadataRefusal }

const refuse = (reason: MetadataRefusal): MetadataResult => ({ ok: false, reason })

function text(value: JsonValue | undefined, max: number): string | undefined | null {
  if (value === undefined) {
    return undefined
  }
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > max ||
    /\p{Cc}/u.test(value)
  ) {
    return null
  }
  return value
}

/**
 * @param expectedClientId for a CIMD document: the URL it was fetched from,
 *   which `client_id` must equal exactly; for DCR: undefined (a `client_id`
 *   member is then refused, the server assigns it).
 * @param fallbackName the name shown when the client gives none.
 */
export function validateClientMetadata(
  document: JsonValue,
  expectedClientId: string | undefined,
  fallbackName: string,
): MetadataResult {
  if (!isJsonObject(document)) {
    return refuse('not_an_object')
  }
  if (Object.keys(document).length > 64) {
    return refuse('too_many_members')
  }
  const clientId = document['client_id']
  if (expectedClientId === undefined ? clientId !== undefined : clientId !== expectedClientId) {
    return refuse('client_id_mismatch')
  }
  for (const secret of ['client_secret', 'client_secret_expires_at']) {
    if (document[secret] !== undefined) {
      return refuse('secret_not_allowed')
    }
  }
  for (const keys of ['jwks', 'jwks_uri']) {
    if (document[keys] !== undefined) {
      return refuse('keys_not_allowed')
    }
  }
  const method = document['token_endpoint_auth_method']
  if (method !== undefined && method !== 'none') {
    return refuse('auth_method_unsupported')
  }
  const redirects = document['redirect_uris']
  if (
    !Array.isArray(redirects) ||
    redirects.length === 0 ||
    redirects.length > OAUTH_LIMITS.maxRedirectUris ||
    !redirects.every((u) => typeof u === 'string' && parseRedirectUri(u) !== undefined) ||
    new Set(redirects).size !== redirects.length
  ) {
    return refuse('redirect_uris_invalid')
  }
  const rawGrants = document['grant_types'] ?? [GRANT_TYPE_AUTHORIZATION_CODE]
  const grantTypes: ('authorization_code' | 'refresh_token')[] = []
  if (!Array.isArray(rawGrants) || rawGrants.length === 0 || rawGrants.length > 2) {
    return refuse('grant_types_invalid')
  }
  for (const grant of rawGrants) {
    if (
      (grant !== GRANT_TYPE_AUTHORIZATION_CODE && grant !== GRANT_TYPE_REFRESH_TOKEN) ||
      grantTypes.includes(grant)
    ) {
      return refuse('grant_types_invalid')
    }
    grantTypes.push(grant)
  }
  if (!grantTypes.includes(GRANT_TYPE_AUTHORIZATION_CODE)) {
    return refuse('grant_types_invalid')
  }
  const responseTypes = document['response_types']
  if (
    responseTypes !== undefined &&
    !(Array.isArray(responseTypes) && responseTypes.length === 1 && responseTypes[0] === 'code')
  ) {
    return refuse('response_types_invalid')
  }
  const applicationType = document['application_type'] ?? 'web'
  if (applicationType !== 'web' && applicationType !== 'native') {
    return refuse('application_type_invalid')
  }
  const name = text(document['client_name'], OAUTH_LIMITS.clientNameMaxLength)
  if (name === null) {
    return refuse('client_name_invalid')
  }
  const display: Record<string, string> = {}
  for (const [member, max] of [
    ['client_uri', 512],
    ['software_id', 128],
    ['software_version', 64],
  ] as const) {
    const value = text(document[member], max)
    if (value === null) {
      return refuse('member_invalid')
    }
    if (value !== undefined) {
      display[member] = value
    }
  }
  return {
    ok: true,
    metadata: {
      clientName: name ?? fallbackName,
      redirectUris: redirects.filter((u): u is string => typeof u === 'string'),
      grantTypes,
      applicationType,
      display: (name === undefined
        ? display
        : { ...display, client_name: name }) satisfies JsonObject,
    },
  }
}

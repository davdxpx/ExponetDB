import {
  type AuthorizationServerMetadata,
  CLIENT_ASSERTION_ALGORITHMS,
  GRANT_TYPES,
  MCP_ADVERTISED_SCOPES,
  OAUTH_RESOURCES,
  type OAuthResource,
  type ProtectedResourceMetadata,
  protectedResourceScopes,
  RESOURCE_PATHS,
  SCOPE_IDS,
  type Scope,
  TOKEN_ENDPOINT_AUTH_METHODS,
} from '@exponetdb/contracts'

/**
 * Discovery (oauth.md §2). The issuer is the configured public origin
 * (never `Host` or a forwarded header); each resource is the origin plus its
 * path. Only what is implemented is advertised: no OpenID Connect discovery
 * (ExponetDB issues no ID tokens), no `offline_access`, no `jwks_uri`.
 */
export const OAUTH_PATHS = {
  authorize: '/oauth/authorize',
  token: '/oauth/token',
  revoke: '/oauth/revoke',
  register: '/oauth/register',
  deviceAuthorization: '/oauth/device_authorization',
  /** The Web App pages of the ceremonies. */
  consentPage: '/oauth/consent',
  devicePage: '/oauth/device',
  errorPage: '/oauth/error',
} as const

export const AUTHORIZATION_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server'

/** RFC 9728 §3.1: the well-known segment is inserted before the resource path. */
export function protectedResourceMetadataPath(resource: OAuthResource): string {
  return `/.well-known/oauth-protected-resource${RESOURCE_PATHS[resource]}`
}

export function resourceUri(issuer: string, resource: OAuthResource): string {
  return `${issuer}${RESOURCE_PATHS[resource]}`
}

/** The resource named by an RFC 8707 `resource` value (exact string), or undefined. */
export function resourceOf(issuer: string, value: string | undefined): OAuthResource | undefined {
  if (value === undefined) {
    return undefined
  }
  return OAUTH_RESOURCES.find((r) => resourceUri(issuer, r) === value)
}

/** Scopes a token can ever hold (the session scope `api` and `plans.approve` never). */
export function tokenScopes(): readonly Scope[] {
  return SCOPE_IDS.filter((s) => s !== 'api' && s !== 'plans.approve')
}

export function authorizationServerMetadata(issuer: string): AuthorizationServerMetadata {
  return {
    issuer,
    authorization_endpoint: `${issuer}${OAUTH_PATHS.authorize}`,
    token_endpoint: `${issuer}${OAUTH_PATHS.token}`,
    revocation_endpoint: `${issuer}${OAUTH_PATHS.revoke}`,
    registration_endpoint: `${issuer}${OAUTH_PATHS.register}`,
    device_authorization_endpoint: `${issuer}${OAUTH_PATHS.deviceAuthorization}`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: [...GRANT_TYPES],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: [...TOKEN_ENDPOINT_AUTH_METHODS],
    token_endpoint_auth_signing_alg_values_supported: [...CLIENT_ASSERTION_ALGORITHMS],
    revocation_endpoint_auth_methods_supported: [...TOKEN_ENDPOINT_AUTH_METHODS],
    revocation_endpoint_auth_signing_alg_values_supported: [...CLIENT_ASSERTION_ALGORITHMS],
    scopes_supported: [...tokenScopes()],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  }
}

export function protectedResourceMetadata(
  issuer: string,
  resource: OAuthResource,
): ProtectedResourceMetadata {
  return {
    resource: resourceUri(issuer, resource),
    authorization_servers: [issuer],
    scopes_supported: [...(resource === 'mcp' ? MCP_ADVERTISED_SCOPES : protectedResourceScopes())],
    bearer_methods_supported: ['header'],
    resource_name: resource === 'mcp' ? 'ExponetDB MCP' : 'ExponetDB REST API',
  }
}

/**
 * The `WWW-Authenticate` challenge of a protected resource (RFC 6750 §3,
 * RFC 9728 §5.1). Values are fixed strings and catalog scope names; nothing
 * from the request is echoed. `scope` is one scope or a list (MCP: the
 * scopes already held plus the missing one, since some clients replace
 * rather than merge; without `code` it is the hint of a first challenge).
 */
export function bearerChallenge(
  issuer: string,
  resource: OAuthResource,
  error?: {
    readonly code?: 'invalid_token' | 'insufficient_scope'
    readonly scope?: Scope | readonly Scope[]
  },
): string {
  const parts = [`resource_metadata="${issuer}${protectedResourceMetadataPath(resource)}"`]
  if (error?.code !== undefined) {
    parts.unshift(`error="${error.code}"`)
  }
  const scopes =
    error?.scope === undefined ? [] : typeof error.scope === 'string' ? [error.scope] : error.scope
  if (scopes.length > 0) {
    parts.push(`scope="${scopes.join(' ')}"`)
  }
  return `Bearer ${parts.join(', ')}`
}

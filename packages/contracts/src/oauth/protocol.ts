import * as z from 'zod'
import { type ClientKind, SCOPE_IDS, type Scope, ScopeSchema } from '../scopes.ts'

/*
 * OAuth protocol contracts of ExponetDB's authorization server (oauth.md,
 * Wave 3B). These are the wire shapes of the protocol endpoints under
 * `/oauth` and `/.well-known`; they are OAuth documents, not `/api/v1`
 * resources, and their errors are the normative OAuth errors (RFC 6749
 * §5.2, RFC 7009, RFC 7591 §3.2.2, RFC 8628 §3.5, RFC 8707), never RFC 9457
 * problems.
 *
 * Standards as implemented: OAuth 2.1 (draft-ietf-oauth-v2-1-16, an
 * Internet-Draft), RFC 8414, RFC 9728, RFC 9207, RFC 8707, RFC 7009,
 * RFC 7591 (approval-gated compatibility only), RFC 8628, RFC 7523
 * (`private_key_jwt` client authentication), RFC 8252 (loopback redirects)
 * and Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document-02,
 * an Internet-Draft), as profiled by MCP 2026-07-28.
 */

/** The two protected resources (audiences). A token is valid for exactly one. */
export const OAUTH_RESOURCES = ['api', 'mcp'] as const
export type OAuthResource = (typeof OAUTH_RESOURCES)[number]
export const OAuthResourceSchema = z.enum(OAUTH_RESOURCES)

/** Path of each resource below the issuer (`https://db.exponet.cloud/api`). */
export const RESOURCE_PATHS: Readonly<Record<OAuthResource, string>> = {
  api: '/api',
  mcp: '/mcp',
}

/**
 * Which resources a client kind may ever obtain a token for. The Web App
 * never holds tokens (sessions only); the first-party CLI and service
 * accounts use the REST API; third-party clients (kind `mcp`) may be bound
 * to either resource, one per grant. MCP machine credentials do not exist:
 * MCP access is always on behalf of a human.
 */
export const RESOURCES_BY_CLIENT_KIND: Readonly<Record<ClientKind, readonly OAuthResource[]>> = {
  web: [],
  cli: ['api'],
  mcp: ['api', 'mcp'],
  ci: ['api'],
}

export const GRANT_TYPE_AUTHORIZATION_CODE = 'authorization_code'
export const GRANT_TYPE_REFRESH_TOKEN = 'refresh_token'
export const GRANT_TYPE_CLIENT_CREDENTIALS = 'client_credentials'
/** RFC 8628 §3.4. */
export const GRANT_TYPE_DEVICE_CODE = 'urn:ietf:params:oauth:grant-type:device_code'
export const GRANT_TYPES = [
  GRANT_TYPE_AUTHORIZATION_CODE,
  GRANT_TYPE_REFRESH_TOKEN,
  GRANT_TYPE_CLIENT_CREDENTIALS,
  GRANT_TYPE_DEVICE_CODE,
] as const
export type GrantType = (typeof GRANT_TYPES)[number]

/** RFC 7523 §2.2. */
export const CLIENT_ASSERTION_TYPE_JWT_BEARER =
  'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'

/** Token endpoint authentication methods of V1: no shared client secrets (OD-5). */
export const TOKEN_ENDPOINT_AUTH_METHODS = ['none', 'private_key_jwt'] as const
export type TokenEndpointAuthMethod = (typeof TOKEN_ENDPOINT_AUTH_METHODS)[number]

/** Asymmetric JWS algorithms accepted for `private_key_jwt` assertions (never `none`, never HMAC). */
export const CLIENT_ASSERTION_ALGORITHMS = ['ES256', 'ES384', 'EdDSA', 'PS256', 'RS256'] as const
export type ClientAssertionAlgorithm = (typeof CLIENT_ASSERTION_ALGORITHMS)[number]

/** How a client became known (OD-5). */
export const CLIENT_REGISTRATIONS = ['first_party', 'pre_registered', 'cimd', 'dcr'] as const
export type ClientRegistration = (typeof CLIENT_REGISTRATIONS)[number]

export const CLIENT_STATES = ['pending', 'active', 'rejected', 'disabled'] as const
export type ClientState = (typeof CLIENT_STATES)[number]

/** The stable OAuth `client_id` values of the first-party clients. */
export const FIRST_PARTY_CLIENT_IDS = {
  web: 'exponetdb-web',
  cli: 'exponetdb-cli',
} as const

/**
 * Bounds of the authorization server (oauth.md §5, Wave 3B). Times are
 * seconds on the database clock.
 */
export const OAUTH_LIMITS = {
  accessTokenSeconds: 600,
  authorizationCodeSeconds: 60,
  authorizationRequestSeconds: 600,
  deviceCodeSeconds: 600,
  deviceIntervalSeconds: 5,
  /** RFC 8628 §3.5: each `slow_down` adds 5 seconds to the interval. */
  deviceSlowDownSeconds: 5,
  grantDefaultDays: 30,
  grantMaxDays: 90,
  machineGrantDefaultDays: 90,
  machineGrantMaxDays: 365,
  apiKeyDefaultDays: 90,
  apiKeyMaxDays: 365,
  clientAssertionMaxLifetimeSeconds: 300,
  clientAssertionClockSkewSeconds: 60,
  dcrPendingDays: 7,
  dcrMaxPending: 50,
  cimdMaxBytes: 64 * 1024,
  cimdTimeoutMs: 5000,
  cimdCacheMinSeconds: 300,
  cimdCacheMaxSeconds: 86_400,
  maxRedirectUris: 8,
  maxRedirectUriLength: 512,
  maxStateLength: 512,
  maxScopes: SCOPE_IDS.length,
  maxTargetRestrictions: 64,
  maxJwksKeys: 4,
  maxQueryLength: 8192,
  maxFormBytes: 16 * 1024,
  maxRegistrationBytes: 16 * 1024,
  clientNameMaxLength: 100,
} as const

/** Normative OAuth error codes used by the protocol endpoints. */
export const OAUTH_ERROR_CODES = [
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
  'access_denied',
  'unsupported_response_type',
  'server_error',
  'temporarily_unavailable',
  'invalid_target',
  'unsupported_token_type',
  'invalid_redirect_uri',
  'invalid_client_metadata',
  'authorization_pending',
  'slow_down',
  'expired_token',
  'invalid_token',
  'insufficient_scope',
] as const
export type OAuthErrorCode = (typeof OAUTH_ERROR_CODES)[number]

/** `{ "error": … }` of the token, revocation, registration and device endpoints. */
export const OAuthErrorResponseSchema = z
  .strictObject({
    error: z.enum(OAUTH_ERROR_CODES),
    error_description: z
      .string()
      .max(256)
      .regex(/^[\x20-\x21\x23-\x5B\x5D-\x7E]*$/)
      .optional(),
  })
  .meta({ id: 'OAuthErrorResponse' })
export type OAuthErrorResponse = z.infer<typeof OAuthErrorResponseSchema>

const HttpsUrl = z.url().max(512)

/** RFC 8414 authorization server metadata as ExponetDB publishes it (never an unimplemented feature). */
export const AuthorizationServerMetadataSchema = z
  .strictObject({
    issuer: HttpsUrl,
    authorization_endpoint: HttpsUrl,
    token_endpoint: HttpsUrl,
    revocation_endpoint: HttpsUrl,
    registration_endpoint: HttpsUrl,
    device_authorization_endpoint: HttpsUrl,
    response_types_supported: z.tuple([z.literal('code')]),
    response_modes_supported: z.tuple([z.literal('query')]),
    grant_types_supported: z.array(z.enum(GRANT_TYPES)),
    code_challenge_methods_supported: z.tuple([z.literal('S256')]),
    token_endpoint_auth_methods_supported: z.array(z.enum(TOKEN_ENDPOINT_AUTH_METHODS)),
    token_endpoint_auth_signing_alg_values_supported: z.array(z.enum(CLIENT_ASSERTION_ALGORITHMS)),
    revocation_endpoint_auth_methods_supported: z.array(z.enum(TOKEN_ENDPOINT_AUTH_METHODS)),
    revocation_endpoint_auth_signing_alg_values_supported: z.array(
      z.enum(CLIENT_ASSERTION_ALGORITHMS),
    ),
    scopes_supported: z.array(ScopeSchema),
    client_id_metadata_document_supported: z.literal(true),
    authorization_response_iss_parameter_supported: z.literal(true),
  })
  .meta({ id: 'AuthorizationServerMetadata' })
export type AuthorizationServerMetadata = z.infer<typeof AuthorizationServerMetadataSchema>

/** RFC 9728 protected resource metadata (one document per resource). */
export const ProtectedResourceMetadataSchema = z
  .strictObject({
    resource: HttpsUrl,
    authorization_servers: z.tuple([HttpsUrl]),
    scopes_supported: z.array(ScopeSchema),
    bearer_methods_supported: z.tuple([z.literal('header')]),
    resource_name: z.string().max(64),
  })
  .meta({ id: 'ProtectedResourceMetadata' })
export type ProtectedResourceMetadata = z.infer<typeof ProtectedResourceMetadataSchema>

/** The minimal baseline advertised for both resources; more is requested by step-up. */
export function protectedResourceScopes(): readonly Scope[] {
  return ['targets.read', 'schema.read', 'diagnostics.read']
}

/** RFC 6749 §5.1 token response (no identity data, no ID token). */
export const TokenResponseSchema = z
  .strictObject({
    access_token: z.string().regex(/^exat_[A-Za-z0-9_-]{43}$/),
    token_type: z.literal('Bearer'),
    expires_in: z.int().min(1).max(OAUTH_LIMITS.accessTokenSeconds),
    scope: z.string().max(4096),
    refresh_token: z
      .string()
      .regex(/^exrt_[A-Za-z0-9_-]{43}$/)
      .optional(),
  })
  .meta({ id: 'TokenResponse' })
export type TokenResponse = z.infer<typeof TokenResponseSchema>

/** RFC 8628 §3.2 device authorization response (no `verification_uri_complete`, see oauth.md §5). */
export const DeviceAuthorizationResponseSchema = z
  .strictObject({
    device_code: z.string().regex(/^exdc_[A-Za-z0-9_-]{43}$/),
    user_code: z.string().regex(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/),
    verification_uri: HttpsUrl,
    expires_in: z.int().min(1).max(OAUTH_LIMITS.deviceCodeSeconds),
    interval: z.int().min(1).max(60),
  })
  .meta({ id: 'DeviceAuthorizationResponse' })
export type DeviceAuthorizationResponse = z.infer<typeof DeviceAuthorizationResponseSchema>

/** RFC 7591 §3.2.1 registration response of an approval-gated public client (never a secret). */
export const ClientRegistrationResponseSchema = z
  .strictObject({
    client_id: z.string().regex(/^exdb-dcr-[A-Za-z0-9_-]{43}$/),
    client_id_issued_at: z.int().min(0),
    client_name: z.string().max(OAUTH_LIMITS.clientNameMaxLength),
    redirect_uris: z.array(z.string().max(OAUTH_LIMITS.maxRedirectUriLength)),
    grant_types: z.array(z.enum([GRANT_TYPE_AUTHORIZATION_CODE, GRANT_TYPE_REFRESH_TOKEN])),
    response_types: z.tuple([z.literal('code')]),
    token_endpoint_auth_method: z.literal('none'),
    application_type: z.enum(['web', 'native']).optional(),
  })
  .meta({ id: 'ClientRegistrationResponse' })
export type ClientRegistrationResponse = z.infer<typeof ClientRegistrationResponseSchema>

/** `Bearer` token values the resource servers accept (the prefix decides the credential type). */
export const ACCESS_TOKEN_PATTERN = /^exat_[A-Za-z0-9_-]{43}$/
export const API_KEY_PATTERN = /^exak_[A-Za-z0-9_-]{43}$/

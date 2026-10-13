import * as z from 'zod'
import {
  entityId,
  GrantIdSchema,
  IdentityIdSchema,
  OAuthClientIdSchema,
  TargetIdSchema,
  TargetPathSchema,
  TierSchema,
  TimestampSchema,
  untrustedText,
} from '../common.ts'
import { IdentityLabelSchema } from '../rest/access.ts'
import { ClientKindSchema, ScopeSchema } from '../scopes.ts'
import {
  CLIENT_ASSERTION_ALGORITHMS,
  CLIENT_REGISTRATIONS,
  CLIENT_STATES,
  OAUTH_LIMITS,
  OAuthResourceSchema,
  TOKEN_ENDPOINT_AUTH_METHODS,
} from './protocol.ts'

/*
 * Views and request bodies of the delegation surfaces (Wave 3B): OAuth
 * clients and their approval, grants ("connected applications"), service
 * accounts, API keys, and the Web App consent and device-verification
 * ceremonies. No view carries a token, a code, a hash, a private key or a
 * raw address. Client display metadata comes from the client and is
 * untrusted: it is shown as text and never decides anything.
 */

export const ApiKeyIdSchema = entityId('key')

/** Where a grant or API key may act, on top of the identity's live role bindings. */
export const TargetRestrictionSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('all') }).meta({
      description: 'Every target the identity may reach through its live role bindings.',
    }),
    z.strictObject({
      kind: z.literal('list'),
      targetIds: z
        .array(TargetIdSchema)
        .min(1)
        .max(OAUTH_LIMITS.maxTargetRestrictions)
        .refine((ids) => new Set(ids).size === ids.length, 'targets must be unique'),
    }),
  ])
  .meta({ id: 'TargetRestriction' })
export type TargetRestriction = z.infer<typeof TargetRestrictionSchema>

export const GrantRestrictionsSchema = z
  .strictObject({
    tiers: z
      .array(TierSchema)
      .min(1)
      .max(2)
      .refine((t) => new Set(t).size === t.length, 'tiers must be unique'),
    targets: TargetRestrictionSchema,
  })
  .meta({ id: 'GrantRestrictions' })
export type GrantRestrictions = z.infer<typeof GrantRestrictionsSchema>

const ClientIdentifierSchema = z.string().min(1).max(OAUTH_LIMITS.maxRedirectUriLength).meta({
  description:
    'The OAuth client_id: a fixed first-party id, a CIMD URL, a generated DCR id, or the cli_ id of a service-account client. An identifier, never a credential.',
})

export const OAuthClientSummarySchema = z
  .object({
    id: OAuthClientIdSchema,
    clientId: ClientIdentifierSchema,
    kind: ClientKindSchema,
    registration: z.enum(CLIENT_REGISTRATIONS),
    state: z.enum(CLIENT_STATES),
    firstParty: z.boolean(),
    name: untrustedText(
      OAUTH_LIMITS.clientNameMaxLength,
      'Client name; untrusted presentation data.',
    ),
  })
  .meta({ id: 'OAuthClientSummary' })

export const JwkViewSchema = z
  .object({
    kid: z.string().max(64),
    kty: z.enum(['EC', 'OKP', 'RSA']),
    alg: z.enum(CLIENT_ASSERTION_ALGORITHMS).nullable(),
    thumbprint: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .meta({ id: 'JwkView', description: 'A registered public key (RFC 7638 thumbprint).' })

export const OAuthClientViewSchema = OAuthClientSummarySchema.extend({
  redirectUris: z.array(untrustedText(OAUTH_LIMITS.maxRedirectUriLength, 'Redirect URI.')),
  applicationType: z.enum(['web', 'native']).nullable(),
  tokenEndpointAuthMethod: z.enum(TOKEN_ENDPOINT_AUTH_METHODS),
  grantTypes: z.array(z.string().max(64)),
  metadataFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  approvedFingerprint: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/)
    .nullable(),
  createdAt: TimestampSchema,
  stateChangedAt: TimestampSchema,
  approvedAt: TimestampSchema.nullable(),
  approvedBy: IdentityIdSchema.nullable(),
  pendingExpiresAt: TimestampSchema.nullable(),
  requesterHash: z
    .string()
    .regex(/^hmac-sha256:[0-9a-f]{64}$/)
    .nullable()
    .meta({ description: 'Keyed pseudonym of the DCR requester address; never the address.' }),
  metadataFetchedAt: TimestampSchema.nullable(),
  metadataExpiresAt: TimestampSchema.nullable(),
  serviceAccountId: IdentityIdSchema.nullable(),
  keys: z.array(JwkViewSchema),
  clientUri: untrustedText(
    512,
    'client_uri from the metadata; shown as text, never fetched.',
  ).nullable(),
  softwareId: untrustedText(128, 'software_id from the metadata; unverified.').nullable(),
  softwareVersion: untrustedText(64, 'software_version from the metadata; unverified.').nullable(),
}).meta({ id: 'OAuthClient' })
export type OAuthClientView = z.infer<typeof OAuthClientViewSchema>

export const GrantStateSchema = z.enum(['active', 'revoked', 'expired']).meta({ id: 'GrantState' })

/**
 * How a grant was last used (Wave 7 decision 10): an MCP tool's rate class or
 * `rest` for a call to `/api/v1`. Mirrors `GRANT_USE_CLASSES` of
 * `@exponetdb/auth` (a test keeps the two equal).
 */
export const GRANT_USE_CLASS_VALUES = ['read', 'plan', 'apply', 'data', 'rest'] as const
export const GrantUseClassSchema = z
  .enum(GRANT_USE_CLASS_VALUES)
  .meta({ id: 'GrantUseClass', description: 'How a grant was last used.' })

export const GrantViewSchema = z
  .object({
    id: GrantIdSchema,
    kind: z.enum(['delegated', 'machine']),
    identityId: IdentityIdSchema,
    client: OAuthClientSummarySchema,
    resource: OAuthResourceSchema,
    resourceUri: z.url().max(512),
    scopes: z.array(ScopeSchema),
    restrictions: GrantRestrictionsSchema,
    createdAt: TimestampSchema,
    consentAt: TimestampSchema.nullable(),
    expiresAt: TimestampSchema,
    state: GrantStateSchema,
    revokedAt: TimestampSchema.nullable(),
    revokeReason: z.string().max(64).nullable(),
    lastTokenAt: TimestampSchema.nullable(),
    lastUsedAt: TimestampSchema.nullable().optional().meta({
      description:
        'Wave 8, additive: the minute of the last request the grant authenticated (a token of this grant presented to `/api/v1` or `/mcp`), as the Control Store recorded it; at most one write a minute. null: no use is recorded, which is not proof that the grant was never used (the record began with its deployment and a background write can be lost). A data basis for "last used", never an input to a decision.',
    }),
    lastUseClass: GrantUseClassSchema.nullable().optional().meta({
      description: 'Wave 8, additive: how the last recorded use came in; null with `lastUsedAt`.',
    }),
  })
  .meta({ id: 'Grant' })
export type GrantView = z.infer<typeof GrantViewSchema>

export const ApiKeyViewSchema = z
  .object({
    id: ApiKeyIdSchema,
    serviceAccountId: IdentityIdSchema,
    label: untrustedText(64, 'Label chosen at creation.').nullable(),
    scopes: z.array(ScopeSchema),
    restrictions: GrantRestrictionsSchema,
    createdAt: TimestampSchema,
    createdBy: IdentityIdSchema,
    expiresAt: TimestampSchema,
    lastUsedAt: TimestampSchema.nullable(),
    revokedAt: TimestampSchema.nullable(),
    state: z.enum(['active', 'revoked', 'expired']),
  })
  .meta({ id: 'ApiKey' })
export type ApiKeyView = z.infer<typeof ApiKeyViewSchema>

/** The only response that carries an API key: at creation, once, never again. */
export const ApiKeyCreatedSchema = z
  .object({
    apiKey: ApiKeyViewSchema,
    secret: z
      .string()
      .regex(/^exak_[A-Za-z0-9_-]{43}$/)
      .meta({ description: 'The API key, shown once; only its hash is stored.' }),
  })
  .meta({ id: 'ApiKeyCreated' })
export type ApiKeyCreated = z.infer<typeof ApiKeyCreatedSchema>

export const ServiceAccountViewSchema = z
  .object({
    id: IdentityIdSchema,
    label: IdentityLabelSchema,
    displayName: untrustedText(128, 'Display name of the service account.').nullable(),
    state: z.enum(['invited', 'active', 'disabled', 'erased']),
    responsibleIdentityId: IdentityIdSchema,
    createdBy: IdentityIdSchema,
    createdAt: TimestampSchema,
    client: OAuthClientViewSchema.nullable(),
    apiKeys: z.array(ApiKeyViewSchema),
    grants: z.array(GrantViewSchema),
  })
  .meta({ id: 'ServiceAccount' })
export type ServiceAccountView = z.infer<typeof ServiceAccountViewSchema>

// ----- consent and device verification (Web App ceremonies) -----

export const ScopeOfferSchema = z
  .object({
    scope: ScopeSchema,
    available: z.boolean(),
    reason: z.enum(['not_held', 'not_grantable']).nullable(),
    write: z.boolean(),
    effect: z.enum(['read', 'control_record', 'consequential']).meta({
      description:
        'What the strongest action of this scope does (Wave 7): reads only, records plans or findings without changing a managed system, or changes one. Derived from the action contracts; the consent page shows this, never the name.',
    }),
    tier: TierSchema.nullable(),
    explicitConsent: z.boolean(),
    humanOnly: z.boolean(),
  })
  .meta({ id: 'ScopeOffer' })

/** A target a person may restrict a grant to (Wave 7: the consent target selection). */
export const ConsentTargetSchema = z
  .object({ id: TargetIdSchema, path: TargetPathSchema, tier: TierSchema })
  .meta({ id: 'ConsentTarget' })

export const ConsentClientSchema = OAuthClientSummarySchema.extend({
  redirectHost: untrustedText(256, 'Host the code goes to; shown prominently.').nullable(),
  loopbackRedirect: z.boolean(),
  lookalike: z.boolean().meta({
    description: 'The untrusted name resembles a first-party client but the client is not.',
  }),
}).meta({ id: 'ConsentClient' })

export const ConsentViewSchema = z
  .object({
    kind: z.enum(['authorization_code', 'device']),
    client: ConsentClientSchema,
    resource: OAuthResourceSchema,
    resourceUri: z.url().max(512),
    scopes: z.array(ScopeOfferSchema),
    defaults: GrantRestrictionsSchema,
    targets: z.array(ConsentTargetSchema).max(200).meta({
      description:
        'The targets the person can see, to restrict the grant to some of them (at most 64). Empty when the person may list none; the default is every target of the chosen tiers.',
    }),
    lifetimeDays: z.strictObject({ default: z.int().min(1), max: z.int().min(1) }),
    reauth: z.strictObject({ fresh: z.boolean(), withinSeconds: z.int().min(1) }),
    expiresAt: TimestampSchema,
  })
  .meta({ id: 'ConsentView' })
export type ConsentView = z.infer<typeof ConsentViewSchema>

export const AuthorizationRequestHandleSchema = z
  .string()
  .regex(/^exar_[A-Za-z0-9_-]{43}$/)
  .meta({ description: 'Opaque handle of a pending authorization request.' })

export const UserCodeSchema = z
  .string()
  .min(8)
  .max(16)
  .regex(/^[A-Za-z -]+$/)
  .meta({ description: 'The user code shown by the device (case and dashes do not matter).' })

const decisionFields = {
  decision: z.enum(['allow', 'deny']),
  scopes: z.array(ScopeSchema).max(OAUTH_LIMITS.maxScopes),
  tiers: z
    .array(TierSchema)
    .max(2)
    .refine((t) => new Set(t).size === t.length, 'tiers must be unique'),
  lifetimeDays: z.int().min(1).max(OAUTH_LIMITS.grantMaxDays),
  acknowledgeProduction: z.literal(true).optional(),
  targets: TargetRestrictionSchema.optional().meta({
    description:
      'Wave 7: only these targets (each one the person can see, within the chosen tiers); absent means every target of the chosen tiers.',
  }),
}

export const ConsentViewRequestSchema = z.strictObject({
  request: AuthorizationRequestHandleSchema,
})
export const ConsentDecisionRequestSchema = z
  .strictObject({ request: AuthorizationRequestHandleSchema, ...decisionFields })
  .meta({ id: 'ConsentDecisionRequest' })
export const ConsentResultSchema = z
  .object({ redirectTo: z.string().max(8192) })
  .meta({ id: 'ConsentResult', description: 'Where the browser goes next (the client redirect).' })

export const DeviceViewRequestSchema = z.strictObject({ userCode: UserCodeSchema })
export const DeviceDecisionRequestSchema = z
  .strictObject({ userCode: UserCodeSchema, ...decisionFields })
  .meta({ id: 'DeviceDecisionRequest' })
export const DeviceResultSchema = z
  .object({ status: z.enum(['approved', 'denied']) })
  .meta({ id: 'DeviceResult' })

// ----- administration -----

export const ClientApprovalRequestSchema = z
  .strictObject({
    fingerprint: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .meta({ description: 'The metadata fingerprint the administrator reviewed.' }),
  })
  .meta({ id: 'ClientApprovalRequest' })

export const ClientDecisionReasonSchema = z
  .strictObject({ reason: untrustedText(500, 'Why; stored in the audit.').optional() })
  .meta({ id: 'ClientDecisionReason' })

export const CimdClientRequestSchema = z
  .strictObject({
    clientId: z.string().min(9).max(OAUTH_LIMITS.maxRedirectUriLength).startsWith('https://'),
  })
  .meta({ id: 'CimdClientRequest' })

const JwkCommon = {
  kid: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/),
  alg: z.enum(CLIENT_ASSERTION_ALGORITHMS).optional(),
  use: z.literal('sig').optional(),
}
const b64u = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/)

/** A public signing key; private members (`d`, `p`, `q`, …) and symmetric keys are refused by shape. */
export const PublicJwkSchema = z
  .discriminatedUnion('kty', [
    z.strictObject({
      kty: z.literal('EC'),
      crv: z.enum(['P-256', 'P-384']),
      x: b64u(43, 64),
      y: b64u(43, 64),
      ...JwkCommon,
    }),
    z.strictObject({
      kty: z.literal('OKP'),
      crv: z.literal('Ed25519'),
      x: b64u(43, 43),
      ...JwkCommon,
    }),
    z.strictObject({
      kty: z.literal('RSA'),
      n: b64u(342, 1366),
      e: b64u(1, 8),
      ...JwkCommon,
    }),
  ])
  .meta({ id: 'PublicJwk' })
export type PublicJwk = z.infer<typeof PublicJwkSchema>

export const PublicJwksSchema = z
  .strictObject({
    keys: z
      .array(PublicJwkSchema)
      .min(1)
      .max(OAUTH_LIMITS.maxJwksKeys)
      .refine((keys) => new Set(keys.map((k) => k.kid)).size === keys.length, 'kid must be unique'),
  })
  .meta({ id: 'PublicJwks' })

export const ServiceAccountCreateRequestSchema = z
  .strictObject({
    displayName: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[^\p{Cc}]+$/u),
    responsibleIdentityId: IdentityIdSchema.optional(),
  })
  .meta({ id: 'ServiceAccountCreateRequest' })

export const ServiceClientKeysRequestSchema = z
  .strictObject({ jwks: PublicJwksSchema })
  .meta({ id: 'ServiceClientKeysRequest' })

const machineAuthority = {
  scopes: z.array(ScopeSchema).min(1).max(OAUTH_LIMITS.maxScopes),
  restrictions: GrantRestrictionsSchema,
  acknowledgeProductionWrite: z.literal(true).optional(),
}

export const MachineGrantRequestSchema = z
  .strictObject({
    ...machineAuthority,
    lifetimeDays: z.int().min(1).max(OAUTH_LIMITS.machineGrantMaxDays),
  })
  .meta({ id: 'MachineGrantRequest' })

export const ApiKeyCreateRequestSchema = z
  .strictObject({
    ...machineAuthority,
    label: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[^\p{Cc}]+$/u)
      .optional(),
    lifetimeDays: z.int().min(1).max(OAUTH_LIMITS.apiKeyMaxDays),
  })
  .meta({ id: 'ApiKeyCreateRequest' })

export const RevokeRequestSchema = z
  .strictObject({ reason: untrustedText(500, 'Why; stored in the audit.').optional() })
  .meta({ id: 'RevokeRequest' })

export const RevokeResultSchema = z.object({ revoked: z.boolean() }).meta({ id: 'RevokeResult' })

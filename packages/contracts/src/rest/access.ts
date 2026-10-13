import * as z from 'zod'
import { ActionClassSchema, ActionIdSchema } from '../actions.ts'
import {
  EnvironmentIdSchema,
  entityId,
  IdentityIdSchema,
  JsonValueSchema,
  MigrationIdSchema,
  OperationIdSchema,
  PlanIdSchema,
  ProductIdSchema,
  ProjectIdSchema,
  SessionIdSchema,
  Sha256DigestSchema,
  TargetIdSchema,
  TierSchema,
  TimestampSchema,
  untrustedText,
} from '../common.ts'
import { PermissionSchema } from '../permissions.ts'
import { BINDING_SCOPE_KINDS, RoleIdSchema } from '../roles.ts'
import { PlanViewSchema } from './resources.ts'

/*
 * Access resources of /api/v1 (Wave 3A): the current identity, identities,
 * roles, role bindings, own sessions and factors, policy settings and the
 * approval queue (resources.md "Access", identity.md, authorization.md).
 * Response objects are open; request objects are strict. No secret, hash,
 * public key, raw IP address or raw user agent is part of any shape.
 */

export const AuthFactorIdSchema = entityId('fac')
export const RoleBindingIdSchema = entityId('rlb')
export const ApprovalIdSchema = entityId('apr')

/** A pseudonymous audit label, `human #<n>` (audit.md §6). */
export const IdentityLabelSchema = z
  .string()
  .regex(/^(?:human|service) #[1-9][0-9]{0,9}$/)
  .meta({ description: 'Pseudonymous label used in audit events.' })

/** E-mail addresses are contact data, never identifiers (federation.md §1). */
export const EmailSchema = z
  .string()
  .min(3)
  .max(254)
  .regex(/^[^\s@\p{Cc}]{1,64}@[^\s@\p{Cc}]{1,190}\.[^\s@\p{Cc}]{1,63}$/u)
  .meta({ description: 'E-mail address (contact data; never an identifier).' })

export const IdentityStateSchema = z
  .enum(['invited', 'active', 'disabled', 'erased'])
  .meta({ id: 'IdentityState' })

/**
 * Where a binding applies. Coverage is structural (global ⊇ product ⊇
 * project ⊇ target, environment ⊇ its targets); there is no text wildcard.
 */
export const BindingScopeSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('global') }),
    z.strictObject({ kind: z.literal('product'), productId: ProductIdSchema }),
    z.strictObject({ kind: z.literal('project'), projectId: ProjectIdSchema }),
    z.strictObject({ kind: z.literal('environment'), environmentId: EnvironmentIdSchema }),
    z.strictObject({ kind: z.literal('target'), targetId: TargetIdSchema }),
  ])
  .meta({ id: 'BindingScope' })
export type BindingScope = z.infer<typeof BindingScopeSchema>
export const BindingScopeKindSchema = z.enum(BINDING_SCOPE_KINDS)

export const FactorSummarySchema = z
  .object({
    passkeys: z.int().min(0),
    password: z.boolean(),
    totp: z.boolean(),
    recoveryCodesRemaining: z.int().min(0),
  })
  .meta({ id: 'FactorSummary' })

export const IdentityViewSchema = z
  .object({
    id: IdentityIdSchema,
    kind: z.enum(['human', 'service']),
    state: IdentityStateSchema,
    label: IdentityLabelSchema,
    displayName: untrustedText(128, 'Display name; null after erasure.').nullable(),
    email: EmailSchema.nullable().meta({ description: 'Contact address; null after erasure.' }),
    createdAt: TimestampSchema,
    activatedAt: TimestampSchema.nullable(),
    recoveryRequired: z.boolean(),
    factors: FactorSummarySchema,
  })
  .meta({ id: 'Identity' })

export const RoleBindingViewSchema = z
  .object({
    id: RoleBindingIdSchema,
    identityId: IdentityIdSchema,
    roleId: RoleIdSchema,
    scope: BindingScopeSchema,
    state: z.enum(['active', 'revoked']),
    createdAt: TimestampSchema,
    createdByOperationId: OperationIdSchema.nullable(),
    revokedAt: TimestampSchema.nullable(),
  })
  .meta({ id: 'RoleBinding' })

export const SessionViewSchema = z
  .object({
    id: SessionIdSchema,
    current: z.boolean(),
    clientKind: z.literal('web'),
    createdAt: TimestampSchema,
    lastSeenAt: TimestampSchema,
    idleExpiresAt: TimestampSchema,
    expiresAt: TimestampSchema,
    device: untrustedText(
      64,
      'Coarse device label (browser and system family); never the raw user agent.',
    ),
    reauthAt: TimestampSchema.nullable(),
    assurance: z.enum(['full', 'recovery']),
  })
  .meta({ id: 'WebSession' })

export const FactorViewSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('passkey'),
      id: AuthFactorIdSchema,
      label: untrustedText(64, 'Passkey label chosen by the person.'),
      createdAt: TimestampSchema,
      lastUsedAt: TimestampSchema.nullable(),
      backedUp: z.boolean(),
      deviceType: z.enum(['singleDevice', 'multiDevice']),
    }),
    z.object({
      kind: z.literal('password'),
      id: AuthFactorIdSchema,
      createdAt: TimestampSchema,
    }),
    z.object({
      kind: z.literal('totp'),
      id: AuthFactorIdSchema,
      createdAt: TimestampSchema,
      lastUsedAt: TimestampSchema.nullable(),
    }),
    z.object({
      kind: z.literal('recovery_codes'),
      id: AuthFactorIdSchema,
      createdAt: TimestampSchema,
      remaining: z.int().min(0).max(10),
    }),
  ])
  .meta({ id: 'AuthFactor' })

export const EffectivePermissionSchema = z
  .object({ permission: PermissionSchema, scopes: z.array(BindingScopeSchema) })
  .meta({ id: 'EffectivePermission' })

export const MeSchema = z
  .object({
    identity: IdentityViewSchema,
    session: SessionViewSchema,
    bindings: z.array(RoleBindingViewSchema),
    effectivePermissions: z.array(EffectivePermissionSchema).meta({
      description:
        'Projection of the live bindings at the time of the request: which permission holds at which scopes. Authorization is evaluated per request; this list is information, not a token.',
    }),
  })
  .meta({ id: 'Me' })

export const PolicyRuleViewSchema = z
  .object({
    id: z.string().max(128),
    version: z.int().min(1),
    description: z.string().max(512),
    appliesTo: z.array(z.string().max(64)),
    severity: z.enum(['deny', 'require', 'warn']),
    defaults: z.record(z.string(), JsonValueSchema),
    settings: z.array(
      z.object({
        scopeKind: z.enum(['installation', 'product', 'project', 'environment', 'target']),
        scopeId: z.string().max(64),
        revision: z.int().min(1),
        params: z.record(z.string(), JsonValueSchema),
        createdAt: TimestampSchema,
        operationId: OperationIdSchema.nullable(),
      }),
    ),
  })
  .meta({ id: 'PolicyRule' })

export const PolicySettingsViewSchema = z
  .object({ rules: z.array(PolicyRuleViewSchema) })
  .meta({ id: 'PolicySettings' })

export const ApprovalViewSchema = z
  .object({
    id: ApprovalIdSchema,
    operationId: OperationIdSchema,
    planId: PlanIdSchema,
    planHash: Sha256DigestSchema,
    approverIdentityId: IdentityIdSchema,
    decision: z.enum(['approved', 'rejected']),
    selfApproval: z.boolean(),
    decidedAt: TimestampSchema,
    notBefore: TimestampSchema,
  })
  .meta({ id: 'Approval' })

/** The longest file text a review carries (characters); longer files are cut visibly. */
export const REVIEW_SOURCE_MAX_CHARS = 262_144

/** A file of the change as stored, shown verbatim to the person who decides (Wave 7 order §24). */
export const ReviewSourceSchema = z
  .object({
    migrationId: MigrationIdSchema,
    revision: z.int().min(1),
    file: z.enum(['up.sql', 'verify.sql', 'down.sql']),
    text: untrustedText(
      REVIEW_SOURCE_MAX_CHARS,
      'The file exactly as stored: shown as text with line numbers, never as markup or links; cut when truncated is true.',
    ),
    bytes: z.int().min(0),
    truncated: z.boolean(),
  })
  .meta({ id: 'ReviewSource' })

/**
 * What a person reviews before deciding (Wave 7 order §24): only facts the
 * server computed from the stored plan (the plan view with its subject,
 * creator, decision, rules, requirements, expiry and the change with its
 * analysis), the creating client's own name (never verified), and the
 * statements verbatim from the bundle store. Nothing here comes from an
 * agent's words.
 */
export const ApprovalReviewSchema = z
  .object({
    plan: PlanViewSchema,
    clientName: untrustedText(
      100,
      "The creating client's own name: not verified, never a decision.",
    ).nullable(),
    sources: z.array(ReviewSourceSchema).max(64),
  })
  .meta({ id: 'ApprovalReview' })

export const ApprovalQueueItemSchema = z
  .object({
    operationId: OperationIdSchema,
    planId: PlanIdSchema,
    planHash: Sha256DigestSchema,
    kind: ActionIdSchema,
    class: ActionClassSchema,
    tier: TierSchema.nullable(),
    actorIdentityId: IdentityIdSchema.nullable(),
    actorClient: z.enum(['web', 'rest', 'mcp', 'cli', 'ci', 'system']),
    requestedAt: TimestampSchema,
    ownPlan: z.boolean().meta({
      description: 'The caller is the actor of the plan: approving it is a self-approval.',
    }),
    approvals: z.array(ApprovalViewSchema),
    required: z.int().min(1),
    change: z.object({ content: JsonValueSchema, analysis: JsonValueSchema }).optional().meta({
      description:
        'The exact change and its planning-time analysis (access plans): what an approval approves.',
    }),
    review: ApprovalReviewSchema.optional().meta({
      description:
        'Wave 7: the server-computed review of the plan (facts, rules, creator, statements verbatim).',
    }),
  })
  .meta({ id: 'ApprovalQueueItem' })

/** The reviewable part of an access plan: exact content and analysis (Wave 3A kinds). */
export const AccessChangeViewSchema = z
  .object({
    content: JsonValueSchema.meta({ description: 'The exact change the plan executes.' }),
    analysis: JsonValueSchema.meta({
      description:
        'Before, after and risk analysis computed at planning time (effective permissions, production coverage, owner impact, escalation check).',
    }),
  })
  .meta({ id: 'AccessChange' })

// ----- request bodies (strict) -----

export const InviteIdentityRequestSchema = z.strictObject({
  email: EmailSchema,
  displayName: untrustedText(128, 'Display name.').optional(),
})

export const InvitationDeliverySchema = z
  .object({
    status: z.enum(['not_configured', 'sent', 'failed']),
    channel: z.enum(['none', 'email']),
  })
  .meta({
    id: 'InvitationDelivery',
    description:
      'Truthful delivery state: without a configured notification provider nothing is sent and the link must be passed on by the inviting person.',
  })

export const InvitationResponseSchema = z
  .object({
    identity: IdentityViewSchema,
    invitation: z.object({
      link: z.url().meta({
        description:
          'One-time link; the secret is in the fragment. Shown once, never stored in plaintext.',
      }),
      expiresAt: TimestampSchema,
      delivery: InvitationDeliverySchema,
    }),
  })
  .meta({ id: 'Invitation' })

export const DisableIdentityRequestSchema = z.strictObject({
  reason: untrustedText(1000, 'Why; recorded in the audit, permanent.').optional(),
})

export const RoleBindingPlanRequestSchema = z.strictObject({
  identityId: IdentityIdSchema,
  roleId: RoleIdSchema,
  scope: BindingScopeSchema,
})

export const PolicySettingsPlanRequestSchema = z.strictObject({
  scopeKind: z.enum(['installation', 'product', 'project', 'environment', 'target']),
  scopeId: z.string().max(64),
  ruleId: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9-]+)+$/),
  params: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), JsonValueSchema),
})

export const ApprovalDecisionRequestSchema = z.strictObject({
  planHash: Sha256DigestSchema.meta({
    description: 'The plan hash the person reviewed; a different current hash refuses.',
  }),
  acknowledgeSelfApproval: z.literal(true).optional().meta({
    description: 'Required when the caller approves their own plan (OD-9).',
  }),
})

export const SessionRevokeResultSchema = z
  .object({ revoked: z.int().min(0) })
  .meta({ id: 'SessionRevokeResult' })

export type FactorSummaryView = z.infer<typeof FactorSummarySchema>
export type IdentityView = z.infer<typeof IdentityViewSchema>
export type RoleBindingView = z.infer<typeof RoleBindingViewSchema>
export type SessionView = z.infer<typeof SessionViewSchema>
export type FactorView = z.infer<typeof FactorViewSchema>
export type EffectivePermission = z.infer<typeof EffectivePermissionSchema>
export type Me = z.infer<typeof MeSchema>
export type PolicySettingsView = z.infer<typeof PolicySettingsViewSchema>
export type ApprovalView = z.infer<typeof ApprovalViewSchema>
export type ApprovalQueueItem = z.infer<typeof ApprovalQueueItemSchema>
export type AccessChangeView = z.infer<typeof AccessChangeViewSchema>
export type InvitationDelivery = z.infer<typeof InvitationDeliverySchema>
export type InvitationResponse = z.infer<typeof InvitationResponseSchema>

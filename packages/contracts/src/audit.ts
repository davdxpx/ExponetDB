import * as z from 'zod'
import { entityId, untrustedText } from './common.ts'

/**
 * Audit event `exponetdb.audit/v1` ([audit.md §1](../../../exponetdb-docs/02-control-plane/audit.md#1-event-shape)).
 *
 * A stored contract: every event is hashed into the audit chain (`ac1`,
 * audit.md §4.1) exactly as it is shaped here, so a change of shape is a new
 * schema version. Strict at every level: unknown members are refused.
 *
 * Personal data (OD-8, Wave 2 design): identity ids and pseudonymous labels
 * (`human #3`), never names or e-mail addresses; IP addresses and user agents
 * only as keyed hashes (`hmac-sha256:<hex>`); `reason` is caller-supplied,
 * untrusted, length-capped text that is stored, never interpreted.
 */
export const AUDIT_EVENT_SCHEMA_ID = 'exponetdb.audit/v1'
export const AUDIT_CHAIN_HASH_VERSION = 'ac1'

export const AUDIT_PHASES = [
  'requested',
  'denied',
  'accepted',
  'completed',
  'failed',
  'reconciled',
] as const
export type AuditPhase = (typeof AUDIT_PHASES)[number]

const ACTION = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/
const TOKEN = /^[A-Za-z0-9_.:-]{1,128}$/
const KEYED_HASH = /^hmac-sha256:[0-9a-f]{64}$/
const PLAN_HASH = /^sha256:[0-9a-f]{64}$/
const CHECKSUM = /^sha256:c1:[0-9a-f]{64}$/
const CHAIN_HASH = /^sha256:ac1:[0-9a-f]{64}$/

export const AuditActionSchema = z
  .string()
  .max(64)
  .regex(ACTION)
  .meta({ description: 'Audited action, `<domain>.<verb>` (audit.md §2). Open set.' })

/**
 * A pseudonymous label: `human #<n>`, `service #<n>` or `system:<process>`
 * (a process role, `migrate`, or `maintenance` for one-shot maintenance
 * commands). Never a name.
 */
export const AuditActorLabelSchema = z
  .string()
  .regex(
    /^(?:(?:human|service) #[1-9][0-9]{0,9}|system:(?:serve|worker|gateway|migrate|maintenance))$/,
  )

export const AuditActorSchema = z.strictObject({
  kind: z.enum(['human', 'service', 'system']),
  identityId: entityId('idn').nullable(),
  label: AuditActorLabelSchema,
  viaBreakGlass: entityId('bgl').nullable().optional(),
  reauthAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/)
    .nullable()
    .optional(),
})

export const AuditClientSchema = z.strictObject({
  clientId: entityId('cli').nullable(),
  kind: z.enum(['web', 'rest', 'mcp', 'cli', 'ci', 'system']),
  name: untrustedText(
    100,
    'Registered or metadata name of the client; untrusted, never used for decisions.',
  ).optional(),
  grantId: entityId('grt').nullable().optional(),
  sessionId: entityId('ses').nullable().optional(),
})

export const AuditSubjectSchema = z.strictObject({
  targetId: entityId('tgt').optional(),
  targetPath: z
    .string()
    .max(160)
    .regex(/^[a-z][a-z0-9-]{0,38}(?:\/[a-z][a-z0-9-]{0,38}){2}$/)
    .optional(),
  tier: z.enum(['prod', 'nonprod']).optional(),
  clusterId: entityId('cls').optional(),
  serverId: entityId('srv').optional(),
  nodeId: entityId('nod').optional(),
  installationId: entityId('ins').optional(),
  secretId: entityId('sec').optional(),
})

export const AuditRefsSchema = z.strictObject({
  planId: entityId('pln').optional(),
  planHash: z.string().regex(PLAN_HASH).optional(),
  operationId: entityId('op').optional(),
  jobId: entityId('job').nullable().optional(),
  migrationIds: z
    .array(z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/))
    .max(256)
    .optional(),
  checksums: z.array(z.string().regex(CHECKSUM)).max(256).optional(),
  approvalIds: z.array(entityId('apr')).max(32).optional(),
  checkpointSeq: z.number().int().min(1).optional(),
  droppedThroughSeq: z.number().int().min(1).optional(),
  boundaryHash: z.string().regex(CHAIN_HASH).optional(),
  keyIds: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/))
    .max(32)
    .optional(),
})

export const AuditDecisionSchema = z.strictObject({
  decision: z.enum(['allow', 'require', 'deny']),
  rules: z.array(z.string().regex(TOKEN)).max(128),
  policyVersion: z.string().regex(/^sha256:pv1:[0-9a-f]{64}$/),
})

export const AuditResultSchema = z.strictObject({
  status: z.enum(['succeeded', 'failed', 'denied']),
  errorCode: z
    .string()
    .regex(/^[A-Za-z0-9_]{1,64}$/)
    .nullable()
    .optional(),
  applyOutcome: z
    .enum(['not_started', 'applied', 'not_applied', 'partially_applied', 'unknown'])
    .optional(),
  verificationOutcome: z
    .enum(['not_applicable', 'pending', 'passed', 'failed', 'partial', 'error'])
    .optional(),
})

export const AuditRequestSchema = z.strictObject({
  requestId: entityId('req').optional(),
  traceId: z
    .string()
    .regex(/^[0-9a-f]{32}$/)
    .optional(),
  ipHash: z.string().regex(KEYED_HASH).optional(),
  userAgentHash: z.string().regex(KEYED_HASH).optional(),
})

/** Bounded structured change description; never secret values (callers redact). */
const ChangeValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string().max(256),
    z.number().int(),
    z.boolean(),
    z.null(),
    z.array(ChangeValueSchema).max(64),
    z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), ChangeValueSchema),
  ]),
)
export const AuditChangesSchema = z.record(
  z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
  ChangeValueSchema,
)

export const AuditReasonSchema = untrustedText(
  1000,
  'Why, as supplied by the caller: stored verbatim, untrusted, never interpreted, permanent (must not contain personal data).',
)

/** Members a writer supplies; the writer adds `schema`, `seq`, `id` and `occurredAt`. */
export const AuditEventInputSchema = z.strictObject({
  action: AuditActionSchema,
  phase: z.enum(AUDIT_PHASES),
  actor: AuditActorSchema,
  client: AuditClientSchema.optional(),
  subject: AuditSubjectSchema.optional(),
  refs: AuditRefsSchema.optional(),
  reason: AuditReasonSchema.optional(),
  decision: AuditDecisionSchema.optional(),
  result: AuditResultSchema.optional(),
  request: AuditRequestSchema.optional(),
  changes: AuditChangesSchema.optional(),
})
export type AuditEventInput = z.infer<typeof AuditEventInputSchema>

/**
 * The stored and hashed event: the input plus chain position, id and time
 * (database clock, microseconds). The REST read projection is
 * `AuditEventSchema` in `rest/resources.ts`.
 */
export const StoredAuditEventSchema = AuditEventInputSchema.extend({
  schema: z.literal(AUDIT_EVENT_SCHEMA_ID),
  seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  id: entityId('aud'),
  occurredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
}).meta({
  title: AUDIT_EVENT_SCHEMA_ID,
  description: 'One audit event as stored and hashed into the ac1 chain (audit.md §1, §4.1).',
})
export type StoredAuditEvent = z.infer<typeof StoredAuditEventSchema>

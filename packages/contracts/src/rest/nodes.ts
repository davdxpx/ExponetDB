import * as z from 'zod'
import {
  ClusterIdSchema,
  CursorSchema,
  JobIdSchema,
  JsonValueSchema,
  limitSchema,
  NodeIdSchema,
  ObservationSourceSchema,
  OperationIdSchema,
  openEnum,
  pageSchema,
  ServerIdSchema,
  Sha256DigestSchema,
  TimestampSchema,
  untrustedJson,
  untrustedText,
} from '../common.ts'
import {
  ConfigChangeSchema,
  DnsNameSchema,
  ExtensionStepSchema,
  HbaRuleSchema,
  NODE_CAPABILITIES,
  type NodeCapabilityKey,
  ProtectedAccessSchema,
  RoleStepSchema,
} from '../node-protocol/capabilities.ts'
import { KeyIdSchema } from '../node-protocol/primitives.ts'

/**
 * Capability operations through a node ([control-plane.md §9](../../../../exponetdb-docs/07-node-agent/control-plane.md#9-capability-operations)):
 * the inspection request (`node.inspect`), the node-signed observations it
 * keeps, and the plan request of `node.plan` per kind.
 */

/**
 * Capabilities `node.inspect` may run: every read and plan capability except
 * `postgres.tls.plan@1`, which stages a key on the host and runs only inside
 * `postgres.tls.rotate`.
 */
export const INSPECTABLE_CAPABILITIES = (
  Object.keys(NODE_CAPABILITIES) as NodeCapabilityKey[]
).filter((k) => NODE_CAPABILITIES[k].kind !== 'apply' && k !== 'postgres.tls.plan@1')

export const InspectableCapabilitySchema = z
  .enum(INSPECTABLE_CAPABILITIES as [NodeCapabilityKey, ...NodeCapabilityKey[]])
  .meta({ id: 'InspectableCapability', description: 'A read or plan capability, name@major.' })

/** The capabilities whose arguments name a local cluster (`cluster`). */
export function takesCluster(capability: NodeCapabilityKey): boolean {
  const args = NODE_CAPABILITIES[capability].args
  return args instanceof z.ZodObject && 'cluster' in args.shape
}

export const NodeInspectionRequestSchema = z
  .strictObject({
    capability: InspectableCapabilitySchema,
    clusterId: ClusterIdSchema.nullable().meta({
      description:
        'The registry cluster the capability reads; the Control Plane maps it to the node instance (control-plane.md §9.1). null for host capabilities.',
    }),
    args: z.record(z.string(), JsonValueSchema).meta({
      description:
        "The capability's arguments without `cluster`; checked against the capability's schema.",
    }),
  })
  .meta({ id: 'NodeInspectionRequest' })

export const NodeObservationSchema = z
  .strictObject({
    capability: InspectableCapabilitySchema,
    clusterId: ClusterIdSchema.nullable(),
    argsHash: Sha256DigestSchema,
    operationId: OperationIdSchema,
    jobId: JobIdSchema,
    source: z.literal('agent_reported').meta({
      description: "The node's word: its nr1 signature was verified against the bound node key.",
    }),
    observedAt: TimestampSchema.meta({ description: 'When the worker judged the completion.' }),
    result: untrustedJson("The capability's result as the node reported it."),
  })
  .meta({ id: 'NodeObservation' })

export const NodeObservationQuerySchema = z.strictObject({
  capability: InspectableCapabilitySchema.optional(),
  clusterId: ClusterIdSchema.optional(),
})

export const NodeObservationListSchema = z
  .strictObject({ items: z.array(NodeObservationSchema).max(500) })
  .meta({ id: 'NodeObservationList' })

// ----- Wave 8: job history and the agent PKI's certificates (read-only) -----

export const NodeJobSchema = z
  .object({
    id: JobIdSchema,
    nodeId: NodeIdSchema,
    operationId: OperationIdSchema,
    capability: z
      .string()
      .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/)
      .max(80)
      .meta({ description: 'The capability name; its major version is `capabilityMajor`.' }),
    capabilityMajor: z.int().min(1),
    state: openEnum(
      ['pending', 'dispatched', 'running', 'completed', 'expired', 'canceled', 'outcome_unknown'],
      'Where the job is: completed (the node reported a result), expired or canceled (it did not run to completion), outcome_unknown (it ran and nobody can say how it ended).',
    ),
    createdAt: TimestampSchema,
    startedAt: TimestampSchema.nullable(),
    finishedAt: TimestampSchema.nullable().meta({
      description:
        'When the node completed the job; for a job that ended another way, when its state last changed; null while it is open.',
    }),
    outcome: openEnum(
      ['succeeded', 'failed', 'rejected', 'canceled'],
      "What the node reported; null until a result arrives. The node's word, trusted only when `resultVerified` is true.",
    ).nullable(),
    resultVerified: z.boolean().nullable().meta({
      description:
        "Whether the worker verified the node's signature on the result: true, false, or null while it has not judged (or there is no result yet).",
    }),
  })
  .meta({
    id: 'NodeJob',
    description:
      "A job of a node (control-plane.md §7): never the envelope, the arguments, the node's completion or any signature.",
  })

export const NodeJobListQuerySchema = z.strictObject({
  limit: limitSchema(200, 50).optional(),
  cursor: CursorSchema.optional(),
})

export const NodeJobListSchema = pageSchema(NodeJobSchema).meta({ id: 'NodeJobList' })

export const NodeCertificateAuthoritySchema = z
  .object({
    role: openEnum(
      ['root_ca', 'issuing_ca', 'gateway_server_ca', 'postgres_ca'],
      "root_ca and issuing_ca sign node certificates, gateway_server_ca signs the gateway's TLS certificate, postgres_ca signs PostgreSQL server certificates (OD-17).",
    ),
    subjectCommonName: untrustedText(128, 'Common name of the certificate subject.'),
    notBefore: TimestampSchema,
    notAfter: TimestampSchema,
    fingerprint: Sha256DigestSchema.meta({
      description: 'SHA-256 of the DER encoding of the certificate.',
    }),
  })
  .meta({ id: 'NodeCertificateAuthority' })

export const NodeCertificatesSchema = z
  .object({
    authorities: z.array(NodeCertificateAuthoritySchema).max(8),
    notRecorded: z
      .array(
        z.object({
          role: openEnum(
            ['root_ca', 'issuing_ca', 'gateway_server_ca', 'postgres_ca'],
            'A certificate authority the Control Store does not hold yet.',
          ),
          reason: openEnum(['not_initialized'], 'Why it is not listed.'),
        }),
      )
      .max(8),
    nodes: z
      .array(
        z.object({
          nodeId: NodeIdSchema,
          serverId: ServerIdSchema,
          state: openEnum(
            [
              'pending_binding',
              'active',
              'degraded',
              'binding_failed',
              'revoked',
              'decommissioned',
            ],
            "The node's lifecycle state in the registry (not the inferred `offline`).",
          ),
          certificateExpiresAt: TimestampSchema.meta({
            description:
              "Expiry of the node's client certificate as recorded at enrollment or renewal.",
          }),
          serverCertificates: z
            .array(
              z.object({
                localName: untrustedText(128, "The instance's local name as the agent reports it."),
                expiresAt: TimestampSchema,
              }),
            )
            .max(32)
            .meta({
              description:
                'Expiry of the PostgreSQL server certificates the agent reported with its last heartbeat (source: the node, `agent_reported`).',
            }),
        }),
      )
      .max(1000),
    nodesTruncated: z.boolean(),
    notKnown: z
      .array(
        z.object({
          subject: openEnum(
            ['gateway_leaf', 'external_server_certificates'],
            'What this release cannot report.',
          ),
          reason: openEnum(
            ['in_memory_only', 'not_probed'],
            'gateway_leaf: the gateway mints its TLS certificate in memory for 72 hours and records nothing; external_server_certificates: ExponetDB does not connect to external clusters to read their certificates.',
          ),
        }),
      )
      .max(4),
    source: ObservationSourceSchema.meta({
      description:
        'live: read from the Control Store in this request. The expiry of a server certificate inside `nodes` is what the node last reported; the certificate expiry of a node is what it was issued.',
    }),
    observedAt: TimestampSchema,
  })
  .meta({
    id: 'NodeCertificates',
    description:
      "Certificates of the agent PKI and the PostgreSQL CA with their validity, and the expiry of each node's certificate; never key material or a certificate itself.",
  })

/** A role step a plan may carry: never `set_password` (a verifier is never in a plan). */
const PlannedRoleStepSchema = RoleStepSchema.refine((step) => step.op !== 'set_password', {
  message: 'passwords are set by credential.rotate, never by a plan',
})

/** The change of each kind (control-plane.md §9.3). */
export const NodeChangeSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('postgres.reload') }),
    z.strictObject({ kind: z.literal('postgres.restart') }),
    z.strictObject({
      kind: z.literal('postgres.config.apply'),
      changes: z
        .array(ConfigChangeSchema)
        .min(1)
        .max(128)
        .refine((changes) => new Set(changes.map((c) => c.name)).size === changes.length, {
          message: 'each parameter is named once (Wave 5 correction review)',
        }),
      reload: z.boolean(),
    }),
    z.strictObject({
      kind: z.literal('postgres.hba.apply'),
      managedRules: z.array(HbaRuleSchema).max(64),
      protectedAccess: z.array(ProtectedAccessSchema).max(15).meta({
        description:
          "ExponetDB's access to keep besides the agent's own, which the agent always keeps.",
      }),
    }),
    z.strictObject({
      kind: z.literal('postgres.roles.apply'),
      steps: z.array(PlannedRoleStepSchema).min(1).max(1024),
    }),
    z.strictObject({
      kind: z.literal('postgres.extensions.apply'),
      database: z.string().regex(/^[a-z_][a-z0-9_$-]{0,62}$/),
      steps: z.array(ExtensionStepSchema).min(1).max(64),
    }),
    z
      .strictObject({
        kind: z.literal('postgres.tls.rotate'),
        dnsNames: z.array(DnsNameSchema).max(8),
        ipAddresses: z
          .array(z.string().regex(/^(([0-9]{1,3}\.){3}[0-9]{1,3}|[0-9a-f:]{2,39})$/))
          .max(8),
        validityDays: z.int().min(1).max(90),
      })
      .refine((r) => r.dnsNames.length + r.ipAddresses.length > 0, {
        message: 'a server certificate names at least one DNS name or address',
      }),
  ])
  .meta({ id: 'NodeChange' })

export const NodePlanRequestSchema = z
  .strictObject({
    clusterId: ClusterIdSchema.meta({
      description: 'The registry cluster, mapped to the node instance (control-plane.md §9.1).',
    }),
    change: NodeChangeSchema,
  })
  .meta({ id: 'NodePlanRequest' })

export const NodeConfigUpdateRequestSchema = z
  .strictObject({
    addJobKeys: z.array(KeyIdSchema).max(2).meta({
      description: 'Staged or active job keys the node does not trust yet.',
    }),
    retireJobKeys: z.array(KeyIdSchema).max(2).meta({
      description: 'Retiring or retired job keys the node still trusts.',
    }),
  })
  .refine((r) => r.addJobKeys.length + r.retireJobKeys.length > 0, {
    message: 'a job-key change adds or removes at least one key',
  })
  .refine(
    (r) =>
      new Set([...r.addJobKeys, ...r.retireJobKeys]).size ===
      r.addJobKeys.length + r.retireJobKeys.length,
    { message: 'a key is named once' },
  )
  .meta({
    id: 'NodeConfigUpdateRequest',
    description:
      'node.config.update (control-plane.md §9.8): job-signing keys added to or removed from one node; the gateway address is not changed (OD-27).',
  })

export const NODE_PLAN_KINDS = [
  'postgres.reload',
  'postgres.restart',
  'postgres.config.apply',
  'postgres.hba.apply',
  'postgres.roles.apply',
  'postgres.extensions.apply',
  'postgres.tls.rotate',
] as const
export type NodePlanKind = (typeof NODE_PLAN_KINDS)[number]

export type NodeInspectionRequest = z.infer<typeof NodeInspectionRequestSchema>
export type NodeObservation = z.infer<typeof NodeObservationSchema>
export type NodePlanRequest = z.infer<typeof NodePlanRequestSchema>
export type NodeChange = z.infer<typeof NodeChangeSchema>
export type NodeConfigUpdateRequest = z.infer<typeof NodeConfigUpdateRequestSchema>
export type NodeJob = z.infer<typeof NodeJobSchema>
export type NodeCertificates = z.infer<typeof NodeCertificatesSchema>
export type InspectableCapability = z.infer<typeof InspectableCapabilitySchema>

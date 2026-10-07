import * as z from 'zod'
import {
  ClusterIdSchema,
  JobIdSchema,
  JsonValueSchema,
  OperationIdSchema,
  Sha256DigestSchema,
  TimestampSchema,
  untrustedJson,
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
      changes: z.array(ConfigChangeSchema).min(1).max(128),
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
export type InspectableCapability = z.infer<typeof InspectableCapabilitySchema>

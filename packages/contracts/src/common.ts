import {
  type EntityId,
  type IdPrefix,
  idPattern,
  isId,
  isMigrationId,
  type JsonValue,
  MIGRATION_ID_PATTERN,
  type MigrationId,
} from '@exponetdb/kernel'
import * as z from 'zod'

/**
 * Metadata keys ExponetDB attaches to schemas. They appear in generated JSON
 * Schema as annotations: `untrusted` marks database-sourced or caller-supplied
 * text that agents must treat as data (C-26); `x-extensible-enum` marks open
 * enums that may gain values within a major version (versioning.md §2).
 */
export interface ContractMeta {
  readonly id?: string
  readonly title?: string
  readonly description?: string
  readonly untrusted?: boolean
  readonly 'x-extensible-enum'?: readonly string[]
  readonly exponetdbIdPrefix?: IdPrefix
  readonly exponetdbMigrationId?: true
}

/** An entity id schema validated by the kernel's own rule, typed as the kernel brand. */
export function entityId<P extends IdPrefix>(prefix: P) {
  // register() annotates this exact instance (meta() would clone it and leave
  // an unannotated custom schema behind for the JSON Schema generator).
  return z
    .custom<EntityId<P>>((value) => isId(prefix, value), {
      message: `Expected a ${prefix}_<ULID> id (uppercase canonical ULID).`,
    })
    .register(z.globalRegistry, {
      exponetdbIdPrefix: prefix,
      description: `Entity id \`${idPattern(prefix)}\`.`,
    })
}

export const MigrationIdSchema = z
  .custom<MigrationId>((value) => isMigrationId(value), {
    message: 'Expected a migration id (26-character uppercase ULID).',
  })
  .register(z.globalRegistry, {
    exponetdbMigrationId: true,
    description: `Migration ULID \`${MIGRATION_ID_PATTERN}\`.`,
  })

export const ProductIdSchema = entityId('prd')
export const ProjectIdSchema = entityId('prj')
export const EnvironmentIdSchema = entityId('env')
export const TargetIdSchema = entityId('tgt')
export const ServerIdSchema = entityId('srv')
export const NodeIdSchema = entityId('nod')
export const ClusterIdSchema = entityId('cls')
export const PlanIdSchema = entityId('pln')
export const OperationIdSchema = entityId('op')
export const JobIdSchema = entityId('job')
export const EvidenceIdSchema = entityId('evd')
export const IdentityIdSchema = entityId('idn')
export const OAuthClientIdSchema = entityId('cli')
export const GrantIdSchema = entityId('grt')
export const SessionIdSchema = entityId('ses')
export const AuditEventIdSchema = entityId('aud')
export const FindingIdSchema = entityId('fnd')
export const BackupIdSchema = entityId('bkp')
export const RequestIdSchema = entityId('req')

/**
 * An open enum: known values are listed, consumers must accept others
 * (versioning.md §2). Producers inside ExponetDB only emit known values.
 */
export function openEnum<const V extends readonly [string, ...string[]]>(
  values: V,
  description: string,
) {
  return z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_.:-]*$/)
    .meta({ 'x-extensible-enum': values, description })
}

/** RFC 3339 UTC timestamp with `Z` (fractional seconds allowed). */
export const TimestampSchema = z.iso
  .datetime()
  .meta({ description: 'RFC 3339 UTC timestamp ending in Z.' })

/** Authorization tier (C-24). Closed: a third tier is a major change. */
export const TierSchema = z
  .enum(['prod', 'nonprod'])
  .meta({ description: 'Authorization tier (C-24).' })
export type Tier = z.infer<typeof TierSchema>

/** Slug of a product, project or environment: immutable, part of target paths. */
export const SlugSchema = z.string().regex(/^[a-z][a-z0-9-]{0,38}$/)

/** `<product>/<project>/<environment>`, e.g. `reosa/platform/production`. */
export const TargetPathSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,38}\/[a-z][a-z0-9-]{0,38}\/[a-z][a-z0-9-]{0,38}$/)
  .meta({ description: 'Target path <product>/<project>/<environment>.' })

/** A target addressed by id or path (C-4: never by host or connection string). */
export const TargetRefSchema = z
  .union([TargetIdSchema, TargetPathSchema])
  .meta({ description: 'A target as tgt_ id or as path <product>/<project>/<environment>.' })

/** Where an observed state comes from (C-28). */
export const ObservationSourceSchema = openEnum(
  ['live', 'sampled', 'cached', 'agent_reported', 'inferred'],
  'Source of an observed state: live (read in this request), sampled (periodic sampler), cached (an earlier read served again), agent_reported (node agent), inferred (derived from other observations).',
)

/** Every observed state carries its source and time (C-28). */
export const FreshnessSchema = z
  .object({ source: ObservationSourceSchema, observedAt: TimestampSchema })
  .meta({ id: 'Freshness', description: 'Source and time of an observed state.' })

export const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/)
export const ApplyChecksumSchema = z
  .string()
  .regex(/^sha256:c[1-9][0-9]*:[0-9a-f]{64}$/)
  .meta({
    description:
      'Migration apply checksum (sha256:c1:<hex>); the canonicalizer is part of the value.',
  })
export const LedgerStateHashSchema = z.string().regex(/^sha256:ls[1-9][0-9]*:[0-9a-f]{64}$/)
export const SchemaFingerprintSchema = z
  .string()
  .regex(/^fp[1-9][0-9]*:[1-9][0-9]*:[0-9a-f]{64}$/)
  .meta({ description: 'Schema fingerprint fp<n>:<pg_major>:<hex>.' })

/** Opaque pagination cursor (REST architecture §2). */
export const CursorSchema = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/)

/** Page size for cursor pagination; the default and maximum are per collection. */
export function limitSchema(max: number, defaultValue: number) {
  return z.int().min(1).max(max).default(defaultValue)
}

/** Collection envelope: items plus an opaque cursor, stable order by id. */
export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: CursorSchema.nullable().meta({
      description: 'Cursor for the next page, null on the last page.',
    }),
  })
}

/** Human-readable text from a database or a caller: data, never instructions (C-26). */
export function untrustedText(maxLength: number, description: string) {
  return z.string().max(maxLength).meta({ untrusted: true, description })
}

export const PostgresVersionSchema = z
  .string()
  .regex(/^[1-9][0-9]*(\.[0-9]+)?$/)
  .meta({ description: 'PostgreSQL server version, major.minor.' })

/**
 * Any JSON value, as a named recursive schema. Used only where the contract is
 * genuinely data (query rows, EXPLAIN output, capability arguments selected by
 * a capability name) and always labeled at the field that uses it.
 */
export const JsonValueSchema: z.ZodType<JsonValue> = z
  .lazy(() =>
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(JsonValueSchema),
      z.record(z.string(), JsonValueSchema),
    ]),
  )
  .meta({ id: 'JsonValue', description: 'Any JSON value.' })

/** True when the text contains a C0 control character or DEL. */
export function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) {
      return true
    }
  }
  return false
}

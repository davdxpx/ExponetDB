import * as z from 'zod'
import { hasControlCharacter, MigrationIdSchema } from '../common.ts'

/**
 * `exponetdb.migration/v1` ([migration-bundles.md §2](../../../../exponetdb-docs/04-migrations/migration-bundles.md#2-manifest-migrationyaml)).
 * Strict: unknown keys are errors, so `transactinal: false` cannot fall back
 * to a default. Field constraints follow the Wave 1 clarification in §2.
 */
export const MIGRATION_MANIFEST_SCHEMA_ID = 'exponetdb.migration/v1'

/**
 * Go/Prometheus-style duration: components h, m, s, ms in this order, each an
 * integer without leading zeros. No lookaround, so every JSON Schema engine
 * (including RE2-based ones) evaluates it the same way.
 */
export const DURATION_PATTERN =
  /^(?:(0|[1-9][0-9]{0,8})h)?(?:(0|[1-9][0-9]{0,8})m)?(?:(0|[1-9][0-9]{0,8})s)?(?:(0|[1-9][0-9]{0,8})ms)?$/
/** Bounds for lockTimeout and statementTimeout: 1 ms to 6 h (0 means "no timeout" in PostgreSQL). */
export const TIMEOUT_MIN_MS = 1
export const TIMEOUT_MAX_MS = 6 * 60 * 60 * 1000

/** Milliseconds of a duration, or undefined when the text is not in the grammar. */
export function parseDurationMs(text: string): number | undefined {
  const match = text.length >= 2 ? DURATION_PATTERN.exec(text) : null
  if (match === null) {
    return undefined
  }
  const [, h, m, s, ms] = match
  return (
    Number(h ?? 0) * 3_600_000 + Number(m ?? 0) * 60_000 + Number(s ?? 0) * 1000 + Number(ms ?? 0)
  )
}

export const DurationSchema = z
  .string()
  .min(2)
  .regex(DURATION_PATTERN)
  .refine(
    (v) => {
      const ms = parseDurationMs(v)
      return ms !== undefined && ms >= TIMEOUT_MIN_MS && ms <= TIMEOUT_MAX_MS
    },
    { message: 'Timeouts must lie between 1 ms and 6 h.' },
  )
  .meta({ description: 'Duration such as 5s, 10m, 1h30m or 250ms, between 1 ms and 6 h.' })

export const MigrationNameSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .meta({ description: 'Kebab-case slug, at most 64 characters; not hashed.' })

export const BaselineRefSchema = z
  .string()
  .max('baseline:'.length + 64)
  .regex(/^baseline:[a-z0-9]+(-[a-z0-9]+)*$/)
  .meta({ description: 'Baseline node baseline:<slug>.' })

export const DependencyRefSchema = z.union([MigrationIdSchema, BaselineRefSchema])

export const ExecutionRoleAliasSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}$/)
  .meta({ description: 'Execution role alias defined in the project configuration.' })

const utf8Length = (value: string): number => new TextEncoder().encode(value).length

export const SchemaNameSchema = z
  .string()
  .min(1)
  .refine((v) => utf8Length(v) <= 63, { message: 'At most 63 bytes.' })
  .refine((v) => !hasControlCharacter(v), { message: 'No control characters.' })
  .meta({ description: 'PostgreSQL schema name (1 to 63 bytes, no control characters).' })

const VERSION = '(?:0|[1-9]\\d*)(?:\\.(?:0|[1-9]\\d*))*'
const COMPARATOR = `(?:>=|<=|>|<|=)?${VERSION}`
export const VersionRangeSchema = z
  .string()
  .regex(new RegExp(`^${COMPARATOR}(?: ${COMPARATOR})*$`))
  .meta({ description: 'Space-separated comparators such as ">=16 <19" or ">=0.7.0".' })

export const ExtensionNameSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/)

export const CompatibilityClassSchema = z.enum([
  'additive',
  'potentially_breaking',
  'data_rewrite',
  'destructive',
])
export const RollbackSafetySchema = z.enum(['safe', 'lossy', 'unsafe'])

/** Count of Unicode code points (not UTF-16 units). */
const codePoints = (value: string): number => [...value].length

export const MigrationManifestSchema = z
  .strictObject({
    schema: z.literal(MIGRATION_MANIFEST_SCHEMA_ID),
    id: MigrationIdSchema,
    name: MigrationNameSchema,
    description: z
      .string()
      .refine((v) => codePoints(v) >= 1 && codePoints(v) <= 2000, {
        message: '1 to 2000 code points.',
      })
      .meta({
        untrusted: true,
        description: 'Why the change exists; plain text, 1 to 2000 code points.',
      }),
    dependsOn: z.array(DependencyRefSchema).max(1000),
    execution: z.strictObject({
      transactional: z.boolean(),
      lockTimeout: DurationSchema.optional(),
      statementTimeout: DurationSchema.optional(),
      role: ExecutionRoleAliasSchema.optional(),
      searchPath: z.array(SchemaNameSchema).max(32).optional(),
    }),
    requires: z
      .strictObject({
        postgres: VersionRangeSchema.optional(),
        extensions: z
          .array(
            z.strictObject({ name: ExtensionNameSchema, version: VersionRangeSchema.optional() }),
          )
          .max(64)
          .refine((list) => new Set(list.map((e) => e.name)).size === list.length, {
            message: 'Extension names must be unique.',
          })
          .optional(),
      })
      .optional(),
    compatibility: z
      .strictObject({
        declared: CompatibilityClassSchema,
        notes: z.string().min(1).meta({ untrusted: true }).optional(),
      })
      .refine(
        (c) => c.declared === 'additive' || (c.notes !== undefined && c.notes.trim().length > 0),
        {
          message: 'notes are required unless declared is additive.',
          path: ['notes'],
        },
      ),
    verification: z.strictObject({
      expectations: z.enum(['auto', 'none']),
      runtimeChecks: z.enum(['verify.sql', 'none']),
    }),
    rollback: z
      .strictObject({
        script: z.enum(['down.sql', 'none']),
        safety: RollbackSafetySchema.optional(),
        notes: z.string().min(1).meta({ untrusted: true }).optional(),
      })
      .refine((r) => (r.script === 'down.sql') === (r.safety !== undefined), {
        message: 'safety is required when script is down.sql and must be absent when it is none.',
        path: ['safety'],
      })
      .optional(),
    source: z
      .strictObject({
        authors: z
          .array(z.string().min(1).max(320).meta({ untrusted: true }))
          .max(32)
          .optional(),
        ticket: z.string().min(1).max(200).meta({ untrusted: true }).optional(),
      })
      .optional(),
  })
  .meta({
    id: 'MigrationManifest',
    title: 'exponetdb.migration/v1',
    description: 'migration.yaml of a migration bundle (strict).',
  })

export type MigrationManifest = z.infer<typeof MigrationManifestSchema>

import { encodeUtf8 } from '@exponetdb/kernel'
import * as z from 'zod'
import { hasControlCharacter, SlugSchema } from '../common.ts'
import {
  BaselineRefSchema,
  DurationSchema,
  ExecutionRoleAliasSchema,
  ExtensionNameSchema,
  SchemaNameSchema,
} from './migration.ts'

/**
 * `exponetdb.project/v1` ([migration-bundles.md §6](../../../../exponetdb-docs/04-migrations/migration-bundles.md#6-project-configuration-exponetdbprojectyaml)).
 * Strict. Covers the documented fields; bundle roots and per-rule lint
 * overrides are added as optional fields in Wave 6.
 */
export const PROJECT_CONFIG_SCHEMA_ID = 'exponetdb.project/v1'

export const PostgresRoleNameSchema = z
  .string()
  .min(1)
  .refine((v) => encodeUtf8(v).length <= 63, { message: 'At most 63 bytes.' })
  .refine((v) => !hasControlCharacter(v), { message: 'No control characters.' })

export const ProjectDefaultsSchema = z.strictObject({
  lockTimeout: DurationSchema.optional(),
  statementTimeout: DurationSchema.optional(),
  role: ExecutionRoleAliasSchema.optional(),
  searchPath: z.array(SchemaNameSchema).max(32).optional(),
})
export type ProjectDefaults = z.infer<typeof ProjectDefaultsSchema>

export const ProjectConfigSchema = z
  .strictObject({
    schema: z.literal(PROJECT_CONFIG_SCHEMA_ID),
    project: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,38}\/[a-z][a-z0-9-]{0,38}$/)
      .meta({ description: '<product>/<project>; must match the registry.' }),
    layout: z.enum(['bundles', 'legacy+bundles']),
    defaults: ProjectDefaultsSchema.optional(),
    executionRoles: z
      .record(ExecutionRoleAliasSchema, PostgresRoleNameSchema)
      .refine((roles) => Object.keys(roles).length >= 1, {
        message: 'At least one execution role alias.',
      }),
    managedScope: z.strictObject({
      includeSchemas: z.union([z.literal('*'), z.array(SchemaNameSchema).min(1).max(256)]),
      excludeSchemas: z.array(SchemaNameSchema).max(256),
    }),
    trustedExtensions: z.array(ExtensionNameSchema).max(64).optional(),
    lintProfile: z.enum(['strict', 'standard']),
    legacy: z
      .strictObject({
        directory: z.string().min(1).max(1024),
        baseline: BaselineRefSchema,
      })
      .optional(),
  })
  .refine((c) => c.layout !== 'legacy+bundles' || c.legacy !== undefined, {
    message: 'legacy is required when layout is legacy+bundles.',
    path: ['legacy'],
  })
  .refine(
    (c) => c.defaults?.role === undefined || Object.hasOwn(c.executionRoles, c.defaults.role),
    {
      message: 'defaults.role must name an alias in executionRoles.',
      path: ['defaults', 'role'],
    },
  )
  .meta({
    id: 'ProjectConfig',
    title: 'exponetdb.project/v1',
    description: 'exponetdb.project.yaml at the root of a migration stream (strict).',
  })

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>

/** Project slugs for display. */
export const ProjectSlugSchema = SlugSchema

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
 * Strict. Covers the documented fields; Wave 6 added the optional bundle
 * roots, lint settings and project invariants (additive: none of them is
 * part of the `c1` projection, which reads `defaults` only).
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

/** A lint rule id (`analysis.md` §6). */
export const LintRuleIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)

/**
 * A bundle root, relative to the project file's directory: forward
 * slashes, no `..`, no absolute path, no empty or `.` segment (G6 order §13).
 */
export const BundleRootSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9._\-/]+$/)
  .refine((v) => v.split('/').every((part) => part !== '' && part !== '.' && part !== '..'), {
    message: 'A relative path: no leading or trailing slash, no empty, . or .. segment.',
  })
  .meta({ description: 'A directory of bundles, relative to exponetdb.project.yaml.' })

export const ProjectLintSchema = z
  .strictObject({
    rules: z
      .record(LintRuleIdSchema, z.enum(['error', 'warn', 'info', 'off']))
      .optional()
      .meta({
        description:
          'Per-rule level overrides. Rules the engine enforces (forbidden statements, DAG errors, non-transactional statements in a transactional bundle) cannot be lowered; a lowered rule of a prod-tier project is shown in every plan.',
      }),
    sizeThreshold: z
      .strictObject({
        bytes: z.int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
        rows: z.int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      })
      .optional()
      .meta({
        description:
          'A table is non-trivial above this heap size or row estimate (default 64 MiB, 1 million rows).',
      }),
    forbiddenSchemas: z.array(SchemaNameSchema).max(64).optional(),
    forbiddenFunctions: z.array(z.string().min(1).max(127)).max(256).optional(),
  })
  .meta({ id: 'ProjectLint' })

export const ProjectInvariantsSchema = z
  .strictObject({
    rowSecurityRequired: z.array(SchemaNameSchema).max(256).optional().meta({
      description: 'Schemas whose new tables must enable row level security in the same migration.',
    }),
    grantRequired: z.array(SchemaNameSchema).max(256).optional().meta({
      description: 'Schemas whose new tables must receive an explicit GRANT in the same migration.',
    }),
  })
  .meta({ id: 'ProjectInvariants' })

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
    bundleRoots: z.array(BundleRootSchema).min(1).max(64).optional().meta({
      description:
        'Where the stream reads bundles in place (no copy step); default the directory of this file.',
    }),
    lint: ProjectLintSchema.optional(),
    invariants: ProjectInvariantsSchema.optional(),
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

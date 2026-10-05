import * as z from 'zod'

/** Maximum file sizes of a bundle in bytes (migration-bundles.md §1). */
export const BUNDLE_FILE_LIMITS = {
  'migration.yaml': 64 * 1024,
  'up.sql': 4 * 1024 * 1024,
  'verify.sql': 512 * 1024,
  'down.sql': 4 * 1024 * 1024,
} as const

export const BUNDLE_FILE_NAMES = ['migration.yaml', 'up.sql', 'verify.sql', 'down.sql'] as const
export type BundleFileName = (typeof BUNDLE_FILE_NAMES)[number]

const fileText = (name: BundleFileName) =>
  z
    .string()
    .max(BUNDLE_FILE_LIMITS[name])
    .meta({
      untrusted: true,
      description: `Exact text of ${name} (UTF-8, at most ${BUNDLE_FILE_LIMITS[name]} bytes).`,
    })

/**
 * A bundle submitted inline (REST lint and plan requests, MCP `migration_lint`).
 * The bytes are hashed exactly as received; the content is untrusted (C-26).
 */
export const BundleSubmissionSchema = z
  .strictObject({
    directory: z
      .string()
      .regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}_[a-z0-9]+(-[a-z0-9]+)*$/)
      .max(91)
      .meta({ description: 'Bundle directory name <ULID>_<name>.' }),
    files: z.strictObject({
      'migration.yaml': fileText('migration.yaml'),
      'up.sql': fileText('up.sql'),
      'verify.sql': fileText('verify.sql').optional(),
      'down.sql': fileText('down.sql').optional(),
    }),
  })
  .meta({ id: 'MigrationBundleSubmission' })

export type BundleSubmission = z.infer<typeof BundleSubmissionSchema>

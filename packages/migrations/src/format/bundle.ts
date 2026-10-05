import {
  BUNDLE_FILE_LIMITS,
  BUNDLE_FILE_NAMES,
  type BUNDLE_INVALID_REASONS,
  type BundleFileName,
  type MigrationManifest,
  type ValidationIssue,
} from '@exponetdb/contracts'
import { decodeUtf8, err, ok, type Result } from '@exponetdb/kernel'
import { type BundleDigests, computeBundleDigests } from './digests.ts'
import { parseMigrationManifest } from './projection.ts'
import { normalizeSqlSource } from './sql.ts'
import { parseStrictYaml } from './yaml.ts'

type BundleInvalidReason = (typeof BUNDLE_INVALID_REASONS)[number]

/** The refusal of a bundle, shaped like the details of the matching catalog codes. */
export type BundleFailure =
  | {
      readonly code: 'MIGRATION_BUNDLE_INVALID'
      readonly details: { readonly reason: BundleInvalidReason; readonly file?: BundleFileName }
    }
  | {
      readonly code: 'MIGRATION_MANIFEST_INVALID'
      readonly details: { readonly errors: readonly ValidationIssue[] }
    }

export interface BundleInput {
  /** Directory name `<ULID>_<name>`. */
  readonly directory: string
  /** Every file of the directory with its exact bytes. */
  readonly files: ReadonlyMap<string, Uint8Array>
  /** The `defaults` block of the project configuration. */
  readonly projectDefaults: unknown
}

export interface ValidatedBundle {
  readonly directory: string
  readonly manifest: MigrationManifest
  readonly digests: BundleDigests
}

const DIRECTORY = /^([0-7][0-9A-HJKMNP-TV-Z]{25})_([a-z0-9]+(?:-[a-z0-9]+)*)$/

function invalid(reason: BundleInvalidReason, file?: BundleFileName): Result<never, BundleFailure> {
  return err({
    code: 'MIGRATION_BUNDLE_INVALID',
    details: file === undefined ? { reason } : { reason, file },
  })
}

function manifestInvalid(errors: readonly ValidationIssue[]): Result<never, BundleFailure> {
  return err({ code: 'MIGRATION_MANIFEST_INVALID', details: { errors: errors.slice(0, 100) } })
}

function isBundleFileName(name: string): name is BundleFileName {
  return BUNDLE_FILE_NAMES.some((n) => n === name)
}

/**
 * Validates a bundle directory ([migration-bundles.md §1, §2](../../../../exponetdb-docs/04-migrations/migration-bundles.md))
 * and computes its digests. Pure: the caller passes the bytes; nothing is read
 * from disk or the network. The server, the CLI and the Control Store runner
 * call this same function.
 */
export function validateBundle(input: BundleInput): Result<ValidatedBundle, BundleFailure> {
  const match = DIRECTORY.exec(input.directory)
  if (match === null || input.directory.length > 91) {
    return invalid('invalid_directory_name')
  }
  for (const name of input.files.keys()) {
    if (!isBundleFileName(name)) {
      return invalid('unexpected_file')
    }
  }
  for (const name of BUNDLE_FILE_NAMES) {
    const bytes = input.files.get(name)
    if (bytes === undefined) {
      if (name === 'migration.yaml' || name === 'up.sql') {
        return invalid('missing_file', name)
      }
      continue
    }
    if (bytes.length > BUNDLE_FILE_LIMITS[name]) {
      return invalid('file_too_large', name)
    }
  }
  const manifestBytes = input.files.get('migration.yaml') ?? new Uint8Array()
  const manifestText = decodeUtf8(manifestBytes)
  if (!manifestText.ok) {
    return invalid('invalid_utf8', 'migration.yaml')
  }
  if (manifestText.value.charCodeAt(0) === 0xfeff) {
    return invalid('bom', 'migration.yaml')
  }
  if (manifestText.value.includes('\u0000')) {
    return invalid('nul', 'migration.yaml')
  }
  const yaml = parseStrictYaml(manifestText.value)
  if (!yaml.ok) {
    return manifestInvalid([
      { path: yaml.error.path, code: yaml.error.code, message: yaml.error.message },
    ])
  }
  const manifest = parseMigrationManifest(yaml.value)
  if (!manifest.ok) {
    const e = manifest.error
    return manifestInvalid(
      'issues' in e
        ? e.issues
        : [{ path: 'path' in e ? e.path : '', code: e.code, message: 'Invalid manifest value.' }],
    )
  }
  if (manifest.value.id !== match[1] || manifest.value.name !== match[2]) {
    return invalid('directory_mismatch', 'migration.yaml')
  }
  const hasVerify = input.files.has('verify.sql')
  if (hasVerify !== (manifest.value.verification.runtimeChecks === 'verify.sql')) {
    return invalid('verify_file_mismatch', 'verify.sql')
  }
  const hasDown = input.files.has('down.sql')
  if (hasDown !== (manifest.value.rollback?.script === 'down.sql')) {
    return invalid('rollback_file_mismatch', 'down.sql')
  }
  const files: { 'up.sql'?: Uint8Array; 'verify.sql'?: Uint8Array; 'down.sql'?: Uint8Array } = {}
  for (const name of ['up.sql', 'verify.sql', 'down.sql'] as const) {
    const bytes = input.files.get(name)
    if (bytes !== undefined) {
      files[name] = bytes
    }
  }
  const digests = computeBundleDigests({
    manifest: yaml.value,
    projectDefaults: input.projectDefaults,
    files,
  })
  if (!digests.ok) {
    const e = digests.error
    if ('file' in e) {
      return e.code === 'missing_file' ? invalid('missing_file', e.file) : invalid(e.code, e.file)
    }
    if ('issues' in e) {
      return manifestInvalid(e.issues)
    }
    return manifestInvalid([
      {
        path: 'path' in e ? e.path : '/execution',
        code: e.code,
        message: 'The value cannot be materialized.',
      },
    ])
  }
  if (digests.value.executableText['up.sql'] === '') {
    // empty_migration: nothing but whitespace; no_statements: only comments.
    const source = normalizeSqlSource(files['up.sql'] ?? new Uint8Array())
    const blank = source.ok && /^[ \t\n\v\f]*$/.test(source.value)
    return invalid(blank ? 'empty_migration' : 'no_statements', 'up.sql')
  }
  return ok({ directory: input.directory, manifest: manifest.value, digests: digests.value })
}

/** Refuses two bundles with the same migration id in one submission. */
export function findDuplicateMigrationId(bundles: readonly ValidatedBundle[]): string | undefined {
  const seen = new Set<string>()
  for (const b of bundles) {
    if (seen.has(b.manifest.id)) {
      return b.manifest.id
    }
    seen.add(b.manifest.id)
  }
  return undefined
}

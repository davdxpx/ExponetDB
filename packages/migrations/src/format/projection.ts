import {
  type MigrationManifest,
  MigrationManifestSchema,
  type ProjectDefaults,
  ProjectDefaultsSchema,
  parseDurationMs,
} from '@exponetdb/contracts'
import {
  canonicalize,
  err,
  InvariantError,
  type JsonObject,
  ok,
  type Result,
} from '@exponetdb/kernel'

/**
 * Manifest projections P (apply), V (verify) and R (rollback) of `c1`
 * ([migration-bundles.md N7](../../../../exponetdb-docs/04-migrations/migration-bundles.md#normative-definition-of-c1-frozen-at-g1)).
 * FROZEN AT G1 together with the SQL canonicalization.
 */

/** Engine defaults for timeouts not set by the manifest or the project (planning-and-apply.md §5). */
export const ENGINE_DEFAULT_LOCK_TIMEOUT_MS = 5_000
export const ENGINE_DEFAULT_STATEMENT_TIMEOUT_MS = 15 * 60_000

export interface ManifestIssue {
  readonly path: string
  readonly code: string
  readonly message: string
}

export type ProjectionRefusal =
  | { readonly code: 'invalid_duration' | 'duration_out_of_range'; readonly path: string }
  | { readonly code: 'unresolved_execution_role' | 'unresolved_search_path' }
  | { readonly code: 'manifest_invalid'; readonly issues: readonly ManifestIssue[] }
  | { readonly code: 'project_defaults_invalid'; readonly issues: readonly ManifestIssue[] }

export interface Projections {
  /** JCS of P, V and R: the exact bytes framed into the digests. */
  readonly apply: string
  readonly verify: string
  readonly rollback: string
  /** P as an object: the canonical manifest recorded with the bundle (defaults materialized). */
  readonly applyFields: JsonObject
}

const DURATION_FIELDS = new Set(['lockTimeout', 'statementTimeout'])

interface ZodLikeIssue {
  readonly code: string
  readonly path: readonly PropertyKey[]
  readonly message: string
}

function toIssue(issue: ZodLikeIssue): ManifestIssue {
  const pointer = issue.path
    .map((p) => `/${String(p).replaceAll('~', '~0').replaceAll('/', '~1')}`)
    .join('')
  return { path: pointer, code: issue.code, message: issue.message }
}

/** Duration issues get the `c1` refusal codes; the first issue decides (schema member order). */
function durationRefusal(issue: ZodLikeIssue): ProjectionRefusal | undefined {
  const last = issue.path.at(-1)
  if (typeof last !== 'string' || !DURATION_FIELDS.has(last)) {
    return undefined
  }
  const path = toIssue(issue).path
  return issue.code === 'custom'
    ? { code: 'duration_out_of_range', path }
    : { code: 'invalid_duration', path }
}

/** Validates project defaults (eagerly, whether or not a default is used). */
export function parseProjectDefaults(value: unknown): Result<ProjectDefaults, ProjectionRefusal> {
  const parsed = ProjectDefaultsSchema.safeParse(value ?? {})
  if (parsed.success) {
    return ok(parsed.data)
  }
  const first = parsed.error.issues[0]
  const refusal = first === undefined ? undefined : durationRefusal(first)
  return err(
    refusal ?? { code: 'project_defaults_invalid', issues: parsed.error.issues.map(toIssue) },
  )
}

/** Validates a parsed migration.yaml against `exponetdb.migration/v1`. */
export function parseMigrationManifest(
  value: unknown,
): Result<MigrationManifest, ProjectionRefusal> {
  const parsed = MigrationManifestSchema.safeParse(value)
  if (parsed.success) {
    return ok(parsed.data)
  }
  const first = parsed.error.issues[0]
  const refusal = first === undefined ? undefined : durationRefusal(first)
  return err(refusal ?? { code: 'manifest_invalid', issues: parsed.error.issues.map(toIssue) })
}

function durationMs(
  text: string | undefined,
  fallback: string | undefined,
  engineDefault: number,
): number {
  const chosen = text ?? fallback
  if (chosen === undefined) {
    return engineDefault
  }
  const ms = parseDurationMs(chosen)
  if (ms === undefined) {
    throw new InvariantError('a validated duration did not parse')
  }
  return ms
}

/** Code-point (UTF-8 byte) order for the canonical sort of `dependsOn`. */
function byCodePoint(a: string, b: string): number {
  // dependsOn entries are ASCII (ULIDs and baseline slugs), where UTF-16 and
  // code point order agree; the explicit comparison documents the intent.
  return a < b ? -1 : a > b ? 1 : 0
}

/** P, V and R of a validated manifest with validated project defaults (N7). */
export function projectManifest(
  manifest: MigrationManifest,
  defaults: ProjectDefaults,
): Result<Projections, ProjectionRefusal> {
  const role = manifest.execution.role ?? defaults.role
  if (role === undefined) {
    return err({ code: 'unresolved_execution_role' })
  }
  const searchPath = manifest.execution.searchPath ?? defaults.searchPath
  if (searchPath === undefined) {
    return err({ code: 'unresolved_search_path' })
  }
  const extensions = [...(manifest.requires?.extensions ?? [])]
    .map((e) => ({ name: e.name, version: e.version ?? null }))
    .sort((a, b) => byCodePoint(a.name, b.name))
  const applyFields: JsonObject = {
    schema: manifest.schema,
    id: manifest.id,
    dependsOn: [...new Set(manifest.dependsOn)].sort(byCodePoint),
    execution: {
      transactional: manifest.execution.transactional,
      lockTimeout: durationMs(
        manifest.execution.lockTimeout,
        defaults.lockTimeout,
        ENGINE_DEFAULT_LOCK_TIMEOUT_MS,
      ),
      statementTimeout: durationMs(
        manifest.execution.statementTimeout,
        defaults.statementTimeout,
        ENGINE_DEFAULT_STATEMENT_TIMEOUT_MS,
      ),
      role,
      searchPath: [...searchPath],
    },
    requires: { postgres: manifest.requires?.postgres ?? null, extensions },
    compatibility: { declared: manifest.compatibility.declared },
  }
  const verifyFields: JsonObject = {
    verification: {
      expectations: manifest.verification.expectations,
      runtimeChecks: manifest.verification.runtimeChecks,
    },
  }
  const rollback = manifest.rollback
  const rollbackFields: JsonObject = {
    rollback:
      rollback === undefined
        ? null
        : {
            script: rollback.script,
            safety: rollback.safety ?? null,
            notes: rollback.notes ?? null,
          },
  }
  return ok({
    apply: jcs(applyFields),
    verify: jcs(verifyFields),
    rollback: jcs(rollbackFields),
    applyFields,
  })
}

function jcs(value: JsonObject): string {
  const text = canonicalize(value)
  if (!text.ok) {
    throw new InvariantError(`projection is not JSON: ${text.error.code}`)
  }
  return text.value
}

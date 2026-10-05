import type { Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { type ProjectConfig, ProjectConfigSchema } from '@exponetdb/contracts'
import { decodeUtf8 } from '@exponetdb/kernel'
import {
  type BundleDigests,
  findDuplicateMigrationId,
  parseProjectDefaults,
  parseStrictYaml,
  projectManifest,
  validateBundle,
} from '@exponetdb/migrations/format'
import { buildGraph, type MigrationGraph } from '@exponetdb/migrations/graph'
import { SafeError } from '@exponetdb/observability'

/**
 * The Control Store's own migration bundles
 * ([control-database.md §5](../../../exponetdb-docs/02-control-plane/control-database.md#5-the-control-stores-own-migrations)).
 *
 * They are real ExponetDB bundles (`<ULID>_<slug>/` with `migration.yaml`,
 * `up.sql`, `verify.sql`), validated and digested by the frozen
 * `migrations/format` code and ordered by `migrations/graph`. They ship with
 * the release next to this package (`packages/control-store/migrations/`, in
 * the image `/app/migrations/`), so the release knows its expected set.
 *
 * Control Store rules on top of the format: every bundle is transactional,
 * has a `verify.sql` whose every check is named (`-- check:`), and executes
 * as the login that runs the migration (`exdb_migrate`).
 */
export const SHIPPED_BUNDLES_DIR = new URL('../migrations/', import.meta.url)
export const MIGRATE_LOGIN = 'exdb_migrate'

export interface ExecutionSettings {
  readonly lockTimeoutMs: number
  readonly statementTimeoutMs: number
  readonly searchPath: readonly string[]
}

export interface LoadedBundle {
  readonly directory: string
  readonly id: string
  readonly name: string
  readonly dependsOn: readonly string[]
  readonly digests: BundleDigests
  readonly execution: ExecutionSettings
  /** up.sql as shipped (decoded UTF-8): the exact text that is executed. */
  readonly upSql: string
  readonly verifySql: string
  /** The `-- check:` names of verify.sql, in order. */
  readonly checkNames: readonly string[]
}

export interface BundleSet {
  readonly project: ProjectConfig
  /** In application order. */
  readonly bundles: readonly LoadedBundle[]
  readonly graph: MigrationGraph
}

export type BundleSetErrorReason =
  | 'directory_unreadable'
  | 'project_config_invalid'
  | 'bundle_invalid'
  | 'not_transactional'
  | 'verify_sql_missing'
  | 'check_unnamed'
  | 'execution_role_not_migrate'
  | 'duplicate_migration_id'
  | 'graph_invalid'

export class BundleSetError extends SafeError {
  override readonly name = 'BundleSetError'
  /** Directory name of the offending bundle (a shipped file name, not input). */
  readonly bundle: string | undefined
  /** The `migrations/format` or `migrations/graph` refusal code, when there is one. */
  readonly detail: string | undefined

  constructor(reason: BundleSetErrorReason, bundle?: string, detail?: string) {
    super(reason, 'The shipped Control Store bundles are invalid.')
    this.bundle = bundle
    this.detail = detail
  }
}

const CHECK_DIRECTIVE = /^[ \t]*--[ \t]*check:[ \t]*(\S(?:.*\S)?)[ \t]*$/

/** Names of the checks of a verify.sql, from its `-- check:` directives, in order. */
export function checkNamesOf(verifySql: string): string[] {
  const names: string[] = []
  for (const line of verifySql.split(/\r\n|\r|\n/)) {
    const m = CHECK_DIRECTIVE.exec(line)
    if (m?.[1] !== undefined) {
      names.push(m[1].slice(0, 120))
    }
  }
  return names
}

function text(bytes: Uint8Array | undefined, bundle: string): string {
  const decoded = bytes === undefined ? undefined : decodeUtf8(bytes)
  if (decoded === undefined || !decoded.ok) {
    throw new BundleSetError('bundle_invalid', bundle, 'invalid_utf8')
  }
  return decoded.value
}

/** Loads, validates and orders a bundle directory. Throws {@link BundleSetError}. */
export async function loadBundleSet(dir: URL | string = SHIPPED_BUNDLES_DIR): Promise<BundleSet> {
  const base = typeof dir === 'string' ? dir : fileURLToPath(dir)
  let entries: Dirent[]
  let projectText: string
  try {
    entries = await readdir(base, { withFileTypes: true })
    projectText = text(await readFile(`${base}/exponetdb.project.yaml`), 'exponetdb.project.yaml')
  } catch (error) {
    if (error instanceof BundleSetError) {
      throw error
    }
    throw new BundleSetError('directory_unreadable')
  }
  const yaml = parseStrictYaml(projectText)
  const project = yaml.ok ? ProjectConfigSchema.safeParse(yaml.value) : undefined
  if (project === undefined || !project.success) {
    throw new BundleSetError('project_config_invalid')
  }
  const defaults = parseProjectDefaults(project.data.defaults)
  if (!defaults.ok) {
    throw new BundleSetError('project_config_invalid', undefined, defaults.error.code)
  }

  const bundles: LoadedBundle[] = []
  const validated = []
  for (const entry of entries
    .filter((e) => e.isDirectory())
    .sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const files = new Map<string, Uint8Array>()
    for (const file of await readdir(`${base}/${entry.name}`)) {
      files.set(file, new Uint8Array(await readFile(`${base}/${entry.name}/${file}`)))
    }
    const result = validateBundle({
      directory: entry.name,
      files,
      projectDefaults: project.data.defaults,
    })
    if (!result.ok) {
      const e = result.error
      throw new BundleSetError(
        'bundle_invalid',
        entry.name,
        e.code === 'MIGRATION_BUNDLE_INVALID' ? e.details.reason : e.code,
      )
    }
    validated.push(result.value)
    const manifest = result.value.manifest
    if (!manifest.execution.transactional) {
      throw new BundleSetError('not_transactional', entry.name)
    }
    if (manifest.verification.runtimeChecks !== 'verify.sql') {
      throw new BundleSetError('verify_sql_missing', entry.name)
    }
    const projection = projectManifest(manifest, defaults.value)
    if (!projection.ok) {
      throw new BundleSetError('bundle_invalid', entry.name, projection.error.code)
    }
    const execution = projection.value.applyFields['execution']
    const role = manifest.execution.role ?? defaults.value.role
    if (role === undefined || project.data.executionRoles[role] !== MIGRATE_LOGIN) {
      throw new BundleSetError('execution_role_not_migrate', entry.name)
    }
    const verifySql = text(files.get('verify.sql'), entry.name)
    const checkNames = checkNamesOf(verifySql)
    if (checkNames.length === 0) {
      throw new BundleSetError('check_unnamed', entry.name)
    }
    const searchPath = manifest.execution.searchPath ?? defaults.value.searchPath ?? []
    bundles.push({
      directory: entry.name,
      id: manifest.id,
      name: manifest.name,
      dependsOn: manifest.dependsOn,
      digests: result.value.digests,
      execution: {
        lockTimeoutMs: numberMember(execution, 'lockTimeout'),
        statementTimeoutMs: numberMember(execution, 'statementTimeout'),
        searchPath,
      },
      upSql: text(files.get('up.sql'), entry.name),
      verifySql,
      checkNames,
    })
  }
  const duplicate = findDuplicateMigrationId(validated)
  if (duplicate !== undefined) {
    throw new BundleSetError('duplicate_migration_id', duplicate)
  }
  const graph = buildGraph({
    migrations: bundles.map((b) => ({ id: b.id, dependsOn: b.dependsOn })),
  })
  if (!graph.ok) {
    throw new BundleSetError('graph_invalid', undefined, graph.error.code)
  }
  const byId = new Map(bundles.map((b) => [b.id, b]))
  const ordered = graph.value.order().flatMap((id) => {
    const b = byId.get(id)
    return b === undefined ? [] : [b]
  })
  return { project: project.data, bundles: ordered, graph: graph.value }
}

function numberMember(value: unknown, name: string): number {
  const v = typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) {
    throw new BundleSetError('bundle_invalid', undefined, 'execution_settings')
  }
  return v
}

/** What a release expects in the ledger: every shipped id with its checksum and verify digest. */
export interface ExpectedMigration {
  readonly id: string
  readonly name: string
  readonly checksum: string
  readonly verifyDigest: string
}

export function expectedMigrations(set: BundleSet): ExpectedMigration[] {
  return set.bundles.map((b) => ({
    id: b.id,
    name: b.name,
    checksum: b.digests.checksum,
    verifyDigest: b.digests.verifyDigest,
  }))
}

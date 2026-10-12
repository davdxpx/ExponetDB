import { lstat, readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import {
  BUNDLE_FILE_LIMITS,
  BUNDLE_FILE_NAMES,
  type BundleSubmission,
  type ProjectConfig,
  ProjectConfigSchema,
} from '@exponetdb/contracts'
import { type BundleInput, parseStrictYaml } from '@exponetdb/migrations/format'
import { UsageError } from '../cli/usage.ts'
import { CliError } from '../errors.ts'
import { readPrivateJson } from '../files.ts'

/**
 * The local migration stream ([`04-migrations/authoring-and-ci.md`](../../../../exponetdb-docs/04-migrations/authoring-and-ci.md)):
 * `exponetdb.project.yaml` (strict YAML, `exponetdb.project/v1`) found from
 * `--workdir` upwards, and the bundle directories of its roots read with
 * their exact bytes. Nothing here talks to a server; the same pure packages
 * the server uses validate, hash and lint what is read.
 */
export const PROJECT_FILE = 'exponetdb.project.yaml'
const BUNDLE_DIRECTORY = /^[0-7][0-9A-HJKMNP-TV-Z]{25}_[a-z0-9]+(-[a-z0-9]+)*$/
const MAX_PROJECT_BYTES = 64 * 1024
const MAX_BUNDLES = 5000

export interface LocalProject {
  readonly file: string
  readonly root: string
  readonly config: ProjectConfig
}

export interface LocalBundle {
  readonly directory: string
  readonly path: string
  readonly input: BundleInput
  readonly submission: BundleSubmission | undefined
}

/** The project file from `start` upwards, or undefined. */
export async function findProjectFile(start: string): Promise<string | undefined> {
  let dir = resolve(start)
  for (;;) {
    const candidate = join(dir, PROJECT_FILE)
    const info = await lstat(candidate).catch(() => undefined)
    if (info?.isFile() === true) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Reads and validates a project file; a refusal names the fields. */
export async function readProject(file: string): Promise<LocalProject> {
  const info = await lstat(file).catch(() => undefined)
  if (info === undefined || !info.isFile()) throw new UsageError(`${file} is not a regular file.`)
  if (info.size > MAX_PROJECT_BYTES) throw new UsageError(`${file} is larger than 64 KiB.`)
  const text = await readFile(file, 'utf8')
  const yaml = parseStrictYaml(text)
  if (!yaml.ok)
    throw new CliError(
      'VALIDATION_FAILED',
      `${file}: ${yaml.error.path || '(root)'}: ${yaml.error.message}`,
    )
  const parsed = ProjectConfigSchema.safeParse(yaml.value)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 8)
      .map((i) => `${i.path.length === 0 ? '(root)' : i.path.join('.')}: ${i.message}`)
    throw new CliError(
      'VALIDATION_FAILED',
      `${file} is not a valid exponetdb.project/v1 file: ${issues.join('; ')}`,
    )
  }
  return { file, root: dirname(file), config: parsed.data }
}

/** The project of this invocation (`--workdir` or the current directory, searched upwards). */
export async function currentProject(workdir: string): Promise<LocalProject> {
  const file = await findProjectFile(workdir)
  if (file === undefined) {
    throw new UsageError(`No ${PROJECT_FILE} in ${resolve(workdir)} or above.`, 'exponetdb init')
  }
  return readProject(file)
}

/** The bundle roots of a project as absolute directories (default: the project directory). */
export function bundleRoots(project: LocalProject): string[] {
  return (project.config.bundleRoots ?? ['.']).map((r) => resolve(project.root, r))
}

// ignoreBOM: a byte order mark stays in the text (the server refuses it as the local check does).
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * Every bundle directory of the roots, with its exact bytes. A symbolic
 * link, an unexpected file or an oversized file is passed on as it is, so
 * the shared validation refuses it with its reason; a link is never
 * followed.
 */
export async function readBundles(project: LocalProject): Promise<LocalBundle[]> {
  const bundles: LocalBundle[] = []
  for (const root of bundleRoots(project)) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => {
      throw new CliError(
        'VALIDATION_FAILED',
        `The bundle root ${relative(project.root, root) || '.'} cannot be read.`,
      )
    })
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!BUNDLE_DIRECTORY.test(entry.name)) continue
      if (!entry.isDirectory()) {
        throw new CliError(
          'VALIDATION_FAILED',
          `${join(root, entry.name)} is not a directory (links are not followed).`,
        )
      }
      if (bundles.length >= MAX_BUNDLES)
        throw new CliError('VALIDATION_FAILED', 'More than 5000 bundles.')
      const path = join(root, entry.name)
      const files = new Map<string, Uint8Array>()
      for (const file of await readdir(path, { withFileTypes: true })) {
        if (!file.isFile()) {
          // Still reported: the validation refuses an unexpected entry by name.
          files.set(file.name, new Uint8Array())
          continue
        }
        const limit = (BUNDLE_FILE_LIMITS as Record<string, number>)[file.name] ?? 0
        const info = await lstat(join(path, file.name))
        // An oversized file is read only up to the limit + 1 byte: enough for the refusal.
        const bytes = await readFile(join(path, file.name))
        files.set(
          file.name,
          new Uint8Array(info.size > limit + 1 ? bytes.subarray(0, limit + 1) : bytes),
        )
      }
      bundles.push({
        directory: entry.name,
        path,
        input: { directory: entry.name, files, projectDefaults: project.config.defaults ?? {} },
        submission: submissionOf(entry.name, files),
      })
    }
  }
  return bundles
}

/** The REST submission of a bundle (exact text), or undefined when it is not valid UTF-8. */
function submissionOf(
  directory: string,
  files: ReadonlyMap<string, Uint8Array>,
): BundleSubmission | undefined {
  const text: Record<string, string> = {}
  for (const name of BUNDLE_FILE_NAMES) {
    const bytes = files.get(name)
    if (bytes === undefined) continue
    try {
      text[name] = decoder.decode(bytes)
    } catch {
      return undefined
    }
  }
  if (text['migration.yaml'] === undefined || text['up.sql'] === undefined) return undefined
  return { directory, files: text as BundleSubmission['files'] }
}

/** Where a project records its link to a server and profile (personal, not committed). */
export const LINK_DIR = '.exponetdb'
export const LINK_FILE = 'link.json'

/** The project's link to a server and profile (non-secret), if any. */
export async function readLink(
  root: string,
): Promise<{ server: string; profile: string | null } | undefined> {
  const raw = await readPrivateJson(join(root, LINK_DIR, LINK_FILE))
  if (typeof raw !== 'object' || raw === null) return undefined
  const v = raw as Record<string, unknown>
  return typeof v['server'] === 'string'
    ? { server: v['server'], profile: typeof v['profile'] === 'string' ? v['profile'] : null }
    : undefined
}

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Dependency license scan (ADR-0030 §5). Bun installs every package once into
 * `node_modules/.bun/<name>@<version>/node_modules/<name>` and links each workspace package's
 * dependencies into its own `node_modules`; this check walks those installed manifests (what is
 * on disk, not what a lockfile says) and judges every third-party package against the policy of
 * the closure it ends up in:
 *
 * - **shipped**: reachable from the runtime `dependencies` of a workspace package under `apps/`
 *   or `packages/` (server image, CLI artifact, browser bundle);
 * - **development**: reachable only from a `devDependencies` of any workspace manifest, root and
 *   tooling included (build, test and lint tools; never shipped).
 *
 * A package in both closures is judged as shipped. A license that is missing, cannot be parsed or
 * carries a `WITH` exception is a problem, not a guess. Optional dependencies and peers that are
 * not installed on this platform are skipped, so the scan covers the current platform.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export type Closure = 'shipped' | 'development'

/** Licenses a shipped package may carry. Any other license stops the change for the owner. */
export const SHIPPED_LICENSES: readonly string[] = [
  'MIT',
  'MIT-0',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'CC0-1.0',
  'BlueOak-1.0.0',
  'Unlicense',
]

/**
 * Added for development tools that never ship. MPL-2.0 is file-level copyleft: unmodified build
 * and test tools (`lightningcss`, `axe-core`) place no obligation on ExponetDB code. CC-BY-4.0
 * covers data such as `caniuse-lite`; Python-2.0 is `argparse`.
 */
export const DEVELOPMENT_LICENSES: readonly string[] = [
  ...SHIPPED_LICENSES,
  'MPL-2.0',
  'CC-BY-4.0',
  'Python-2.0',
]

/** Font files only: the OFL applies to self-hosted font packages and nothing else. */
export const FONT_LICENSE = 'OFL-1.1'
export const FONT_PACKAGE_PREFIX = '@fontsource/'

export interface LicenseOverride {
  readonly license: string
  /** Why this license is right, naming the file it was verified from. */
  readonly reason: string
}

/**
 * `name@version` of a package whose manifest declares no usable license, with the license read
 * from its LICENSE file. An entry is added only after verifying that file; the reason says so.
 */
export const LICENSE_OVERRIDES: Readonly<Record<string, LicenseOverride>> = {}

// ---------------------------------------------------------------------------
// SPDX expressions
// ---------------------------------------------------------------------------

export type SpdxNode =
  | { readonly kind: 'id'; readonly id: string }
  | { readonly kind: 'and' | 'or'; readonly left: SpdxNode; readonly right: SpdxNode }

export type SpdxParse =
  | { readonly ok: true; readonly node: SpdxNode }
  | { readonly ok: false; readonly reason: string }

class SpdxSyntaxError extends Error {}

const SPDX_ID = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/

/** Parses `A OR B`, `A AND B` and parentheses; `WITH` and anything else unknown is refused. */
export function parseSpdx(expression: string): SpdxParse {
  const tokens = expression.match(/[()]|[^\s()]+/g) ?? []
  let pos = 0
  const fail = (reason: string): never => {
    throw new SpdxSyntaxError(reason)
  }
  const isOperator = (token: string | undefined, word: 'AND' | 'OR' | 'WITH'): boolean =>
    token?.toUpperCase() === word

  function parsePrimary(): SpdxNode {
    const token = tokens[pos]
    if (token === undefined) {
      return fail('the expression ends where a license id is expected')
    }
    if (token === '(') {
      pos += 1
      const inner = parseOr()
      if (tokens[pos] !== ')') {
        return fail('a parenthesis is not closed')
      }
      pos += 1
      return inner
    }
    if (token === ')' || /^(?:AND|OR|WITH)$/i.test(token)) {
      return fail(`unexpected "${token}"`)
    }
    if (!SPDX_ID.test(token)) {
      return fail(`"${token}" is not an SPDX license id`)
    }
    pos += 1
    if (isOperator(tokens[pos], 'WITH')) {
      return fail('a WITH exception is not evaluated')
    }
    return { kind: 'id', id: token }
  }

  function parseAnd(): SpdxNode {
    let left = parsePrimary()
    while (isOperator(tokens[pos], 'AND')) {
      pos += 1
      left = { kind: 'and', left, right: parsePrimary() }
    }
    return left
  }

  function parseOr(): SpdxNode {
    let left = parseAnd()
    while (isOperator(tokens[pos], 'OR')) {
      pos += 1
      left = { kind: 'or', left, right: parseAnd() }
    }
    return left
  }

  try {
    if (tokens.length === 0) {
      return { ok: false, reason: 'the license expression is empty' }
    }
    const node = parseOr()
    if (pos < tokens.length) {
      return fail(`unexpected "${tokens[pos]}"`)
    }
    return { ok: true, node }
  } catch (error) {
    if (error instanceof SpdxSyntaxError) {
      return { ok: false, reason: error.message }
    }
    throw error
  }
}

function holds(node: SpdxNode, allowed: ReadonlySet<string>): boolean {
  switch (node.kind) {
    case 'id':
      return allowed.has(node.id.toLowerCase())
    case 'and':
      return holds(node.left, allowed) && holds(node.right, allowed)
    case 'or':
      return holds(node.left, allowed) || holds(node.right, allowed)
  }
}

/**
 * Whether an SPDX expression is acceptable: `OR` needs either side, `AND` needs both. An
 * expression that does not parse, or carries a `WITH` exception, is never acceptable. License ids
 * compare case-insensitively, as SPDX defines.
 */
export function evaluateSpdx(expression: string, allowed: Iterable<string>): boolean {
  const parsed = parseSpdx(expression)
  if (!parsed.ok) {
    return false
  }
  return holds(parsed.node, new Set([...allowed].map((id) => id.toLowerCase())))
}

// ---------------------------------------------------------------------------
// Judging one package
// ---------------------------------------------------------------------------

export interface PackageLicense {
  readonly name: string
  readonly version: string
  /** The declared license expression, or undefined when the manifest declares none. */
  readonly license: string | undefined
}

export interface Verdict {
  readonly ok: boolean
  /** The expression that was judged ("(none)" when the manifest declares nothing). */
  readonly license: string
  readonly reason: string
}

/** The licenses a package may carry in a closure. */
export function allowedLicenses(name: string, closure: Closure): string[] {
  const base = closure === 'shipped' ? SHIPPED_LICENSES : DEVELOPMENT_LICENSES
  return name.startsWith(FONT_PACKAGE_PREFIX) ? [...base, FONT_LICENSE] : [...base]
}

export function judge(
  pkg: PackageLicense,
  closure: Closure,
  overrides: Readonly<Record<string, LicenseOverride>> = LICENSE_OVERRIDES,
): Verdict {
  const declared = pkg.license?.trim() ?? ''
  let expression = declared
  let parsed: SpdxParse =
    declared === '' ? { ok: false, reason: 'no license is declared' } : parseSpdx(declared)
  let basis = ''
  const override = overrides[`${pkg.name}@${pkg.version}`]
  if (!parsed.ok && override !== undefined) {
    expression = override.license
    parsed = parseSpdx(override.license)
    basis = ` (override: ${override.reason})`
  }
  if (!parsed.ok) {
    return {
      ok: false,
      license: expression === '' ? '(none)' : expression,
      reason: `${parsed.reason}; add a verified entry to LICENSE_OVERRIDES or replace the package`,
    }
  }
  const allowed = allowedLicenses(pkg.name, closure)
  if (!evaluateSpdx(expression, allowed)) {
    return {
      ok: false,
      license: expression,
      reason: `not allowed in the ${closure} closure (allowed: ${allowed.join(', ')})${basis}`,
    }
  }
  return { ok: true, license: expression, reason: `allowed in the ${closure} closure${basis}` }
}

// ---------------------------------------------------------------------------
// Reading the installed packages
// ---------------------------------------------------------------------------

type Field = 'dependencies' | 'optionalDependencies' | 'peerDependencies' | 'devDependencies'

interface Manifest {
  readonly name: string
  readonly version: string
  readonly license: string | undefined
  readonly workspaces: readonly string[]
  readonly fields: Readonly<Record<Field, Readonly<Record<string, string>>>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'string') {
        out[key] = entry
      }
    }
  }
  return out
}

function licenseType(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value
  }
  if (isRecord(value) && typeof value['type'] === 'string') {
    return value['type']
  }
  return undefined
}

/**
 * The declared license: the SPDX string `license`, the legacy `{ type }` object, or the legacy
 * `licenses` array (a choice between its entries, so joined with OR).
 */
export function declaredLicense(manifest: Record<string, unknown>): string | undefined {
  const single = licenseType(manifest['license'])
  if (single !== undefined) {
    return single
  }
  const legacy = manifest['licenses']
  if (Array.isArray(legacy)) {
    const types = legacy.map(licenseType).filter((t): t is string => t !== undefined)
    if (types.length > 0) {
      return types.join(' OR ')
    }
  }
  return undefined
}

function readManifest(dir: string): Manifest | undefined {
  const file = join(dir, 'package.json')
  if (!existsSync(file)) {
    return undefined
  }
  let json: unknown
  try {
    json = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
  if (!isRecord(json)) {
    return undefined
  }
  const workspaces = Array.isArray(json['workspaces'])
    ? json['workspaces'].filter((w): w is string => typeof w === 'string')
    : []
  return {
    name: typeof json['name'] === 'string' ? json['name'] : basename(dir),
    version: typeof json['version'] === 'string' ? json['version'] : 'unknown',
    license: declaredLicense(json),
    workspaces,
    fields: {
      dependencies: stringRecord(json['dependencies']),
      optionalDependencies: stringRecord(json['optionalDependencies']),
      peerDependencies: stringRecord(json['peerDependencies']),
      devDependencies: stringRecord(json['devDependencies']),
    },
  }
}

/**
 * Node resolution of `name` from the package at `fromDir`: the first `node_modules/<name>` on the
 * way up that holds a manifest, as a real path. For a package in Bun's store this finds its
 * sibling links (`.bun/x@1/node_modules/y`), for a workspace package its own `node_modules`.
 */
export function resolveInstalled(fromDir: string, name: string): string | undefined {
  let dir = fromDir
  for (;;) {
    const modules = basename(dir) === 'node_modules' ? dir : join(dir, 'node_modules')
    const candidate = join(modules, name)
    if (existsSync(join(candidate, 'package.json'))) {
      return realpathSync(candidate)
    }
    const parent = dirname(dir)
    if (parent === dir) {
      return undefined
    }
    dir = parent
  }
}

interface Workspace {
  /** Real directory path. */
  readonly dir: string
  /** Path relative to the repository root ("." for the root package). */
  readonly rel: string
  readonly manifest: Manifest
}

/** A `workspaces` entry is a directory or `<parent>/*`; a missing parent has no members. */
function expandWorkspace(realRoot: string, pattern: string): string[] {
  if (!pattern.endsWith('/*')) {
    return [pattern]
  }
  const parent = pattern.slice(0, -2)
  if (!existsSync(join(realRoot, parent))) {
    return []
  }
  return readdirSync(join(realRoot, parent), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `${parent}/${e.name}`)
}

/** The root package and every workspace package its `workspaces` field names. */
export function workspacesOf(rootDir: string): Workspace[] {
  const realRoot = realpathSync(rootDir)
  const rootManifest = readManifest(realRoot)
  if (rootManifest === undefined) {
    throw new Error(`${rootDir}/package.json is missing or unreadable`)
  }
  const found: Workspace[] = []
  for (const pattern of rootManifest.workspaces) {
    for (const rel of expandWorkspace(realRoot, pattern)) {
      const dir = join(realRoot, rel)
      const manifest = readManifest(dir)
      if (manifest !== undefined) {
        found.push({ dir: realpathSync(dir), rel, manifest })
      }
    }
  }
  found.push({ dir: realRoot, rel: '.', manifest: rootManifest })
  return found
}

interface Installed {
  readonly dir: string
  readonly manifest: Manifest
}

export interface Collected {
  /** `name@version` of every third-party package in the shipped closure. */
  readonly shipped: ReadonlyMap<string, PackageLicense>
  /** `name@version` of every package reachable only from development dependencies. */
  readonly development: ReadonlyMap<string, PackageLicense>
  /** Declared dependencies that are not installed, and unreadable manifests. */
  readonly problems: readonly string[]
}

/** Walks the installed manifests under `rootDir` and returns both closures. */
export function collect(rootDir: string): Collected {
  const realRoot = realpathSync(rootDir)
  const workspaces = workspacesOf(realRoot)
  const workspaceByName = new Map(workspaces.map((w) => [w.manifest.name, w.dir]))
  const workspaceDirs = new Set(workspaces.map((w) => w.dir))
  const problems = new Set<string>()

  const describe = (dir: string, manifest: Manifest): string =>
    workspaceDirs.has(dir)
      ? `${relative(realRoot, dir) || '.'}/package.json`
      : `${manifest.name}@${manifest.version}`

  /** The installed directories of the listed dependency fields of one package. */
  function resolveFields(dir: string, manifest: Manifest, fields: readonly Field[]): string[] {
    const out: string[] = []
    for (const field of fields) {
      const required = field === 'dependencies' || field === 'devDependencies'
      for (const [name, spec] of Object.entries(manifest.fields[field])) {
        const target = spec.startsWith('workspace:')
          ? workspaceByName.get(name)
          : resolveInstalled(dir, name)
        if (target !== undefined) {
          out.push(target)
        } else if (required) {
          problems.add(
            `${describe(dir, manifest)}: ${field} "${name}" is not installed (run bun install)`,
          )
        }
      }
    }
    return out
  }

  /** Every package reachable from the start directories. */
  function walk(starts: readonly string[]): Map<string, Installed> {
    const seen = new Map<string, Installed>()
    const queue = [...starts]
    for (let dir = queue.pop(); dir !== undefined; dir = queue.pop()) {
      if (seen.has(dir)) {
        continue
      }
      const manifest = readManifest(dir)
      if (manifest === undefined) {
        problems.add(`${relative(realRoot, dir)}: package.json is missing or unreadable`)
        continue
      }
      seen.set(dir, { dir, manifest })
      queue.push(
        ...resolveFields(dir, manifest, [
          'dependencies',
          'optionalDependencies',
          'peerDependencies',
        ]),
      )
    }
    return seen
  }

  const productRoots = workspaces
    .filter((w) => w.rel.startsWith('apps/') || w.rel.startsWith('packages/'))
    .flatMap((w) => resolveFields(w.dir, w.manifest, ['dependencies']))
  const developmentRoots = workspaces.flatMap((w) =>
    resolveFields(
      w.dir,
      w.manifest,
      w.rel.startsWith('apps/') || w.rel.startsWith('packages/')
        ? ['devDependencies']
        : ['dependencies', 'devDependencies'],
    ),
  )

  function thirdParty(seen: ReadonlyMap<string, Installed>): Map<string, PackageLicense> {
    const out = new Map<string, PackageLicense>()
    for (const { dir, manifest } of seen.values()) {
      const key = `${manifest.name}@${manifest.version}`
      if (!workspaceDirs.has(dir) && !out.has(key)) {
        out.set(key, { name: manifest.name, version: manifest.version, license: manifest.license })
      }
    }
    return out
  }

  const shipped = thirdParty(walk(productRoots))
  const development = new Map(
    [...thirdParty(walk(developmentRoots))].filter(([key]) => !shipped.has(key)),
  )
  return { shipped, development, problems: [...problems].sort() }
}

export interface LicenseReport {
  readonly problems: string[]
  readonly shipped: number
  readonly development: number
}

/** Judges every collected package; problems are `name@version (closure): license — reason`. */
export function checkLicenses(rootDir: string): LicenseReport {
  const collected = collect(rootDir)
  const problems = [...collected.problems]
  for (const closure of ['shipped', 'development'] as const) {
    const packages = [...collected[closure].entries()].sort(([a], [b]) => a.localeCompare(b))
    for (const [key, pkg] of packages) {
      const verdict = judge(pkg, closure)
      if (!verdict.ok) {
        problems.push(`${key} (${closure}): ${verdict.license} — ${verdict.reason}`)
      }
    }
  }
  return {
    problems,
    shipped: collected.shipped.size,
    development: collected.development.size,
  }
}

function main(): void {
  const report = checkLicenses(root)
  if (report.problems.length > 0) {
    console.error(report.problems.join('\n'))
    process.exit(1)
  }
  console.log(
    `dependency licenses hold (${report.shipped} shipped and ${report.development} development packages checked)`,
  )
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}

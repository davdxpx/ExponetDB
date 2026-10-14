import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

/**
 * The license notice of the Web App (ADR-0030 section 5, third-party-register.md): the build writes
 * `assets/third-party-licenses.txt`, a plain text file `serve` delivers next to the bundle. It lists
 * every npm package that ended up in the bundle (the JavaScript chunks and the CSS and font files
 * they import) with its license text, and it appends the repository notices for the files copied
 * from Supabase and shadcn/ui. A bundled package without a license text and without a declared
 * license stops the build, so a notice can never be silently missing.
 */
export const NOTICE_FILE = 'assets/third-party-licenses.txt'

export interface BundledPackage {
  readonly name: string
  readonly version: string
  /** The declared SPDX expression, when the manifest has one. */
  readonly license: string | undefined
  readonly repository: string | undefined
  /** The text of the package's license file, when it ships one. */
  readonly text: string | undefined
}

/**
 * The package directory a bundled module belongs to: the last `node_modules/<name>` (or
 * `node_modules/@scope/<name>`) of its path, query and virtual-module prefix removed. Workspace
 * sources and anything outside `node_modules` belong to no third-party package.
 */
export function packageDirOf(moduleId: string): string | undefined {
  const clean = moduleId.replace(/^\0/, '').split('?')[0] ?? ''
  const marker = `${sep}node_modules${sep}`
  const at = clean.lastIndexOf(marker)
  if (at === -1) return undefined
  const rest = clean.slice(at + marker.length).split(sep)
  const first = rest[0]
  if (first === undefined || first === '') return undefined
  const parts = first.startsWith('@') ? rest.slice(0, 2) : rest.slice(0, 1)
  if (
    parts.some((p) => p === '' || p === undefined) ||
    (first.startsWith('@') && parts.length < 2)
  ) {
    return undefined
  }
  return join(clean.slice(0, at + marker.length), ...parts)
}

const LICENSE_FILE = /^(?:licen[cs]e|copying|unlicense)(?:[-._].*)?$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads the name, version, license and license text of an installed package directory. */
export function readPackage(dir: string): BundledPackage | undefined {
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  const json: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!isRecord(json) || typeof json['name'] !== 'string') return undefined
  const rawLicense = json['license']
  const license =
    typeof rawLicense === 'string'
      ? rawLicense
      : isRecord(rawLicense) && typeof rawLicense['type'] === 'string'
        ? rawLicense['type']
        : Array.isArray(json['licenses'])
          ? json['licenses']
              .map((l: unknown) => (isRecord(l) && typeof l['type'] === 'string' ? l['type'] : ''))
              .filter((l) => l !== '')
              .join(' OR ') || undefined
          : undefined
  const repo = json['repository']
  const repository =
    typeof repo === 'string'
      ? repo
      : isRecord(repo) && typeof repo['url'] === 'string'
        ? repo['url']
        : undefined
  const file = readdirSync(dir)
    .filter((entry) => LICENSE_FILE.test(entry))
    .sort()[0]
  const text = file === undefined ? undefined : readFileSync(join(dir, file), 'utf8').trim()
  return {
    name: json['name'],
    version: typeof json['version'] === 'string' ? json['version'] : 'unknown',
    license,
    repository,
    text: text === '' ? undefined : text,
  }
}

/** The distinct packages behind a set of bundled module ids, sorted by name and version. */
export function bundledPackages(moduleIds: Iterable<string>): {
  readonly packages: BundledPackage[]
  readonly problems: string[]
} {
  const dirs = new Set<string>()
  for (const id of moduleIds) {
    const dir = packageDirOf(id)
    if (dir !== undefined && existsSync(dir)) dirs.add(realpathSync(dir))
  }
  const packages = new Map<string, BundledPackage>()
  const problems: string[] = []
  for (const dir of [...dirs].sort()) {
    const pkg = readPackage(dir)
    if (pkg === undefined) {
      // A nested directory without its own manifest (a subpath folder): the owning package is
      // found by walking up to the nearest package.json.
      const up = nearestPackage(dirname(dir))
      if (up === undefined)
        problems.push(`${dir}: no package.json; the bundle names no package for it`)
      else packages.set(`${up.name}@${up.version}`, up)
      continue
    }
    if (pkg.text === undefined && (pkg.license === undefined || pkg.license.trim() === '')) {
      problems.push(
        `${pkg.name}@${pkg.version}: bundled, but ships no license file and declares no license; add its license text to the notices or replace the package`,
      )
    }
    packages.set(`${pkg.name}@${pkg.version}`, pkg)
  }
  return {
    packages: [...packages.values()].sort((a, b) =>
      `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
    ),
    problems,
  }
}

function nearestPackage(from: string): BundledPackage | undefined {
  let dir = from
  for (;;) {
    const pkg = readPackage(dir)
    if (pkg !== undefined) return pkg
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

const RULE = '-'.repeat(78)

/** The notice text: header, the repository notices, then one section per bundled package. */
export function renderNotices(
  packages: readonly BundledPackage[],
  repositoryNotices: readonly { readonly title: string; readonly text: string }[],
): string {
  const out: string[] = [
    'ExponetDB Web App: third-party licenses',
    '',
    'The Web App bundle contains the third-party software listed below, each under its own',
    'license. ExponetDB itself is proprietary. This file is generated by the build from the',
    'packages that are actually bundled; do not edit it.',
    '',
    `Bundled npm packages: ${packages.length}`,
    '',
  ]
  for (const notice of repositoryNotices) {
    out.push(RULE, notice.title, RULE, '', notice.text.trim(), '')
  }
  for (const pkg of packages) {
    out.push(
      RULE,
      `${pkg.name} ${pkg.version}`,
      `License: ${pkg.license ?? '(see the text below)'}`,
    )
    if (pkg.repository !== undefined) out.push(`Source: ${pkg.repository}`)
    out.push(RULE, '')
    out.push(
      pkg.text ??
        `The package ships no license file; it declares the license ${pkg.license ?? '(none)'} in its manifest.`,
      '',
    )
  }
  return `${out.join('\n')}\n`
}

/**
 * Checks a finished notice file: it must name the bundle's package count, hold a section for every
 * listed package and carry the repository notices. Returns the problems (empty when it is sound).
 */
export function verifyNoticeText(
  text: string,
  expected: readonly { readonly name: string; readonly version: string }[],
  requiredTitles: readonly string[],
): string[] {
  const problems: string[] = []
  if (!text.startsWith('ExponetDB Web App: third-party licenses')) {
    problems.push(`${NOTICE_FILE}: not the generated notice file`)
  }
  for (const title of requiredTitles) {
    if (!text.includes(title)) problems.push(`${NOTICE_FILE}: the notice "${title}" is missing`)
  }
  for (const pkg of expected) {
    if (!text.includes(`\n${pkg.name} ${pkg.version}\nLicense: `)) {
      problems.push(`${NOTICE_FILE}: no section for ${pkg.name}@${pkg.version}`)
    }
  }
  return problems
}

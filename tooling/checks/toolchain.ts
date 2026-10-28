/**
 * The pinned toolchain (test campaign TC-051). `engines` in the root package.json is advisory in
 * Bun, so `bun install` and the suites ran on Node 26 and Bun 1.3 without a word and their
 * results looked authoritative. This compares the running Node and Bun with `engines`:
 *
 *   bun tooling/checks/toolchain.ts             exits 1 when a version is outside its range
 *                                               (the first step of `bun run verify`)
 *   bun tooling/checks/toolchain.ts --preinstall  prints the mismatch; exits 1 only under CI=true
 *
 * Plain Node built-ins only: it runs before the dependencies are installed.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type Version = readonly [number, number, number]

function parse(text: string): Version | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(text)
  return m === null ? undefined : [Number(m[1]), Number(m[2]), Number(m[3])]
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] as number) - (b[i] as number)
    if (d !== 0) return d
  }
  return 0
}

/** `version` against a range of `>=x.y.z` and `<x[.y[.z]]` parts; false for anything unreadable. */
export function satisfies(version: string, range: string): boolean {
  const v = parse(version)
  if (v === undefined) return false
  for (const part of range.trim().split(/\s+/)) {
    const m = /^(>=|<)(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(part)
    if (m === null) return false
    const bound: Version = [Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)]
    const c = compare(v, bound)
    if (m[1] === '>=' ? c < 0 : c >= 0) return false
  }
  return true
}

/** One line per tool outside its range, or not there. */
export function mismatches(
  engines: Readonly<Record<string, string>>,
  running: Readonly<Record<string, string | undefined>>,
): string[] {
  return Object.entries(engines).flatMap(([tool, range]) => {
    const version = running[tool]
    if (version === undefined) return [`${tool} is not available (needs ${range})`]
    return satisfies(version, range) ? [] : [`${tool} ${version} is outside ${range}`]
  })
}

/**
 * A tool's version as its own binary reports it. Under Bun `process.versions.node` is the Node
 * version Bun emulates, not the `node` on the PATH that runs Vitest, so it is never used.
 */
function versionOf(tool: string): string | undefined {
  const run = spawnSync(tool, ['--version'], { encoding: 'utf8' })
  const m = run.status === 0 ? /(\d+\.\d+\.\d+)/.exec(run.stdout) : null
  return m?.[1]
}

function main(): number {
  const root = join(import.meta.dirname, '..', '..')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    engines?: Record<string, string>
  }
  const problems = mismatches(
    pkg.engines ?? {},
    Object.fromEntries(Object.keys(pkg.engines ?? {}).map((tool) => [tool, versionOf(tool)])),
  )
  if (problems.length === 0) return 0
  const lines = [
    'The toolchain is outside the supported range (package.json "engines"):',
    ...problems.map((p) => `  - ${p}`),
    'Results from this toolchain are not authoritative; use the pinned versions (CI and local-development.md).',
  ]
  const strict = !process.argv.includes('--preinstall') || process.env['CI'] === 'true'
  console.error(lines.join('\n'))
  return strict ? 1 : 0
}

if (import.meta.main) process.exitCode = main()

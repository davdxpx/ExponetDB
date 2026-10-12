/**
 * Packs the CLI into an npm tarball that works outside the monorepo
 * ([`15-cli/install.md`](../../../exponetdb-docs/15-cli/install.md)):
 *
 * - one ES module for Node.js 24 (`bin/exponetdb.mjs`) with every workspace
 *   package and pure dependency bundled in; nothing resolves `workspace:*`;
 * - PostgreSQL's parser per major (`libpg-query` 16, 17 and 18, WASM) stays
 *   three packages, bundled into the tarball (`bundleDependencies`): each
 *   loads its own `libpg-query.wasm` next to its module, so installing needs
 *   no registry;
 * - the build identity as literals: the version from package.json (it must
 *   equal `CLI_VERSION`), the commit (`EXPONETDB_BUILD_COMMIT`, else the
 *   checkout's HEAD, `-dirty` when the tree has changes) and the commit's
 *   time (`SOURCE_DATE_EPOCH` overrides): the same commit packs the same
 *   bundle, and no build path, user name or secret is embedded (checked);
 * - `BUILD.json`, the third-party notices of what was bundled, and a
 *   SHA-256 checksum file next to the tarball.
 *
 * Usage: `bun run --cwd apps/cli pack` (Bun is build tooling only). The
 * result is `apps/cli/dist/artifacts/exponetdb-cli-<version>.tgz`. Never
 * published to a public registry (the manifest stays private).
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLI_VERSION } from '../src/version.ts'

// The two Bun APIs this build script uses (it runs under Bun only; the
// package is type-checked without Bun's types).
declare const Bun: {
  build(options: {
    entrypoints: string[]
    outdir: string
    naming: string
    target: 'node'
    format: 'esm'
    minify: boolean
    sourcemap: 'none'
    conditions: string[]
    external: string[]
    define: Record<string, string>
  }): Promise<{ success: boolean; logs: unknown[] }>
  resolveSync(specifier: string, from: string): string
}

const here = dirname(fileURLToPath(import.meta.url))
const app = join(here, '..')
const root = join(app, '..', '..')
const stage = join(app, 'dist', 'package')
const artifacts = join(app, 'dist', 'artifacts')
const PARSER_PACKAGES = ['libpg-query-16', 'libpg-query-17', 'libpg-query-18'] as const

function fail(message: string): never {
  console.error(`pack: ${message}`)
  process.exit(1)
}

function git(args: readonly string[]): string | undefined {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : undefined
}

const manifest = JSON.parse(await readFile(join(app, 'package.json'), 'utf8')) as {
  version: string
  description: string
}
if (manifest.version !== CLI_VERSION) {
  fail(`package.json says ${manifest.version}, src/version.ts says ${CLI_VERSION}`)
}
const version = manifest.version

const commitInput =
  process.env['EXPONETDB_BUILD_COMMIT'] ??
  (() => {
    const head = git(['rev-parse', 'HEAD'])
    if (head === undefined) return 'unknown'
    const dirty = (git(['status', '--porcelain']) ?? '') !== ''
    return dirty ? `${head}-dirty` : head
  })()
if (!/^(?:[0-9a-f]{7,40}(?:-dirty)?|unknown)$/.test(commitInput)) {
  fail('EXPONETDB_BUILD_COMMIT must be a commit id')
}
const commit = commitInput
const epoch = process.env['SOURCE_DATE_EPOCH']
const builtAt =
  epoch !== undefined && /^\d+$/.test(epoch)
    ? new Date(Number(epoch) * 1000).toISOString()
    : (() => {
        const t = git(['show', '-s', '--format=%cI', 'HEAD'])
        return t === undefined ? null : new Date(t).toISOString()
      })()

await rm(stage, { recursive: true, force: true })
await mkdir(artifacts, { recursive: true })
const result = await Bun.build({
  entrypoints: [join(app, 'src', 'main.ts')],
  outdir: stage,
  naming: 'bin/exponetdb.mjs',
  target: 'node',
  format: 'esm',
  minify: false,
  sourcemap: 'none',
  conditions: ['@exponetdb/source'],
  external: [...PARSER_PACKAGES],
  define: {
    __EXPONETDB_CLI_BUILD__: JSON.stringify({ version, commit, builtAt }),
  },
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  fail('the bundle failed')
}
const binPath = join(stage, 'bin', 'exponetdb.mjs')
let bundle = await readFile(binPath, 'utf8')
if (!bundle.startsWith('#!')) bundle = `#!/usr/bin/env node\n${bundle}`

// The packages Bun bundled, from its module comments (relative paths such as
// `// ../../node_modules/.bun/zod@4.6.5/node_modules/zod/…`): their notices go
// into THIRD_PARTY_NOTICES.md.
const bundled = new Map<string, string>()
for (const m of bundle.matchAll(
  /^\/\/ (?:\.\.\/)*node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?((?:@[^/\s]+\/)?[^/\s]+)\//gm,
)) {
  const name = m[1]
  if (name === undefined || bundled.has(name)) continue
  const marker = m[0].slice(3, m[0].length - 1 - name.length)
  bundled.set(name, join(app, marker, name))
}
// The module comments name source files relative to this package; they are
// dropped, so the artifact carries no layout of the build machine.
bundle = bundle.replace(/^\/\/ (?:\.\.\/)+[^\n]*\n/gm, '')
await writeFile(binPath, bundle)
await chmod(binPath, 0o755)

// The parser packages and their own dependencies, below node_modules.
async function copyPackage(name: string, from: string, to: string): Promise<void> {
  const manifestPath = Bun.resolveSync(`${name}/package.json`, from)
  const dir = dirname(manifestPath)
  await cp(dir, to, { recursive: true, dereference: true })
  const pkg = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>
  }
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    await copyPackage(dep, dir, join(to, 'node_modules', dep))
  }
}
const postgres = join(root, 'packages', 'postgres')
const parserVersions: Record<string, string> = {}
for (const name of PARSER_PACKAGES) {
  await copyPackage(name, postgres, join(stage, 'node_modules', name))
  const pkg = JSON.parse(
    await readFile(join(stage, 'node_modules', name, 'package.json'), 'utf8'),
  ) as { version: string }
  parserVersions[name] = `npm:libpg-query@${pkg.version}`
}

// Third-party notices: the bundled packages and the parser packages.
async function notice(name: string, dir: string): Promise<string> {
  const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
    version?: string
    license?: string
  }
  const files = await readdir(dir)
  const licenseFile = files.find((f) => /^(?:license|licence|copying)(?:\.(?:md|txt))?$/i.test(f))
  const text = licenseFile === undefined ? '' : await readFile(join(dir, licenseFile), 'utf8')
  return [
    `## ${name} ${pkg.version ?? ''}`.trim(),
    '',
    `License: ${pkg.license ?? 'see the package'}`,
    '',
    ...(text === '' ? [] : ['```text', text.trim(), '```', '']),
  ].join('\n')
}
const notices = ['# Third-party notices', '', 'Packages bundled into the ExponetDB CLI.', '']
for (const [name, dir] of [...bundled].sort(([a], [b]) => a.localeCompare(b))) {
  notices.push(await notice(name, dir))
}
for (const name of PARSER_PACKAGES)
  notices.push(await notice(name, join(stage, 'node_modules', name)))
await writeFile(join(stage, 'THIRD_PARTY_NOTICES.md'), notices.join('\n'))

const build = {
  name: '@exponetdb/cli',
  version,
  commit,
  builtAt,
  node: '>=24.0.0 <25',
  parser: parserVersions,
}
await writeFile(join(stage, 'BUILD.json'), `${JSON.stringify(build, null, 2)}\n`)
await writeFile(
  join(stage, 'package.json'),
  `${JSON.stringify(
    {
      name: '@exponetdb/cli',
      version,
      private: true,
      license: 'UNLICENSED',
      description: manifest.description,
      type: 'module',
      bin: { exponetdb: './bin/exponetdb.mjs' },
      engines: { node: '>=24.0.0 <25' },
      os: ['linux', 'darwin', 'win32'],
      files: ['bin', 'BUILD.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'],
      dependencies: parserVersions,
      bundleDependencies: [...PARSER_PACKAGES],
    },
    null,
    2,
  )}\n`,
)
await cp(join(app, 'README.md'), join(stage, 'README.md'))
await cp(join(root, 'LICENSE'), join(stage, 'LICENSE'))

// Nothing of the build machine and nothing unresolved may be in the artifact.
const forbidden = [root, app, process.env['HOME'], 'workspace:', '@exponetdb/source'].filter(
  (s): s is string => s !== undefined && s.length > 1,
)
for (const text of [bundle, await readFile(join(stage, 'package.json'), 'utf8')]) {
  for (const s of forbidden)
    if (text.includes(s)) fail(`the artifact contains ${JSON.stringify(s)}`)
}
if (/from ["']@exponetdb\//.test(bundle) || /import\(["']@exponetdb\//.test(bundle)) {
  fail('the bundle still imports a workspace package')
}

const packed = spawnSync('npm', ['pack', '--pack-destination', artifacts, '--json'], {
  cwd: stage,
  encoding: 'utf8',
})
if (packed.status !== 0) fail(`npm pack failed: ${packed.stderr}`)
const [info] = JSON.parse(packed.stdout) as [{ filename: string; files: { path: string }[] }]
const tgz = join(artifacts, info.filename.replace(/^@[^/]+\//, '').replace('/', '-'))
for (const name of PARSER_PACKAGES) {
  if (!info.files.some((f) => f.path === `node_modules/${name}/wasm/libpg-query.wasm`)) {
    fail(`the tarball lacks ${name}'s parser`)
  }
}
const digest = createHash('sha256')
  .update(await readFile(tgz))
  .digest('hex')
const base = relative(artifacts, tgz)
await writeFile(`${tgz}.sha256`, `${digest}  ${base}\n`)
console.log(JSON.stringify({ artifact: relative(root, tgz), sha256: digest, ...build }, null, 2))

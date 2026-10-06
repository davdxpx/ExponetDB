/**
 * Bundles the program into one ES module for Node.js 24 (Bun is build
 * tooling only; the runtime is Node). The build identity is injected as
 * literals: the version from package.json and the commit from
 * `EXPONETDB_BUILD_COMMIT` (CI and the image build pass the commit being
 * built), else `unknown`. No timestamps: the same commit yields the same
 * bundle. The Control Store bundles are copied next to it
 * (`dist/bundle/migrations/`, one level above `bin/`, where the control-store
 * package resolves `../migrations/` from the bundled module at runtime), and
 * so is the built Web App (`dist/bundle/web/`, where `serve` looks for it;
 * build `apps/web` first). Bun copies the native Argon2 bindings of
 * `@node-rs/argon2` next to the bundle and loads them relative to it. The
 * SQL parser packages (libpg-query per PostgreSQL major, WASM) stay
 * packages under `dist/bundle/node_modules/`: each loads its own
 * `libpg-query.wasm` next to its module.
 */
import { access, cp, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const app = join(here, '..')
const out = join(app, 'dist', 'bundle')
const manifest: unknown = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'))
const version =
  typeof manifest === 'object' &&
  manifest !== null &&
  'version' in manifest &&
  typeof manifest.version === 'string'
    ? manifest.version
    : '0.0.0-dev'
const commitInput = process.env['EXPONETDB_BUILD_COMMIT'] ?? 'unknown'
const commit = /^(?:[0-9a-f]{7,40}|unknown)$/.test(commitInput) ? commitInput : 'unknown'

const PARSER_PACKAGES = ['libpg-query-16', 'libpg-query-17', 'libpg-query-18'] as const

await rm(out, { recursive: true, force: true })
const result = await Bun.build({
  entrypoints: [join(app, 'src', 'main.ts')],
  outdir: out,
  naming: 'bin/exponetdb.mjs',
  target: 'node',
  format: 'esm',
  minify: false,
  sourcemap: 'none',
  conditions: ['@exponetdb/source'],
  // PostgreSQL's parser per major (libpg-query, WASM) loads its .wasm next to
  // its own module, and all three name it the same: they stay packages.
  external: ['pg-native', ...PARSER_PACKAGES],
  define: {
    EXPONETDB_BUILD_VERSION: JSON.stringify(version),
    EXPONETDB_BUILD_COMMIT: JSON.stringify(commit),
  },
})
if (!result.success) {
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}
await cp(
  join(app, '..', '..', 'packages', 'control-store', 'migrations'),
  join(out, 'migrations'),
  {
    recursive: true,
  },
)
const web = join(app, '..', 'web', 'dist')
try {
  await access(join(web, 'index.html'))
} catch {
  console.error('the Web App is not built: run `bun run --cwd apps/web build` first')
  process.exit(1)
}
await cp(web, join(out, 'web'), { recursive: true })
// The parser packages, resolved from the package that depends on them, go to
// `dist/bundle/node_modules/` (`/app/node_modules/` in the image), where Node
// resolves the bundle's imports of them.
async function copyPackage(name: string, from: string, to: string): Promise<void> {
  const manifestPath = Bun.resolveSync(`${name}/package.json`, from)
  const dir = dirname(manifestPath)
  await cp(dir, to, { recursive: true, dereference: true })
  // Each package's own dependencies go below it (libpg-query 16, 17 and 18
  // each need their own @pgsql/types).
  const pkg: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  const deps =
    typeof pkg === 'object' &&
    pkg !== null &&
    'dependencies' in pkg &&
    typeof pkg.dependencies === 'object'
      ? Object.keys(pkg.dependencies ?? {})
      : []
  for (const dep of deps) {
    await copyPackage(dep, dir, join(to, 'node_modules', dep))
  }
}
const postgres = join(app, '..', '..', 'packages', 'postgres')
for (const name of PARSER_PACKAGES) {
  await copyPackage(name, postgres, join(out, 'node_modules', name))
}
console.log(`bundled exponetdb ${version}+${commit} into ${out}`)
